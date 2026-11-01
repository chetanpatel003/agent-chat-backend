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
  type OpenRouterTurnResult,
} from "@/providers/openrouter";
import { buildConversationContext } from "@/providers/conversation-context";
import { PRODUCTION_TOOL_REGISTRY, toOpenRouterTools } from "@/tools/registry";
import type { ToolRegistry } from "@/tools/types";
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
  type GuardedTransitionResult,
} from "@/services/run-transitions";
import {
  publishRunEvent,
  createRunEventEmitter,
  type PublishRunEvent,
  type EmitRunEvent,
} from "@/realtime/publish-run-event";

export type RunAgentTurnPayload = {
  agentRunId: string;
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
): Promise<GuardedTransitionResult> {
  try {
    await prisma.$transaction(async (tx) => {
      const message = await tx.message.updateMany({
        where: { id: pendingMessageId, status: "PENDING" },
        data: {
          status: "FAILED",
          ...(content ? { content: content as Prisma.InputJsonValue } : {}),
        },
      });
      if (message.count === 0) throw new SkippedTransition();

      const run = await tx.agentRun.updateMany({
        where: { id: agentRunId, status: { in: ACTIVE_RUN_STATUSES } },
        data: { status: "FAILED", errorCode, errorMessage, completedAt: new Date() },
      });
      if (run.count === 0) throw new SkippedTransition();
    });
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
) {
  const marked = await markDefiniteFailure(agentRunId, pendingMessageId, errorCode, errorMessage, content);
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
  result: OpenRouterTurnResult,
): Promise<GuardedTransitionResult> {
  try {
    await prisma.$transaction(async (tx) => {
      const message = await tx.message.updateMany({
        where: { id: pendingMessageId, status: "PENDING" },
        data: { status: "COMPLETE", content: content as Prisma.InputJsonValue },
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
    });
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
  result: OpenRouterTurnResult,
  emit: EmitRunEvent,
) {
  const finalized = await finalizeSuccess(agentRunId, pendingMessageId, chatId, content, result);
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
}): Promise<ToolCallOutcome> {
  const { toolCall, registry, agentRunId, userId, messageId, emit } = params;
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
  let outcome: { ok: true; output: unknown } | { ok: false; errorCode: string; errorMessage: string };
  try {
    const rawOutput = await tool.execute(parsedInput.data, { agentRunId, userId, invocationId: invocation.id });
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
      errorCode: "EXECUTION_FAILED",
      errorMessage: error instanceof Error ? error.message : "Tool execution failed",
    };
  }
  const durationMs = Date.now() - startedAt;

  if (outcome.ok) {
    const completed = await prisma.toolInvocation.update({
      where: { id: invocation.id },
      data: { status: "COMPLETED", output: outcome.output as Prisma.InputJsonValue, durationMs },
    });
    await emit({ type: "tool_completed", toolInvocationId: completed.id, toolName: tool.name, durationMs });
    return buildToolCallOutcome(completed, toolCall, rawInput, outcome.output as Record<string, unknown>, null);
  }

  const failed = await prisma.toolInvocation.update({
    where: { id: invocation.id },
    data: { status: "FAILED", errorCode: outcome.errorCode, errorMessage: outcome.errorMessage, durationMs },
  });
  await emit({
    type: "tool_failed",
    toolInvocationId: failed.id,
    toolName: tool.name,
    durationMs,
    errorCode: outcome.errorCode,
  });
  return buildToolCallOutcome(failed, toolCall, rawInput, null, {
    code: outcome.errorCode,
    message: outcome.errorMessage,
  });
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
) {
  const run = await prisma.agentRun.findUniqueOrThrow({
    where: { id: payload.agentRunId },
  });
  const emit = createRunEventEmitter(run.id, publish);

  // Terminal states are never reopened — this check runs before
  // anything else, so a late-arriving duplicate invocation (a Trigger.dev
  // retry racing a completed attempt, a cancellation that landed while
  // this exact attempt was in flight, or its own idempotencyKey not
  // being assumed infallible) can never overwrite a terminal AgentRun.
  if (TERMINAL_STATUSES.includes(run.status)) {
    return { status: run.status, skipped: true as const, ambiguous: false as const };
  }

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
  const staleToolInvocation = await prisma.toolInvocation.findFirst({
    where: { agentRunId: run.id, status: "RUNNING" },
  });
  if (staleToolInvocation) {
    if (await isAgentRunRecentlyActive(run.id)) {
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
      if (reconciled?.status === "completed") {
        await prisma.toolInvocation.updateMany({
          where: { id: staleToolInvocation.id, status: "RUNNING" },
          data: { status: "COMPLETED", output: reconciled.output as Prisma.InputJsonValue },
        });
      } else if (reconciled?.status === "failed") {
        await prisma.toolInvocation.updateMany({
          where: { id: staleToolInvocation.id, status: "RUNNING" },
          data: { status: "FAILED", errorCode: reconciled.errorCode, errorMessage: reconciled.errorMessage },
        });
      }
    }
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
    if (await isAgentRunRecentlyActive(run.id)) {
      return { status: await readAgentRunStatus(run.id), skipped: true as const, ambiguous: false as const };
    }
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
  const history = [skillSystemPrompt, ...(await buildConversationContext(run.chatId))];

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

  const providerTools = toOpenRouterTools(registry);
  const content: ContentBlock[] = [];
  // The in-progress turn's own assistant-tool_calls/tool-result messages,
  // appended to `history` on each call — never derived from the
  // database, since tools aren't exposed to real conversations yet and
  // reconstructing this sequence across turns isn't needed in Phase 2.
  const turnMessages: ProviderMessage[] = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Checked between loop iterations: a cancel arriving while idle
    // between rounds is caught here, before wasting another provider
    // call that would just be discarded anyway.
    const beforeRound = await readAgentRunStatus(run.id);
    if (beforeRound !== "RUNNING") {
      return { status: beforeRound, skipped: true as const, ambiguous: false as const };
    }

    await prisma.agentRun.update({ where: { id: run.id }, data: { turnCount: turn + 1 } });

    let result;
    try {
      result = await callOpenRouter([...history, ...turnMessages], providerTools);
    } catch (error) {
      if (error instanceof OpenRouterAmbiguousError) {
        return ambiguousOutcome(run.id, emit);
      }
      if (error instanceof OpenRouterDefiniteError) {
        return definiteFailureOutcome(run.id, pendingMessage.id, error.code, error.message, content, emit);
      }
      // Genuinely unexpected (e.g. a DB write failure) — rethrow and let
      // Trigger.dev's own retry policy handle it. The next attempt's
      // re-entry check above will find this same PENDING row and treat
      // it as ambiguous rather than calling OpenRouter again.
      throw error;
    }

    // Checked immediately after the provider call returns — the
    // critical window: a cancel could have landed in the database while
    // this call was in flight. Caught here, before any write assumes
    // the run is still ours to finalize.
    const afterCall = await readAgentRunStatus(run.id);
    if (afterCall !== "RUNNING") {
      return { status: afterCall, skipped: true as const, ambiguous: false as const };
    }

    // Pushed unconditionally, before branching on tool_calls: any
    // narration the model gives alongside a tool request ("Let me check
    // that...") is captured too, not just the final answer's text.
    if (result.reasoning) content.push({ type: "thinking", text: result.reasoning });
    if (result.text) content.push({ type: "text", text: result.text });

    if (!result.toolCalls) {
      return successOutcome(run.id, pendingMessage.id, run.chatId, content, result, emit);
    }

    // The *last* permitted round: a tool_calls response here can never
    // be returned to the model (there is no round `turn + 1` to feed
    // the result back into) — executing it would spend real work (real
    // external-provider credits, once Phase 3 registers Magica tools)
    // for an outcome nothing can ever use. Each requested call is
    // recorded CANCELLED instead of executed — a real, auditable
    // ToolInvocation + content-block pair, never silently discarded —
    // and the run ends via the same TURN_LIMIT_EXCEEDED path used when
    // the model never stops requesting tools at all.
    if (turn === MAX_TURNS - 1) {
      for (const toolCall of result.toolCalls) {
        const outcome = await recordTurnLimitCancellation({
          toolCall,
          agentRunId: run.id,
          messageId: pendingMessage.id,
          emit,
        });
        content.push(...outcome.blocks);
      }
      await prisma.message.update({
        where: { id: pendingMessage.id },
        data: { content: content as Prisma.InputJsonValue },
      });
      return definiteFailureOutcome(
        run.id,
        pendingMessage.id,
        "TURN_LIMIT_EXCEEDED",
        "The agent requested additional tool calls on the final permitted turn; they could not be executed because their results could never have been returned to the model. See the accompanying tool_use/tool_result blocks.",
        content,
        emit,
      );
    }

    // The model asked for one or more tools. Its own tool-calling
    // message must be recorded before anything else, exactly as
    // OpenRouter's protocol requires: an assistant tool_calls message is
    // immediately followed by one tool-role message per call.
    turnMessages.push({ role: "assistant", content: result.text, tool_calls: result.toolCalls });

    // Sequential, not parallel — the simplest design that still keeps
    // result/charge/message ordering deterministic (true parallel
    // execution would need its own serialization for the ToolInvocation
    // inserts and the shared `content` array; not worth it before a real
    // tool has latency that makes it matter).
    for (const toolCall of result.toolCalls) {
      // Checked immediately before each tool execution.
      const beforeTool = await readAgentRunStatus(run.id);
      if (beforeTool !== "RUNNING") {
        return { status: beforeTool, skipped: true as const, ambiguous: false as const };
      }

      let outcome: ToolCallOutcome;
      try {
        outcome = await runOneToolCall({
          toolCall,
          registry,
          agentRunId: run.id,
          userId: run.userId,
          messageId: pendingMessage.id,
          emit,
        });
      } catch (error) {
        // A Magica-backed tool's execute() exhausted its own polling
        // budget (or the run was cancelled mid-poll) — genuinely still
        // can't tell the outcome. The ToolInvocation is left exactly
        // as runOneToolCall left it (RUNNING, providerRunId intact if
        // persisted) — back off the same way every other mid-round
        // guard loss does: write nothing further, let a later
        // re-entry's reconcile() pick this up. Not a loop resumption —
        // this execution attempt simply ends here.
        if (error instanceof MagicaPollInconclusiveError) {
          return { status: await readAgentRunStatus(run.id), skipped: true as const, ambiguous: false as const };
        }
        throw error;
      }
      content.push(...outcome.blocks);
      turnMessages.push(outcome.providerMessage);

      // Persisted after *each* tool call, not batched once per round —
      // so a cancellation detected partway through a multi-tool-call
      // round never loses an earlier call's already-finished result.
      // Content-only; never touches status, so it's safe even if a
      // cancel is racing it (disjoint columns, no guard needed here).
      await prisma.message.update({
        where: { id: pendingMessage.id },
        data: { content: content as Prisma.InputJsonValue },
      });
    }
  }

  // Bounded loop exhausted without a final answer. A known, definite
  // outcome (we chose to stop) — not ambiguous.
  return definiteFailureOutcome(
    run.id,
    pendingMessage.id,
    "TURN_LIMIT_EXCEEDED",
    "The agent did not produce a final answer within the maximum number of turns.",
    content,
    emit,
  );
}

export const runAgentTurn = task({
  id: "run-agent-turn",
  // Wrapped, not passed directly: Trigger.dev calls `run(payload, ctx)`
  // with its own second argument, which would otherwise land in
  // executeAgentTurn's `registry` parameter and silently break the
  // default. Production always gets the one-argument call, so all three
  // defaults (PRODUCTION_TOOL_REGISTRY, the real publisher,
  // PRODUCTION_SKILL_REGISTRY) apply.
  run: (payload: RunAgentTurnPayload) => executeAgentTurn(payload),
});
