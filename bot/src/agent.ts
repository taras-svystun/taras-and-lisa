import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Env } from "./bot";
import { CONTENT_FILES, type ServicesContent } from "./content-schemas";
import { getFile, updateFile, GitHubApiError } from "./github";
import type { ConversationTurn } from "./conversation-memory";
import { logLlmCallStart, logLlmCall, logToolCall, logGithubCommit, logError } from "./logger";
import { type LangfuseEvent, traceCreateEvent, generationCreateEvent, spanCreateEvent } from "./langfuse";

interface LangfuseTurnContext {
  traceId: string;
  parentObservationId: string;
  batch: LangfuseEvent[];
}

/**
 * The core agentic loop: takes a free-text instruction from the site owner
 * and, through a tool-calling conversation with Claude, either commits one
 * or more content file changes to GitHub or responds without changing
 * anything. Runs on Cloudflare Workers (fetch-based @anthropic-ai/sdk usage
 * only). Telegram (grammY) is not imported here — bot.ts is responsible for
 * turning a Telegram message into a call to runAgent() and rendering the
 * result back to the user.
 */

// One-line change if we ever want to switch models.
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 2048;
const MAX_ITERATIONS = 6;
// Low but non-zero — trims occasional variance-driven scope creep on top of
// the SCOPE CONFINEMENT prompt rules, without fully determinizing the model.
const TEMPERATURE = 0.2;

type ContentFileKey = keyof typeof CONTENT_FILES;
const CONTENT_FILE_KEYS = Object.keys(CONTENT_FILES) as ContentFileKey[];

const READ_TOOL_NAME = "read_content_file";
const UPDATE_TOOL_NAME = "update_content_file";

export interface CommitRecord {
  file: string;
  commitUrl: string;
  diffSummary: string;
}

const tools: Anthropic.Tool[] = [
  {
    name: READ_TOOL_NAME,
    description:
      "Read the current content of one of the site's content files, so you know its exact current shape before editing it. Always call this before update_content_file unless you already read the same file earlier in this conversation.",
    input_schema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          enum: CONTENT_FILE_KEYS,
          description: "Which content file to read.",
        },
      },
      required: ["file"],
    },
  },
  {
    name: UPDATE_TOOL_NAME,
    description:
      "Replace the ENTIRE content of one of the site's content files and commit the change to GitHub. `content` must be the complete file content — every field and array item, not just the parts that changed.",
    input_schema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          enum: CONTENT_FILE_KEYS,
          description: "Which content file to update.",
        },
        content: {},
        commit_message: {
          type: "string",
          description:
            'Optional git commit message. If omitted, a default like "bot: update <file>" is used.',
        },
      },
      required: ["file", "content"],
    },
  },
];

const SYSTEM_PROMPT = `You are the content-editing engine behind a Telegram bot for a small portfolio/business website. The site owner sends you a plain-language instruction, and you either (a) edit the site's content by committing changes to its content files on GitHub, or (b) reply with an explanation or a clarifying question without changing anything.

There are exactly three content files you can read and edit:

1. "site" — the homepage/about/contact copy. Top-level fields, grouped by the page section they belong to:
   - HOME PAGE section: heroEyebrow, heroHeadline, heroSubhead
   - ABOUT section: aboutHeading, aboutBody (array of paragraph strings), aboutPhotoAlt
   - CONTACT section: contactHeading, contactBody, email, instagramUrl (optional URL), telegramUrl (optional URL)
   - Cross-section field with no single owner: name

2. "services" — the list of services offered. Flat array of objects, each with exactly: id, title, description. Each array item is its own scope — "the first service" or "the yoga service" refers to exactly one item, not the whole array.

3. "portfolio" — a separate technical/consulting resume page. Top-level fields, grouped by section:
   - HEADER section: eyebrow, heading, subhead
   - EXPERIENCE section: experienceHeading, experience (array of {role, company, period, bullets})
   - PROJECTS section: projectsHeading, projectsSubhead, projects (array of {title, description, url})
   - EDUCATION section: educationHeading, educationBody (array of HTML strings)
   - CTA section: ctaHeading, ctaBody, ctaEmail, githubUrl

RULES — follow all of these exactly:

- SCOPE CONFINEMENT (this is the rule you have historically gotten wrong — read it twice): when the user's instruction names or clearly implies ONE section (e.g. "home page", "about section", "the yoga service", "contact info"), you may only change fields that belong to that exact section, per the groupings listed above. Never extend a change to a sibling section in the same file just because it feels stylistically consistent to do so — e.g. "add emojis to the home page" touches heroEyebrow/heroHeadline/heroSubhead ONLY, and must NOT touch aboutHeading/aboutBody/contactHeading etc., even though they live in the same "site" file and even though adding emojis there too would also look fine on its own. If the user's instruction clearly names multiple sections or the whole page/site, then all the sections they named are in scope — but never more than what they named or unambiguously implied.

- MANDATORY PRE-COMMIT SELF-CHECK: before calling update_content_file, silently produce a short internal list of every field you are about to change. For each one, confirm it is either (a) explicitly named in the user's instruction, or (b) part of the one specific section/item the user's instruction clearly and singularly refers to. If any field on your list fails both tests, remove it from the update — do not include it just because you already have the file open. If removing it leaves you unsure whether you've correctly captured everything the user actually wants, ask a clarifying question instead of committing a partial guess.

- Before calling update_content_file for any file, you MUST call read_content_file for that same file first in this conversation, unless you already have its current content from an earlier read_content_file call in this same conversation.
- content passed to update_content_file must be the COMPLETE file content, not a partial patch — you are replacing the whole file. Any field not mentioned by the user, and any field outside the scope established by SCOPE CONFINEMENT above, must be carried over unchanged from what you read. Losing existing data, or changing fields outside the requested scope, is the single worst failure mode here — be careful to preserve every field and every array item you were not explicitly asked to change.
- If the user's instruction is ambiguous — for example "update the second service" when you're not sure which one they mean, or a request that doesn't clearly map to any of the three files, or a request where you cannot confidently determine which section(s) are in scope — do not guess. Respond with a clarifying question and do not call update_content_file.
- If the user's instruction is clear - then do exactly what asked, confined exactly to what SCOPE CONFINEMENT allows. If you are unsure whether you understood the user request correctly - do not guess. Respond with a clarifying question and do not call update_content_file.
- You may make multiple edits (calling update_content_file more than once) if the user's message clearly asks for changes to more than one file in a single message.
- The field lists above for each file are COMPLETE and FIXED — you may only ever set values for fields that already exist in a file's schema. Never invent a new field name, and never offer "add a new field" as an option when asking a clarifying question, even if it sounds like the obvious solution. If a request genuinely requires a field that doesn't exist (e.g. a second email address, when "site" only has one "email" field), say plainly that adding a new field requires a code-level schema change you cannot make through chat, and then offer only the options that ARE possible within the current schema (e.g. replace the existing value, or combine multiple values into the single existing field as a formatted string).
- Your final text response goes straight to the site owner over Telegram. Be brief, and confirm exactly what changed in plain language, naming the specific fields or section you touched.

EXAMPLES — study these carefully, they show the exact behavior expected:

Example 1 — section-scoped request, correct behavior:
User: "Add emojis to the home page text to make it funnier. Only to the home page."
Correct action: read_content_file("site"), then update_content_file("site", <full file with emojis added ONLY to heroEyebrow, heroHeadline, heroSubhead — aboutHeading, aboutBody, aboutPhotoAlt, contactHeading, contactBody, email, instagramUrl, telegramUrl, name all unchanged from what was read>).
Correct reply: "Done! Added some emojis to the home page headline and subhead — left the about and contact sections untouched since you asked for home page only."

Example 2 — ambiguous scope, correct behavior:
User: "Make the site sound more fun"
Correct action: no tool call. Ask a clarifying question instead — this could mean the whole site, just the home page, or a specific section, and guessing wrong means editing content the user didn't ask you to touch.
Correct reply: "Happy to! Just to confirm scope — the whole site (home, about, contact), or a specific section?"

Example 3 — single array item, correct behavior:
User: "Update the description of the yoga service to mention it's beginner-friendly"
Correct action: read_content_file("services"), then update_content_file("services", <full array with ONLY the yoga service object's description field changed, every other service object byte-for-byte identical to what was read>).
Correct reply: "Updated the yoga service description to mention it's beginner-friendly. Nothing else changed."

TONE AND STYLE — how you write your responses to the user (this only changes how you talk, not what you're allowed to do):
- Always reply in the same language the user wrote their message in.
- Be clear and concise — get to the point fast. Cut corporate-sounding filler like "I appreciate your request" or "Please note that."
- Use plain, everyday words. Avoid jargon unless the user used it first.
- Keep a casual, friendly tone, like a sharp friend helping out, not a formal assistant.
- Light humor and jokes are welcome when they genuinely fit the moment — but never when something actually broke or the user sounds frustrated. A failed commit is not a punchline.
- This tone applies to every kind of response you generate: confirmations, clarifying questions, and explanations of what went wrong.

FINAL REMINDER (most important rule, repeated because it's the one you've gotten wrong before): touch ONLY the fields inside the section(s) the user actually named or singularly implied. When in doubt about scope, ask — don't guess and don't extend a change further than what was asked, even if the extension seems harmless or stylistically consistent.`;

export async function runAgent(
  env: Env,
  userMessage: string,
  history: ConversationTurn[],
  chatId: number,
  updateId: number,
): Promise<{ finalText: string; commits: CommitRecord[]; langfuseBatch: LangfuseEvent[] }> {
  const commits: CommitRecord[] = [];
  const traceId = crypto.randomUUID();
  const langfuseBatch: LangfuseEvent[] = [
    traceCreateEvent({
      id: traceId,
      name: "telegram-message",
      sessionId: String(chatId),
      input: { text: userMessage },
      metadata: { updateId },
    }),
  ];

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

    // History only ever contains plain text turns — never tool_use/tool_result
    // blocks (see the rule in dev-diary.md). It only affects the starting
    // point of the conversation; the loop mechanics below are unchanged.
    const messages: Anthropic.MessageParam[] = [
      ...history.map((turn) => ({ role: turn.role, content: turn.text })),
      { role: "user", content: userMessage },
    ];

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      console.log();
      logLlmCallStart({
        chatId,
        model: MODEL,
        messageCount: messages.length,
        isRetry: iteration > 0,
      });
      const llmStart = Date.now();
      const llmStartIso = new Date().toISOString();
      const messagesSent = messages.slice();
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });
      const llmEndIso = new Date().toISOString();
      const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      logLlmCall({
        chatId,
        model: MODEL,
        latencyMs: Date.now() - llmStart,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        toolCallCount: toolUseBlocks.length,
      });
      const { id: generationId, event: generationEvent } = generationCreateEvent({
        traceId,
        name: "claude-haiku-tool-call",
        model: MODEL,
        startTime: llmStartIso,
        endTime: llmEndIso,
        input: messagesSent,
        output: response.content,
        usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
      });
      langfuseBatch.push(generationEvent);

      if (response.stop_reason !== "tool_use") {
        const finalText = extractText(response);
        langfuseBatch.push(traceCreateEvent({ id: traceId, output: finalText }));
        return { finalText, commits, langfuseBatch };
      }

      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        const toolStart = Date.now();
        const toolStartIso = new Date().toISOString();
        const { content, isError } = await executeTool(env, block, commits, chatId, {
          traceId,
          parentObservationId: generationId,
          batch: langfuseBatch,
        });
        const toolEndIso = new Date().toISOString();
        logToolCall({
          chatId,
          toolName: block.name,
          args: block.input,
          result: content,
          latencyMs: Date.now() - toolStart,
          success: !isError,
        });
        langfuseBatch.push(
          spanCreateEvent({
            traceId,
            parentObservationId: generationId,
            name: `tool:${block.name}`,
            startTime: toolStartIso,
            endTime: toolEndIso,
            input: block.input,
            output: content,
          }),
        );
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content,
          is_error: isError,
        });
      }
      messages.push({ role: "user", content: toolResults });
    }

    const doneSoFar =
      commits.length > 0
        ? ` Before stopping, I did complete: ${commits.map((c) => `${c.file} (${c.commitUrl})`).join(", ")}.`
        : " I didn't make any changes.";
    const finalText =
      "This request was too complex or ambiguous for me to finish automatically — I hit my step limit." +
      doneSoFar +
      " Please rephrase your request or break it into smaller steps.";
    langfuseBatch.push(traceCreateEvent({ id: traceId, output: finalText }));
    return { finalText, commits, langfuseBatch };
  } catch (err) {
    logError({ chatId, step: "run_agent", error: err });
    const commitNote =
      commits.length > 0
        ? `Before the error, I did commit: ${commits.map((c) => `${c.file} (${c.commitUrl})`).join(", ")}.`
        : "No changes were committed.";
    const finalText = `Something went wrong while processing your request: ${errMessage(err)}. ${commitNote}`;
    langfuseBatch.push(traceCreateEvent({ id: traceId, output: finalText }));
    return { finalText, commits, langfuseBatch };
  }
}

async function executeTool(
  env: Env,
  block: Anthropic.ToolUseBlock,
  commits: CommitRecord[],
  chatId: number,
  lf: LangfuseTurnContext,
): Promise<{ content: string; isError: boolean }> {
  if (block.name === READ_TOOL_NAME) {
    return handleReadContentFile(env, block.input);
  }
  if (block.name === UPDATE_TOOL_NAME) {
    return handleUpdateContentFile(env, block.input, commits, chatId, lf);
  }
  return { content: `Unknown tool: ${block.name}`, isError: true };
}

async function handleReadContentFile(
  env: Env,
  rawInput: unknown,
): Promise<{ content: string; isError: boolean }> {
  const input = rawInput as { file?: string };
  const key = input.file as ContentFileKey;
  const entry = CONTENT_FILES[key];
  if (!entry) {
    return {
      content: `Unknown content file "${input.file}". Valid options: ${CONTENT_FILE_KEYS.join(", ")}.`,
      isError: true,
    };
  }

  try {
    const { content } = await getFile(env, entry.path);
    return { content, isError: false };
  } catch (err) {
    return { content: `Failed to read ${key}: ${errMessage(err)}`, isError: true };
  }
}

async function handleUpdateContentFile(
  env: Env,
  rawInput: unknown,
  commits: CommitRecord[],
  chatId: number,
  lf: LangfuseTurnContext,
): Promise<{ content: string; isError: boolean }> {
  const input = rawInput as { file?: string; content?: unknown; commit_message?: string };
  const key = input.file as ContentFileKey;
  const entry = CONTENT_FILES[key];
  if (!entry) {
    return {
      content: `Unknown content file "${input.file}". Valid options: ${CONTENT_FILE_KEYS.join(", ")}.`,
      isError: true,
    };
  }

  const validation = entry.schema.safeParse(input.content);
  if (!validation.success) {
    return { content: formatZodError(validation.error), isError: true };
  }

  // Re-fetch right before writing — don't reuse a sha read earlier in the
  // conversation, it may be stale.
  let fresh: { content: string; sha: string };
  try {
    fresh = await getFile(env, entry.path);
  } catch (err) {
    return {
      content: `Failed to fetch the current file state before writing: ${errMessage(err)}`,
      isError: true,
    };
  }

  const newFileText = serializeContentFile(key, validation.data);
  // The Langfuse-Session trailer lets the queue() handler correlate a later
  // deploy event back to this chat's trace, even though it arrives in a
  // separate Worker invocation minutes later. Own line, after the subject,
  // so it never changes what the commit message actually says. Must be
  // stripped before ever being shown to the user (see index.ts).
  const subject = input.commit_message?.trim() || `bot: update ${key}`;
  const commitMessage = `${subject}\n\nLangfuse-Session: ${chatId}`;

  let result: { commitUrl: string; commitSha: string };
  const commitStart = Date.now();
  const commitStartIso = new Date().toISOString();
  console.log({
    timestamp: commitStartIso,
    message: `📝 committing to GitHub: ${entry.path}`,
    event: "github_commit_started",
    chat_id: chatId,
    file: entry.path,
  });
  try {
    result = await updateFile(env, entry.path, newFileText, commitMessage, fresh.sha);
    logGithubCommit({
      chatId,
      file: entry.path,
      commitSha: result.commitSha,
      latencyMs: Date.now() - commitStart,
      success: true,
    });
    lf.batch.push(
      spanCreateEvent({
        traceId: lf.traceId,
        parentObservationId: lf.parentObservationId,
        name: "github-commit",
        startTime: commitStartIso,
        endTime: new Date().toISOString(),
        input: { file: entry.path },
        output: { commitUrl: result.commitUrl, commitSha: result.commitSha },
      }),
    );
  } catch (err) {
    logGithubCommit({ chatId, file: entry.path, latencyMs: Date.now() - commitStart, success: false });
    lf.batch.push(
      spanCreateEvent({
        traceId: lf.traceId,
        parentObservationId: lf.parentObservationId,
        name: "github-commit",
        startTime: commitStartIso,
        endTime: new Date().toISOString(),
        input: { file: entry.path },
        output: { error: errMessage(err) },
      }),
    );
    return { content: `Failed to commit the change to GitHub: ${errMessage(err)}`, isError: true };
  }

  const diffSummary = summarizeDiff(key, fresh.content, validation.data);
  commits.push({ file: key, commitUrl: result.commitUrl, diffSummary });

  return {
    content: `Committed successfully. Commit URL: ${result.commitUrl}\n${diffSummary}`,
    isError: false,
  };
}

// site.json / portfolio.json are wrapped as { main: {...} } on disk;
// services.json is a flat array with no wrapper. See content-schemas.ts.
function serializeContentFile(key: ContentFileKey, validated: unknown): string {
  const body = key === "services" ? validated : { main: validated };
  return JSON.stringify(body, null, 2) + "\n";
}

function summarizeDiff(key: ContentFileKey, previousRawText: string, newContent: unknown): string {
  const previousParsed = JSON.parse(previousRawText) as unknown;
  const previousInner =
    key === "services" ? previousParsed : (previousParsed as { main: unknown }).main;

  if (key === "services") {
    return summarizeServicesDiff(previousInner as ServicesContent, newContent as ServicesContent);
  }
  return summarizeObjectDiff(
    key,
    previousInner as Record<string, unknown>,
    newContent as Record<string, unknown>,
  );
}

// Mirrors the section groupings in SYSTEM_PROMPT's SCOPE CONFINEMENT rule, so
// a human glancing at the Telegram confirmation can immediately spot if a
// change touched an unexpected section.
const SECTION_GROUPS: Partial<Record<ContentFileKey, Record<string, string[]>>> = {
  site: {
    Home: ["heroEyebrow", "heroHeadline", "heroSubhead"],
    About: ["aboutHeading", "aboutBody", "aboutPhotoAlt"],
    Contact: ["contactHeading", "contactBody", "email", "instagramUrl", "telegramUrl"],
  },
  portfolio: {
    Header: ["eyebrow", "heading", "subhead"],
    Experience: ["experienceHeading", "experience"],
    Projects: ["projectsHeading", "projectsSubhead", "projects"],
    Education: ["educationHeading", "educationBody"],
    CTA: ["ctaHeading", "ctaBody", "ctaEmail", "githubUrl"],
  },
};

function summarizeObjectDiff(
  key: ContentFileKey,
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>,
): string {
  const changedKeys: string[] = [];
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
  for (const k of allKeys) {
    if (JSON.stringify(oldObj[k]) !== JSON.stringify(newObj[k])) {
      changedKeys.push(k);
    }
  }
  if (changedKeys.length === 0) return "No fields changed.";

  const groups = SECTION_GROUPS[key];
  if (!groups) {
    return `Changed field(s): ${changedKeys.join(", ")}.`;
  }

  const bySection = new Map<string, string[]>();
  const ungrouped: string[] = [];
  for (const field of changedKeys) {
    const section = Object.entries(groups).find(([, fields]) => fields.includes(field))?.[0];
    if (section) {
      const list = bySection.get(section) ?? [];
      list.push(field);
      bySection.set(section, list);
    } else {
      ungrouped.push(field);
    }
  }
  const parts = [...bySection.entries()].map(([section, fields]) => `${section} (${fields.join(", ")})`);
  if (ungrouped.length > 0) parts.push(`Other (${ungrouped.join(", ")})`);
  return `Changed: ${parts.join(", ")}.`;
}

function summarizeServicesDiff(oldArr: ServicesContent, newArr: ServicesContent): string {
  const oldById = new Map(oldArr.map((s) => [s.id, s]));
  const newById = new Map(newArr.map((s) => [s.id, s]));

  const added = [...newById.keys()].filter((id) => !oldById.has(id));
  const removed = [...oldById.keys()].filter((id) => !newById.has(id));
  const changed = [...newById.keys()].filter(
    (id) => oldById.has(id) && JSON.stringify(oldById.get(id)) !== JSON.stringify(newById.get(id)),
  );

  const parts: string[] = [];
  if (added.length > 0) parts.push(`added: ${added.join(", ")}`);
  if (removed.length > 0) parts.push(`removed: ${removed.join(", ")}`);
  if (changed.length > 0) parts.push(`changed: ${changed.join(", ")}`);
  return parts.length > 0 ? `Services ${parts.join("; ")}.` : "No services changed.";
}

function formatZodError(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `- ${path}: ${issue.message}`;
  });
  return `Validation failed for the provided content:\n${lines.join("\n")}`;
}

function extractText(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function errMessage(err: unknown): string {
  if (err instanceof GitHubApiError) {
    return `GitHub error (status ${err.status}): ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
