import { webhookCallback } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { createBot, type Env } from "./bot";

let cachedBotInfo: UserFromGetMe | undefined;

const FALLBACK_MESSAGE =
  "Something went wrong internally and I couldn't finish. Please try again, or send /reset to clear the conversation and start over.";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/telegram-webhook") {
      return new Response("Not found", { status: 404 });
    }

    const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secretHeader !== env.WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Extract the chat id from a cloned copy of the body BEFORE handing the
    // request to grammY, so a fallback reply can still be sent — with the
    // right chat id — even if something below throws in a way that bypasses
    // every other layer of error handling (bot.ts's try/catch, agent.ts's
    // try/catch, this handler's own inner try/catch around webhookCallback).
    let chatId: number | undefined;
    try {
      const update = (await request.clone().json()) as { message?: { chat?: { id?: number } } };
      chatId = update.message?.chat?.id;
    } catch (err) {
      console.error("Failed to pre-parse update body for fallback chat id:", err);
    }

    // Top-level try/catch, deliberately outside of anything bot.ts or
    // agent.ts already do internally — this is the last line of defense.
    // See dev-diary.md's "silent field strip → hang" incident: the bot went
    // fully silent once because nothing at this outer layer guaranteed a
    // reply was sent no matter what broke.
    try {
      const bot = createBot(env, cachedBotInfo);
      if (!cachedBotInfo) {
        await bot.init();
        cachedBotInfo = bot.botInfo;
      }

      const handleUpdate = webhookCallback(bot, "cloudflare-mod");
      return await handleUpdate(request);
    } catch (err) {
      console.error("Webhook handler error (outer catch):", err);
      if (chatId !== undefined) {
        await sendFallbackReply(env, chatId);
      } else {
        console.error("No chat id available — could not send a fallback reply.");
      }
      return new Response("OK", { status: 200 });
    }
  },
};

// Raw fetch call to the Telegram Bot API, not routed through grammY's ctx or
// bot instance — this must work even if grammY/the bot object itself is what
// broke.
async function sendFallbackReply(env: Env, chatId: number): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: FALLBACK_MESSAGE }),
    });
  } catch (err) {
    console.error("Fallback Telegram reply itself failed:", err);
  }
}
