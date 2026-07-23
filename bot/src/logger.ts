/**
 * Structured logging for Cloudflare Workers Logs. Every function here emits
 * exactly one console.log call with a single plain object (never a
 * JSON.stringify'd string, never string concatenation) — Cloudflare indexes
 * object fields for dashboard filtering; string logs are text-search only.
 *
 * NEVER pass a secret value (BOT_TOKEN, ANTHROPIC_API_KEY, GITHUB_PAT,
 * WEBHOOK_SECRET, CF_WEBHOOK_SECRET, LANGFUSE_SECRET_KEY) into any of these,
 * including by spreading a full env/config object. If a secret ever needs to
 * appear for debugging, truncate it to its first 6 characters + "...".
 */

function emit(fields: Record<string, unknown>): void {
  console.log({ timestamp: new Date().toISOString(), ...fields });
}

export function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

export function logUserMessage(chatId: number | undefined, updateId: number | undefined, text: string): void {
  emit({
    message: "👤 incoming user message",
    event: "user_message_received",
    chat_id: chatId,
    update_id: updateId,
    text,
  });
}

export function logBotReply(chatId: number, text: string): void {
  emit({
    message: "🤖 outgoing bot reply",
    event: "bot_reply_sent",
    chat_id: chatId,
    text: truncate(text, 300),
  });
}

export function logLlmCallStart(params: {
  chatId: number;
  model: string;
  messageCount: number;
  isRetry: boolean;
}): void {
  emit({
    message: "🧠 LLM call starting",
    event: "llm_call_started",
    chat_id: params.chatId,
    model: params.model,
    message_count: params.messageCount,
    is_retry: params.isRetry,
  });
}

export function logLlmCall(params: {
  chatId: number;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  toolCallCount: number;
}): void {
  emit({
    message: "🧠 LLM call completed",
    event: "llm_call_completed",
    chat_id: params.chatId,
    model: params.model,
    duration_ms: params.latencyMs,
    input_tokens: params.inputTokens,
    output_tokens: params.outputTokens,
    tool_call_count: params.toolCallCount,
  });
}

export function logToolCall(params: {
  chatId: number;
  toolName: string;
  args: unknown;
  result: string;
  latencyMs: number;
  success: boolean;
}): void {
  emit({
    message: params.success ? `✅ tool call succeeded: ${params.toolName}` : `❌ tool call failed: ${params.toolName}`,
    event: "tool_call",
    chat_id: params.chatId,
    tool_name: params.toolName,
    args: params.args,
    result: truncate(params.result, 500),
    duration_ms: params.latencyMs,
    success: params.success,
  });
}

export function logGithubCommit(params: {
  chatId: number;
  file: string;
  commitSha?: string;
  latencyMs: number;
  success: boolean;
}): void {
  emit({
    message: params.success ? `✅ GitHub commit succeeded: ${params.file}` : `❌ GitHub commit failed: ${params.file}`,
    event: "github_commit",
    chat_id: params.chatId,
    file: params.file,
    commit_sha: params.commitSha,
    duration_ms: params.latencyMs,
    success: params.success,
  });
}

// Logged before any extraction/parsing of a deploy-notification message, so
// the exact payload is always captured even if the parser's schema
// assumptions turn out to be wrong — see extractBuildEventInfo in index.ts.
export function logRawDeployMessage(params: { source: "workers_builds_queue" | "webhook" | "email"; raw: unknown }): void {
  emit({
    message: `📦 raw deploy message received (${params.source})`,
    event: "deploy_message_raw",
    source: params.source,
    raw: params.raw,
  });
}

export function logDeployEvent(params: {
  eventType: string;
  branch?: string;
  commitSha?: string;
  buildOutcome?: string | null;
}): void {
  const emoji = params.buildOutcome === "success" ? "✅" : params.buildOutcome === "failure" ? "❌" : "📦";
  emit({
    message: `${emoji} deploy event: ${params.eventType}`,
    event: "deploy_event",
    event_type: params.eventType,
    branch: params.branch,
    commit_sha: params.commitSha,
    build_outcome: params.buildOutcome,
  });
}

export function logError(params: { chatId?: number; step: string; error: unknown }): void {
  const { error } = params;
  emit({
    message: `❌ error in ${params.step}`,
    event: "error",
    chat_id: params.chatId,
    step: params.step,
    error_message: error instanceof Error ? error.message : String(error),
    error_stack: error instanceof Error ? error.stack : undefined,
  });
}
