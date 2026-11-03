// Automatic chat titles from a chat's first message.
//
// - One small OpenRouter Free request (the existing adapter: free route only,
//   no tools), cleaned and validated; any failure falls back to a
//   deterministic title built from the message itself.
// - Written only while the title is still NULL, so a manual rename (or an
//   earlier title) always wins and nothing is ever overwritten.
// - Never charged: OpenRouter Free usage is not billed in credits.
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { callOpenRouter, type ProviderMessage } from "@/providers/openrouter";

export const TITLE_MAX_WORDS = 6;
export const TITLE_MAX_CHARS = 50;

const TitleSchema = z.string().min(2).max(TITLE_MAX_CHARS);

/** Words that start a request but don't describe it. */
const FILLER = new Set([
  "please", "pls", "can", "could", "would", "will", "you", "u", "kindly", "hey", "hi", "hello",
  "i", "i'd", "id", "want", "wanna", "need", "like", "to", "me", "help", "just", "lets", "let's",
]);

function words(text: string): string[] {
  return text
    .replace(/https?:\/\/\S+/g, " ") // never put a URL in a title
    .replace(/[\r\n\t]+/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’-]+$/gu, ""))
    .filter(Boolean);
}

/** Caps words and length (on a word boundary), capitalises the first letter. */
function shape(list: string[]): string | null {
  const out: string[] = [];
  for (const w of list.slice(0, TITLE_MAX_WORDS)) {
    if ([...out, w].join(" ").length > TITLE_MAX_CHARS) break;
    out.push(w);
  }
  const title = out.join(" ").trim();
  if (!title) return null;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/** Deterministic title from the user's message (leading filler dropped). */
export function fallbackTitle(message: string): string | null {
  const all = words(message);
  let start = 0;
  while (start < all.length - 1 && FILLER.has(all[start].toLowerCase())) start++;
  const title = shape(all.slice(start));
  return title && TitleSchema.safeParse(title).success ? title : null;
}

/** Cleans a model reply into a title, or null if it isn't one. */
export function cleanModelTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const firstLine = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return null;
  const unlabelled = firstLine.replace(/^(chat\s+)?title\s*[:\-–—]\s*/i, "");
  const unquoted = unlabelled.replace(/^["'“”‘’`*_#\s]+|["'“”‘’`*_#.!?。\s]+$/gu, "");
  const list = words(unquoted);
  if (list.length === 0 || list.length > 12) return null; // a sentence, not a title
  const title = shape(list);
  return title && TitleSchema.safeParse(title).success ? title : null;
}

const TITLE_PROMPT =
  "Write a short title for a chat that starts with the user's message below. " +
  `Reply with the title only: ${TITLE_MAX_WORDS} words at most, no quotes, no punctuation at the end.`;

export type TitleSource = "model" | "fallback";

/** A title for `message`: the model's, cleaned, or the deterministic fallback. Never throws. */
export async function generateTitle(
  message: string,
  call: (messages: ProviderMessage[]) => Promise<{ text: string | null }> = (m) => callOpenRouter(m),
): Promise<{ title: string | null; source: TitleSource }> {
  try {
    const reply = await call([
      { role: "system", content: TITLE_PROMPT },
      { role: "user", content: message.slice(0, 2_000) },
    ]);
    const title = cleanModelTitle(reply.text);
    if (title) return { title, source: "model" };
  } catch (error) {
    console.warn("Chat title generation failed; using fallback", {
      error: error instanceof Error ? error.name : "UnknownError",
    });
  }
  return { title: fallbackTitle(message), source: "fallback" };
}

/** Sets the title only while it is still NULL (manual or earlier titles always win). */
export async function setTitleIfUntitled(chatId: string, title: string): Promise<boolean> {
  const { count } = await prisma.chat.updateMany({ where: { id: chatId, title: null, isDeleted: false }, data: { title } });
  return count === 1;
}

export type TitleOutcome = "titled" | "already_titled" | "no_title" | "not_first_message";

/** The task body: titles an untitled chat from its first (and only) user message. */
export async function titleChatFromFirstMessage(
  chatId: string,
  call?: (messages: ProviderMessage[]) => Promise<{ text: string | null }>,
): Promise<TitleOutcome> {
  const chat = await prisma.chat.findUnique({ where: { id: chatId }, select: { title: true, isDeleted: true } });
  if (!chat || chat.isDeleted || chat.title !== null) return "already_titled";
  const userMessages = await prisma.message.findMany({
    where: { chatId, role: "USER" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 2,
    select: { content: true },
  });
  if (userMessages.length === 0) return "no_title";
  const blocks = (userMessages[0].content as { type?: string; text?: string }[]) ?? [];
  const text = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join(" ").trim();
  if (!text) return "no_title";
  const { title } = await generateTitle(text, call);
  if (!title) return "no_title";
  return (await setTitleIfUntitled(chatId, title)) ? "titled" : "already_titled";
}
