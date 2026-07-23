# Dev Diary — taras-and-lisa

Persistent context log for this repo. Read this first before touching anything. Kept intentionally short — put decisions, gotchas, and incidents here; let the code itself document its own structure.

## Project overview

Personal/couple brand site for Taras & Lisa (coaching, mountain guiding, snowboarding): a static Astro site plus a Telegram bot (Cloudflare Worker) that lets the owner edit site content by chatting with it. Bot calls Claude → tool-calling agent reads/writes the site's JSON content files → Zod-validated → committed via the GitHub Contents API → triggers a redeploy. Fully wired and live-tested over real Telegram, including the `/undo` safety-net layer (Stage 3, complete).

## Repo structure

```
taras-and-lisa/
├── site/     Astro site
└── bot/      Telegram bot (Cloudflare Worker)
```

Separate npm projects (own `package-lock.json` each), no shared root package.json/workspaces — run `npm`/`astro`/`wrangler` from inside the relevant subfolder. Repo root has only `README.md`, `.gitignore`, `dev-diary.md`.

## Site (Astro)

- Astro 7.1.0, Node `>=22.12.0`, Tailwind v4. Content Collections (`site/src/content.config.ts`) — three collections, each backed by a JSON file in `site/src/data/`, and that JSON is the *only* source of copy (zero hardcoded strings in `.astro` files, which is what makes the site bot-editable):
  - **site** (`site.json`, wrapped `{main:{...}}`): `name, heroEyebrow, heroHeadline, heroSubhead, aboutHeading, aboutBody[], aboutPhotoAlt, contactHeading, contactBody, email, instagramUrl?, telegramUrl?`
  - **services** (`services.json`, flat array): `{id, title, description}[]`
  - **portfolio** (`portfolio.json`, wrapped `{main:{...}}`): `eyebrow, heading, subhead, experienceHeading, experience[{role,company,period,bullets[]}], projectsHeading, projectsSubhead, projects[{title,description,url}], educationHeading, educationBody[] (raw HTML), ctaHeading, ctaBody, ctaEmail, githubUrl`
- 5 nav pages: Home/About/Services/Portfolio/Contact. Domain: **taras-and-lisa.com**.
- **Hosting — still unconfirmed as of 2026-07-23:** the `@astrojs/cloudflare` adapter + `site/wrangler.jsonc` (Cloudflare Workers-with-static-assets config, pushed by Cloudflare's `cloudflare-workers-and-pages[bot]`) only exist on the separate `cloudflare/workers-autoconfig` branch, not on `main` — confirmed via `git fetch` + `git show`. Whether that branch is merged/live, or classic Pages is still what's serving traffic, hasn't been confirmed against the dashboard. Don't assume either way before touching site hosting config.

## Bot (Cloudflare Workers)

Worker `typetodeploy-bot` (`bot/wrangler.jsonc`), entry `src/index.ts`, `nodejs_compat`. Telegram via **grammY**.

- **`bot/src/bot.ts`** — allowlist middleware (`ALLOWED_USER_ID` vs `ctx.from.id`, silent reject, logged as `message_rejected_allowlist`) gates every command via `bot.use()`. Commands: `/start` (help), `/status`, `/reset` (clears KV history), `/undo` (see below). `message:text` → "⏳ Working on it..." → `runAgent()` → reply with result + a `✅ file: diffSummary — commitUrl` line per commit. Own try/catch around both `runAgent()` and `undoLastBotChange()` as a safety net.
- **`bot/src/conversation-memory.ts`** — per-chat history in `CONVERSATIONS` KV. **Plain `{role, text}` turns only — never raw `tool_use`/`tool_result` blocks** (agent must always re-read files fresh, never trust a replayed read). `MAX_TURNS=8`, `TTL_SECONDS=1800`.
- **`bot/src/index.ts`** — exports `fetch`, `email`, `queue`. **Only `queue` is the active deploy-notification path**: Workers Builds → Event Subscription → `deploy-events` Queue → `queue(batch, env, ctx)` → Telegram, filtered to `branch === "main"` only (Cloudflare's own `cloudflare/workers-autoconfig` branch triggers builds too, and shouldn't page anyone). `fetch`'s `POST /webhooks/pages-deploy` and the `email()` handler are **dormant leftovers, kept working but unused** (webhook needed a paid plan; email got superseded once Workers Builds' structured event data became available). `fetch` also serves the real `POST /telegram-webhook` route (unrelated to deploy notifications) with an outer try/catch that sends a fallback Telegram reply on any uncaught error, so the bot is never silently unresponsive. All paths share one `sendTelegramMessage(env, chatId, text)` helper (raw fetch to Telegram's API, bypasses grammY).
- **`bot/src/content-schemas.ts`** — Zod schemas mirroring `site/src/content.config.ts` field-for-field (**manually kept in sync — no shared code**). **Every `z.object()` uses `.strict()`** (incident-driven, see below — never remove). `site/src/content.config.ts`'s own schemas do *not* have `.strict()` yet — known gap, out of scope so far.
- **`bot/src/github.ts`** — GitHub Contents/Commits REST client. **Must use `Buffer.from(...)`, never `btoa`/`atob`** — the latter silently corrupts the Cyrillic text in this site's content.
- **`bot/src/undo.ts`** — `undoLastBotChange(env)`. Scans the last 5 commits touching `site/src/data`, finds the most recent one whose **committer name is exactly `"TypeToDeploy Bot"`**, and reverts only that. **It does NOT revert "the latest commit on main" generically** — a manual GitHub-web-UI edit is silently skipped, not reverted (confirmed by direct code read, 2026-07-17). If no bot commit is found in the last 5, it just says so and does nothing else. Double-undo (running it twice in a row) re-applies the original change — expected, not a bug, documented in `/start`'s help text.
- **`bot/src/agent.ts`** — `runAgent()`, hand-rolled Claude tool-calling loop (`MODEL="claude-haiku-4-5-20251001"`, `MAX_TOKENS=2048`, `MAX_ITERATIONS=6`, loop termination manually verified — no off-by-one). Two tools: `read_content_file`, `update_content_file`. **Critical invariant: `content` passed to `update_content_file` must always be the COMPLETE file** — any omitted field is silently deleted on the next commit. System prompt also forbids inventing fields not in a schema. Separate TONE AND STYLE block governs phrasing only (casual, user's language, no corporate filler).

## Secrets and environment variables

**Never write actual secret values into this file — names only.**

Cloudflare Worker secrets: `ALLOWED_USER_ID`, `BOT_TOKEN`, `WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `GITHUB_PAT`, `CF_WEBHOOK_SECRET`. All six placeholders in `bot/.dev.vars.example`; real `bot/.dev.vars` is gitignored. `CF_WEBHOOK_SECRET` guards the now-dormant `/webhooks/pages-deploy` route (checked against `cf-webhook-auth` header) — never set by any session, still needs `wrangler secret put CF_WEBHOOK_SECRET` if that path is ever revived.

Plain vars (`bot/wrangler.jsonc`): `GITHUB_OWNER="taras-svystun"`, `GITHUB_REPO="taras-and-lisa"`. KV binding: `CONVERSATIONS` (id `4ca6550cbce043e789571a9e7955dccd`). Queue consumer: `deploy-events`.

GitHub PAT: fine-grained, scoped to this repo only, `contents: read/write` + `metadata: read`.

## GitHub repo info

Owner **taras-svystun**, repo **taras-and-lisa**, default branch **main**, remote `git@github.com:taras-svystun/taras-and-lisa.git`.

## Rules — things NOT to do

- Never commit secret values anywhere in this repo (code, `.dev.vars`, this diary, commit messages, logs — `logEvent` calls must pass individual scalar fields, never spread `env`).
- Never assume file structure — read the actual file before editing (this repo has been restructured before).
- Content JSON files (`site/src/data/*.json`) are the source of truth — no hardcoded copy in `.astro` files.
- Don't loosen a Zod schema to make bad data pass — fix the data instead.
- `bot/src/content-schemas.ts` duplicates `site/src/content.config.ts` — changing one means updating the other in the same change.
- `bot/src/github.ts` must use `Buffer.from(...)`, never `btoa`/`atob` (Cyrillic corruption bug).
- `content` passed to `update_content_file` must always be the COMPLETE file, never a partial patch.
- Never persist raw `tool_use`/`tool_result` blocks in conversation history.
- **All Zod `z.object()` schemas in `bot/src/content-schemas.ts` must use `.strict()`** — silent unknown-key stripping caused a false-success production commit once (see incident below). Never remove it.
- Always `git fetch` and check remote-ahead-of-local before pushing — the bot and Cloudflare's platform integration can both commit to `main` outside any local session's knowledge.
- After scaffolding new top-level files/dirs, verify with `git status` that they're trackable.

## Open items (not yet resolved)

- Confirm whether `site/` hosting is classic Pages or the Workers-with-static-assets setup on `cloudflare/workers-autoconfig` — and whether that branch should be merged to `main`.
- `site/src/content.config.ts` schemas still lack `.strict()` (bot-side schemas already fixed; Astro-side is a known, unaddressed gap).
- Confirm the Workers Builds Event Subscription is actually configured to publish to the `deploy-events` queue (consumer side is wired; publish side unverified).
- `README.md` references `docs/screenshot.png` and `docs/demo.gif` — neither exists yet; owner needs to add both.
- Real-world event/payload shapes for all three deploy-notification paths (webhook JSON, email text, Workers Builds queue message) were guessed defensively, never confirmed against a real delivery — revisit `extractDeployInfo`/`extractDeployInfoFromEmail`/`extractBuildEventInfo` in `bot/src/index.ts` if/when real data disagrees.
- The deploy-failure Telegram message says "send /undo if this was caused by your last edit" — technically only true for edits made through the bot's chat, not manual GitHub edits (`/undo` can't revert those). Minor wording nuance, not fixed.

## History (condensed)

All entries below are from the initial build-out on **2026-07-17** (multiple sessions same day).

- **README.md** rewritten as a portfolio-quality doc (architecture diagram, tech stack, roadmap) — corrected to describe Workers-with-static-assets + Workers Builds, not Pages/webhooks.
- **`/undo` scope investigated** (read-only session) and confirmed as documented above; identified `site/src/data/portfolio.json`'s `ctaEmail` field as a safe manual break/restore target for deploy-failure testing.
- **Deploy notifications, three iterations**, each superseding the last but left in place as dormant code: (1) a `POST /webhooks/pages-deploy` endpoint guarded by `CF_WEBHOOK_SECRET` — abandoned, needs a paid Cloudflare plan; (2) an `email()` handler parsing Cloudflare notification emails via `postal-mime` — abandoned once Workers Builds' structured events became available (also fixed a regex bug where "project" + any word wrongly matched unrelated prose); (3) **the current active path** — a `queue()` handler consuming Workers Builds events from the `deploy-events` Queue, later filtered to `branch === "main"` only. All three share message-composition helpers with consistent 🚀/❌/ℹ️ wording. Local testing gotcha discovered and reused throughout: this Wrangler version (4.111.0) has no local Queues/email simulation, so handlers were tested by direct `tsx` invocation of the exported function with a hand-built batch/message.
- **Structured logging** added via Workers Logs (`bot/src/logger.ts`, `logEvent`) across all handlers — message lifecycle, LLM calls/tool use, content validation, GitHub commits, `/undo`, uncaught errors. Hard rule: never log secrets.
- **Agent tone pass** — added a TONE AND STYLE block to the system prompt (casual, user's language) without touching any behavioral rule.
- **`/undo` command added**, completing Stage 3. Confirmed live via real double-undo on Telegram (commit `4e1f60f` then `150594e`).
- **Incident:** owner asked the bot to add a field (`email`) that isn't in `site.json`'s schema. Zod's default mode silently stripped the unknown key, producing an empty-diff "successful" commit, and the bot later went fully unresponsive with no fallback reply anywhere. Three-part fix: `.strict()` on every content schema, an explicit system-prompt rule against inventing fields, and the outer try/catch + fallback Telegram reply now in `index.ts`.
- **Bootstrap:** diary created; `bot/`+`dev-diary.md` fixed from being untracked in git; `github.ts`, `content-schemas.ts`, `agent.ts` added and wired end-to-end into `bot.ts`'s message handler; KV-backed conversation memory and `/reset` added; secrets/vars wired into `Env`.
