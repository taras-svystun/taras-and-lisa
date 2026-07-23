import type { Env } from "./bot";
import { logError } from "./logger";

/**
 * Plain-fetch Langfuse ingestion client. Deliberately does NOT use the
 * official `langfuse` npm SDK — it depends on a Node.js-specific
 * OpenTelemetry exporter that fails on the Cloudflare Workers runtime
 * (reported in a Langfuse GitHub discussion for exactly this Workers/Hono
 * failure mode). The public ingestion HTTP API is a plain POST with Basic
 * auth, which is trivial to call with native fetch() instead.
 */

export interface LangfuseEvent {
  id: string;
  type: string;
  timestamp: string;
  body: Record<string, unknown>;
}

// Reused for both the opening and closing trace-create events for one
// conversation — Langfuse merges events that share a body.id.
export function traceCreateEvent(params: {
  id: string;
  name?: string;
  sessionId?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
}): LangfuseEvent {
  return {
    id: params.id,
    type: "trace-create",
    timestamp: new Date().toISOString(),
    body: {
      id: params.id,
      name: params.name,
      sessionId: params.sessionId,
      input: params.input,
      output: params.output,
      metadata: params.metadata,
    },
  };
}

export function generationCreateEvent(params: {
  traceId: string;
  name: string;
  model: string;
  startTime: string;
  endTime: string;
  input: unknown;
  output: unknown;
  usage: { input: number; output: number };
}): { id: string; event: LangfuseEvent } {
  const id = crypto.randomUUID();
  return {
    id,
    event: {
      id,
      type: "generation-create",
      timestamp: new Date().toISOString(),
      body: {
        id,
        traceId: params.traceId,
        name: params.name,
        startTime: params.startTime,
        endTime: params.endTime,
        model: params.model,
        input: params.input,
        output: params.output,
        usage: params.usage,
      },
    },
  };
}

export function spanCreateEvent(params: {
  traceId: string;
  parentObservationId?: string;
  name: string;
  startTime: string;
  endTime: string;
  input?: unknown;
  output?: unknown;
}): LangfuseEvent {
  const id = crypto.randomUUID();
  return {
    id,
    type: "span-create",
    timestamp: new Date().toISOString(),
    body: {
      id,
      traceId: params.traceId,
      parentObservationId: params.parentObservationId,
      name: params.name,
      startTime: params.startTime,
      endTime: params.endTime,
      input: params.input,
      output: params.output,
    },
  };
}

// A Langfuse failure must never affect the bot's reply to the user — always
// called via ctx.waitUntil() so it adds zero latency either way, but the
// try/catch here is the real safety net.
export async function sendToLangfuse(env: Env, batch: LangfuseEvent[]): Promise<void> {
  if (batch.length === 0) return;
  try {
    const auth = Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`, "utf-8").toString("base64");
    const response = await fetch(`${env.LANGFUSE_HOST}/api/public/ingestion`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ batch }),
    });
    if (!response.ok) {
      logError({
        step: "langfuse_ingestion",
        error: new Error(`Langfuse ingestion returned ${response.status}: ${await response.text()}`),
      });
    }
  } catch (err) {
    logError({ step: "langfuse_ingestion", error: err });
  }
}
