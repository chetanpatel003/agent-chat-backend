import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { ToolReconcileOutcome } from "@/tools/types";
import { MessageContentSchema, type ContentBlock } from "@/contracts/message";

/**
 * Persists a reconciled provider outcome onto a still-RUNNING invocation
 * and, in the same transaction, adds it to its chat message
 * (attachRecoveredToolResult). Guarded (status must still be RUNNING), so a
 * terminal row is never overwritten and concurrent reconcilers transition
 * it at most once; a failed/cancelled run's reported usage is kept on
 * `output.creditUsed`. Returns whether this call made the transition.
 */
export async function persistReconciledOutcome(
  toolInvocationId: string,
  reconciled: ToolReconcileOutcome<unknown>,
): Promise<boolean> {
  const data: Prisma.ToolInvocationUpdateManyMutationInput =
    reconciled.status === "completed"
      ? { status: "COMPLETED", output: reconciled.output as Prisma.InputJsonValue }
      : {
          status: "FAILED",
          errorCode: reconciled.errorCode,
          errorMessage: reconciled.errorMessage,
          ...(reconciled.creditUsed !== undefined ? { output: { creditUsed: reconciled.creditUsed } } : {}),
        };
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.toolInvocation.updateMany({ where: { id: toolInvocationId, status: "RUNNING" }, data });
    if (count !== 1) return false;
    await attachInTransaction(tx, toolInvocationId);
    return true;
  });
}

const ACTIVE_RUN = new Set(["QUEUED", "RUNNING", "WAITING"]);

export type AttachResult = "attached" | "already_attached" | "not_applicable";

/**
 * H2: puts a tool call that finished *after* its turn stopped tracking it
 * (polling budget exhausted, worker restart, recovery sweep) into the
 * assistant message it belongs to, so the user sees the result in the chat.
 *
 * - Adds the call's tool_use block (or updates its status if present) and
 *   one tool_result block, exactly like the in-turn path writes them.
 * - Idempotent and concurrency-safe: the message row is locked, and a
 *   tool_result already present for this invocation means nothing is written.
 * - A COMPLETED result on a still-PENDING message of an ended run makes the
 *   message COMPLETE, so it is shown as a result — not "Response interrupted".
 *   Failures are added as failed tool results without changing the status.
 * - Never touches credits: `creditsCharged` is whatever settlement has
 *   recorded so far (the messages API fills it in once settled).
 */
export async function attachRecoveredToolResult(toolInvocationId: string): Promise<AttachResult> {
  return prisma.$transaction((tx) => attachInTransaction(tx, toolInvocationId));
}

async function attachInTransaction(tx: Prisma.TransactionClient, toolInvocationId: string): Promise<AttachResult> {
  const invocation = await tx.toolInvocation.findUnique({
    where: { id: toolInvocationId },
    select: {
      id: true,
      messageId: true,
      toolName: true,
      status: true,
      input: true,
      output: true,
      durationMs: true,
      creditsCharged: true,
      errorCode: true,
      errorMessage: true,
      agentRun: { select: { status: true } },
    },
  });
  if (!invocation?.messageId || (invocation.status !== "COMPLETED" && invocation.status !== "FAILED")) {
    return "not_applicable";
  }
  // Row lock: concurrent recoverers serialise here and re-read the content.
  await tx.$queryRaw`SELECT id FROM "Message" WHERE id = ${invocation.messageId}::uuid FOR UPDATE`;
  const message = await tx.message.findUnique({
    where: { id: invocation.messageId },
    select: { id: true, role: true, status: true, content: true },
  });
  if (!message || message.role !== "ASSISTANT") return "not_applicable";

  const content = MessageContentSchema.parse(message.content);
  const failed = invocation.status === "FAILED";
  const runEnded = !ACTIVE_RUN.has(invocation.agentRun.status);
  const status = !failed && runEnded && message.status === "PENDING" ? "COMPLETE" : message.status;
  if (content.some((b) => b.type === "tool_result" && b.toolInvocationId === invocation.id)) {
    // Attached earlier (e.g. while the run was still active): only the status may still need updating.
    if (status !== message.status) await tx.message.update({ where: { id: message.id }, data: { status } });
    return "already_attached";
  }

  const toolUse: ContentBlock = {
    type: "tool_use",
    toolInvocationId: invocation.id,
    toolName: invocation.toolName,
    status: invocation.status,
    input:
      invocation.input && typeof invocation.input === "object" && !Array.isArray(invocation.input)
        ? (invocation.input as Record<string, unknown>)
        : {},
  };
  const toolResult: ContentBlock = {
    type: "tool_result",
    toolInvocationId: invocation.id,
    output:
      !failed && invocation.output && typeof invocation.output === "object" && !Array.isArray(invocation.output)
        ? (invocation.output as Record<string, unknown>)
        : null,
    durationMs: invocation.durationMs,
    creditsCharged: invocation.creditsCharged !== null ? Number(invocation.creditsCharged) : null,
    error: failed
      ? { code: invocation.errorCode ?? "EXECUTION_FAILED", message: invocation.errorMessage ?? "The tool call failed." }
      : null,
  };
  const existingUse = content.findIndex((b) => b.type === "tool_use" && b.toolInvocationId === invocation.id);
  const next: ContentBlock[] =
    existingUse >= 0
      ? content.flatMap((b, i) => (i === existingUse ? [toolUse, toolResult] : [b]))
      : [...content, toolUse, toolResult];

  await tx.message.update({
    where: { id: message.id },
    data: { content: MessageContentSchema.parse(next) as Prisma.InputJsonValue, status },
  });
  return "attached";
}

