import { task } from "@trigger.dev/sdk";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { ToolInvocationStatus, AgentRunStatus } from "@/generated/prisma/enums";
import {
  callOpenRouter,
  OpenRouterAmbiguousError,
  OpenRouterDefiniteError,
  type ProviderMessage,
  type ProviderToolCall,
} from "@/providers/openrouter";
import { buildConversationContext } from "@/providers/conversation-context";
import { PRODUCTION_TOOL_REGISTRY, toOpenRouterTools } from "@/tools/registry";
import type { ToolRegistry } from "@/tools/types";
import type { ContentBlock } from "@/contracts/message";

export type RunAgentTurnPayload = {
  agentRunId: string;
};

const TERMINAL_STATUSES: AgentRunStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];

// Model-call rounds, not individual tool calls within a round — a round
// can dispatch several tool calls at once. Generous enough for a real
// multi-step tool chain, small enough to bound cost/latency decisively
// rather than let a confused model loop indefinitely.
const MAX_TURNS = 8;

/**
 * The AgentRun fails safely, but the PENDING message (and any
 * ToolInvocation left RUNNING) is left untouched — it IS the durable
 * evidence of the unknown outcome, per project-docs/PHASE2-PLAN.md
 * §Decision C. Only the AgentRun transitions, which is what the rest of
 * the system reads to know this chat is no longer blocked. A human-
 * initiated retry sends a new message, which creates a genuinely new
 * AgentRun (send-turn.ts) — never a replay of this one.
 */
async function markAmbiguous(agentRunId: string) {
  await prisma.agentRun.update({
    where: { id: agentRunId },
    data: {
      status: "FAILED",
      errorCode: "AMBIGUOUS_PROVIDER_OUTCOME",
      errorMessage:
        "The AI provider's response was lost before we could record it (a timeout or interruption during the request) — we cannot tell whether it completed. Send a new message to try again; nothing was duplicated or charged twice.",
      completedAt: new Date(),
    },
  });
}

/** A clean, known failure — safe to mark the message FAILED too, unlike
 * the ambiguous case, because we genuinely know the attempt did not
 * produce a usable result. `content` (if given) preserves whatever
 * tool_use/tool_result blocks were already produced this turn — a
 * failure partway through a tool-calling loop shouldn't erase the part
 * that did happen. */
async function markDefiniteFailure(
  agentRunId: string,
  pendingMessageId: string,
  errorCode: string,
  errorMessage: string,
  content?: ContentBlock[],
) {
  await prisma.message.update({
    where: { id: pendingMessageId },
    data: {
      status: "FAILED",
      ...(content ? { content: content as Prisma.InputJsonValue } : {}),
    },
  });
  await prisma.agentRun.update({
    where: { id: agentRunId },
    data: { status: "FAILED", errorCode, errorMessage, completedAt: new Date() },
  });
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
 * the turn silently dying.
 */
async function runOneToolCall(params: {
  toolCall: ProviderToolCall;
  registry: ToolRegistry;
  agentRunId: string;
  userId: string;
  messageId: string;
}): Promise<ToolCallOutcome> {
  const { toolCall, registry, agentRunId, userId, messageId } = params;
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

  const startedAt = Date.now();
  try {
    const rawOutput = await tool.execute(parsedInput.data, { agentRunId, userId });
    const durationMs = Date.now() - startedAt;
    const parsedOutput = tool.outputSchema.safeParse(rawOutput);
    if (!parsedOutput.success) {
      const errorMessage = `Tool returned output that didn't match its declared schema: ${parsedOutput.error.message}`;
      const failed = await prisma.toolInvocation.update({
        where: { id: invocation.id },
        data: { status: "FAILED", errorCode: "INVALID_OUTPUT", errorMessage, durationMs },
      });
      return buildToolCallOutcome(failed, toolCall, rawInput, null, {
        code: "INVALID_OUTPUT",
        message: errorMessage,
      });
    }
    const completed = await prisma.toolInvocation.update({
      where: { id: invocation.id },
      data: {
        status: "COMPLETED",
        output: parsedOutput.data as Prisma.InputJsonValue,
        durationMs,
      },
    });
    return buildToolCallOutcome(
      completed,
      toolCall,
      rawInput,
      parsedOutput.data as Record<string, unknown>,
      null,
    );
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const errorMessage = error instanceof Error ? error.message : "Tool execution failed";
    const failed = await prisma.toolInvocation.update({
      where: { id: invocation.id },
      data: { status: "FAILED", errorCode: "EXECUTION_FAILED", errorMessage, durationMs },
    });
    return buildToolCallOutcome(failed, toolCall, rawInput, null, {
      code: "EXECUTION_FAILED",
      message: errorMessage,
    });
  }
}

/**
 * The real turn logic, exported separately from the Trigger.dev task
 * wrapper so tests can call it directly — in-process, with the
 * OpenRouter adapter mocked — rather than needing a live dev worker for
 * every behavioral test. `pnpm trigger:dev` is still how this actually
 * runs in dev/prod; see run-agent-turn.test.ts for why both matter.
 *
 * `registry` defaults to the empty production registry (Decision A) —
 * tests substitute their own via this parameter rather than module-
 * mocking (found fragile in checkpoint 2.2 — see decisions/0010) or
 * mutating shared module state (risky for cross-file test isolation).
 */
export async function executeAgentTurn(
  payload: RunAgentTurnPayload,
  registry: ToolRegistry = PRODUCTION_TOOL_REGISTRY,
) {
  const run = await prisma.agentRun.findUniqueOrThrow({
    where: { id: payload.agentRunId },
  });

  // Terminal states are never reopened — this check runs before
  // anything else, so a late-arriving duplicate invocation (a Trigger.dev
  // retry racing a completed attempt, or its own idempotencyKey not
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
  const staleToolInvocation = await prisma.toolInvocation.findFirst({
    where: { agentRunId: run.id, status: "RUNNING" },
  });
  if (staleToolInvocation) {
    const tool = registry.get(staleToolInvocation.toolName);
    if (tool?.reconcile) {
      await tool
        .reconcile({
          id: staleToolInvocation.id,
          providerRunId: staleToolInvocation.providerRunId,
        })
        .catch(() => null);
    }
    await markAmbiguous(run.id);
    return { status: "FAILED" as const, skipped: false as const, ambiguous: true as const };
  }

  // Re-entry ambiguous-outcome detection. A PENDING assistant message
  // for this run means a previous execution got far enough to dispatch
  // a provider request but never came back to record the outcome —
  // crashed, got killed for exceeding maxDuration, or the process died
  // mid-flight. This runs before any new work, so it can't be bypassed
  // by a retry racing ahead of it, and it never issues a second
  // OpenRouter request for an attempt whose outcome is unknown.
  const stalePending = await prisma.message.findFirst({
    where: { agentRunId: run.id, role: "ASSISTANT", status: "PENDING" },
  });
  if (stalePending) {
    await markAmbiguous(run.id);
    return { status: "FAILED" as const, skipped: false as const, ambiguous: true as const };
  }

  await prisma.agentRun.update({
    where: { id: run.id },
    data: { status: "RUNNING", startedAt: run.startedAt ?? new Date() },
  });

  const history = await buildConversationContext(run.chatId);

  // Committed before the provider call — this row is "persist the
  // request/attempt state before making the call." It accumulates every
  // block produced across the whole tool-calling loop below (not one row
  // per model-call round) — matching the product's one-bubble-per-turn
  // rendering, and matching Decision C's ambiguity granularity: any
  // crash anywhere in the loop leaves this same row at PENDING.
  const pendingMessage = await prisma.message.create({
    data: {
      chatId: run.chatId,
      userId: run.userId,
      agentRunId: run.id,
      role: "ASSISTANT",
      status: "PENDING",
      content: [],
    },
  });

  const providerTools = toOpenRouterTools(registry);
  const content: ContentBlock[] = [];
  // The in-progress turn's own assistant-tool_calls/tool-result messages,
  // appended to `history` on each call — never derived from the
  // database, since tools aren't exposed to real conversations yet and
  // reconstructing this sequence across turns isn't needed in Phase 2.
  const turnMessages: ProviderMessage[] = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    await prisma.agentRun.update({ where: { id: run.id }, data: { turnCount: turn + 1 } });

    let result;
    try {
      result = await callOpenRouter([...history, ...turnMessages], providerTools);
    } catch (error) {
      if (error instanceof OpenRouterAmbiguousError) {
        await markAmbiguous(run.id);
        return { status: "FAILED" as const, skipped: false as const, ambiguous: true as const };
      }
      if (error instanceof OpenRouterDefiniteError) {
        await markDefiniteFailure(run.id, pendingMessage.id, error.code, error.message, content);
        return { status: "FAILED" as const, skipped: false as const, ambiguous: false as const };
      }
      // Genuinely unexpected (e.g. a DB write failure) — rethrow and let
      // Trigger.dev's own retry policy handle it. The next attempt's
      // re-entry check above will find this same PENDING row and treat
      // it as ambiguous rather than calling OpenRouter again.
      throw error;
    }

    // Pushed unconditionally, before branching on tool_calls: any
    // narration the model gives alongside a tool request ("Let me check
    // that...") is captured too, not just the final answer's text.
    if (result.reasoning) content.push({ type: "thinking", text: result.reasoning });
    if (result.text) content.push({ type: "text", text: result.text });

    if (!result.toolCalls) {
      await prisma.message.update({
        where: { id: pendingMessage.id },
        // Prisma's Json input type doesn't structurally accept our own
        // ContentBlock union — isolated cast at this one boundary;
        // `content` itself stays fully typed everywhere else here.
        data: { status: "COMPLETE", content: content as Prisma.InputJsonValue },
      });
      await prisma.chat.update({
        where: { id: run.chatId },
        data: { lastMessageAt: new Date() },
      });
      await prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: "COMPLETED",
          model: result.model,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          completedAt: new Date(),
        },
      });
      return { status: "COMPLETED" as const, skipped: false as const, ambiguous: false as const };
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
      const outcome = await runOneToolCall({
        toolCall,
        registry,
        agentRunId: run.id,
        userId: run.userId,
        messageId: pendingMessage.id,
      });
      content.push(...outcome.blocks);
      turnMessages.push(outcome.providerMessage);
    }

    // Persist progress made this round even though the Message is still
    // PENDING — partial content survives a crash on the *next* model
    // call instead of being silently lost.
    await prisma.message.update({
      where: { id: pendingMessage.id },
      data: { content: content as Prisma.InputJsonValue },
    });
  }

  // Bounded loop exhausted without a final answer. A known, definite
  // outcome (we chose to stop) — not ambiguous.
  await markDefiniteFailure(
    run.id,
    pendingMessage.id,
    "TURN_LIMIT_EXCEEDED",
    "The agent did not produce a final answer within the maximum number of turns.",
    content,
  );
  return { status: "FAILED" as const, skipped: false as const, ambiguous: false as const };
}

export const runAgentTurn = task({
  id: "run-agent-turn",
  // Wrapped, not passed directly: Trigger.dev calls `run(payload, ctx)`
  // with its own second argument, which would otherwise land in
  // executeAgentTurn's `registry` parameter and silently break the
  // default. Production always gets the one-argument call, so the
  // default (the empty PRODUCTION_TOOL_REGISTRY) applies.
  run: (payload: RunAgentTurnPayload) => executeAgentTurn(payload),
});
