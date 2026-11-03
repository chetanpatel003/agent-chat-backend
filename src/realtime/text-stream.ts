import { streams } from "@trigger.dev/sdk";
import { ASSISTANT_TEXT_STREAM_KEY, TextStreamPartSchema, type TextStreamPart } from "@/contracts/text-stream";

/**
 * One execution's assistant-text realtime stream. Transport only, like
 * publishRunEvent: never throws, never fails the run — the persisted
 * Message is the durable copy (partial text is flushed to it separately).
 */
export type TextStreamSink = {
  write(part: TextStreamPart): void;
  close(): Promise<void>;
};
export type OpenTextStream = () => TextStreamSink;

const NOOP_SINK: TextStreamSink = { write: () => {}, close: async () => {} };

/** Bounds close(): a stalled flush must never hold a finished turn open. */
const CLOSE_TIMEOUT_MS = 10_000;

/** Pipes parts to the current Trigger.dev run's `assistant-text` stream.
 * Outside a task context `streams.pipe` throws synchronously (verified in
 * SDK 4.8.3) and this degrades to a no-op sink. */
export const openTriggerTextStream: OpenTextStream = () => {
  let controller: ReadableStreamDefaultController<TextStreamPart> | null = null;
  const readable = new ReadableStream<TextStreamPart>({
    start(c) {
      controller = c;
    },
  });
  let waitUntilComplete: () => Promise<unknown>;
  try {
    waitUntilComplete = streams.pipe(ASSISTANT_TEXT_STREAM_KEY, readable).waitUntilComplete;
  } catch (error) {
    console.error("Text stream unavailable; continuing without token streaming", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NOOP_SINK;
  }

  let closed = false;
  return {
    write(part) {
      if (closed || !TextStreamPartSchema.safeParse(part).success) return;
      try {
        controller?.enqueue(part);
      } catch {
        // stream already errored/closed — transport only
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        controller?.close();
        await Promise.race([waitUntilComplete(), new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS))]);
      } catch (error) {
        console.error("Text stream close failed", { error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
};
