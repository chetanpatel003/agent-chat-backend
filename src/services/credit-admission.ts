import { prisma } from "@/lib/prisma";
import { estimateNodeCredits, MagicaDefiniteError, type EstimateNode } from "@/providers/magica";
import { ToolExecutionError } from "@/tools/types";

// Pre-execution balance check for billable Magica tools. Applied only where a
// reliable estimate exists (project-docs/magica/CREDIT_ACCOUNTING.md):
//  - fixed: a documented flat price (Crop Image).
//  - estimate: Magica's own `estimate-credits` (GPT Image 2 with an explicit size).
//  - blocked: no reliable estimate and no approved policy yet (GPT Image 2 with
//    size Auto, Merge Videos) — refused before any provider call, never run silently.
// This is a check, not a reservation: settlement charges the actual `creditUsed`.

export type AdmissionSpec =
  | { kind: "fixed"; credits: bigint }
  | { kind: "estimate"; node: EstimateNode }
  | { kind: "blocked"; code: string; message: string };

export async function availableCredits(userId: string): Promise<bigint> {
  const account = await prisma.creditAccount.findUnique({ where: { userId }, select: { balance: true } });
  return account?.balance ?? BigInt(0);
}

/** Throws a coded ToolExecutionError when the run must not start. Raw integer credits throughout. */
export async function admitBillableRun(userId: string, spec: AdmissionSpec): Promise<bigint> {
  if (spec.kind === "blocked") throw new ToolExecutionError(spec.code, spec.message);

  let required: bigint;
  if (spec.kind === "fixed") {
    required = spec.credits;
  } else {
    try {
      required = await estimateNodeCredits(spec.node);
    } catch (error) {
      const reason = error instanceof MagicaDefiniteError ? error.code : "UnknownError";
      console.error("Credit estimate unavailable; not starting billable run", { userId, reason });
      throw new ToolExecutionError(
        "CREDIT_ESTIMATE_UNAVAILABLE",
        "The cost of this action could not be estimated right now, so it was not started. Please try again.",
      );
    }
  }

  const balance = await availableCredits(userId);
  if (balance < required) {
    throw new ToolExecutionError(
      "INSUFFICIENT_CREDITS",
      `Not enough credits: this action needs ${required} and the balance is ${balance}.`,
    );
  }
  return required;
}
