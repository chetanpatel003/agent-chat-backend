import { describe, it, expect, vi, afterEach } from "vitest";

describe("runAfterResponse", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("next/server");
  });

  it("hands the work to Next.js after() and returns without running it", async () => {
    const after = vi.fn();
    vi.doMock("next/server", () => ({ after }));
    const { runAfterResponse } = await import("./after-response");
    const task = vi.fn(async () => {});

    runAfterResponse("chat-title", task);
    expect(after).toHaveBeenCalledTimes(1);
    expect(task).not.toHaveBeenCalled(); // nothing runs before the response

    await after.mock.calls[0][0](); // Next.js runs it once the response is sent
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("swallows (and logs) failures of the deferred work", async () => {
    const after = vi.fn();
    vi.doMock("next/server", () => ({ after }));
    const { runAfterResponse } = await import("./after-response");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    runAfterResponse("chat-title", async () => {
      throw new Error("provider down");
    });
    await expect(after.mock.calls[0][0]()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("Deferred work failed", { label: "chat-title", error: "Error" });
    log.mockRestore();
  });

  it("with the real Next.js after() outside a request scope: never throws, and skips the work", async () => {
    const { runAfterResponse } = await import("./after-response");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const task = vi.fn(async () => {});

    expect(() => runAfterResponse("chat-title", task)).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(task).not.toHaveBeenCalled(); // not run synchronously in place of after()
    expect(warn).toHaveBeenCalledWith("Deferred work skipped: no request scope", expect.objectContaining({ label: "chat-title" }));
    warn.mockRestore();
  });
});
