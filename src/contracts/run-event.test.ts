import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { RunEventSchema } from "./run-event";

const runId = randomUUID();
const at = new Date().toISOString();

describe("RunEventSchema — valid events", () => {
  it("accepts a run_status event", () => {
    expect(RunEventSchema.safeParse({ type: "run_status", runId, seq: 1, at, status: "RUNNING" }).success).toBe(true);
    expect(
      RunEventSchema.safeParse({
        type: "run_status",
        runId,
        seq: 2,
        at,
        status: "FAILED",
        errorCode: "AMBIGUOUS_PROVIDER_OUTCOME",
      }).success,
    ).toBe(true);
  });

  it("accepts an assistant_message event", () => {
    expect(
      RunEventSchema.safeParse({
        type: "assistant_message",
        runId,
        seq: 1,
        at,
        messageId: randomUUID(),
        status: "COMPLETE",
      }).success,
    ).toBe(true);
  });

  it("accepts a tool_started event", () => {
    expect(
      RunEventSchema.safeParse({
        type: "tool_started",
        runId,
        seq: 1,
        at,
        toolInvocationId: randomUUID(),
        toolName: "get_current_time",
      }).success,
    ).toBe(true);
  });

  it("accepts a tool_completed event, with and without durationMs", () => {
    const base = { type: "tool_completed", runId, seq: 1, at, toolInvocationId: randomUUID(), toolName: "t" };
    expect(RunEventSchema.safeParse(base).success).toBe(true);
    expect(RunEventSchema.safeParse({ ...base, durationMs: 42 }).success).toBe(true);
  });

  it("accepts a tool_failed event, with and without durationMs/errorCode", () => {
    const base = { type: "tool_failed", runId, seq: 1, at, toolInvocationId: randomUUID(), toolName: "t" };
    expect(RunEventSchema.safeParse(base).success).toBe(true);
    expect(
      RunEventSchema.safeParse({ ...base, durationMs: 10, errorCode: "EXECUTION_FAILED" }).success,
    ).toBe(true);
  });
});

describe("RunEventSchema — invalid payloads", () => {
  it("rejects a missing runId", () => {
    expect(RunEventSchema.safeParse({ type: "run_status", seq: 1, at, status: "RUNNING" }).success).toBe(
      false,
    );
  });

  it("rejects an unknown type literal", () => {
    expect(RunEventSchema.safeParse({ type: "assistant_text", runId, seq: 1, at }).success).toBe(false);
  });

  it("rejects a negative seq", () => {
    expect(
      RunEventSchema.safeParse({ type: "run_status", runId, seq: -1, at, status: "RUNNING" }).success,
    ).toBe(false);
  });

  it("rejects a non-ISO `at`", () => {
    expect(
      RunEventSchema.safeParse({ type: "run_status", runId, seq: 1, at: "not a date", status: "RUNNING" })
        .success,
    ).toBe(false);
  });

  it("rejects an invalid status for run_status", () => {
    expect(
      RunEventSchema.safeParse({ type: "run_status", runId, seq: 1, at, status: "NOT_A_STATUS" }).success,
    ).toBe(false);
  });

  // The hard security/architecture constraint: an event can never carry
  // assistant text, tool input/output, or any other execution payload —
  // enforced by z.strictObject() rejecting the extra field outright,
  // not by silently stripping it (which would make this test pass for
  // the wrong reason).
  it("rejects an assistant_message event carrying message content", () => {
    expect(
      RunEventSchema.safeParse({
        type: "assistant_message",
        runId,
        seq: 1,
        at,
        messageId: randomUUID(),
        status: "COMPLETE",
        content: "the actual assistant reply text",
      }).success,
    ).toBe(false);
  });

  it("rejects a tool_completed event carrying tool output", () => {
    expect(
      RunEventSchema.safeParse({
        type: "tool_completed",
        runId,
        seq: 1,
        at,
        toolInvocationId: randomUUID(),
        toolName: "get_current_time",
        output: { isoTime: "2026-01-01T00:00:00.000Z" },
      }).success,
    ).toBe(false);
  });

  it("rejects a tool_started event carrying the tool's input", () => {
    expect(
      RunEventSchema.safeParse({
        type: "tool_started",
        runId,
        seq: 1,
        at,
        toolInvocationId: randomUUID(),
        toolName: "get_current_time",
        input: { timezone: "UTC" },
      }).success,
    ).toBe(false);
  });
});
