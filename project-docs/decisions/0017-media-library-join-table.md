# 0017 — Media picker: MessageAttachment join table

Status: accepted (2026-11-03; data model and library scope chosen by the user).

## Requirement
Assessment §4 Composer: "attachments, media picker"; §5 Attachments: "preserve direct-upload and
media-library attachment order". The live reference was not available for inspection, so the
picker is the smallest version of those two lines: choose existing media, keep order.

## Why a migration was required
`Attachment.messageId` allowed exactly one message per attachment, `attachToMessage` refused
anything already sent, and `storageKey` is unique — so re-sending a file was impossible without
either copying the record (rejected: no duplicate records) or a many-to-many association.

## Decision
- `MessageAttachment(messageId, attachmentId, order)`: what a **user message sends**, in order —
  direct uploads and media-library picks. Primary key `(messageId, attachmentId)` (no duplicate
  association), unique `(messageId, order)`, cascade with either side. Backfilled from sent
  uploads (0 rows in the dev database at apply time).
- `Attachment.messageId` keeps meaning **origin**: the message an upload was first sent with, or
  the assistant message that generated an asset. Generated-asset code is unchanged.
- Reads: a USER message's attachments come from the join table (send order); other messages keep
  their own (generated) attachments. Agent context lists a user message's sent files in send order.
- Library (`GET /api/v1/attachments/library`): the caller's READY attachments with a permanent B2
  copy, a supported image/video type, and an origin message in a non-deleted chat — sent uploads
  and generated outputs — newest first, cursor-paginated. Unsent uploads are not listed.
- `attachToMessage` takes one ordered list; each id is classified from the stored row: unsent
  upload → existing checks and first send sets its origin; anything else → must be a usable
  library item; the row is not modified. Ownership: another user's id is a 404.

## Limits
- A library item from another chat may be sent in this chat (the library is per user).
- Uploads never archived to B2 (legacy) can't be re-sent: their source URL expires.
