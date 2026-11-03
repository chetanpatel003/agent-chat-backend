-- AlterTable: generated assets reference the Magica tool invocation that produced them.
ALTER TABLE "Attachment" ADD COLUMN "toolInvocationId" UUID;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_toolInvocationId_fkey"
  FOREIGN KEY ("toolInvocationId") REFERENCES "ToolInvocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex: one attachment per (invocation, output position) — idempotent archival.
-- Uploads (NULL toolInvocationId) are unaffected; Postgres allows many NULLs.
CREATE UNIQUE INDEX "Attachment_toolInvocationId_order_key" ON "Attachment"("toolInvocationId", "order");

-- Rollback:
--   DROP INDEX "Attachment_toolInvocationId_order_key";
--   ALTER TABLE "Attachment" DROP CONSTRAINT "Attachment_toolInvocationId_fkey";
--   ALTER TABLE "Attachment" DROP COLUMN "toolInvocationId";
