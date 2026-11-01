import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  CursorPaginationRequestSchema,
  encodeCursor,
  decodeCursor,
} from "./pagination";

describe("cursor pagination", () => {
  it("round-trips a valid cursor", () => {
    const payload = { sortKey: new Date().toISOString(), id: randomUUID() };
    const cursor = encodeCursor(payload);
    const decoded = decodeCursor(cursor);
    expect(decoded).toEqual(payload);
  });

  it("rejects a cursor that isn't valid base64url JSON", () => {
    expect(decodeCursor("not-a-real-cursor")).toBeNull();
  });

  it("rejects a cursor that decodes to the wrong shape", () => {
    const bogus = Buffer.from(JSON.stringify({ foo: "bar" })).toString(
      "base64url",
    );
    expect(decodeCursor(bogus)).toBeNull();
  });

  it("rejects a cursor whose id isn't a uuid", () => {
    const bogus = Buffer.from(
      JSON.stringify({ sortKey: new Date().toISOString(), id: "not-a-uuid" }),
    ).toString("base64url");
    expect(decodeCursor(bogus)).toBeNull();
  });

  it("defaults limit to 20 and accepts an explicit valid limit", () => {
    expect(CursorPaginationRequestSchema.parse({}).limit).toBe(20);
    expect(CursorPaginationRequestSchema.parse({ limit: 50 }).limit).toBe(50);
  });

  it("rejects a limit above the bound (100) or below 1", () => {
    expect(CursorPaginationRequestSchema.safeParse({ limit: 101 }).success).toBe(
      false,
    );
    expect(CursorPaginationRequestSchema.safeParse({ limit: 0 }).success).toBe(
      false,
    );
  });
});
