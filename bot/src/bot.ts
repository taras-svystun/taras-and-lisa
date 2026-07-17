import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { runAgent } from "./agent";
import { loadHistory, saveHistory, clearHistory, type ConversationTurn } from "./conversation-memory";
import { undoLastBotChange } from "./undo";

export interface Env {
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ALLOWED_USER_ID: string;
  ANTHROPIC_API_KEY: string;
  GITHUB_PAT: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  CONVERSATIONS: KVNamespace;
}

export function createBot(env: Env, botInfo?: UserFromGetMe): Bot {
  const bot = new Bot(env.BOT_TOKEN, { botInfo });

  bot.use(async (ctx, next) => {
    if (!ctx.from || String(ctx.from.id) !== env.ALLOWED_USER_ID) {
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
      const result = await undoLastBotChange(env);
      await ctx.reply(result);
    } catch (err) {
      console.error("Undo command failed unexpectedly:", err);
      await ctx.reply("Something went wrong while trying to undo, please try again.");
    }
  });

  bot.on("message:text", async (ctx) => {
    await ctx.reply("⏳ Working on it...");

    const chatId = ctx.chat.id;

    try {
      const history = await loadHistory(env, chatId);
      const { finalText, commits } = await runAgent(env, ctx.message.text, history);

      if (commits.length > 0) {
        const commitLines = commits
          .map((c) => `✅ ${c.file}: ${c.diffSummary} — ${c.commitUrl}`)
          .join("\n");
        await ctx.reply(`${finalText}\n\n${commitLines}\n\nSite will update in about a minute.`);
      } else {
        await ctx.reply(finalText);
      }

      const updatedHistory: ConversationTurn[] = [
        ...history,
        { role: "user", text: ctx.message.text },
        { role: "assistant", text: finalText },
      ];
      await saveHistory(env, chatId, updatedHistory);
    } catch (err) {
      console.error("Agent run failed:", err);
      await ctx.reply("Something went wrong, please try again.");
    }
  });

  return bot;
}
