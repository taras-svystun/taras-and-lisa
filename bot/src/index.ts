import { webhookCallback } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { createBot, type Env } from "./bot";

let cachedBotInfo: UserFromGetMe | undefined;

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

    const bot = createBot(env, cachedBotInfo);
    if (!cachedBotInfo) {
      await bot.init();
      cachedBotInfo = bot.botInfo;
    }

    try {
      const handleUpdate = webhookCallback(bot, "cloudflare-mod");
      return await handleUpdate(request);
    } catch (err) {
      console.error("Webhook handler error:", err);
      return new Response("OK", { status: 200 });
    }
  },
};
