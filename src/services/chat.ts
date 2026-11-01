import { prisma } from "@/lib/prisma";
import { ValidationError } from "@/lib/errors";
import { requireChatOwnership } from "@/services/ownership";
import { decodeCursor, encodeCursor } from "@/contracts/pagination";
import type {
  ChatResponse,
  CreateChatRequest,
  UpdateChatRequest,
} from "@/contracts/chat";
import type { Chat, Prisma } from "@/generated/prisma/client";

function toChatResponse(chat: Chat): ChatResponse {
  return {
    id: chat.id,
    title: chat.title,
    isPinned: chat.isPinned,
    lastMessageAt: chat.lastMessageAt.toISOString(),
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
  };
}

export async function createChat(
  userId: string,
  input: CreateChatRequest,
): Promise<ChatResponse> {
  const chat = await prisma.chat.create({
    data: { userId, title: input.title },
  });
  return toChatResponse(chat);
}

/** Escapes Postgres ILIKE wildcard characters so a literal "%" or "_" in
 * the user's query is matched literally, not as a wildcard. The query
 * itself is still fully parameterized by Prisma's tagged templates below
 * — this is a correctness fix, not a SQL-injection concern. */
function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

const SEARCH_MATCH_CAP = 500;

/**
 * Chat titles and message content, both matched with ILIKE against the
 * user's own (non-deleted) chats. This is "safe basic search", not full-
 * text search:
 *  - Title: ILIKE on Chat.title — no index exists for this yet (dropped
 *    from checkpoint 1.1's scope; see decisions/0006), so this is a
 *    sequential scan over the user's own chats. Fine at this trial's
 *    scale; would need a GIN/trigram index to stay fast at real scale.
 *  - Content: ILIKE against Message.content cast to text. This DOES
 *    search real message content, but it matches the JSONB column's raw
 *    text representation — it can also match structural JSON (a block's
 *    "type" discriminator, a tool's internal field names, a citation
 *    URL), not only human-readable text. A precise version would extract
 *    just the text/thinking/reasoning/citation block values, which needs
 *    either a generated/indexed text column or jsonb_path queries —
 *    deferred; flagging this explicitly rather than overclaiming
 *    coverage.
 * Capped at 500 matching chat ids as a safety bound, not a real limit for
 * this app's expected data volumes.
 */
async function searchMatchingChatIds(
  userId: string,
  query: string,
): Promise<string[]> {
  const pattern = `%${escapeLikePattern(query)}%`;
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT c.id FROM "Chat" c
    WHERE c."userId" = ${userId} AND c."isDeleted" = false
      AND c.title ILIKE ${pattern}
    UNION
    SELECT DISTINCT m."chatId" AS id FROM "Message" m
    JOIN "Chat" c ON c.id = m."chatId"
    WHERE c."userId" = ${userId} AND c."isDeleted" = false
      AND m.content::text ILIKE ${pattern}
    LIMIT ${SEARCH_MATCH_CAP}
  `;
  return rows.map((r) => r.id);
}

export type ListChatsResult = {
  items: ChatResponse[];
  nextCursor: string | null;
  hasMore: boolean;
};

export async function listChats(
  userId: string,
  opts: { cursor?: string; limit: number; q?: string },
): Promise<ListChatsResult> {
  const decoded = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (opts.cursor && !decoded) {
    throw new ValidationError("Invalid cursor");
  }

  const where: Prisma.ChatWhereInput = { userId, isDeleted: false };

  if (opts.q) {
    const ids = await searchMatchingChatIds(userId, opts.q);
    where.id = { in: ids };
  }

  if (decoded) {
    const cursorDate = new Date(decoded.sortKey);
    where.OR = [
      { lastMessageAt: { lt: cursorDate } },
      { lastMessageAt: cursorDate, id: { lt: decoded.id } },
    ];
  }

  // Pinned-first, then most recently active. No index currently covers
  // isPinned as a leading sort column (see project-docs/decisions/0008)
  // — correct today, a sequential sort rather than an index-order scan
  // at scale.
  const rows = await prisma.chat.findMany({
    where,
    orderBy: [{ isPinned: "desc" }, { lastMessageAt: "desc" }, { id: "desc" }],
    take: opts.limit + 1,
  });

  const hasMore = rows.length > opts.limit;
  const page = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ sortKey: last.lastMessageAt.toISOString(), id: last.id })
      : null;

  return { items: page.map(toChatResponse), nextCursor, hasMore };
}

export async function getChat(userId: string, chatId: string): Promise<ChatResponse> {
  const chat = await requireChatOwnership(userId, chatId);
  return toChatResponse(chat);
}

export async function updateChat(
  userId: string,
  chatId: string,
  input: UpdateChatRequest,
): Promise<ChatResponse> {
  // Ownership check first — a single UPDATE with userId in the WHERE
  // clause would also be safe, but the explicit check keeps the 404-vs-
  // forbidden non-leaking behavior identical to every other resource,
  // and reuses the one ownership function instead of a bespoke query.
  await requireChatOwnership(userId, chatId);
  const chat = await prisma.chat.update({
    where: { id: chatId },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.isPinned !== undefined ? { isPinned: input.isPinned } : {}),
    },
  });
  return toChatResponse(chat);
}

export async function deleteChat(userId: string, chatId: string): Promise<{ id: string }> {
  await requireChatOwnership(userId, chatId);
  const chat = await prisma.chat.update({
    where: { id: chatId },
    data: { isDeleted: true },
  });
  return { id: chat.id };
}
