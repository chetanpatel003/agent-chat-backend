import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { RunEventSchema, type RunEvent } from "@/contracts/run-event";
import { createRunEventEmitter, lastPublishedSeq } from "./publish-run-event";

/** Stands in for Trigger.dev run metadata, which persists across attempts. */
function fakeRunMetadata() {
  const events: RunEvent[] = [];
  return { events, publish: (event: RunEvent) => void events.push(event) };
}

async function runAttempt(runId: string, store: ReturnType<typeof fakeRunMetadata>, count: number) {
  const emit = createRunEventEmitter(runId, store.publish, lastPublishedSeq(runId, store.events));
  for (let i = 0; i < count; i++) await emit({ type: "run_status", status: "RUNNING" });
}

describe("realtime event sequencing across retry attempts", () => {
  it("continues seq after the first attempt's events instead of restarting at 1", async () => {
    const runId = randomUUID();
    const store = fakeRunMetadata();
    await runAttempt(runId, store, 3);
    await runAttempt(runId, store, 2);
    expect(store.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps seq unique and strictly increasing across three attempts", async () => {
    const runId = randomUUID();
    const store = fakeRunMetadata();
    await runAttempt(runId, store, 2);
    await runAttempt(runId, store, 0);
    await runAttempt(runId, store, 4);
    const seqs = store.events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("starts at 1 when nothing has been published yet", async () => {
    const runId = randomUUID();
    const store = fakeRunMetadata();
    await runAttempt(runId, store, 1);
    expect(store.events[0].seq).toBe(1);
  });

  it("ignores another run's events and malformed entries when finding the resume point", () => {
    const runId = randomUUID();
    const at = new Date().toISOString();
    const existing = [
      { type: "run_status", runId, seq: 4, at, status: "RUNNING" },
      { type: "run_status", runId: randomUUID(), seq: 99, at, status: "RUNNING" },
      { type: "run_status", runId, seq: 50 },
      "garbage",
    ];
    expect(lastPublishedSeq(runId, existing)).toBe(4);
    expect(lastPublishedSeq(runId, null)).toBe(0);
  });

  it("returns 0 outside a Trigger.dev task context instead of throwing", () => {
    expect(lastPublishedSeq(randomUUID())).toBe(0);
  });

  it("every emitted event still satisfies the RunEvent contract", async () => {
    const runId = randomUUID();
    const store = fakeRunMetadata();
    await runAttempt(runId, store, 2);
    await runAttempt(runId, store, 2);
    for (const event of store.events) expect(RunEventSchema.safeParse(event).success).toBe(true);
  });
});
