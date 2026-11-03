-- Plan mode is a property of the run (persisted, not only in the task payload).
ALTER TABLE "AgentRun" ADD COLUMN "planMode" BOOLEAN NOT NULL DEFAULT false;

-- Total model thinking time for an assistant message (timing only, never reasoning text).
ALTER TABLE "Message" ADD COLUMN "thinkingMs" INTEGER;

-- Expiry/recovery sweep over pending waitpoints.
CREATE INDEX "Waitpoint_status_expiresAt_idx" ON "Waitpoint"("status", "expiresAt");

-- Rollback:
--   DROP INDEX "Waitpoint_status_expiresAt_idx";
--   ALTER TABLE "Message" DROP COLUMN "thinkingMs";
--   ALTER TABLE "AgentRun" DROP COLUMN "planMode";
