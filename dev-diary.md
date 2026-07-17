# Dev Diary — taras-and-lisa

Persistent context log for this repo. Read this first before touching anything. Kept intentionally short — put decisions, gotchas, and incidents here; let the code itself document its own structure.

## Project overview

Personal/couple brand site for Taras & Lisa (coaching, mountain guiding, snowboarding), built as a static Astro site, plus a Telegram bot (Cloudflare Worker) that lets the owner edit site content by chatting with it — the bot calls Claude, which reads/writes the site's JSON content files and commits via the GitHub API, triggering a redeploy. The core pipeline (chat → Claude tool-calling → Zod validation → GitHub commit → redeploy) is fully wired and has already been exercised live over real Telegram (see Status log). **Stage 3 (the `/undo` safety-net layer) is complete** and has been live-tested by the owner, including the documented double-undo behavior.

## Repo structure

```
taras-and-lisa/
├── site/     Astro site
└── bot/      Telegram bot (Cloudflare Worker)
```

- npm in both (`package-lock.json` in each), TypeScript everywhere. No shared root `package.json`/workspaces — run `npm`/`astro`/`wrangler` from inside the relevant subfolder.
- Repo root has only `README.md`, `.gitignore`, `dev-diary.md`.

## Site (Astro)

- Astro 7.1.0, Node `>=22.12.0`. Tailwind v4 via `@tailwindcss/vite`.
- Content Collections config: `site/src/content.config.ts` (Astro 5+ path). Three collections, each backed by a JSON file in `site/src/data/`:
  - **site** (`site.json`, wrapped `{ "main": {...} }`, read via `getEntry`): `name, heroEyebrow, heroHeadline, heroSubhead, aboutHeading, aboutBody[], aboutPhotoAlt, contactHeading, contactBody, email, instagramUrl?, telegramUrl?`.
  - **services** (`services.json`, flat array, no wrapper): `{ id, title, description }[]`.
  - **portfolio** (`portfolio.json`, wrapped `{ "main": {...} }`): `eyebrow, heading, subhead, experienceHeading, experience[{role,company,period,bullets[]}], projectsHeading, projectsSubhead, projects[{title,description,url}], educationHeading, educationBody[] (raw HTML, rendered via set:html), ctaHeading, ctaBody, ctaEmail, githubUrl`.
- **Zero hardcoded copy in `.astro` files** — every string traces to these JSON files; that's what makes the site bot-editable.
- 5 pages/nav items: Home/About/Services/Portfolio/Contact.
- Domain: **taras-and-lisa.com**.
- **Hosting — unconfirmed, needs owner check:** originally Cloudflare Pages (root dir `site`). On 2026-07-17, Cloudflare's autoconfig bot (`cloudflare-workers-and-pages[bot]`) pushed a commit adding `site/wrangler.jsonc` + the `@astrojs/cloudflare` adapter, which looks like it converts the site to an SSR Workers deployment. Whether classic Pages is still what's actually serving traffic, or whether this Workers config is now live instead, has not been confirmed against the dashboard. Don't assume either way — check before changing site hosting config.

## Bot (Cloudflare Workers)

- Worker name `typetodeploy-bot` (`bot/wrangler.jsonc`), entry `src/index.ts`, `nodejs_compat` enabled. Telegram lib: **grammY**.
- `bot/src/bot.ts` — allowlist middleware (`ALLOWED_USER_ID` vs `ctx.from.id`, silent reject for non-owners), applied to every command since it's registered via `bot.use()` before any `bot.command(...)`. Commands: `/start` (help text, mentions all three other commands), `/status`, `/reset` (clears KV-backed conversation memory), `/undo` (reverts the most recent bot-made content commit — see `undo.ts` below). `message:text` → sends "⏳ Working on it...", loads history, calls `runAgent()`, replies with `finalText` + a `✅ file: diffSummary — commitUrl` line per commit (or just `finalText` if nothing committed), saves updated history. Has its own try/catch around the `runAgent()` call as a safety net (same pattern used around `/undo`'s `undoLastBotChange()` call).
- `bot/src/conversation-memory.ts` — per-chat history in the `CONVERSATIONS` KV namespace. `ConversationTurn = { role, text }` — **plain text only, never raw `tool_use`/`tool_result` blocks** (see Rules). `MAX_TURNS = 8` (last 4 exchanges), `TTL_SECONDS = 1800`.
- `bot/src/index.ts` — Worker `fetch`: only `POST /telegram-webhook` accepted, checks `X-Telegram-Bot-Api-Secret-Token` against `WEBHOOK_SECRET`, caches `botInfo`, delegates to grammY's `webhookCallback`. **Outer try/catch wraps the entire handler** (bot creation + webhook call) — on any escaping error, sends a fallback reply via a raw `fetch` call straight to the Telegram Bot API (bypassing grammY entirely, using a chat id pre-extracted from a cloned request body) so the owner is never met with total silence. Added 2026-07-17 after an incident where the bot went unresponsive with no fallback at this level — see Status log.
- `bot/src/content-schemas.ts` — Zod schemas mirroring `site/src/content.config.ts` field-for-field (**must be kept in sync manually** — separate npm packages, no shared code). `CONTENT_FILES` maps each key (`site`/`services`/`portfolio`) → `{ path, schema }`. `site`/`portfolio` schemas validate the *inner* object (unwrap/rewrap `.main` around every read/write); `services` validates the flat array directly. **Every `z.object()` here uses `.strict()`** (see Rules — incident-driven).
- `bot/src/github.ts` — GitHub Contents/Commits REST client (`getFile`, `updateFile`, `listRecentCommits`, `getChangedFilesInCommit`, `GitHubApiError`). Uses `GITHUB_PAT`/`GITHUB_OWNER`/`GITHUB_REPO`.
- `bot/src/undo.ts` — `undoLastBotChange(env) → string` (no grammY import, same separation-of-concerns pattern as `agent.ts`). Logic: `listRecentCommits(env, "site/src/data", 5)` → find the most recent one with `committerName === "TypeToDeploy Bot"` (skips manual owner edits made directly on GitHub) → if none, return `"No recent bot changes found to undo."` → `getChangedFilesInCommit()` on that commit, filtered to paths under `site/src/data/` → for each changed file, `getFile()` at the commit's `parentSha` for the "before" content, `getFile()` again at `"main"` for a fresh write-sha, then `updateFile()` writing the parent's content back to `main` with message `"bot: undo previous change to {file} (reverting: {original message})"`. Reports success/failure per file independently (a partial failure across multiple files is surfaced explicitly, never hidden). Whole function has its own top-level try/catch (same belt-and-suspenders contract as `runAgent`) so it returns an explanatory string rather than throwing. **Double-undo is expected behavior, not a bug:** running `/undo` twice in a row finds the first undo's own revert commit as the new "most recent bot commit" and reverts *that* — which re-applies the original change. It's just git history; `/start`'s help text tells the owner this upfront.
- `bot/src/agent.ts` — `runAgent(env, userMessage, history) → { finalText, commits }`. Hand-rolled Claude tool-calling loop (`MODEL = "claude-haiku-4-5-20251001"`, `MAX_TOKENS = 2048`, `MAX_ITERATIONS = 6`, now logs `[agent] iteration N/6` each pass). Two tools: `read_content_file`, `update_content_file` (Zod-validates input, returns `is_error` tool result on failure without touching GitHub, re-fetches `sha` fresh right before writing, wraps/unwraps `.main`, pushes `{file, commitUrl, diffSummary}` to a `commits` side-channel array outside the Claude conversation). System prompt rules: read-before-update, `content` must always be the complete file, ask instead of guessing on ambiguous requests, multiple files may be edited per reply if clearly requested, and **never invent a field not in the schema** — explain the limitation and offer only options the current schema supports instead. A separate **TONE AND STYLE** section (added 2026-07-17) governs only phrasing — reply in the user's language, be concise and casual, no corporate filler, light humor only when nothing's actually broken — and is deliberately kept separate from the RULES section above so behavior/safety rules and writing style don't get tangled together.
- Loop termination verified by manual trace (2026-07-17): the `for` loop runs iterations `0..MAX_ITERATIONS-1`; any non-`tool_use` `stop_reason` returns immediately from inside the loop; if every iteration up to the cap keeps calling tools, the loop exits normally and falls through to a guaranteed `return` with a "hit my step limit" `finalText` listing any commits already made. No off-by-one, no missing return.

## Secrets and environment variables

**Never write actual secret values into this file — variable names only.**

Cloudflare Worker secrets (`wrangler secret list`): `ALLOWED_USER_ID`, `BOT_TOKEN`, `WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `GITHUB_PAT`. All five appear as placeholders in `bot/.dev.vars.example`; the real `bot/.dev.vars` is gitignored.

Plain vars (`bot/wrangler.jsonc` → `"vars"`): `GITHUB_OWNER = "taras-svystun"`, `GITHUB_REPO = "taras-and-lisa"`.

KV binding (`bot/wrangler.jsonc` → `"kv_namespaces"`): `CONVERSATIONS`, id `4ca6550cbce043e789571a9e7955dccd`.

GitHub PAT: fine-grained, scoped to this repo only, `contents: read/write` + `metadata: read` — nothing broader.

## GitHub repo info

Owner **taras-svystun**, repo **taras-and-lisa**, default branch **main**, remote `git@github.com:taras-svystun/taras-and-lisa.git`.

## Rules — things NOT to do

- Never commit secret values anywhere in this repo (code, `.dev.vars`, this diary, commit messages).
- Never assume file structure — read the actual file before editing (this repo has been restructured before).
- Content JSON files (`site/src/data/*.json`) are the source of truth — no hardcoded copy in `.astro` files.
- Don't loosen a Zod schema to make bad data pass — fix the data instead.
- `bot/src/content-schemas.ts` duplicates `site/src/content.config.ts` — if you change one, update the other in the same change.
- `bot/src/github.ts` must use `Buffer.from(...)`, never `btoa`/`atob`, for base64 — `btoa`/`atob` silently corrupt the Ukrainian Cyrillic text in this site's content JSON (English-only test strings won't reveal the bug).
- **Critical invariant:** `content` passed to `update_content_file` must always be the COMPLETE file, never a partial patch — any field a caller omits gets silently deleted from the live site on the next commit.
- Never persist raw `tool_use`/`tool_result` blocks in conversation history — plain `{role, text}` turns only; the agent must always re-read files fresh via `read_content_file`, not trust a stale replayed read.
- **All Zod `z.object()` schemas in `bot/src/content-schemas.ts` must use `.strict()`.** Zod's default "strip mode" silently drops unknown keys instead of erroring — a silent drop here means a false-success commit to production content (see 2026-07-17 incident below). Never remove `.strict()` from an object schema here.
  - **Known follow-up, not yet fixed:** `site/src/content.config.ts`'s schemas do NOT have `.strict()` applied and share the same theoretical blind spot at Astro build time (an unknown key in the JSON would silently pass through rather than fail the build). Out of scope for the bot-side fix — flagging for a future session, not modified as part of this task.
- Always `git fetch` and check for remote-ahead-of-local before pushing on this repo — both the bot itself and Cloudflare's platform integration can commit directly to `main` outside of any local session's knowledge.
- After any scaffolding command or session that creates new top-level files/dirs, verify with `git status` that they show up as trackable.

## Status log

### 2026-07-17 — Agent tone/style pass (no behavior change)
- Added a new **TONE AND STYLE** section to the end of `bot/src/agent.ts`'s `SYSTEM_PROMPT`, clearly separated from the existing **RULES** section — reply in the user's language, be concise, cut corporate filler, casual/friendly voice, light humor allowed only when nothing's actually broken. Purely about phrasing; every existing behavioral rule (read-before-write, complete-file invariant, ask-when-ambiguous, never-invent-a-field, etc.) is untouched, word for word.
- Did a full read-through of the whole system prompt string afterward to confirm it's still coherent — no contradictory phrasing, no duplicated rules, all safety-relevant rules unchanged.
- `npx tsc --noEmit -p .` clean.
- **Real-world confirmation the Stage 3 `/undo` feature works, found while syncing with remote before this change:** the owner had already live-tested `/undo` twice in a row on the real bot — commit `4e1f60f` reverted the `daf843e` email update back to `hello@taras-and-lisa.com`, then commit `150594e` (running `/undo` again) reverted *that* revert, restoring `tatarik.sv@gmail.com` — exactly the documented double-undo behavior, working as designed on the first real try.

### 2026-07-17 — Add /undo command — completes Stage 3
- Added `bot/src/undo.ts` (`undoLastBotChange`) and wired it into a new `/undo` command in `bot/src/bot.ts`, behind the same allowlist middleware as every other command. Full logic documented above under **Bot (Cloudflare Workers)**.
- No new GitHub API surface needed — `listRecentCommits`/`getChangedFilesInCommit` in `github.ts` already existed from the earlier session but had no caller until now.
- Confirmed against real repo history (not executed, read-only reasoning only): `origin/main` currently has a genuine bot-authored commit (`daf843e`, "Update contact email...") as its most recent `site/src/data`-touching commit — that's exactly the shape `/undo` is designed to find and revert.
- Added a one-line mention to `/start`'s help text: `/undo` reverts the most recent bot-made change, and running it twice in a row re-applies the original change (since the second run finds the first run's own revert commit as the new "most recent bot commit"). This is expected/fine, just flagging it so the owner isn't surprised.
- `npx tsc --noEmit -p .` clean. Did not attempt a live GitHub-API dry run in this session — that would require handling the real `GITHUB_PAT` from `bot/.dev.vars`, which wasn't asked for and risked touching production repo state beyond scope; verified by typecheck + a full manual trace of the logic against the task spec instead. Owner should verify live via Telegram per their established testing preference.
- **This completes Stage 3** (the undo/safety-net layer on top of the Stage 2 chat-to-commit pipeline).

### 2026-07-17 — Incident: silent field-strip → false-success commit → bot went unresponsive; three-part fix
- **What happened:** the owner asked the bot to add a second email address. `email` isn't a field in the `site` schema, so the agent stuffed an extra key into the object it sent to `update_content_file`. Zod's default object mode silently strips unknown keys, so validation "succeeded" against content silently reduced back to the original (unchanged) shape. GitHub still created a commit — with an empty diff, since nothing had actually changed — and the agent reported success as if the new field had been added. Separately, at some point after that the bot stopped replying to Telegram entirely (no second message ever sent), meaning an unhandled error occurred somewhere with no fallback reply in place at any layer.
- **Fix, part 1 (`bot/src/content-schemas.ts`):** added `.strict()` to every `z.object()` — `siteSchema`, `portfolioSchema`, and all nested item schemas (`services` items, `experience` items, `project` items). An unknown key now makes `.safeParse()` fail with `"Unrecognized key: ..."`, which the existing `update_content_file` handler already turns into a proper `is_error` tool result Claude can see and react to — no GitHub call happens on that path.
- **Fix, part 2 (`bot/src/agent.ts` system prompt):** added an explicit rule — the agent may only set values for fields that already exist in a file's schema, must never invent a new field, and must never offer "add a new field" as a clarifying-question option. If a request genuinely needs a nonexistent field, it must say plainly that adding fields requires a code change it can't make via chat, then offer only real options (e.g. replace the existing `email`, or combine both addresses into that one field as a formatted string).
- **Fix, part 3 (`bot/src/index.ts` + `bot/src/agent.ts`):** wrapped the entire webhook handler (bot creation + `webhookCallback`) in a top-level try/catch outside everything `bot.ts`/`agent.ts` already do internally; on any escaping error it sends a fallback message via a raw `fetch` call directly to the Telegram Bot API (not through grammY), using a chat id pre-extracted from a cloned copy of the request body — so a reply goes out even if the bot object or grammY itself is what broke. Also added a `console.log` at the top of each `runAgent` loop iteration and manually traced the `MAX_ITERATIONS` cap logic end-to-end to confirm it terminates and returns a `finalText` correctly (documented under **Bot** above) — no bug found there, but it hadn't been verified before, only assumed.
- **Verification:** `bot/src/content-schemas.test-manual.ts` now includes a regression case — real `site.json` content plus an injected `secondaryEmail` key — confirmed it now fails loudly (`✖ Unrecognized key: "secondaryEmail"`) instead of silently passing; the three real content files still pass unchanged. `npx tsc --noEmit -p .` clean.
- **Cloudflare Worker logs:** checked `wrangler tail --help` — confirmed it's a live/forward-only stream with no historical query option, and this environment has no dashboard/browser access, so the actual failure point behind the "bot went unresponsive" symptom could not be confirmed against real logs from that time window. If the owner wants the precise error, it'd need to come from the Cloudflare dashboard's Logs tab for that timestamp.
- **Owner testing note:** try asking the bot to add a second email address again — it should now explain upfront that a new field isn't possible and offer only real options (replace / combine into one field), rather than silently failing.

### Earlier history (condensed)
- **2026-07-17** — Fixed `bot/` and `dev-diary.md` being untracked in git (they were simply never `git add`ed in any prior session — not a nested-repo issue, despite that being the first hypothesis). Pushing surfaced two remote-only commits: a bot-authored commit confirming the bot had already been live-tested over Telegram, and Cloudflare's autoconfig commit converting `site/` toward a Workers SSR deployment (see the Hosting note above). Rebased cleanly and pushed.
- **2026-07-17** — Added KV-backed short-term conversation memory (`conversation-memory.ts`) and the `/reset` command; wired history through `runAgent()`.
- **2026-07-17** — Wired `runAgent()` into `bot.ts`'s `message:text` handler, completing the core chat → edit → commit → deploy pipeline end-to-end for the first time.
- **2026-07-17** — Added `bot/src/agent.ts` (the Claude tool-calling loop) — not yet wired into `bot.ts` at that point.
- **2026-07-17** — Added `bot/src/github.ts` (GitHub Contents/Commits API client).
- **2026-07-17** — Added `bot/src/content-schemas.ts` (Zod validation mirroring the Astro schemas), verified against the real content files via a manual script.
- **2026-07-17** — Wired `ANTHROPIC_API_KEY`/`GITHUB_PAT` secrets and `GITHUB_OWNER`/`GITHUB_REPO` vars into `Env`; installed `@anthropic-ai/sdk` and `zod`.
- **2026-07-17** — Bootstrapped this diary from the pre-existing repo (site + bare bot skeleton already built by the owner).
