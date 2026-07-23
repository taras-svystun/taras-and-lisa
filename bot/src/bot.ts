import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { runAgent } from "./agent";
import { loadHistory, saveHistory, clearHistory, type ConversationTurn } from "./conversation-memory";
import { undoLastBotChange } from "./undo";
import { logBotReply, logError } from "./logger";
import { sendToLangfuse } from "./langfuse";

export interface Env {
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ALLOWED_USER_ID: string;
  ANTHROPIC_API_KEY: string;
  GITHUB_PAT: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  CF_WEBHOOK_SECRET: string;
  LANGFUSE_PUBLIC_KEY: string;
  LANGFUSE_SECRET_KEY: string;
  LANGFUSE_HOST: string;
  CONVERSATIONS: KVNamespace;
}

export function createBot(env: Env, botInfo: UserFromGetMe | undefined, cfCtx: ExecutionContext): Bot {
  const bot = new Bot(env.BOT_TOKEN, { botInfo });

  bot.use(async (ctx, next) => {
    if (!ctx.from || String(ctx.from.id) !== env.ALLOWED_USER_ID) {
      if (ctx.from) {
        console.log({
          timestamp: new Date().toISOString(),
          message: "👤 message rejected (user not allowlisted)",
          event: "message_rejected_allowlist",
          user_id: ctx.from.id,
        });
      }
      return;
    }
    await next();
  });

  bot.command("start", (ctx) =>
    ctx.reply(
      "TypeToDeploy is online. Send /status to check health, /reset to clear the conversation memory and start fresh, or /undo to revert the most recent bot-made change. (Running /undo twice in a row re-applies the original change — it's just reverting the revert.)"
    )
  );

  bot.command("status", (ctx) =>
    ctx.reply(`Bot is alive.\nChecked at: ${new Date().toISOString()}`)
  );

  bot.command("reset", async (ctx) => {
    await clearHistory(env, ctx.chat.id);
    await ctx.reply("Memory cleared, starting fresh.");
  });

  bot.command("undo", async (ctx) => {
    await ctx.reply("⏳ Looking for the last bot change to undo...");
    try {
      const result = await undoLastBotChange(env, ctx.chat.id);
      console.log();
      logBotReply(ctx.chat.id, result);
      await ctx.reply(result);
    } catch (err) {
      logError({ chatId: ctx.chat.id, step: "undo_command", error: err });
      await ctx.reply("Something went wrong while trying to undo, please try again.");
    }
  });

  bot.on("message:text", async (ctx) => {
    await ctx.reply("⏳ Working on it...");

    const chatId = ctx.chat.id;

    try {
      const history = await loadHistory(env, chatId);
      const { finalText, commits, langfuseBatch } = await runAgent(
        env,
        ctx.message.text,
        history,
        chatId,
        ctx.update.update_id,
      );

      console.log();

      let replyText: string;
      if (commits.length > 0) {
        const commitLines = commits
          .map((c) => `✅ ${c.file}: ${c.diffSummary} — ${c.commitUrl}`)
          .join("\n");
        replyText = `${finalText}\n\n${commitLines}\n\nSite will update in about a minute.`;
      } else {
        replyText = finalText;
      }
      logBotReply(chatId, replyText);
      cfCtx.waitUntil(sendToLangfuse(env, langfuseBatch));
      await ctx.reply(replyText);

      const updatedHistory: ConversationTurn[] = [
        ...history,
        { role: "user", text: ctx.message.text },
        { role: "assistant", text: finalText },
      ];
      await saveHistory(env, chatId, updatedHistory);
    } catch (err) {
      logError({ chatId, step: "message_handler", error: err });
      await ctx.reply("Something went wrong, please try again.");
    }
  });

  return bot;
}
