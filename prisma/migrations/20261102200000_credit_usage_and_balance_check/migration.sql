-- Actual provider usage, recorded separately from the amount collected.
ALTER TABLE "ToolInvocation" ADD COLUMN "creditsUsed" BIGINT;

-- A credit balance can never go negative. Hand-written CHECK constraints are
-- not modelled by Prisma (same convention as AgentRun_one_active_per_chat).
ALTER TABLE "CreditAccount" ADD CONSTRAINT "CreditAccount_balance_nonnegative" CHECK ("balance" >= 0);

-- A settled invocation always records usage, and collects no more than it used.
ALTER TABLE "ToolInvocation" ADD CONSTRAINT "ToolInvocation_credits_collected_within_used"
  CHECK ("creditsCharged" IS NULL OR ("creditsUsed" IS NOT NULL AND "creditsCharged" >= 0 AND "creditsCharged" <= "creditsUsed"));

-- Rollback:
--   ALTER TABLE "ToolInvocation" DROP CONSTRAINT "ToolInvocation_credits_collected_within_used";
--   ALTER TABLE "CreditAccount" DROP CONSTRAINT "CreditAccount_balance_nonnegative";
--   ALTER TABLE "ToolInvocation" DROP COLUMN "creditsUsed";
