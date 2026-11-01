import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { ContentBlockSchema, MessageContentSchema } from "./message";

describe("ContentBlockSchema", () => {
  it("accepts a valid text block", () => {
    const result = ContentBlockSchema.safeParse({ type: "text", text: "hi" });
    expect(result.success).toBe(true);
  });

  it("accepts a valid tool_use block", () => {
    const result = ContentBlockSchema.safeParse({
      type: "tool_use",
      toolInvocationId: randomUUID(),
      toolName: "crop_image",
      status: "RUNNING",
      input: { image_url: "https://example.com/a.png" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a tool_use block with an invalid status (not in the Prisma enum)", () => {
    const result = ContentBlockSchema.safeParse({
      type: "tool_use",
      toolInvocationId: randomUUID(),
      toolName: "crop_image",
      status: "NOT_A_REAL_STATUS",
      input: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects a tool_use block with a non-uuid toolInvocationId", () => {
    const result = ContentBlockSchema.safeParse({
      type: "tool_use",
      toolInvocationId: "not-a-uuid",
      toolName: "crop_image",
      status: "RUNNING",
      input: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown block type", () => {
    const result = ContentBlockSchema.safeParse({ type: "made_up", foo: 1 });
    expect(result.success).toBe(false);
  });

  it("rejects a block missing its discriminant", () => {
    const result = ContentBlockSchema.safeParse({ text: "no type field" });
    expect(result.success).toBe(false);
  });

  it("accepts every required content-block type", () => {
    const toolId = randomUUID();
    const blocks = [
      { type: "text", text: "hello" },
      { type: "thinking", text: "considering options" },
      {
        type: "tool_use",
        toolInvocationId: toolId,
        toolName: "gpt_image_2",
        status: "PENDING",
        input: {},
      },
      {
        type: "tool_result",
        toolInvocationId: toolId,
        output: { image_url: "https://example.com/out.png" },
        durationMs: 1200,
        creditsCharged: 7700,
        error: null,
      },
      { type: "reasoning", text: "summary of why" },
      { type: "citation", text: "source text", url: "https://example.com" },
      { type: "usage", promptTokens: 10, completionTokens: 20 },
    ];
    const result = MessageContentSchema.safeParse(blocks);
    expect(result.success).toBe(true);
    // order must survive validation exactly as given
    if (result.success) {
      expect(result.data.map((b) => b.type)).toEqual([
        "text",
        "thinking",
        "tool_use",
        "tool_result",
        "reasoning",
        "citation",
        "usage",
      ]);
    }
  });
});
