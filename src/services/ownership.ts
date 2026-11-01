import { prisma } from "@/lib/prisma";
import { NotFoundError } from "@/lib/errors";
import type {
  Chat,
  Message,
  AgentRun,
  ToolInvocation,
  Attachment,
  CreditAccount,
} from "@/generated/prisma/client";

/**
 * Reusable ownership checks, one per resource type. Every function takes
 * the userId from an already-authenticated AuthContext (never from
 * request input) and throws NotFoundError — never a 403 — when the
 * resource doesn't exist OR exists but belongs to someone else. The two
 * cases are deliberately indistinguishable so a response never leaks
 * whether another user's resource exists.
 *
 * Checks go through the parent chain they're described against in the
 * assessment (message -> chat, tool invocation -> agent run -> chat) via
 * Prisma relation filters, rather than trusting only a denormalized owner
 * column — defense in depth if a write path ever let them diverge.
 */

export async function requireChatOwnership(
  userId: string,
  chatId: string,
): Promise<Chat> {
  const chat = await prisma.chat.findFirst({
    where: { id: chatId, userId, isDeleted: false },
  });
  if (!chat) throw new NotFoundError("Chat not found");
  return chat;
}

export async function requireMessageOwnership(
  userId: string,
  messageId: string,
): Promise<Message> {
  const message = await prisma.message.findFirst({
    where: { id: messageId, chat: { userId, isDeleted: false } },
  });
  if (!message) throw new NotFoundError("Message not found");
  return message;
}

export async function requireAgentRunOwnership(
  userId: string,
  agentRunId: string,
): Promise<AgentRun> {
  const run = await prisma.agentRun.findFirst({
    where: { id: agentRunId, chat: { userId, isDeleted: false } },
  });
  if (!run) throw new NotFoundError("Agent run not found");
  return run;
}

export async function requireToolInvocationOwnership(
  userId: string,
  toolInvocationId: string,
): Promise<ToolInvocation> {
  const invocation = await prisma.toolInvocation.findFirst({
    where: {
      id: toolInvocationId,
      agentRun: { chat: { userId, isDeleted: false } },
    },
  });
  if (!invocation) throw new NotFoundError("Tool invocation not found");
  return invocation;
}

export async function requireAttachmentOwnership(
  userId: string,
  attachmentId: string,
): Promise<Attachment> {
  // Attachment.userId is the attachment's own authoritative owner, not a
  // denormalized copy — an upload can exist before it's attached to any
  // chat or message, so there's no parent to check through yet.
  const attachment = await prisma.attachment.findFirst({
    where: { id: attachmentId, userId },
  });
  if (!attachment) throw new NotFoundError("Attachment not found");
  return attachment;
}

/** CreditAccount is 1:1 with User — there's no separate untrusted id to
 * check here, the authenticated userId is the only input. Kept as a named
 * function for the same discoverable pattern as the other resources. */
export async function getOwnCreditAccount(
  userId: string,
): Promise<CreditAccount | null> {
  return prisma.creditAccount.findUnique({ where: { userId } });
}

export async function requireCreditLedgerOwnership(userId: string, entryId: string) {
  const entry = await prisma.creditLedger.findFirst({
    where: { id: entryId, userId },
  });
  if (!entry) throw new NotFoundError("Ledger entry not found");
  return entry;
}
