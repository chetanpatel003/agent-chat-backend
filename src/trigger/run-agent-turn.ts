import { task } from "@trigger.dev/sdk";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import type { ToolInvocationStatus, AgentRunStatus } from "@/generated/prisma/enums";
import {
  callOpenRouter,
  OpenRouterAmbiguousError,
  OpenRouterDefiniteError,
  type ProviderMessage,
  type ProviderToolCall,
  type OpenRouterToolSpec,
  type OpenRouterTurnResult,
} from "@/providers/openrouter";
import { openTriggerTextStream, type OpenTextStream, type TextStreamSink } from "@/realtime/text-stream";
import {
  awaitWaitpoint,
  triggerWaitpointRuntime,
  WAITPOINT_EXPIRED_CODE,
  type WaitpointRuntime,
} from "@/services/waitpoint";
import type { PlanResolution } from "@/contracts/waitpoint";
import { createWebhookNotifier, type WebhookDispatcher, type WebhookNotifier } from "@/services/webhooks";
import { dispatchWebhook } from "./deliver-webhook";
import { buildConversationContext } from "@/providers/conversation-context";
import { PRODUCTION_TOOL_REGISTRY, toOpenRouterTools } from "@/tools/registry";
import { ProviderRunFailedError, ToolExecutionError, type ToolRegistry } from "@/tools/types";
import type { ContentBlock } from "@/contracts/message";
import { MagicaPollInconclusiveError } from "@/providers/magica";
import { PRODUCTION_SKILL_REGISTRY, listSkillMetadata } from "@/skills/registry";
import { buildSkillSystemPrompt } from "@/skills/prompt";
import type { SkillRegistry } from "@/skills/types";
import {
  ACTIVE_RUN_STATUSES,
  casAgentRunStatus,
  isAgentRunRecentlyActive,
  readAgentRunStatus,
  SkippedTransition,
  RUN_TRANSITION_TRANSACTION_OPTIONS,
  isRetryOfOwningRun,
  type GuardedTransitionResult,
  type TurnExecution,
} from "@/services/run-transitions";
import {
  publishRunEvent,
  createRunEventEmitter,
  lastPublishedSeq,
  type PublishRunEvent,
  type EmitRunEvent,
} from "@/realtime/publish-run-event";
import { archiveRunGeneratedAssets, isGeneratedMediaTool } from "@/services/generated-assets";
import { dispatchGeneratedAssetArchival } from "./archive-generated-assets";
import { isBillableTool, settleRunCredits, settleToolInvocationCreditsSafely } from "@/services/credit-settlement";
import { dispatchCreditSettlement } from "./settle-tool-credits";
import { persistReconciledOutcome } from "@/services/tool-reconciliation";

export type RunAgentTurnPayload = {
  agentRunId: string;
  /** A direct tool run (REST tool execution): one validated call, no model. */
  directTool?: { name: string; input: Record<string, unknown> };
};

/** What a finished turn records about model usage (all null for a direct tool run). */
type TurnUsage = { model: string | null; promptTokens: number | null; completionTokens: number | null };
const NO_MODEL_USAGE: TurnUsage = { model: null, promptTokens: null, completionTokens: null };

/** Trigger.dev-only capabilities, injected so tests run in-process. */
export type TurnRuntime = {
  openTextStream: OpenTextStream;
  waitpoints: WaitpointRuntime;
  /** Outbound lifecycle webhooks; defaults to the durable delivery task. */
  webhooks?: WebhookDispatcher;
};

const PRODUCTION_TURN_RUNTIME: TurnRuntime = {
  openTextStream: openTriggerTextStream,
  waitpoints: triggerWaitpointRuntime,
};

const TERMINAL_STATUSES: AgentRunStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];

// Model-call rounds, not individual tool calls within a round — a round
// can dispatch several tool calls at once. Generous enough for a real
// multi-step tool chain, small enough to bound cost/latency decisively
// rather than let a confused model loop indefinitely.
//
// Phase 3.1 (fixed, was a documented Phase 3 prerequisite through 2.5):
// on the *last* allowed round, a tool_calls response is never executed
// — see the `turn === MAX_TURNS - 1` branch below — since its result
// could never be sent back to the model anyway (the loop ends right
// after, via TURN_LIMIT_EXCEEDED). Each requested call is recorded
// CANCELLED instead of silently dropped.
const MAX_TURNS = 8;

/**
 * Every AgentRun status write below goes through the guarded CAS helper
 * in run-transitions.ts, not a plain `update()` — a terminal state (in
 * particular CANCELLED, written by the cancel route while this task may
 * still be mid-call) can never be overwritten by a write that assumed
 * the run was still active. A guard that affects zero rows means another
 * process already decided this run's fate; this function backs off
 * without writing or publishing anything further, returning the row's
 * *real* current status rather than guessing who won the race.
 */

async function markAmbiguous(agentRunId: string): Promise<GuardedTransitionResult> {
  return casAgentRunStatus(agentRunId, ACTIVE_RUN_STATUSES, {
    status: "FAILED",
    errorCode: "AMBIGUOUS_PROVIDER_OUTCOME",
    errorMessage:
      "The AI provider's response was lost before we could record it (a timeout or interruption during the request) — we cannot tell whether it completed. Send a new message to try again; nothing was duplicated or charged twice.",
    completedAt: new Date(),
  });
}

async function ambiguousOutcome(agentRunId: string, emit: EmitRunEvent) {
  const marked = await markAmbiguous(agentRunId);
  if (!marked.applied) {
    return { status: marked.currentStatus, skipped: true as const, ambiguous: false as const };
  }
  await emit({ type: "run_status", status: "FAILED", errorCode: "AMBIGUOUS_PROVIDER_OUTCOME" });
  return { status: "FAILED" as const, skipped: false as const, ambiguous: true as const };
}

/**
 * A clean, known failure — safe to mark the message FAILED too, unlike
 * the ambiguous case, because we genuinely know the attempt did not
 * produce a usable result. Both writes (Message, AgentRun) happen in one
 * transaction, each itself guarded: if the message is no longer PENDING
 * (another process — the cancel route — already finalized it), the
 * whole transaction aborts and neither write lands, rather than the
 * message staying terminal while AgentRun gets overwritten, or vice
 * versa.
 */
async function markDefiniteFailure(
  agentRunId: string,
  pendingMessageId: string,
  errorCode: string,
  errorMessage: string,
  content?: ContentBlock[],
  thinkingMs?: number,
): Promise<GuardedTransitionResult> {
  try {
    await prisma.$transaction(async (tx) => {
      const message = await tx.message.updateMany({
        where: { id: pendingMessageId, status: "PENDING" },
        data: {
          status: "FAILED",
          ...(content ? { content: content as Prisma.InputJsonValue } : {}),
          ...(thinkingMs !== undefined ? { thinkingMs } : {}),
        },
      });
      if (message.count === 0) throw new SkippedTransition();

      const run = await tx.agentRun.updateMany({
        where: { id: agentRunId, status: { in: ACTIVE_RUN_STATUSES } },
        data: { status: "FAILED", errorCode, errorMessage, completedAt: new Date() },
      });
      if (run.count === 0) throw new SkippedTransition();
    }, RUN_TRANSITION_TRANSACTION_OPTIONS);
    return { applied: true };
  } catch (error) {
    if (error instanceof SkippedTransition) {
      return { applied: false, currentStatus: await readAgentRunStatus(agentRunId) };
    }
    throw error;
  }
}

async function definiteFailureOutcome(
  agentRunId: string,
  pendingMessageId: string,
  errorCode: string,
  errorMessage: string,
  content: ContentBlock[],
  emit: EmitRunEvent,
  thinkingMs?: number,
) {
  const marked = await markDefiniteFailure(agentRunId, pendingMessageId, errorCode, errorMessage, content, thinkingMs);
  if (!marked.applied) {
    return { status: marked.currentStatus, skipped: true as const, ambiguous: false as const };
  }
  await emit({ type: "assistant_message", messageId: pendingMessageId, status: "FAILED" });
  await emit({ type: "run_status", status: "FAILED", errorCode });
  return { status: "FAILED" as const, skipped: false as const, ambiguous: false as const };
}

/** Same guarded-transaction shape as markDefiniteFailure, for the
 * success path: Message -> COMPLETE, Chat.lastMessageAt, AgentRun ->
 * COMPLETED, all-or-nothing, guarded by the message still being PENDING. */
async function finalizeSuccess(
  agentRunId: string,
  pendingMessageId: string,
  chatId: string,
  content: ContentBlock[],
  result: TurnUsage,
  thinkingMs?: number,
): Promise<GuardedTransitionResult> {
  try {
    await prisma.$transaction(async (tx) => {
      const message = await tx.message.updateMany({
        where: { id: pendingMessageId, status: "PENDING" },
        data: {
          status: "COMPLETE",
          content: content as Prisma.InputJsonValue,
          ...(thinkingMs !== undefined ? { thinkingMs } : {}),
        },
      });
      if (message.count === 0) throw new SkippedTransition();

      await tx.chat.update({ where: { id: chatId }, data: { lastMessageAt: new Date() } });

      const run = await tx.agentRun.updateMany({
        where: { id: agentRunId, status: { in: ACTIVE_RUN_STATUSES } },
        data: {
          status: "COMPLETED",
          model: result.model,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          completedAt: new Date(),
        },
      });
      if (run.count === 0) throw new SkippedTransition();
    }, RUN_TRANSITION_TRANSACTION_OPTIONS);
    return { applied: true };
  } catch (error) {
    if (error instanceof SkippedTransition) {
      return { applied: false, currentStatus: await readAgentRunStatus(agentRunId) };
    }
    throw error;
  }
}

async function successOutcome(
  agentRunId: string,
  pendingMessageId: string,
  chatId: string,
  content: ContentBlock[],
  result: TurnUsage,
  emit: EmitRunEvent,
  thinkingMs?: number,
) {
  const finalized = await finalizeSuccess(agentRunId, pendingMessageId, chatId, content, result, thinkingMs);
  if (!finalized.applied) {
    return { status: finalized.currentStatus, skipped: true as const, ambiguous: false as const };
  }
  await emit({ type: "assistant_message", messageId: pendingMessageId, status: "COMPLETE" });
  await emit({ type: "run_status", status: "COMPLETED" });
  return { status: "COMPLETED" as const, skipped: false as const, ambiguous: false as const };
}

// Same empirically-verified P2002 shape as send-turn.ts's
// ACTIVE_RUN_INDEX/IDEMPOTENCY_KEY_INDEX checks (decisions/0009): this
// driver-adapter client's meta for a raw-SQL partial index isn't the
// plain { target: string[] } shape standard guidance suggests.
const ASSISTANT_MESSAGE_INDEX = "Message_one_assistant_per_run";

function isDuplicateAssistantMessage(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const meta = error.meta as
    | { driverAdapterError?: { cause?: { constraint?: { index?: string } } } }
    | undefined;
  return meta?.driverAdapterError?.cause?.constraint?.index === ASSISTANT_MESSAGE_INDEX;
}

function toSafeInputRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { raw: value };
}

type ToolCallOutcome = {
  blocks: ContentBlock[];
  /** The `tool` role message fed back to the model on the next round. */
  providerMessage: ProviderMessage;
};

function buildToolCallOutcome(
  invocation: {
    id: string;
    status: ToolInvocationStatus;
    durationMs: number | null;
    creditsCharged: bigint | null;
  },
  toolCall: ProviderToolCall,
  rawInput: unknown,
  output: Record<string, unknown> | null,
  error: { code: string; message: string } | null,
): ToolCallOutcome {
  const blocks: ContentBlock[] = [
    {
      type: "tool_use",
      toolInvocationId: invocation.id,
      toolName: toolCall.function.name,
      status: invocation.status,
      input: toSafeInputRecord(rawInput),
    },
    {
      type: "tool_result",
      toolInvocationId: invocation.id,
      output,
      durationMs: invocation.durationMs,
      creditsCharged: invocation.creditsCharged !== null ? Number(invocation.creditsCharged) : null,
      error,
    },
  ];
  return {
    blocks,
    providerMessage: {
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify(error ? { error: error.message } : output ?? {}),
    },
  };
}

/**
 * Validates, persists (PENDING-before-execution), executes, and records
 * the outcome of one model-requested tool call. An unknown tool name or
 * input that fails the tool's own Zod schema never reaches `execute()` —
 * both still produce a real, auditable ToolInvocation row (FAILED), so
 * every tool_use block in a message always has a real invocation behind
 * it, and the model always gets a tool_result it can react to instead of
 * the turn silently dying. Emits tool_started/tool_completed/tool_failed
 * immediately after each corresponding persist — never before.
 */
async function runOneToolCall(params: {
  toolCall: ProviderToolCall;
  registry: ToolRegistry;
  agentRunId: string;
  userId: string;
  messageId: string;
  emit: EmitRunEvent;
  /** After a successful tool's terminal write (webhooks). */
  onCompleted?: (toolInvocationId: string, toolName: string) => Promise<void>;
}): Promise<ToolCallOutcome> {
  const { toolCall, registry, agentRunId, userId, messageId, emit, onCompleted } = params;
  const idempotencyKey = `${agentRunId}:${toolCall.id}`;

  let rawInput: unknown;
  let malformedArguments: string | null = null;
  try {
    rawInput = JSON.parse(toolCall.function.arguments);
  } catch (error) {
    malformedArguments = error instanceof Error ? error.message : "Invalid JSON";
    rawInput = toolCall.function.arguments;
  }

  const tool = registry.get(toolCall.function.name);
  if (!tool) {
    const invocation = await prisma.toolInvocation.create({
      data: {
        agentRunId,
        messageId,
        toolName: toolCall.function.name,
        idempotencyKey,
        input: rawInput as Prisma.InputJsonValue,
        status: "FAILED",
        errorCode: "UNKNOWN_TOOL",
        errorMessage: `No tool named "${toolCall.function.name}" is registered.`,
      },
    });
    await emit({
      type: "tool_failed",
      toolInvocationId: invocation.id,
      toolName: toolCall.function.name,
      errorCode: "UNKNOWN_TOOL",
    });
    return buildToolCallOutcome(invocation, toolCall, rawInput, null, {
      code: "UNKNOWN_TOOL",
      message: invocation.errorMessage!,
    });
  }

  if (malformedArguments) {
    const invocation = await prisma.toolInvocation.create({
      data: {
        agentRunId,
        messageId,
        toolName: tool.name,
        idempotencyKey,
        input: rawInput as Prisma.InputJsonValue,
        status: "FAILED",
        errorCode: "MALFORMED_ARGUMENTS",
        errorMessage: `Tool call arguments were not valid JSON: ${malformedArguments}`,
      },
    });
    await emit({
      type: "tool_failed",
      toolInvocationId: invocation.id,
      toolName: tool.name,
      errorCode: "MALFORMED_ARGUMENTS",
    });
    return buildToolCallOutcome(invocation, toolCall, rawInput, null, {
      code: "MALFORMED_ARGUMENTS",
      message: invocation.errorMessage!,
    });
  }

  const parsedInput = tool.inputSchema.safeParse(rawInput);
  if (!parsedInput.success) {
    const invocation = await prisma.toolInvocation.create({
      data: {
        agentRunId,
        messageId,
        toolName: tool.name,
        idempotencyKey,
        input: rawInput as Prisma.InputJsonValue,
        status: "FAILED",
        errorCode: "INVALID_INPUT",
        errorMessage: `Invalid input: ${parsedInput.error.message}`,
      },
    });
    await emit({
      type: "tool_failed",
      toolInvocationId: invocation.id,
      toolName: tool.name,
      errorCode: "INVALID_INPUT",
    });
    return buildToolCallOutcome(invocation, toolCall, rawInput, null, {
      code: "INVALID_INPUT",
      message: invocation.errorMessage!,
    });
  }

  // Persisted RUNNING before execute() is ever called — this row is the
  // durable "an attempt was made" marker tool-side, mirroring the
  // Message-level PENDING marker for model calls. Re-entry finds this
  // exact row if the process dies mid-execute.
  const invocation = await prisma.toolInvocation.create({
    data: {
      agentRunId,
      messageId,
      toolName: tool.name,
      idempotencyKey,
      input: parsedInput.data as Prisma.InputJsonValue,
      status: "RUNNING",
    },
  });
  await emit({ type: "tool_started", toolInvocationId: invocation.id, toolName: tool.name });

  // Execution and persistence are deliberately separated (Phase 3.1
  // hardening): this block ONLY decides the tool's own outcome — it
  // never writes to the database. A persistence failure (the single
  // `toolInvocation.update()` below) is a genuinely unexpected
  // infrastructure problem, not a tool-execution outcome, and must
  // never be caught here and mischaracterized as one — doing so
  // previously risked a *second* write attempt inside that same catch,
  // which could itself fail and escape uncaught, or could silently
  // overwrite an accurate EXECUTION_FAILED/INVALID_OUTPUT reason with a
  // misleading one describing a DB error instead. There is now exactly
  // one `toolInvocation.update()` call on every path, and if it throws,
  // it propagates uncaught — exactly the same principle already applied
  // to the OpenRouter call itself in the main loop below ("rethrow and
  // let Trigger.dev's retry policy + the re-entry/ambiguous-outcome
  // mechanism handle it").
  const startedAt = Date.now();
  let outcome:
    | { ok: true; output: unknown }
    | { ok: false; errorCode: string; errorMessage: string; creditUsed?: number };
  try {
    const rawOutput = await tool.execute(parsedInput.data, {
      agentRunId,
      userId,
      invocationId: invocation.id,
      // Best-effort UI progress: a failed publish must never fail (or
      // make ambiguous) a provider run that has already started.
      onProgress: (phase) =>
        emit({ type: "tool_progress", toolInvocationId: invocation.id, toolName: tool.name, phase }).catch((error: unknown) => {
          console.warn("tool_progress publish failed", {
            agentRunId,
            toolInvocationId: invocation.id,
            error: error instanceof Error ? error.name : "UnknownError",
          });
        }),
    });
    const parsedOutput = tool.outputSchema.safeParse(rawOutput);
    outcome = parsedOutput.success
      ? { ok: true, output: parsedOutput.data }
      : {
          ok: false,
          errorCode: "INVALID_OUTPUT",
          errorMessage: `Tool returned output that didn't match its declared schema: ${parsedOutput.error.message}`,
        };
  } catch (error) {
    // A Magica-backed tool's execute() throws this one specific type to
    // mean "still can't tell, leave the invocation exactly as it is" —
    // never a genuine execution failure. Rethrown here, uncaught by
    // this function, so it reaches the main loop's own handling
    // (below) rather than being persisted as FAILED — the invocation
    // stays RUNNING (with providerRunId intact, if one was already
    // persisted) for a later reconciliation attempt to pick up.
    if (error instanceof MagicaPollInconclusiveError) throw error;
    outcome = {
      ok: false,
      // A coded tool error (e.g. INSUFFICIENT_CREDITS) keeps its code; anything else is EXECUTION_FAILED as before.
      errorCode: error instanceof ToolExecutionError ? error.code : "EXECUTION_FAILED",
      errorMessage: error instanceof Error ? error.message : "Tool execution failed",
      creditUsed: error instanceof ProviderRunFailedError ? error.creditUsed : undefined,
    };
  }
  const durationMs = Date.now() - startedAt;

  if (outcome.ok) {
    const completed = await prisma.toolInvocation.update({
      where: { id: invocation.id },
      data: { status: "COMPLETED", output: outcome.output as Prisma.InputJsonValue, durationMs },
    });
    await emit({ type: "tool_completed", toolInvocationId: completed.id, toolName: tool.name, durationMs });
    await onCompleted?.(completed.id, tool.name);
    // After the provider outcome is durable: archival runs as its own
    // retried Trigger.dev task, independent of this run's liveness. Never
    // throws, never changes the invocation's outcome.
    if (isGeneratedMediaTool(tool.name)) await dispatchGeneratedAssetArchival(completed.id);
    return buildToolCallOutcome(
      await settledInvocation(completed),
      toolCall,
      rawInput,
      outcome.output as Record<string, unknown>,
      null,
    );
  }

  const failed = await prisma.toolInvocation.update({
    where: { id: invocation.id },
    data: {
      status: "FAILED",
      errorCode: outcome.errorCode,
      errorMessage: outcome.errorMessage,
      durationMs,
      // A failed/cancelled provider run may still have been charged: keep the reported raw usage.
      ...(outcome.creditUsed !== undefined ? { output: { creditUsed: outcome.creditUsed } } : {}),
    },
  });
  await emit({
    type: "tool_failed",
    toolInvocationId: failed.id,
    toolName: tool.name,
    durationMs,
    errorCode: outcome.errorCode,
  });
  return buildToolCallOutcome(await settledInvocation(failed), toolCall, rawInput, null, {
    code: outcome.errorCode,
    message: outcome.errorMessage,
  });
}

/** Settles a terminal invocation's provider usage (no-op for non-billable
 * tools, e.g. skills; OpenRouter is never billed) and returns the row with
 * its creditsCharged. Settlement failure never changes the tool outcome;
 * run recovery retries it. */
async function settledInvocation<T extends { id: string; toolName: string; creditsCharged: bigint | null }>(
  invocation: T,
): Promise<T> {
  // Non-billable tools (skills, fixtures) never touch the credit tables or the DB here.
  if (!isBillableTool(invocation.toolName)) return invocation;
  // Durable first (idempotent, retried, independent of this run's state), so a
  // crash or DB error after the terminal write cannot lose the charge; then an
  // inline attempt so the tool_result block can carry creditsCharged.
  await dispatchCreditSettlement(invocation.id);
  const result = await settleToolInvocationCreditsSafely(invocation.id);
  if (result?.status !== "settled") return invocation;
  return { ...invocation, creditsCharged: result.charged };
}

/**
 * Records one model-requested tool call as CANCELLED, without ever
 * calling `execute()` — used only for a call the model requests on the
 * *last* permitted round, whose result could never be sent back for
 * the model to use (there is no further round). Reuses the exact same
 * ToolInvocation/content-block vocabulary as an executed call
 * (`ToolInvocationStatus.CANCELLED` already exists in the schema) so
 * the model's unmet request is durably visible — a real, auditable row
 * and a `tool_use`/`tool_result` block pair — never silently dropped.
 */
async function recordTurnLimitCancellation(params: {
  toolCall: ProviderToolCall;
  agentRunId: string;
  messageId: string;
  emit: EmitRunEvent;
}): Promise<ToolCallOutcome> {
  const { toolCall, agentRunId, messageId, emit } = params;
  let rawInput: unknown;
  try {
    rawInput = JSON.parse(toolCall.function.arguments);
  } catch {
    rawInput = toolCall.function.arguments;
  }

  const invocation = await prisma.toolInvocation.create({
    data: {
      agentRunId,
      messageId,
      toolName: toolCall.function.name,
      idempotencyKey: `${agentRunId}:${toolCall.id}`,
      input: rawInput as Prisma.InputJsonValue,
      status: "CANCELLED",
      errorCode: "TURN_LIMIT_EXCEEDED",
      errorMessage:
        "The maximum number of turns was reached before this tool call could be executed; its result could never have been returned to the model, so it was never run.",
    },
  });
  await emit({
    type: "tool_failed",
    toolInvocationId: invocation.id,
    toolName: invocation.toolName,
    errorCode: "TURN_LIMIT_EXCEEDED",
  });
  return buildToolCallOutcome(invocation, toolCall, rawInput, null, {
    code: "TURN_LIMIT_EXCEEDED",
    message: invocation.errorMessage!,
  });
}

/**
 * The real turn logic, exported separately from the Trigger.dev task
 * wrapper so tests can call it directly — in-process, with the
 * OpenRouter adapter mocked — rather than needing a live dev worker for
 * every behavioral test. `pnpm trigger:dev` is still how this actually
 * runs in dev/prod; see run-agent-turn.test.ts for why both matter.
 *
 * `registry`, `publish`, and `skillRegistry` all default to the
 * production implementations (the tool registry — the two skill-
 * loading tools as of checkpoint 2.5, per Decision A's amendment; the
 * real Trigger.dev-metadata publisher; the real `agent-skills/`
 * discovery result) and are dependency-injected rather than module-
 * mocked — the same pattern established in checkpoint 2.3 for the tool
 * registry, extended in 2.4 to the publisher and now in 2.5 to the
 * skill registry, for the same reason each time: module-mocking
 * Trigger.dev's own SDK was found fragile in checkpoint 2.2 (a
 * `vi.spyOn` on the task silently failed to intercept a real call), and
 * tests should not be coupled to the real `agent-skills/` directory's
 * actual contents either.
 */
export async function executeAgentTurn(
  payload: RunAgentTurnPayload,
  registry: ToolRegistry = PRODUCTION_TOOL_REGISTRY,
  publish: PublishRunEvent = publishRunEvent,
  skillRegistry: SkillRegistry = PRODUCTION_SKILL_REGISTRY,
  runtime: TurnRuntime = PRODUCTION_TURN_RUNTIME,
  execution?: TurnExecution,
): Promise<TurnResult> {
  const hooks: TurnHooks = { notify: null };
  const result = await runAgentTurnOnce(payload, registry, publish, skillRegistry, runtime, execution, hooks);
  // Terminal outcomes this execution decided (never a skipped/backed-off one).
  if (hooks.notify && !result.skipped && (result.status === "COMPLETED" || result.status === "FAILED")) {
    const { errorCode } = await prisma.agentRun.findUniqueOrThrow({
      where: { id: payload.agentRunId },
      select: { errorCode: true },
    });
    await hooks.notify(result.status === "COMPLETED" ? "agent.completed" : "agent.failed", {
      status: result.status,
      errorCode,
    });
  }
  return result;
}

/** Per-execution hooks set once the run is loaded. */
type TurnHooks = { notify: WebhookNotifier | null };

async function runAgentTurnOnce(
  payload: RunAgentTurnPayload,
  registry: ToolRegistry,
  publish: PublishRunEvent,
  skillRegistry: SkillRegistry,
  runtime: TurnRuntime,
  execution: TurnExecution | undefined,
  hooks: TurnHooks,
): Promise<TurnResult> {
  const run = await prisma.agentRun.findUniqueOrThrow({
    where: { id: payload.agentRunId },
  });
  const emit = createRunEventEmitter(run.id, publish, lastPublishedSeq(run.id));

  // Terminal states are never reopened — this check runs before
  // anything else, so a late-arriving duplicate invocation (a Trigger.dev
  // retry racing a completed attempt, a cancellation that landed while
  // this exact attempt was in flight, or its own idempotencyKey not
  // being assumed infallible) can never overwrite a terminal AgentRun.
  if (TERMINAL_STATUSES.includes(run.status)) {
    return { status: run.status, skipped: true as const, ambiguous: false as const };
  }
  hooks.notify = await createWebhookNotifier(runtime.webhooks ?? dispatchWebhook, run);

  // Tool-call re-entry, checked before the plain-message check below
  // because it's more specific and, for a tool backed by a real external
  // run (Magica, Phase 3), genuinely actionable: `reconcile()` can poll
  // the provider's own run instead of guessing. Nothing in Phase 2 has a
  // real async tool to safely resume the loop against afterward (per
  // PHASE2-PLAN.md), so this checkpoint proves the handler is dispatched
  // — not a full resume-and-continue path — and still ends the run
  // FAILED/AMBIGUOUS either way. The ToolInvocation itself is left
  // RUNNING as evidence, same principle as the Message-PENDING marker.
  //
  // Phase 3.1: before concluding "stale," check whether this AgentRun
  // has been written to recently (`isAgentRunRecentlyActive`) — a
  // genuinely concurrent sibling execution (or this very run, moments
  // into its own work) looks identical to a crashed one at this exact
  // instant, and guessing wrong here used to be able to flip an
  // in-progress run to FAILED out from under its own legitimate
  // completion (see API_CONTRACTS.md, checkpoint 2.4's "known, accepted
  // trade-off" — closed by this check, not assumed away). Backing off
  // writes nothing and lets whoever is actually alive finish.
  // A retry attempt of the owning Trigger.dev run proves the previous
  // attempt has ended (attempts never overlap), so its leftovers are
  // abandoned and are recovered now, not deferred to the time-based gate —
  // which, after a crash within the last 120 s, would otherwise skip,
  // complete this attempt successfully, and strand the run (decisions/0016).
  const previousAttemptEnded = isRetryOfOwningRun(run, execution);

  const staleToolInvocation = await prisma.toolInvocation.findFirst({
    where: { agentRunId: run.id, status: "RUNNING" },
  });
  if (staleToolInvocation) {
    if (!previousAttemptEnded && (await isAgentRunRecentlyActive(run.id))) {
      return { status: await readAgentRunStatus(run.id), skipped: true as const, ambiguous: false as const };
    }
    const tool = registry.get(staleToolInvocation.toolName);
    if (tool?.reconcile) {
      // The result is now captured and persisted — previously it was
      // discarded unconditionally (see API_CONTRACTS.md's checkpoint
      // 3.2 note). Any throw (including MagicaPollInconclusiveError,
      // but treated identically for any other error too, same
      // conservative swallow as before) means "still can't tell" —
      // the invocation is left exactly as it is, guarded updates below
      // never run. Resolving to "completed" or "failed" persists that
      // outcome onto the ToolInvocation — guarded so a terminal row is
      // never overwritten — but the AgentRun still ends ambiguous
      // either way: resuming the OpenRouter conversation with the
      // recovered result is explicitly out of this checkpoint's scope.
      const reconciled = await tool
        .reconcile({ id: staleToolInvocation.id, providerRunId: staleToolInvocation.providerRunId })
        .catch(() => null);
      if (reconciled) await persistReconciledOutcome(staleToolInvocation.id, reconciled);
    }
    // Archive outputs of this run's COMPLETED invocations (including one
    // just reconciled) from their stored output — never a new Magica run.
    await archiveRunGeneratedAssets(run.id);
    await settleRunCredits(run.id);
    return ambiguousOutcome(run.id, emit);
  }

  // Re-entry ambiguous-outcome detection. A PENDING assistant message
  // for this run means a previous execution got far enough to dispatch
  // a provider request but never came back to record the outcome —
  // crashed, got killed for exceeding maxDuration, or the process died
  // mid-flight. This runs before any new work, so it can't be bypassed
  // by a retry racing ahead of it, and it never issues a second
  // OpenRouter request for an attempt whose outcome is unknown.
  //
  // Same liveness check as above, same reason: this is the exact
  // checkpoint where the checkpoint-2.4 concurrency test's race was
  // traced to — a sibling's own still-PENDING message looked
  // indistinguishable from a crashed one.
  const stalePending = await prisma.message.findFirst({
    where: { agentRunId: run.id, role: "ASSISTANT", status: "PENDING" },
  });
  if (stalePending) {
    if (!previousAttemptEnded && (await isAgentRunRecentlyActive(run.id))) {
      return { status: await readAgentRunStatus(run.id), skipped: true as const, ambiguous: false as const };
    }
    // A crash after a tool completed but before its outputs were archived/settled.
    await archiveRunGeneratedAssets(run.id);
    await settleRunCredits(run.id);
    return ambiguousOutcome(run.id, emit);
  }

  // Guarded: a cancellation could have landed between the terminal check
  // above and here. QUEUED is the normal fresh-start case; RUNNING is
  // allowed too for the narrow re-entry window where a previous attempt
  // marked RUNNING but crashed before inserting any PENDING message —
  // safe to just continue, not a reason to restart the whole run.
  const toRunning = await casAgentRunStatus(run.id, ["QUEUED", "RUNNING"], {
    status: "RUNNING",
    startedAt: run.startedAt ?? new Date(),
  });
  if (!toRunning.applied) {
    return { status: toRunning.currentStatus, skipped: true as const, ambiguous: false as const };
  }
  await emit({ type: "run_status", status: "RUNNING" });
  await hooks.notify?.("agent.started", { status: "RUNNING" });

  // The skill system prompt is synthesized fresh on every entry (never
  // persisted as a Message) from the injected skill registry's current
  // metadata — same "rebuild from source, nothing cached in process
  // memory" principle buildConversationContext already follows for chat
  // history. It carries only name+description for every registered
  // skill, never a skill's body; a skill's own instructions only reach
  // the model when load_skill actually returns them, as an ordinary
  // tool result already flowing back through `turnMessages` below.
  const skillSystemPrompt: ProviderMessage = {
    role: "system",
    content: buildSkillSystemPrompt(listSkillMetadata(skillRegistry)),
  };
  const history = [skillSystemPrompt, ...(await buildConversationContext(run.chatId, run.userId))];

  // Committed before the provider call — this row is "persist the
  // request/attempt state before making the call." It accumulates every
  // block produced across the whole tool-calling loop below (not one row
  // per model-call round) — matching the product's one-bubble-per-turn
  // rendering, and matching Decision C's ambiguity granularity: any
  // crash anywhere in the loop leaves this same row at PENDING.
  //
  // The partial unique index Message_one_assistant_per_run is the real
  // mutex against two truly concurrent executeAgentTurn() calls for the
  // same run: both can pass every read-check above (neither has
  // inserted anything yet), but only one of these inserts can succeed.
  // The loser's P2002 here is "a duplicate concurrent execution," not an
  // error — it exits without touching AgentRun state, same as any other
  // guard loss, because the winner owns this run now.
  let pendingMessage;
  try {
    pendingMessage = await prisma.message.create({
      data: {
        chatId: run.chatId,
        userId: run.userId,
        agentRunId: run.id,
        role: "ASSISTANT",
        status: "PENDING",
        content: [],
      },
    });
  } catch (error) {
    if (isDuplicateAssistantMessage(error)) {
      const current = await readAgentRunStatus(run.id);
      return { status: current, skipped: true as const, ambiguous: false as const };
    }
    throw error;
  }

  const state: TurnState = {
    runId: run.id,
    chatId: run.chatId,
    messageId: pendingMessage.id,
    emit,
    textStream: runtime.openTextStream(),
    content: [],
    thinkingMs: 0,
  };
  try {
    if (payload.directTool) {
      return await runDirectTool({ run, state, registry, call: payload.directTool, notify: hooks.notify });
    }
    return await runTurnLoop({ run, state, history, registry, runtime, notify: hooks.notify });
  } finally {
    await state.textStream.close();
  }
}

type TurnResult = { status: AgentRunStatus; skipped: boolean; ambiguous: boolean };

/** Everything one execution of a turn accumulates into its pending message. */
type TurnState = {
  runId: string;
  chatId: string;
  messageId: string;
  emit: EmitRunEvent;
  textStream: TextStreamSink;
  /** Every block produced so far, in order (persisted into the pending message). */
  content: ContentBlock[];
  /** Total time-to-first-output across rounds (timing only, never reasoning). */
  thinkingMs: number;
};

/** Thrown from the text callback when the pending message is no longer ours. */
class RunNoLongerActive extends Error {}

/** Streamed text reaches PostgreSQL at most this often while a round streams. */
const PARTIAL_TEXT_FLUSH_MS = 1000;

/** Content-only, guarded on the message still being PENDING: false means the
 * run was cancelled/interrupted/finalized elsewhere. */
async function persistPending(state: TurnState, content: ContentBlock[]): Promise<boolean> {
  const updated = await prisma.message.updateMany({
    where: { id: state.messageId, status: "PENDING" },
    data: { content: content as Prisma.InputJsonValue, thinkingMs: state.thinkingMs },
  });
  return updated.count > 0;
}

/** Stop/interrupt keeps the message's content; text streamed since the last
 * flush is added to the CANCELLED message (never to a FAILED/COMPLETE one). */
async function preserveCancelledText(state: TurnState, text: string | null) {
  if (!text?.trim()) return;
  await prisma.message.updateMany({
    where: { id: state.messageId, status: "CANCELLED" },
    data: { content: [...state.content, { type: "text", text }] as Prisma.InputJsonValue, thinkingMs: state.thinkingMs },
  });
}

async function skippedResult(runId: string): Promise<TurnResult> {
  return { status: await readAgentRunStatus(runId), skipped: true, ambiguous: false };
}

/**
 * One model call, streamed: visible text deltas go to the realtime text
 * stream and (throttled) into the pending message; thinking time is the
 * time to the first output. Failure outcomes keep any partial text.
 */
async function modelRound(
  state: TurnState,
  round: number,
  messages: ProviderMessage[],
  tools: OpenRouterToolSpec[],
): Promise<{ ok: true; result: OpenRouterTurnResult } | { ok: false; done: TurnResult }> {
  await state.emit({ type: "step", step: "thinking", round });
  const startedAt = Date.now();
  let thinkingRecorded = false;
  const recordThinking = async () => {
    if (thinkingRecorded) return;
    thinkingRecorded = true;
    const durationMs = Date.now() - startedAt;
    state.thinkingMs += durationMs;
    await state.emit({ type: "thinking_completed", round, durationMs });
  };

  let partial = "";
  let lastFlush = Date.now();
  let result: OpenRouterTurnResult;
  try {
    result = await callOpenRouter(messages, tools, {
      onTextDelta: async (delta) => {
        if (!thinkingRecorded) {
          await recordThinking();
          await state.emit({ type: "step", step: "responding", round });
        }
        partial += delta;
        state.textStream.write({ messageId: state.messageId, round, delta });
        if (Date.now() - lastFlush >= PARTIAL_TEXT_FLUSH_MS) {
          lastFlush = Date.now();
          if (!(await persistPending(state, [...state.content, { type: "text", text: partial }]))) {
            throw new RunNoLongerActive();
          }
        }
      },
    });
  } catch (error) {
    if (error instanceof RunNoLongerActive) {
      await preserveCancelledText(state, partial);
      return { ok: false, done: await skippedResult(state.runId) };
    }
    if (error instanceof OpenRouterAmbiguousError) {
      // Logged before any database write, so the outcome is diagnosable even
      // if persisting it fails. Error class only: no provider text or prompt.
      console.warn("Provider call outcome unknown", {
        agentRunId: state.runId,
        messageId: state.messageId,
        round,
        error: error.name,
      });
      return { ok: false, done: await ambiguousOutcome(state.runId, state.emit) };
    }
    if (error instanceof OpenRouterDefiniteError) {
      await recordThinking();
      const kept = error.partialText ?? (partial.trim() || null);
      // Logged before persistence (see above). The code is our own enum;
      // provider messages and partial text are never logged — only a length.
      console.warn("Provider call failed", {
        agentRunId: state.runId,
        messageId: state.messageId,
        round,
        code: error.code,
        partialTextChars: kept?.length ?? 0,
      });
      const content: ContentBlock[] = kept ? [...state.content, { type: "text", text: kept }] : state.content;
      return {
        ok: false,
        done: await definiteFailureOutcome(
          state.runId,
          state.messageId,
          error.code,
          error.message,
          content,
          state.emit,
          state.thinkingMs,
        ),
      };
    }
    // Genuinely unexpected (e.g. a DB write failure) — rethrow and let
    // Trigger.dev's own retry policy handle it. The next attempt's
    // re-entry check finds this same PENDING row and treats it as
    // ambiguous rather than calling OpenRouter again.
    throw error;
  }
  await recordThinking();

  // Checked immediately after the provider call returns — the critical
  // window: a cancel could have landed while this call was in flight.
  const afterCall = await readAgentRunStatus(state.runId);
  if (afterCall !== "RUNNING") {
    await preserveCancelledText(state, result.text);
    return { ok: false, done: { status: afterCall, skipped: true, ambiguous: false } };
  }
  return { ok: true, result };
}

const PLAN_MODE_INSTRUCTION =
  "Plan mode is on. Do not call any tools and do not carry out the request yet. Reply only with a short, " +
  "numbered plan of the steps you would take, naming any tools you would use. The user will approve or " +
  "reject the plan before you act.";

/**
 * Plan mode: round 0 proposes a plan (no tools offered), then the run
 * waits at a PLAN waitpoint. Approve → the plan and approval join the
 * conversation and the normal loop continues; reject → the turn completes
 * with the plan as its answer; expiry → the run stops (content kept).
 */
async function planPhase(params: {
  run: { id: string; chatId: string };
  state: TurnState;
  history: ProviderMessage[];
  runtime: TurnRuntime;
}): Promise<{ done: TurnResult } | { approved: ProviderMessage[] }> {
  const { run, state, history, runtime } = params;
  await prisma.agentRun.update({ where: { id: run.id }, data: { turnCount: 1 } });
  const [systemPrompt, ...conversation] = history;
  const round = await modelRound(state, 0, [systemPrompt, { role: "system", content: PLAN_MODE_INSTRUCTION }, ...conversation], []);
  if (!round.ok) return { done: round.done };

  const plan = round.result.text;
  if (!plan) {
    return {
      done: await definiteFailureOutcome(
        run.id,
        state.messageId,
        "EMPTY_PLAN",
        "The model didn't propose a plan. Send the message again, or turn plan mode off.",
        state.content,
        state.emit,
        state.thinkingMs,
      ),
    };
  }
  state.content.push({ type: "text", text: plan });
  if (!(await persistPending(state, state.content))) return { done: await skippedResult(run.id) };

  const outcome = await awaitWaitpoint({
    agentRunId: run.id,
    type: "PLAN",
    round: 0,
    payload: { plan },
    runtime: runtime.waitpoints,
    emit: state.emit,
  });
  if (outcome.status === "inactive") return { done: await skippedResult(run.id) };
  if (outcome.status === "expired") {
    await state.emit({ type: "assistant_message", messageId: state.messageId, status: "CANCELLED" });
    await state.emit({ type: "run_status", status: "CANCELLED", errorCode: WAITPOINT_EXPIRED_CODE });
    return { done: { status: "CANCELLED", skipped: false, ambiguous: false } };
  }
  const { decision, note } = outcome.resolution as PlanResolution;
  if (decision === "reject") {
    return {
      done: await successOutcome(run.id, state.messageId, run.chatId, state.content, round.result, state.emit, state.thinkingMs),
    };
  }
  return {
    approved: [
      { role: "assistant", content: plan },
      { role: "user", content: `The plan is approved. Carry it out now.${note ? ` Note from the user: ${note}` : ""}` },
    ],
  };
}

/**
 * REST tool execution: the one requested call goes through exactly the same
 * path as a model-requested call (registry, input schema, credit admission,
 * persistence, settlement, archival, webhooks), and the turn ends with its
 * outcome. No model is called.
 */
async function runDirectTool(params: {
  run: { id: string; chatId: string; userId: string };
  state: TurnState;
  registry: ToolRegistry;
  call: { name: string; input: Record<string, unknown> };
  notify: WebhookNotifier | null;
}): Promise<TurnResult> {
  const { run, state, registry, call, notify } = params;
  await prisma.agentRun.update({ where: { id: run.id }, data: { turnCount: 1 } });
  await state.emit({ type: "step", step: "responding", round: 0 });
  let outcome: ToolCallOutcome;
  try {
    outcome = await runOneToolCall({
      toolCall: { id: `direct_${run.id}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } },
      registry,
      agentRunId: run.id,
      userId: run.userId,
      messageId: state.messageId,
      emit: state.emit,
      onCompleted: notify
        ? (invocationId, toolName) => notify("tool.completed", { status: "COMPLETED", toolInvocationId: invocationId, toolName })
        : undefined,
    });
  } catch (error) {
    // Still polling past its budget: left RUNNING for reconciliation, as in the loop.
    if (error instanceof MagicaPollInconclusiveError) return skippedResult(run.id);
    throw error;
  }
  state.content.push(...outcome.blocks);
  const result = outcome.blocks.find((b) => b.type === "tool_result");
  const error = result?.type === "tool_result" ? result.error : null;
  if (error) {
    return definiteFailureOutcome(run.id, state.messageId, error.code, error.message, state.content, state.emit, 0);
  }
  return successOutcome(run.id, state.messageId, run.chatId, state.content, NO_MODEL_USAGE, state.emit, 0);
}

/** Non-billable tool calls that run concurrently within one group. */
const PARALLEL_TOOL_LIMIT = 3;

/**
 * Parallel-eligible: not billable, and not backed by an external provider
 * run (a tool with `reconcile`, i.e. every Magica tool). Billable calls
 * stay sequential because credit admission is a balance check, not a
 * reservation: two concurrent billable calls could each pass it against
 * the same balance and together overspend it.
 */
function isParallelEligible(toolName: string, registry: ToolRegistry): boolean {
  return !isBillableTool(toolName) && !registry.get(toolName)?.reconcile;
}

/** Consecutive parallel-eligible calls form one group; every other call is
 * its own group. Group order, and order within a group, is the model's. */
function groupToolCalls(calls: ProviderToolCall[], registry: ToolRegistry): ProviderToolCall[][] {
  const groups: ProviderToolCall[][] = [];
  for (const call of calls) {
    const last = groups.at(-1);
    const eligible = isParallelEligible(call.function.name, registry);
    if (eligible && last && isParallelEligible(last[0].function.name, registry)) last.push(call);
    else groups.push([call]);
  }
  return groups;
}

/** Runs `fn` over `items` with at most `limit` in flight; results in input order. */
async function settleWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function runTurnLoop(params: {
  run: { id: string; chatId: string; userId: string; planMode: boolean };
  state: TurnState;
  history: ProviderMessage[];
  registry: ToolRegistry;
  runtime: TurnRuntime;
  notify: WebhookNotifier | null;
}): Promise<TurnResult> {
  const { run, state, history, registry, runtime, notify } = params;
  const { content, emit } = state;
  const providerTools = toOpenRouterTools(registry);
  // The in-progress turn's own assistant-tool_calls/tool-result messages,
  // appended to `history` on each call — never derived from the database.
  const turnMessages: ProviderMessage[] = [];

  let firstRound = 0;
  if (run.planMode) {
    const planned = await planPhase({ run, state, history, runtime });
    if ("done" in planned) return planned.done;
    turnMessages.push(...planned.approved);
    firstRound = 1;
  }

  for (let turn = firstRound; turn < MAX_TURNS; turn++) {
    // Checked between loop iterations: a cancel arriving while idle
    // between rounds is caught here, before wasting another provider
    // call that would just be discarded anyway.
    const beforeRound = await readAgentRunStatus(run.id);
    if (beforeRound !== "RUNNING") {
      return { status: beforeRound, skipped: true, ambiguous: false };
    }

    await prisma.agentRun.update({ where: { id: run.id }, data: { turnCount: turn + 1 } });

    const round = await modelRound(state, turn, [...history, ...turnMessages], providerTools);
    if (!round.ok) return round.done;
    const result = round.result;

    // Pushed before branching on tool_calls so user-visible `content`
    // sent alongside a tool request is kept, not just the final answer.
    if (result.text) content.push({ type: "text", text: result.text });

    if (!result.toolCalls) {
      return successOutcome(run.id, state.messageId, run.chatId, content, result, emit, state.thinkingMs);
    }

    // The *last* permitted round: a tool_calls response here can never
    // be returned to the model (there is no round `turn + 1` to feed
    // the result back into) — executing it would spend real work (real
    // external-provider credits) for an outcome nothing can ever use.
    // Each requested call is recorded CANCELLED instead of executed — a
    // real, auditable ToolInvocation + content-block pair, never silently
    // discarded — and the run ends via TURN_LIMIT_EXCEEDED.
    if (turn === MAX_TURNS - 1) {
      for (const toolCall of result.toolCalls) {
        const outcome = await recordTurnLimitCancellation({
          toolCall,
          agentRunId: run.id,
          messageId: state.messageId,
          emit,
        });
        content.push(...outcome.blocks);
      }
      await persistPending(state, content);
      return definiteFailureOutcome(
        run.id,
        state.messageId,
        "TURN_LIMIT_EXCEEDED",
        "The agent requested additional tool calls on the final permitted turn; they could not be executed because their results could never have been returned to the model. See the accompanying tool_use/tool_result blocks.",
        content,
        emit,
        state.thinkingMs,
      );
    }

    // The model asked for one or more tools. Its own tool-calling
    // message must be recorded before anything else, exactly as
    // OpenRouter's protocol requires: an assistant tool_calls message is
    // immediately followed by one tool-role message per call.
    turnMessages.push({ role: "assistant", content: result.text, tool_calls: result.toolCalls });

    // Independent non-billable calls run in parallel (bounded); billable
    // calls run one at a time. Results, tool messages and content blocks
    // are always appended in the model's call order, never completion
    // order, so ordering is deterministic. Each invocation keeps its own
    // row, idempotency key and exactly-once settlement.
    for (const group of groupToolCalls(result.toolCalls, registry)) {
      // Checked immediately before each group of tool executions.
      const beforeTool = await readAgentRunStatus(run.id);
      if (beforeTool !== "RUNNING") {
        return { status: beforeTool, skipped: true, ambiguous: false };
      }

      const settled = await settleWithConcurrency(group, PARALLEL_TOOL_LIMIT, (toolCall) =>
        runOneToolCall({
          toolCall,
          registry,
          agentRunId: run.id,
          userId: run.userId,
          messageId: state.messageId,
          emit,
          onCompleted: notify
            ? (invocationId, toolName) =>
                notify("tool.completed", { status: "COMPLETED", toolInvocationId: invocationId, toolName })
            : undefined,
        }),
      );
      let failure: { reason: unknown } | null = null;
      let appended = false;
      for (const outcome of settled) {
        if (outcome.status === "fulfilled") {
          content.push(...outcome.value.blocks);
          turnMessages.push(outcome.value.providerMessage);
          appended = true;
        } else failure ??= { reason: outcome.reason };
      }

      // Persisted after each group, so a cancellation detected partway
      // through a round never loses an already-finished result.
      // Content-only; never touches status (disjoint columns, no guard).
      if (appended) {
        await prisma.message.update({
          where: { id: state.messageId },
          data: { content: content as Prisma.InputJsonValue, thinkingMs: state.thinkingMs },
        });
      }

      if (failure) {
        // A Magica-backed tool's execute() exhausted its own polling
        // budget (or the run was cancelled mid-poll) — genuinely still
        // can't tell the outcome. The ToolInvocation is left exactly
        // as runOneToolCall left it (RUNNING, providerRunId intact if
        // persisted) — back off without writing anything further; a
        // later re-entry's reconcile() picks it up.
        if (failure.reason instanceof MagicaPollInconclusiveError) return skippedResult(run.id);
        throw failure.reason;
      }
    }
  }

  // Bounded loop exhausted without a final answer. A known, definite
  // outcome (we chose to stop) — not ambiguous.
  return definiteFailureOutcome(
    run.id,
    state.messageId,
    "TURN_LIMIT_EXCEEDED",
    "The agent did not produce a final answer within the maximum number of turns.",
    content,
    emit,
    state.thinkingMs,
  );
}

export const runAgentTurn = task({
  id: "run-agent-turn",
  // Wrapped, not passed directly: Trigger.dev calls `run(payload, ctx)`
  // with its own second argument, which would otherwise land in
  // executeAgentTurn's `registry` parameter and silently break the
  // default. Production passes only the payload and the execution, so the
  // production registry, publisher, skill registry and runtime apply.
  // `ctx` identifies this attempt, which lets re-entry tell a retry of this
  // run (previous attempt certainly ended) from a concurrent execution.
  run: (payload: RunAgentTurnPayload, { ctx }) =>
    executeAgentTurn(payload, undefined, undefined, undefined, undefined, {
      triggerRunId: ctx.run.id,
      attempt: ctx.attempt.number,
    }),
});
