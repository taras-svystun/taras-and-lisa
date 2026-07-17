import type { Env } from "./bot";

/**
 * Short-term conversational memory, scoped per Telegram chat, backed by the
 * CONVERSATIONS KV namespace. This is ONLY for plain-text conversational
 * context (e.g. "did I already ask a clarifying question?") — never for
 * tool_use/tool_result blocks. See the rule in dev-diary.md: file contents
 * go stale between messages, so the agent must always re-read files fresh
 * via read_content_file; memory here is not a cache for that.
 */

export type ConversationTurn = { role: "user" | "assistant"; text: string };

// Keeps the last 4 user/assistant exchanges — enough for follow-up context
// (e.g. "the agent asked a clarifying question, the user answers next
// message") without growing the prompt (and token cost) unboundedly.
const MAX_TURNS = 8;

// 30 minutes of inactivity auto-expires the conversation. After that, the
// next message starts fresh — matches how someone would naturally use this:
// a burst of edits in one sitting, not one long-running conversation.
const TTL_SECONDS = 1800;

function conversationKey(chatId: number): string {
  return `conv:${chatId}`;
}

export async function loadHistory(env: Env, chatId: number): Promise<ConversationTurn[]> {
  const raw = await env.CONVERSATIONS.get(conversationKey(chatId));
  if (raw === null) return [];

  try {
    return JSON.parse(raw) as ConversationTurn[];
  } catch (err) {
    console.error(`Corrupted conversation history for chat ${chatId}:`, err);
    return [];
  }
}

export async function saveHistory(
  env: Env,
  chatId: number,
  history: ConversationTurn[],
): Promise<void> {
  const trimmed = history.slice(-MAX_TURNS);
  await env.CONVERSATIONS.put(conversationKey(chatId), JSON.stringify(trimmed), {
    expirationTtl: TTL_SECONDS,
  });
}

export async function clearHistory(env: Env, chatId: number): Promise<void> {
  await env.CONVERSATIONS.delete(conversationKey(chatId));
}
