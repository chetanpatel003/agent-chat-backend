import { describe, it, expect, vi } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { toErrorResponse, ConflictError } from "./errors";

const p2028 = (message: string) =>
  new Prisma.PrismaClientKnownRequestError(`Transaction API error: ${message}`, { code: "P2028", clientVersion: "7.10.1" });

describe("toErrorResponse", () => {
  it("maps pool saturation (transaction couldn't start) to a retryable 503", () => {
    expect(toErrorResponse(p2028("Unable to start a transaction in the given time."))).toEqual({
      status: 503,
      body: { ok: false, error: { code: "ServiceBusy", message: "The service is busy. Try again in a moment." } },
    });
  });

  it("keeps other transaction errors as a generic 500 without detail", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = toErrorResponse(p2028("Transaction already closed"));
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain("Transaction");
  });

  it("still maps typed application errors", () => {
    expect(toErrorResponse(new ConflictError("busy chat")).status).toBe(409);
  });
});
