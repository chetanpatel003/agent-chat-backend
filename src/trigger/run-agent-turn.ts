import { task } from "@trigger.dev/sdk";
import { prisma } from "@/lib/prisma";
import type { AgentRunStatus } from "@/generated/prisma/enums";

export type RunAgentTurnPayload = {
  agentRunId: string;
};

const TERMINAL_STATUSES: AgentRunStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];

/**
 * Checkpoint 2.1 stub: proves the dispatch -> Trigger.dev -> persist ->
 * read-back pipeline, including idempotent re-entry (a retried/duplicate
 * invocation for an already-terminal run is a safe no-op). Checkpoint
 * 2.2 replaces the body between "mark RUNNING" and "mark COMPLETED" with
 * the real OpenRouter call and the PENDING-marker ambiguous-outcome
 * mechanism from project-docs/PHASE2-PLAN.md — the re-entry guard below
 * is written to already match that design, not just this stub's needs.
 */
export const runAgentTurn = task({
  id: "run-agent-turn",
  run: async (payload: RunAgentTurnPayload) => {
    const run = await prisma.agentRun.findUniqueOrThrow({
      where: { id: payload.agentRunId },
    });

    // Terminal states are never reopened — a late-arriving duplicate
    // invocation (Trigger.dev's own idempotencyKey should prevent this,
    // but isn't assumed infallible) is a no-op, not a re-run.
    if (TERMINAL_STATUSES.includes(run.status)) {
      return { status: run.status, skipped: true as const };
    }

    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "RUNNING", startedAt: run.startedAt ?? new Date() },
    });

    // --- stub model turn (checkpoint 2.2 replaces this block) ---
    const message = await prisma.message.create({
      data: {
        chatId: run.chatId,
        userId: run.userId,
        agentRunId: run.id,
        role: "ASSISTANT",
        status: "COMPLETE",
        content: [
          {
            type: "text",
            text: "(stub response — checkpoint 2.1 proves dispatch only, no model was called)",
          },
        ],
      },
    });
    await prisma.chat.update({
      where: { id: run.chatId },
      data: { lastMessageAt: message.createdAt },
    });
    // --- end stub ---

    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    return { status: "COMPLETED" as const, skipped: false as const };
  },
});
