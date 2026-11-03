import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { requireAttachmentOwnership, requireChatOwnership } from "@/services/ownership";
import {
  createUploadAuthorization,
  fetchAssemblyStatus,
  nonceFromStatus,
  type AssemblyUpload,
} from "@/lib/transloadit";
import {
  AttachmentMetadataSchema,
  isUploadMimeType,
  maxUploadBytes,
  UPLOAD_MIME_TYPES,
  type AttachmentResponse,
  type CreateAttachmentRequest,
  type MediaLibraryPage,
  type UploadAuthorizationResponse,
} from "@/contracts/attachment";
import { decodeCursor, encodeCursor } from "@/contracts/pagination";
import {
  copyUrlToObject,
  signedGetUrl,
  SIGNED_URL_DEFAULT_TTL_SECONDS,
  SourceFetchError,
  StorageConfigError,
  uploadObjectKey,
} from "@/lib/b2";
import type { Attachment, AttachmentStatus, Prisma } from "@/generated/prisma/client";

/** The verified file could not be archived to object storage. Retriable;
 * the attachment stays non-READY. Deliberately generic: no provider detail. */
export class UploadArchiveError extends Error {
  constructor() {
    super("The uploaded file could not be stored. Please retry.");
    this.name = "UploadArchiveError";
  }
}

/** Object storage is not configured on this server. */
export class UploadStorageUnavailableError extends Error {
  constructor() {
    super("File storage is not available right now.");
    this.name = "UploadStorageUnavailableError";
  }
}

/**
 * Streams the verified Transloadit file into B2 under its deterministic
 * key. Re-running overwrites the same object, so a retry after a
 * copy-succeeded/DB-failed crash is safe.
 */
async function archiveUpload(attachment: Pick<Attachment, "id" | "userId">, sourceUrl: string, mimeType: string) {
  if (!isUploadMimeType(mimeType)) throw new UploadArchiveError();
  const key = uploadObjectKey(attachment.userId, attachment.id, mimeType);
  try {
    await copyUrlToObject({ sourceUrl, key, contentType: mimeType, limits: { maxBytes: maxUploadBytes(mimeType) } });
  } catch (error) {
    console.error("Upload archive failed", {
      attachmentId: attachment.id,
      error: error instanceof Error ? error.name : "UnknownError",
      reason: error instanceof SourceFetchError ? error.reason : undefined,
    });
    if (error instanceof StorageConfigError) throw new UploadStorageUnavailableError();
    throw new UploadArchiveError();
  }
  return key;
}

/** Transloadit deletes un-exported uploads after ~24h; stop offering
 * them as tool inputs before that. */
export const ATTACHMENT_USABLE_FOR_MS = 23 * 60 * 60 * 1000;

const AUTHORIZABLE: AttachmentStatus[] = ["PENDING", "UPLOADING", "FAILED", "CANCELLED"];
const COMPLETABLE: AttachmentStatus[] = ["UPLOADING", "FAILED"];

/** An archived file's signed URL could not be produced. Generic by design. */
export class AttachmentUrlUnavailableError extends Error {
  constructor() {
    super("This file is temporarily unavailable.");
    this.name = "AttachmentUrlUnavailableError";
  }
}

/**
 * Archived files are served only through a short-lived signed B2 URL,
 * signed for the authenticated owner (the helper re-checks the key's
 * user namespace). There is deliberately no fallback to the stored
 * Transloadit URL for archived rows. Rows never archived keep their
 * existing URL unchanged.
 */
async function deliveryUrl(attachment: Attachment, ownerUserId: string): Promise<string | null> {
  if (!attachment.storageKey) return attachment.url;
  try {
    return await signedGetUrl(attachment.storageKey, ownerUserId, SIGNED_URL_DEFAULT_TTL_SECONDS);
  } catch (error) {
    console.error("Attachment URL signing failed", {
      attachmentId: attachment.id,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    throw new AttachmentUrlUnavailableError();
  }
}

/** `ownerUserId` must be the authenticated caller whose ownership of this
 * attachment (or its chat) has already been established. */
export async function toAttachmentResponse(attachment: Attachment, ownerUserId: string): Promise<AttachmentResponse> {
  return {
    id: attachment.id,
    messageId: attachment.messageId,
    source: attachment.source,
    status: attachment.status,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes !== null ? Number(attachment.sizeBytes) : null,
    url: await deliveryUrl(attachment, ownerUserId),
    metadata: AttachmentMetadataSchema.parse(attachment.sanitizedMetadata ?? {}),
    order: attachment.order,
    createdAt: attachment.createdAt.toISOString(),
  };
}

function metadataOf(attachment: Attachment) {
  return AttachmentMetadataSchema.parse(attachment.sanitizedMetadata ?? {});
}

export async function createAttachment(
  userId: string,
  input: CreateAttachmentRequest,
): Promise<AttachmentResponse> {
  if (input.chatId) await requireChatOwnership(userId, input.chatId);
  const attachment = await prisma.attachment.create({
    data: {
      userId,
      chatId: input.chatId ?? null,
      source: "UPLOAD",
      status: "PENDING",
      mimeType: input.mimeType,
      sizeBytes: BigInt(input.sizeBytes),
      sanitizedMetadata: { filename: input.filename },
      order: 0,
    },
  });
  return toAttachmentResponse(attachment, userId);
}

/** Issues signed Assembly params for one (re)upload of this attachment.
 * A fresh nonce per call: `<attachmentId>:<random>`. */
export async function authorizeUpload(userId: string, attachmentId: string): Promise<UploadAuthorizationResponse> {
  const attachment = await requireAttachmentOwnership(userId, attachmentId);
  if (attachment.source !== "UPLOAD" || attachment.messageId || !AUTHORIZABLE.includes(attachment.status)) {
    throw new ConflictError("This attachment can no longer be uploaded");
  }
  const authorization = createUploadAuthorization(`${attachment.id}:${randomUUID()}`);
  await prisma.attachment.update({ where: { id: attachment.id }, data: { status: "UPLOADING" } });
  return authorization;
}

async function markFailed(attachmentId: string, reason: string): Promise<never> {
  await prisma.attachment.updateMany({
    where: { id: attachmentId, status: { in: COMPLETABLE } },
    data: { status: "FAILED" },
  });
  throw new ValidationError(reason);
}

type VerifiedUpload =
  | { ok: false; error: string }
  | {
      ok: true;
      mimeType: string;
      sizeBytes: number;
      url: string;
      width?: number;
      height?: number;
      durationSeconds?: number;
    };

function verifiedUpload(upload: AssemblyUpload): VerifiedUpload {
  if (!isUploadMimeType(upload.mime)) return { ok: false, error: "Uploaded file type is not supported" };
  if (upload.size > maxUploadBytes(upload.mime)) return { ok: false, error: "Uploaded file is too large" };
  let url: URL;
  try {
    url = new URL(upload.ssl_url);
  } catch {
    return { ok: false, error: "Upload result has no valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, error: "Upload result has no valid URL" };
  const positive = (n: number | null | undefined) => (typeof n === "number" && n > 0 ? n : undefined);
  const width = positive(upload.meta?.width);
  const height = positive(upload.meta?.height);
  return {
    ok: true,
    mimeType: upload.mime,
    sizeBytes: upload.size,
    url: url.toString(),
    width: width !== undefined ? Math.round(width) : undefined,
    height: height !== undefined ? Math.round(height) : undefined,
    durationSeconds: positive(upload.meta?.duration),
  };
}

/**
 * Marks an attachment READY only after re-reading its Assembly from
 * Transloadit and checking: completed without error, created from *our*
 * signed authorization for *this* attachment (nonce), exactly one
 * upload, and server-measured type/size within limits — and after the
 * verified file is archived to B2. Client claims about type, size or
 * success are never trusted. Idempotent.
 */
export async function completeUpload(
  userId: string,
  attachmentId: string,
  assemblyId: string,
): Promise<AttachmentResponse> {
  const attachment = await requireAttachmentOwnership(userId, attachmentId);
  if (attachment.status === "READY") {
    if (attachment.storageKey || !attachment.url) return toAttachmentResponse(attachment, userId);
    // Verified before archiving existed: archive it now, while Transloadit
    // still holds the file. On failure the row stays READY as before.
    const key = await archiveUpload(attachment, attachment.url, attachment.mimeType);
    await prisma.attachment.updateMany({
      where: { id: attachment.id, status: "READY", storageKey: null },
      data: { storageKey: key },
    });
    return toAttachmentResponse(await requireAttachmentOwnership(userId, attachment.id), userId);
  }
  if (!COMPLETABLE.includes(attachment.status)) {
    throw new ConflictError("This upload was cancelled or never authorized");
  }

  const status = await fetchAssemblyStatus(assemblyId);
  if (!status) return markFailed(attachment.id, "Transloadit returned an unreadable Assembly status");
  if (status.error) return markFailed(attachment.id, "The upload failed at Transloadit");
  if (!nonceFromStatus(status)?.startsWith(`${attachment.id}:`)) {
    return markFailed(attachment.id, "This Assembly does not belong to this attachment");
  }
  if (status.ok !== "ASSEMBLY_COMPLETED") throw new ConflictError("The upload has not finished processing yet");
  if (status.uploads?.length !== 1) return markFailed(attachment.id, "Expected exactly one uploaded file");

  const verified = verifiedUpload(status.uploads[0]);
  if (!verified.ok) return markFailed(attachment.id, verified.error);

  // Archive before READY; a failure leaves the attachment UPLOADING/FAILED
  // so the client's completion retry can archive again.
  const storageKey = await archiveUpload(attachment, verified.url, verified.mimeType);

  const { filename } = metadataOf(attachment);
  const sanitizedMetadata: Prisma.InputJsonValue = Object.fromEntries(
    Object.entries({
      filename,
      width: verified.width,
      height: verified.height,
      durationSeconds: verified.durationSeconds,
    }).filter(([, v]) => v !== undefined),
  );
  // Guarded write: a concurrent duplicate completion updates nothing
  // and falls through to re-reading the row the winner wrote.
  await prisma.attachment.updateMany({
    where: { id: attachment.id, status: { in: COMPLETABLE } },
    data: {
      status: "READY",
      assemblyId: status.assembly_id,
      url: verified.url,
      mimeType: verified.mimeType,
      sizeBytes: BigInt(verified.sizeBytes),
      sanitizedMetadata,
      storageKey,
    },
  });
  const current = await requireAttachmentOwnership(userId, attachment.id);
  if (current.status !== "READY") throw new ConflictError("This upload was cancelled");
  return toAttachmentResponse(current, userId);
}

export async function cancelUpload(userId: string, attachmentId: string): Promise<AttachmentResponse> {
  const attachment = await requireAttachmentOwnership(userId, attachmentId);
  if (attachment.messageId) throw new ConflictError("An attachment already sent with a message cannot be cancelled");
  if (attachment.status === "CANCELLED") return toAttachmentResponse(attachment, userId);
  const updated = await prisma.attachment.update({
    where: { id: attachment.id },
    data: { status: "CANCELLED" },
  });
  return toAttachmentResponse(updated, userId);
}

/**
 * Binds the caller's READY, unattached, unexpired uploads to a new user
 * message inside the admission transaction, in the given order. Any
 * id that isn't the caller's is a 404 (no existence leak); any other
 * ineligibility is a 400. Guarded updates make a concurrent double-use
 * fail instead of attaching one file to two messages.
 */
/**
 * Associates a user message with its attachments, in the given order — one
 * list mixing two kinds, told apart by the stored row (never by the client):
 *  - a direct upload, not yet sent (`messageId` null): the existing checks
 *    (finished upload, same chat, still usable) and its first send sets its
 *    origin (`messageId`, `chatId`, `order`) under a guarded update;
 *  - a media-library item, already in one of the user's chats (sent upload
 *    or generated output): it must be READY, permanently stored, a supported
 *    type, and from a chat that wasn't deleted. Nothing is copied and the
 *    row is not changed — it is referenced again.
 * Every item gets a `MessageAttachment(messageId, attachmentId, order)` row;
 * its primary key makes a duplicate association impossible.
 */
export async function attachToMessage(
  tx: Prisma.TransactionClient,
  userId: string,
  chatId: string,
  messageId: string,
  attachmentIds: string[],
  now = new Date(),
): Promise<void> {
  if (attachmentIds.length === 0) return;
  if (new Set(attachmentIds).size !== attachmentIds.length) throw new ValidationError("Duplicate attachment id");
  const rows = await tx.attachment.findMany({
    where: { id: { in: attachmentIds }, userId },
    include: { message: { select: { chat: { select: { isDeleted: true } } } } },
  });
  // Owned by someone else or unknown: indistinguishable, never leaked.
  if (rows.length !== attachmentIds.length) throw new NotFoundError("Attachment not found");

  for (const row of rows) {
    if (row.messageId === null) {
      if (row.source !== "UPLOAD" || row.status !== "READY" || !row.url) {
        throw new ValidationError("Only finished uploads can be attached");
      }
      if (row.chatId && row.chatId !== chatId) throw new ValidationError("Attachment belongs to a different chat");
      if (now.getTime() - row.updatedAt.getTime() > ATTACHMENT_USABLE_FOR_MS) {
        throw new ValidationError("An attachment has expired; please upload it again");
      }
    } else if (!isLibraryUsable(row)) {
      throw new ValidationError("This media is no longer available");
    }
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const [order, id] of attachmentIds.entries()) {
    if (byId.get(id)?.messageId === null) {
      const { count } = await tx.attachment.updateMany({
        where: { id, userId, status: "READY", messageId: null },
        data: { messageId, chatId, order },
      });
      if (count !== 1) throw new ConflictError("An attachment was used concurrently");
    }
  }
  await tx.messageAttachment.createMany({
    data: attachmentIds.map((attachmentId, order) => ({ messageId, attachmentId, order })),
  });
}

/** A media-library item: ready, permanently stored, supported, and from a live chat. */
function isLibraryUsable(row: Attachment & { message: { chat: { isDeleted: boolean } } | null }): boolean {
  return (
    row.status === "READY" &&
    !!row.storageKey &&
    isUploadMimeType(row.mimeType) &&
    !!row.message &&
    !row.message.chat.isDeleted
  );
}

/** Media-library listing (see contracts/attachment.ts). Newest first, cursor-paginated by (createdAt, id). */
export async function listMediaLibrary(
  userId: string,
  opts: { cursor?: string; limit: number },
): Promise<MediaLibraryPage> {
  const decoded = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (opts.cursor && !decoded) throw new ValidationError("Invalid cursor");
  const where: Prisma.AttachmentWhereInput = {
    userId,
    status: "READY",
    storageKey: { not: null },
    mimeType: { in: [...UPLOAD_MIME_TYPES] },
    message: { chat: { isDeleted: false } },
    ...(decoded
      ? {
          OR: [
            { createdAt: { lt: new Date(decoded.sortKey) } },
            { createdAt: new Date(decoded.sortKey), id: { lt: decoded.id } },
          ],
        }
      : {}),
  };
  const rows = await prisma.attachment.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: opts.limit + 1,
  });
  const page = rows.slice(0, opts.limit);
  const items = await Promise.all(
    page.map(async (row) => {
      try {
        return await toAttachmentResponse(row, userId);
      } catch (error) {
        // One unsignable file must not fail the whole library: it is listed as unavailable.
        if (!(error instanceof AttachmentUrlUnavailableError)) throw error;
        return toAttachmentResponse({ ...row, storageKey: null, url: null }, userId);
      }
    }),
  );
  const last = page.at(-1);
  const hasMore = rows.length > opts.limit;
  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor({ sortKey: last.createdAt.toISOString(), id: last.id }) : null,
  };
}
