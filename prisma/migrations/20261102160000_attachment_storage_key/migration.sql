-- AlterTable: B2 object key, set only after a successful archive.
ALTER TABLE "Attachment" ADD COLUMN "storageKey" TEXT;

-- CreateIndex: one row per object; Postgres allows many NULLs.
CREATE UNIQUE INDEX "Attachment_storageKey_key" ON "Attachment"("storageKey");
