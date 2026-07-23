/**
 * Structured logging helper for Workers Logs. Every call site is responsible
 * for including "type" and "level" ("info" | "error") itself — this function
 * only stamps a timestamp and serializes.
 *
 * NEVER pass a secret value (BOT_TOKEN, ANTHROPIC_API_KEY, GITHUB_PAT,
 * WEBHOOK_SECRET) into this, including by spreading a full env/config object.
 */
export function logEvent(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}
