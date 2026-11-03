import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { ToolReconcileOutcome } from "@/tools/types";

/**
 * Persists a reconciled provider outcome onto a still-RUNNING invocation.
 * Guarded (status must still be RUNNING), so a terminal row is never
 * overwritten and concurrent reconcilers transition it at most once. A
 * failed/cancelled run's reported usage is kept on `output.creditUsed`.
 * Returns whether this call made the transition.
 */
export async function persistReconciledOutcome(
  toolInvocationId: string,
  reconciled: ToolReconcileOutcome<unknown>,
): Promise<boolean> {
  const data: Prisma.ToolInvocationUpdateManyMutationInput =
    reconciled.status === "completed"
      ? { status: "COMPLETED", output: reconciled.output as Prisma.InputJsonValue }
      : {
          status: "FAILED",
          errorCode: reconciled.errorCode,
          errorMessage: reconciled.errorMessage,
          ...(reconciled.creditUsed !== undefined ? { output: { creditUsed: reconciled.creditUsed } } : {}),
        };
  const { count } = await prisma.toolInvocation.updateMany({ where: { id: toolInvocationId, status: "RUNNING" }, data });
  return count === 1;
}
