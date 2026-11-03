-- Media library: one attachment can be sent with many user messages, without
-- copying the file or creating another Attachment row. The composite primary
-- key makes a duplicate association impossible; (messageId, order) keeps a
-- message's attachment order unambiguous.
CREATE TABLE "MessageAttachment" (
    "messageId" UUID NOT NULL,
    "attachmentId" UUID NOT NULL,
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageAttachment_pkey" PRIMARY KEY ("messageId","attachmentId")
);

CREATE UNIQUE INDEX "MessageAttachment_messageId_order_key" ON "MessageAttachment"("messageId", "order");
CREATE INDEX "MessageAttachment_attachmentId_idx" ON "MessageAttachment"("attachmentId");

ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_attachmentId_fkey"
    FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every upload already sent with a user message, in its existing
-- order. Inserts derived rows only; no existing row is changed.
INSERT INTO "MessageAttachment" ("messageId", "attachmentId", "order", "createdAt")
SELECT a."messageId", a."id", a."order", a."updatedAt"
FROM "Attachment" a
JOIN "Message" m ON m."id" = a."messageId"
WHERE a."source" = 'UPLOAD' AND m."role" = 'USER';

-- Rollback:
--   DROP TABLE "MessageAttachment";
