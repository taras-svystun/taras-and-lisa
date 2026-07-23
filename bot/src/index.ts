import { webhookCallback } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import PostalMime from "postal-mime";
import { createBot, type Env } from "./bot";
import { logUserMessage, logRawDeployMessage, logDeployEvent, logError } from "./logger";
import { traceCreateEvent, spanCreateEvent, sendToLangfuse } from "./langfuse";

let cachedBotInfo: UserFromGetMe | undefined;

const FALLBACK_MESSAGE =
  "Something went wrong internally and I couldn't finish. Please try again, or send /reset to clear the conversation and start over.";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Logged before ANY parsing, validation, or routing — including before
    // the /webhooks/pages-deploy vs /telegram-webhook branch below — so a
    // dropped update always leaves a trace of having arrived at all. Targets
    // a suspected bug where the first message after /start sometimes
    // silently disappears: if it's dropped downstream, this line proves it
    // got here; if it's missing even here, the problem is upstream of the
    // Worker entirely. update_id showing up twice would mean Telegram is
    // redelivering the same webhook.
    let rawUpdate: unknown;
    try {
      rawUpdate = await request.clone().json();
    } catch {
      rawUpdate = undefined;
    }
    const update = rawUpdate as
      | {
          update_id?: number;
          message?: { chat?: { id?: number }; text?: string };
          callback_query?: { data?: string };
        }
      | undefined;
    const chatId = update?.message?.chat?.id;
    const updateId = update?.update_id;
    logUserMessage(chatId, updateId, update?.message?.text ?? update?.callback_query?.data ?? "");

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

    // Top-level try/catch, deliberately outside of anything bot.ts or
    // agent.ts already do internally — this is the last line of defense.
    // See dev-diary.md's "silent field strip → hang" incident: the bot went
    // fully silent once because nothing at this outer layer guaranteed a
    // reply was sent no matter what broke.
    try {
      const bot = createBot(env, cachedBotInfo, ctx);
      if (!cachedBotInfo) {
        await bot.init();
        cachedBotInfo = bot.botInfo;
      }

      const handleUpdate = webhookCallback(bot, "cloudflare-mod");
      return await handleUpdate(request);
    } catch (err) {
      logError({ chatId, step: "webhook_outer_catch", error: err });
      if (chatId !== undefined) {
        await sendTelegramMessage(env, chatId, FALLBACK_MESSAGE);
      } else {
        logError({
          step: "webhook_outer_catch_no_chat_id",
          error: new Error("No chat id available — could not send a fallback reply."),
        });
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

      logRawDeployMessage({ source: "email", raw: { subject, body } });

      const info = extractDeployInfoFromEmail(subject, body);
      const telegramMessage = composeDeployMessage(info);

      await sendTelegramMessage(env, Number(env.ALLOWED_USER_ID), telegramMessage);
    } catch (err) {
      logError({ step: "deploy_email", error: err });
    }
  },

  // The ACTIVE deploy-notification path as of 2026-07-17: Workers Builds ->
  // Event Subscriptions -> the "deploy-events" Queue -> this handler ->
  // Telegram. Both the webhook (`fetch`) and email handlers above are kept
  // working but are now unused leftovers from earlier attempts.
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const message of batch.messages) {
      try {
        logRawDeployMessage({ source: "workers_builds_queue", raw: message.body });

        const info = extractBuildEventInfo(message.body);
        logDeployEvent({
          eventType: info.eventType,
          branch: info.branch,
          commitSha: info.commitHash,
          buildOutcome: info.buildOutcome,
        });

        const isTerminal = info.buildOutcome === "success" || info.buildOutcome === "failure";
        if (isTerminal && info.branch === "main") {
          const telegramMessage = composeBuildEventMessage(info);
          await sendTelegramMessage(env, Number(env.ALLOWED_USER_ID), telegramMessage);
        }
        // Non-terminal (still running / canceled) and non-main-branch builds
        // (e.g. Cloudflare's own cloudflare/workers-autoconfig bot branch)
        // are logged above via logDeployEvent but shouldn't page the owner.

        await correlateWithLangfuseSession(env, ctx, info);
      } catch (err) {
        logError({ step: "build_event_processing", error: err });
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
    logError({ chatId, step: "send_telegram_message", error: err });
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
// names once a real payload has been observed via the raw-payload log line
// in handlePagesDeployWebhook below. No official schema exists for this
// dormant path, unlike extractBuildEventInfo below.
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
    return `❌ Deploy failed for ${info.project}. Check the Cloudflare dashboard for build logs. If this was caused by an edit made through this bot's chat, send /undo to revert it — /undo can't revert manual edits made directly on GitHub.`;
  }
  return `ℹ️ Received a deployment event for ${info.project}, status unclear — check the Cloudflare dashboard.`;
}

interface BuildEventInfo {
  eventType: string;
  workerName: string;
  status: string;
  buildOutcome: string | null;
  branch?: string;
  commitHash?: string;
  commitMessage?: string;
  author?: string;
  createdAt?: string;
  stoppedAt?: string;
}

// Workers Builds event shape, per Cloudflare's documented contract
// (developers.cloudflare.com/workers/ci-cd/builds/event-subscriptions,
// confirmed against the docs 2026-07-23 — not a guess like extractDeployInfo
// above):
//   { type: "cf.workersBuilds.worker.build.<succeeded|failed|canceled|started>",
//     source: { workerName },
//     payload: { status, buildOutcome, createdAt, stoppedAt,
//                buildTriggerMetadata: { branch, commitHash, commitMessage, author, ... } } }
// `status` is "success"/"failed"/"canceled"/"running"; buildOutcome mirrors
// it as "success"/"failure"/"canceled"/null (while running). Optional
// chaining throughout and "unknown" fallbacks so an unexpected/changed shape
// never throws — the raw payload is always logged separately (see queue()
// above) as a permanent safety net in case eventSchemaVersion changes later.
function extractBuildEventInfo(raw: unknown): BuildEventInfo {
  const root = raw as Record<string, unknown> | undefined;
  const source = root?.source as Record<string, unknown> | undefined;
  const payload = root?.payload as Record<string, unknown> | undefined;
  const triggerMeta = payload?.buildTriggerMetadata as Record<string, unknown> | undefined;

  return {
    eventType: typeof root?.type === "string" ? root.type : "unknown",
    workerName: typeof source?.workerName === "string" ? source.workerName : "unknown",
    status: typeof payload?.status === "string" ? payload.status : "unknown",
    buildOutcome: typeof payload?.buildOutcome === "string" ? payload.buildOutcome : null,
    branch: typeof triggerMeta?.branch === "string" ? triggerMeta.branch : undefined,
    commitHash: typeof triggerMeta?.commitHash === "string" ? triggerMeta.commitHash : undefined,
    commitMessage: typeof triggerMeta?.commitMessage === "string" ? triggerMeta.commitMessage : undefined,
    author: typeof triggerMeta?.author === "string" ? triggerMeta.author : undefined,
    createdAt: typeof payload?.createdAt === "string" ? payload.createdAt : undefined,
    stoppedAt: typeof payload?.stoppedAt === "string" ? payload.stoppedAt : undefined,
  };
}

// Mirrors composeDeployMessage()'s wording/emoji conventions (🚀/❌/ℹ️, same
// "Deploy {succeeded,failed} for X" opening) but as its own function rather
// than folded into composeDeployMessage — Workers Builds events carry a
// meaningfully different detail shape (branch + commit message vs. a project
// + site URL), so sharing one function would mean branching on which optional
// field happens to be set, which is more confusing than two small functions.
function composeBuildEventMessage(info: BuildEventInfo): string {
  const branchSuffix = info.branch ? ` (${info.branch})` : "";
  if (info.buildOutcome === "success") {
    const commitSuffix = info.commitMessage ? ` ${stripLangfuseTrailer(info.commitMessage)}` : "";
    return `🚀 Deploy succeeded for ${info.workerName}${branchSuffix}.${commitSuffix}`;
  }
  if (info.buildOutcome === "failure") {
    // /undo only reverts edits made through this bot's own chat — a manual
    // GitHub edit isn't something /undo can find or revert (see undo.ts).
    return `❌ Deploy failed for ${info.workerName}${branchSuffix}. Check the Cloudflare dashboard for build logs. If this was caused by an edit made through this bot's chat, send /undo to revert it — /undo can't revert manual edits made directly on GitHub.`;
  }
  return `ℹ️ Received a build event for ${info.workerName}${branchSuffix}, status unclear — check the Cloudflare dashboard.`;
}

// The Langfuse-Session trailer (added by agent.ts when the bot commits an
// edit) must never leak into a message shown to the owner.
function stripLangfuseTrailer(message: string): string {
  return message.replace(/\n*Langfuse-Session:\s*\S+\s*/g, "").trimEnd();
}

// Correlates a build event back to the chat that triggered it, so the whole
// message -> LLM -> tool calls -> GitHub commit -> deploy outcome lifecycle
// shows up under one Langfuse session, even though the deploy event arrives
// in a separate Worker invocation minutes later. Silently does nothing if
// the commit wasn't made by this bot (no trailer to find) — e.g. a manual
// GitHub edit outside the bot's chat.
async function correlateWithLangfuseSession(
  env: Env,
  ctx: ExecutionContext,
  info: BuildEventInfo,
): Promise<void> {
  const sessionMatch = info.commitMessage?.match(/Langfuse-Session:\s*(\S+)/);
  if (!sessionMatch) return;

  const sessionId = sessionMatch[1];
  const traceId = crypto.randomUUID();
  const startTime = info.createdAt ?? new Date().toISOString();
  const endTime = info.stoppedAt ?? new Date().toISOString();

  const langfuseBatch = [
    traceCreateEvent({
      id: traceId,
      name: "deploy-event",
      sessionId,
      input: { branch: info.branch, commitHash: info.commitHash },
      metadata: { eventType: info.eventType },
    }),
    spanCreateEvent({
      traceId,
      name: "workers-build",
      startTime,
      endTime,
      input: { branch: info.branch, commitHash: info.commitHash },
      output: { status: info.status, buildOutcome: info.buildOutcome },
    }),
  ];
  ctx.waitUntil(sendToLangfuse(env, langfuseBatch));
}

async function handlePagesDeployWebhook(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get("cf-webhook-auth");
  if (authHeader !== env.CF_WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const payload: unknown = await request.json();

    logRawDeployMessage({ source: "webhook", raw: payload });

    const info = extractDeployInfo(payload);
    const message = composeDeployMessage(info);

    await sendTelegramMessage(env, Number(env.ALLOWED_USER_ID), message);
  } catch (err) {
    logError({ step: "pages_deploy_webhook", error: err });
  }

  // Always 200 — a non-2xx response makes Cloudflare treat this as a failed
  // delivery and retry aggressively.
  return new Response("OK", { status: 200 });
}
