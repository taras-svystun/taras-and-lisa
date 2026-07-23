import { webhookCallback } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import PostalMime from "postal-mime";
import { createBot, type Env } from "./bot";
import { logEvent } from "./logger";

let cachedBotInfo: UserFromGetMe | undefined;

const FALLBACK_MESSAGE =
  "Something went wrong internally and I couldn't finish. Please try again, or send /reset to clear the conversation and start over.";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhooks/pages-deploy") {
      return handlePagesDeployWebhook(request, env);
    }

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
      logEvent({
        type: "uncaught_error",
        level: "error",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      if (chatId !== undefined) {
        await sendTelegramMessage(env, chatId, FALLBACK_MESSAGE);
      } else {
        console.error("No chat id available — could not send a fallback reply.");
      }
      return new Response("OK", { status: 200 });
    }
  },

  // Cloudflare Pages deploy notifications currently arrive as email (Email
  // Routing rule -> this Worker), not the /webhooks/pages-deploy endpoint
  // above — that endpoint is kept working but dormant since webhook
  // notification destinations require a paid Cloudflare plan. Reuses the
  // same composeDeployMessage() as the webhook path so the Telegram wording
  // is identical regardless of which path delivered the notification.
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      // message.raw is a single-use stream — buffer it before parsing.
      const rawBuffer = await new Response(message.raw).arrayBuffer();
      const parsed = await PostalMime.parse(rawBuffer);

      const subject = parsed.subject ?? "";
      const body = parsed.text ?? parsed.html ?? "";

      logEvent({ type: "deploy_email_received", level: "info", subject, body });

      const info = extractDeployInfoFromEmail(subject, body);
      const telegramMessage = composeDeployMessage(info);

      await sendTelegramMessage(env, Number(env.ALLOWED_USER_ID), telegramMessage);
    } catch (err) {
      logEvent({
        type: "deploy_email_error",
        level: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  // The ACTIVE deploy-notification path as of 2026-07-17: Workers Builds ->
  // Event Subscriptions -> the "deploy-events" Queue -> this handler ->
  // Telegram. Both the webhook (`fetch`) and email handlers above are kept
  // working but are now unused leftovers from earlier attempts.
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const message of batch.messages) {
      try {
        logEvent({ type: "build_event_received", level: "info", event: message.body });

        const info = extractBuildEventInfo(message.body);

        if (info.outcome === "ignored") {
          logEvent({ type: "build_event_ignored", level: "info", workerName: info.workerName });
        } else if (info.branch !== "main") {
          // Cloudflare can auto-create other branches (e.g. the
          // cloudflare/workers-autoconfig bot) — those builds shouldn't page
          // the owner over Telegram.
          logEvent({
            type: "build_event_ignored_non_main_branch",
            level: "info",
            workerName: info.workerName,
            branch: info.branch,
          });
        } else {
          const telegramMessage = composeBuildEventMessage(info);
          await sendTelegramMessage(env, Number(env.ALLOWED_USER_ID), telegramMessage);
        }
      } catch (err) {
        logEvent({
          type: "build_event_error",
          level: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }

      // Always ack, even on error — this is a low-stakes notification, not
      // something that needs guaranteed delivery with retries.
      message.ack();
    }
  },
};

// Raw fetch call to the Telegram Bot API, not routed through grammY's ctx or
// bot instance — this must work even when grammY/the bot object itself is what
// broke (used by the outer catch above), and it's also the only "send an
// arbitrary message to a chat id" primitive in this codebase, so the Pages
// deploy webhook below reuses it rather than duplicating the fetch call.
async function sendTelegramMessage(env: Env, chatId: number, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    console.error("Telegram sendMessage call failed:", err);
  }
}

interface DeployInfo {
  project: string;
  environment: string;
  outcome: "success" | "failure" | "unknown";
  url?: string;
}

// Cloudflare's Notifications webhook payload isn't fully documented for Pages
// deployment events — the generic envelope is {name, text, data, ts,
// account_id, policy_id, alert_type, ...} with event-specific detail nested
// under `data`, but the exact field names inside `data` for a Pages
// deployment aren't published. This tries several plausible key names and
// falls back to "unknown"/undefined rather than throwing — refine the key
// names once a real payload has been observed via the cf_deploy_webhook_received
// log line below.
function extractDeployInfo(payload: unknown): DeployInfo {
  const root = payload as Record<string, unknown> | undefined;
  const data = (root?.data as Record<string, unknown> | undefined) ?? {};

  const project =
    firstNonEmptyString(
      data.project_name,
      data.project,
      data.pages_project_name,
      root?.project_name,
      root?.project,
    ) ?? "unknown";

  const environment =
    firstNonEmptyString(data.environment, data.stage, root?.environment) ?? "unknown";

  const url = firstNonEmptyString(
    data.url,
    data.deployment_url,
    data.preview_url,
    data.production_url,
    root?.url,
  );

  const statusText = [data.status, data.stage, root?.alert_event, root?.text]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();

  let outcome: DeployInfo["outcome"] = "unknown";
  if (statusText.includes("fail") || statusText.includes("error")) {
    outcome = "failure";
  } else if (statusText.includes("success") || statusText.includes("succeed") || statusText.includes("passed")) {
    outcome = "success";
  }

  return { project, environment, outcome, url };
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

// Cloudflare's Pages deployment notification EMAIL wording also isn't
// documented ahead of time — same philosophy as extractDeployInfo() above:
// flexible case-insensitive keyword matching over the subject+body, "unknown"
// fallbacks everywhere, never throw on unexpected content. Feeds the same
// DeployInfo shape into the same composeDeployMessage() as the webhook path.
function extractDeployInfoFromEmail(subject: string, body: string): DeployInfo {
  const combined = `${subject}\n${body}`;
  const combinedLower = combined.toLowerCase();

  let outcome: DeployInfo["outcome"] = "unknown";
  if (combinedLower.includes("fail") || combinedLower.includes("error")) {
    outcome = "failure";
  } else if (
    combinedLower.includes("success") ||
    combinedLower.includes("succeed") ||
    combinedLower.includes("passed")
  ) {
    outcome = "success";
  }

  // Only treat "project" as a label when it's followed by a real marker (a
  // quote or a colon) — matching on bare whitespace is too eager and grabs
  // the next word out of unrelated prose (e.g. "...your project\nThere is
  // new activity..." would otherwise wrongly capture "There").
  const projectMatch =
    combined.match(/project[:\s]*["']([a-z0-9][a-z0-9._-]*)["']/i) ??
    combined.match(/project:\s*([a-z0-9][a-z0-9._-]*)/i);
  const project = projectMatch?.[1] ?? "unknown";

  const urlMatch = combined.match(/https?:\/\/[^\s<>"')\]]+/i);

  return { project, environment: "unknown", outcome, url: urlMatch?.[0] };
}

function composeDeployMessage(info: DeployInfo): string {
  if (info.outcome === "success") {
    const urlSuffix = info.url ? ` ${info.url}` : "";
    return `🚀 Deploy succeeded for ${info.project}. Live in a minute or two.${urlSuffix}`;
  }
  if (info.outcome === "failure") {
    return `❌ Deploy failed for ${info.project}. Check the Cloudflare dashboard for build logs. If this was caused by your last edit, send /undo to revert it.`;
  }
  return `ℹ️ Received a deployment event for ${info.project}, status unclear — check the Cloudflare dashboard.`;
}

interface BuildEventInfo {
  workerName: string;
  outcome: "success" | "failure" | "ignored" | "unknown";
  branch?: string;
  commitMessage?: string;
}

// Workers Builds event shape (per Cloudflare's docs, confirmed against a real
// message via the build_event_received log line on first delivery):
// { type: "cf.workersBuilds.worker.build.failed", source: { workerName },
//   payload: { status, buildOutcome, buildTriggerMetadata: { branch, commitMessage, ... } } }
// Same defensive philosophy as extractDeployInfo/extractDeployInfoFromEmail
// above: optional chaining everywhere, "unknown" fallback, never throw on a
// missing/unexpected field. "started"/"cancelled" events are classified as
// "ignored" — the queue handler logs those but doesn't message Telegram.
function extractBuildEventInfo(raw: unknown): BuildEventInfo {
  const root = raw as Record<string, unknown> | undefined;
  const source = root?.source as Record<string, unknown> | undefined;
  const payload = root?.payload as Record<string, unknown> | undefined;
  const triggerMeta = payload?.buildTriggerMetadata as Record<string, unknown> | undefined;

  const workerName =
    firstNonEmptyString(source?.workerName, root?.workerName, payload?.workerName) ?? "unknown";

  const branch = firstNonEmptyString(triggerMeta?.branch);
  const commitMessage = firstNonEmptyString(triggerMeta?.commitMessage);

  const statusText = [root?.type, payload?.status, payload?.buildOutcome]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();

  let outcome: BuildEventInfo["outcome"] = "unknown";
  if (statusText.includes("started") || statusText.includes("cancel")) {
    outcome = "ignored";
  } else if (statusText.includes("fail") || statusText.includes("error")) {
    outcome = "failure";
  } else if (statusText.includes("success") || statusText.includes("succeed")) {
    outcome = "success";
  }

  return { workerName, outcome, branch, commitMessage };
}

// Mirrors composeDeployMessage()'s wording/emoji conventions (🚀/❌/ℹ️, same
// "Deploy {succeeded,failed} for X" opening) but as its own function rather
// than folded into composeDeployMessage — Workers Builds events carry a
// meaningfully different detail shape (branch + commit message vs. a project
// + site URL), so sharing one function would mean branching on which optional
// field happens to be set, which is more confusing than two small functions.
function composeBuildEventMessage(info: BuildEventInfo): string {
  const branchSuffix = info.branch ? ` (${info.branch})` : "";
  if (info.outcome === "success") {
    const commitSuffix = info.commitMessage ? ` ${info.commitMessage}` : "";
    return `🚀 Deploy succeeded for ${info.workerName}${branchSuffix}.${commitSuffix}`;
  }
  if (info.outcome === "failure") {
    return `❌ Deploy failed for ${info.workerName}${branchSuffix}. Check the Cloudflare dashboard for build logs. Send /undo if this was caused by your last edit.`;
  }
  return `ℹ️ Received a build event for ${info.workerName}, status unclear — check the Cloudflare dashboard.`;
}

async function handlePagesDeployWebhook(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get("cf-webhook-auth");
  if (authHeader !== env.CF_WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const payload: unknown = await request.json();

    logEvent({ type: "cf_deploy_webhook_received", level: "info", payload });

    const info = extractDeployInfo(payload);
    const message = composeDeployMessage(info);

    await sendTelegramMessage(env, Number(env.ALLOWED_USER_ID), message);
  } catch (err) {
    logEvent({
      type: "cf_deploy_webhook_error",
      level: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // Always 200 — a non-2xx response makes Cloudflare treat this as a failed
  // delivery and retry aggressively.
  return new Response("OK", { status: 200 });
}
