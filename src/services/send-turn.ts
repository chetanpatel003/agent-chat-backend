import { dispatchChatTitle } from "@/trigger/generate-chat-title";
import { runAfterResponse } from "@/lib/after-response";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { requireChatOwnership } from "@/services/ownership";
import { attachToMessage } from "@/services/attachment";
import { runAgentTurn } from "@/trigger/run-agent-turn";
import { cancelActiveRunInTx, cancelTriggerRunBestEffort, INTERRUPTED_BY_USER } from "@/services/agent-run";
import { RUN_TRANSITION_TRANSACTION_OPTIONS } from "@/services/run-transitions";
import type { SendMessageRequest, SendMessageResponse } from "@/contracts/message";

// Verified empirically against the real DB — see decisions/0009. Prisma's
// P2002 meta shape for this driver-adapter client, against a raw-SQL
// index, is not the plain { target: string[] } shape standard-field
// guidance suggests.
const ACTIVE_RUN_INDEX = "AgentRun_one_active_per_chat";
const IDEMPOTENCY_KEY_INDEX = "AgentRun_idempotencyKey_key";

function violatedIndex(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return null;
  }
  const meta = error.meta as
    | { driverAdapterError?: { cause?: { constraint?: { index?: string } } } }
    | undefined;
  return meta?.driverAdapterError?.cause?.constraint?.index ?? null;
}

async function readExistingDispatch(
  userId: string,
  chatId: string,
  idempotencyKey: string,
): Promise<SendMessageResponse> {
  const run = await prisma.agentRun.findUniqueOrThrow({ where: { idempotencyKey } });
  // Keys are global: a key already used by someone else (or for another
  // chat) is a conflict, never a way to read that dispatch.
  if (run.userId !== userId || run.chatId !== chatId) {
    throw new ConflictError("This Idempotency-Key was already used for a different request");
  }
  // The user Message that triggered this run carries the same
  // agentRunId — a deliberate reuse of that column for the user's own
  // message, not just assistant/tool output (see PHASE2-PLAN.md §3 and
  // the comment on this same choice in the admission transaction below).
  const message = await prisma.message.findFirstOrThrow({
    where: { agentRunId: run.id, role: "USER" },
  });
  return {
    chatId: run.chatId,
    messageId: message.id,
    runId: run.id,
    triggerRunId: run.triggerRunId ?? "",
  };
}

/**
 * The admission + durable-dispatch entry point for sending a message.
 * One transaction creates the user Message and the AgentRun together,
 * then (once committed) dispatches the durable task. Idempotent on the
 * caller-supplied Idempotency-Key: a retried send with the same key
 * returns the original dispatch's result rather than creating a second
 * run, per project-docs/PHASE2-PLAN.md §Decision C and the "Additional
 * requirements" on duplicate dispatch.
 */
export async function sendTurn(
  userId: string,
  chatId: string,
  idempotencyKey: string,
  input: Pick<SendMessageRequest, "text"> & {
    attachmentIds?: string[];
    planMode?: boolean;
    interruptRunId?: string;
    /** REST tool execution: dispatched with the run; no model is called. */
    directTool?: { name: string; input: Record<string, unknown> };
  },
): Promise<SendMessageResponse> {
  await requireChatOwnership(userId, chatId);

  let agentRunId: string;
  let userMessageId: string;
  let interrupted: { id: string; triggerRunId: string | null } | null;
  try {
    const admitted = await prisma.$transaction(async (tx) => {
      let interruptedRun: { id: string; triggerRunId: string | null } | null = null;
      // Interrupt: the chat's active run is cancelled in the same
      // transaction that admits this message, so "one active run per chat"
      // holds throughout and a retried send (same Idempotency-Key) rolls
      // back both. A run that already finished is simply not cancelled.
      if (input.interruptRunId) {
        const target = await tx.agentRun.findFirst({ where: { id: input.interruptRunId, chatId } });
        if (!target) throw new NotFoundError("Agent run not found");
        if (await cancelActiveRunInTx(tx, target.id, INTERRUPTED_BY_USER)) {
          interruptedRun = { id: target.id, triggerRunId: target.triggerRunId };
        }
      }
      const agentRun = await tx.agentRun.create({
        data: { chatId, userId, idempotencyKey, status: "QUEUED", planMode: input.planMode ?? false },
      });
      const message = await tx.message.create({
        data: {
          chatId,
          userId,
          agentRunId: agentRun.id,
          role: "USER",
          status: "COMPLETE",
          content: [{ type: "text", text: input.text }],
        },
      });
      // After the AgentRun insert, so a retried send hits the idempotency
      // violation first instead of failing on already-attached files.
      await attachToMessage(tx, userId, chatId, message.id, input.attachmentIds ?? []);
      await tx.chat.update({
        where: { id: chatId },
        data: { lastMessageAt: message.createdAt },
      });
      return { agentRun, message, interruptedRun };
      // Also cancels an interrupted run: same options as every run transition.
    }, RUN_TRANSITION_TRANSACTION_OPTIONS);
    agentRunId = admitted.agentRun.id;
    userMessageId = admitted.message.id;
    interrupted = admitted.interruptedRun;
  } catch (error) {
    const index = violatedIndex(error);
    if (index === IDEMPOTENCY_KEY_INDEX) {
      // Same send, retried — not an error, return what already happened.
      return readExistingDispatch(userId, chatId, idempotencyKey);
    }
    if (index === ACTIVE_RUN_INDEX) {
      throw new ConflictError("A run is already active for this chat");
    }
    throw error;
  }

  if (interrupted) await cancelTriggerRunBestEffort(interrupted.triggerRunId, { agentRunId: interrupted.id, chatId });

  try {
    const handle = await runAgentTurn.trigger(
      { agentRunId, ...(input.directTool ? { directTool: input.directTool } : {}) },
      { idempotencyKey, idempotencyKeyTTL: "24h" },
    );
    const updated = await prisma.agentRun.update({
      where: { id: agentRunId },
      data: { triggerRunId: handle.id },
    });
    // A new chat's first message also gets a title — scheduled to run after
    // the response is sent (no query or dispatch on this path; never throws).
    if (!input.directTool) runAfterResponse("chat-title", () => maybeDispatchChatTitle(updated.chatId));
    return {
      chatId: updated.chatId,
      messageId: userMessageId,
      runId: updated.id,
      triggerRunId: handle.id,
    };
  } catch (error) {
    // The transaction committed but dispatch itself failed (network,
    // Trigger.dev outage) — fail closed and surface it clearly rather
    // than return a 202 for a run nothing will ever process.
    await prisma.agentRun.update({
      where: { id: agentRunId },
      data: {
        status: "FAILED",
        errorCode: "DISPATCH_FAILED",
        errorMessage: "Could not start the agent run",
        completedAt: new Date(),
      },
    });
    throw error;
  }
}

/**
 * Starts title generation only for an untitled chat whose first user message
 * this is — existing chats with history are never renamed, and a chat with a
 * manual title is skipped. Runs after the response (see runAfterResponse).
 * Best-effort: failures are logged, never thrown.
 */
export async function maybeDispatchChatTitle(chatId: string): Promise<void> {
  try {
    const chat = await prisma.chat.findUnique({ where: { id: chatId }, select: { title: true } });
    if (!chat || chat.title !== null) return;
    const userMessages = await prisma.message.count({ where: { chatId, role: "USER" } });
    if (userMessages !== 1) return;
    await dispatchChatTitle(chatId);
  } catch (error) {
    console.error("Chat title check failed", { chatId, error: error instanceof Error ? error.name : "UnknownError" });
  }
}
