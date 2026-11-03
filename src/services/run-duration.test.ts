import { describe, it, expect } from "vitest";
import { runDurationMs, runQueueMs } from "./run-duration";
import { MessageResponseSchema } from "@/contracts/message";

const at = (iso: string) => new Date(iso);

describe("runDurationMs (finished turn, admission → completion)", () => {
  it("measures a long-running tool turn from the authoritative timestamps", () => {
    // e.g. a Merge Videos turn: ~4 s of model thinking, ~3 min of provider work.
    const run = { status: "COMPLETED" as const, createdAt: at("2026-11-04T10:00:00.000Z"), completedAt: at("2026-11-04T10:03:12.500Z") };
    expect(runDurationMs(run)).toBe(192_500);
  });

  it.each(["FAILED", "CANCELLED"] as const)("is measured for a %s run too", (status) => {
    expect(runDurationMs({ status, createdAt: at("2026-11-04T10:00:00Z"), completedAt: at("2026-11-04T10:00:09Z") })).toBe(9_000);
  });

  it.each(["QUEUED", "RUNNING", "WAITING"] as const)("is null while the run is %s (never a running estimate)", (status) => {
    expect(runDurationMs({ status, createdAt: at("2026-11-04T10:00:00Z"), completedAt: null })).toBeNull();
    expect(runDurationMs({ status, createdAt: at("2026-11-04T10:00:00Z"), completedAt: at("2026-11-04T10:00:05Z") })).toBeNull();
  });

  it("is null when a result was recovered after its run ended (message COMPLETE, run not COMPLETED)", () => {
    const ended = { status: "FAILED" as const, createdAt: at("2026-11-04T10:00:00Z"), completedAt: at("2026-11-04T10:05:00Z") };
    expect(runDurationMs(ended, "COMPLETE")).toBeNull();
    expect(runDurationMs(ended, "PENDING")).toBe(300_000); // the interrupted run's own duration
    expect(runDurationMs({ ...ended, status: "COMPLETED" }, "COMPLETE")).toBe(300_000);
  });

  it("is null for missing, invalid or out-of-order timestamps", () => {
    expect(runDurationMs(null)).toBeNull();
    expect(runDurationMs({ status: "COMPLETED", createdAt: at("2026-11-04T10:00:00Z"), completedAt: null })).toBeNull();
    expect(runDurationMs({ status: "COMPLETED", createdAt: null, completedAt: at("2026-11-04T10:00:00Z") })).toBeNull();
    expect(runDurationMs({ status: "COMPLETED", createdAt: new Date("not a date"), completedAt: at("2026-11-04T10:00:00Z") })).toBeNull();
    expect(runDurationMs({ status: "COMPLETED", createdAt: at("2026-11-04T10:00:05Z"), completedAt: at("2026-11-04T10:00:00Z") })).toBeNull();
  });
});

describe("MessageResponseSchema.runDurationMs", () => {
  const base = {
    id: "01a1a2fa-0000-7000-8000-000000000001",
    chatId: "01a1a2fa-0000-7000-8000-000000000002",
    agentRunId: null,
    role: "ASSISTANT",
    status: "COMPLETE",
    content: [],
    attachments: [],
    thinkingMs: 4000,
    error: null,
    createdAt: "2026-11-04T10:00:00.000Z",
  };
  it("defaults to null when an older server omits it", () => {
    expect(MessageResponseSchema.parse(base).runDurationMs).toBeNull();
  });
  it("rejects a negative or fractional duration", () => {
    expect(MessageResponseSchema.safeParse({ ...base, runDurationMs: -1 }).success).toBe(false);
    expect(MessageResponseSchema.safeParse({ ...base, runDurationMs: 1.5 }).success).toBe(false);
  });
});

describe("runQueueMs (admission → execution start)", () => {
  const base = { createdAt: at("2026-11-04T10:00:00.000Z"), completedAt: null };
  it("is the measured wait before Trigger.dev started the run, separate from execution", () => {
    expect(runQueueMs({ ...base, status: "RUNNING", startedAt: at("2026-11-04T10:00:07.250Z") })).toBe(7_250);
    expect(runQueueMs({ ...base, status: "COMPLETED", startedAt: at("2026-11-04T10:00:01Z"), completedAt: at("2026-11-04T10:05:00Z") })).toBe(1_000);
  });
  it("is null while still queued, and for missing, invalid or out-of-order timestamps", () => {
    expect(runQueueMs({ ...base, status: "QUEUED", startedAt: null })).toBeNull();
    expect(runQueueMs({ ...base, status: "FAILED", startedAt: null })).toBeNull(); // never started (e.g. cancelled while queued)
    expect(runQueueMs({ ...base, status: "RUNNING", startedAt: new Date("nope") })).toBeNull();
    expect(runQueueMs({ ...base, status: "RUNNING", startedAt: at("2026-11-04T09:59:59Z") })).toBeNull();
    expect(runQueueMs(null)).toBeNull();
  });
});
