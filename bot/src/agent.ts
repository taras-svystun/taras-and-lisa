import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Env } from "./bot";
import { CONTENT_FILES, type ServicesContent } from "./content-schemas";
import { getFile, updateFile, GitHubApiError } from "./github";
import type { ConversationTurn } from "./conversation-memory";

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

1. "site" — the homepage/about/contact copy. Top-level fields: name, heroEyebrow, heroHeadline, heroSubhead, aboutHeading, aboutBody (array of paragraph strings), aboutPhotoAlt, contactHeading, contactBody, email, instagramUrl (optional URL), telegramUrl (optional URL).

2. "services" — the list of services offered. This file is a flat array of objects, each with exactly: id, title, description.

3. "portfolio" — a separate technical/consulting resume page. Top-level fields: eyebrow, heading, subhead, experienceHeading, experience (array of {role, company, period, bullets}), projectsHeading, projectsSubhead, projects (array of {title, description, url}), educationHeading, educationBody (array of HTML strings), ctaHeading, ctaBody, ctaEmail, githubUrl.

RULES — follow all of these exactly:

- Before calling update_content_file for any file, you MUST call read_content_file for that same file first in this conversation, unless you already have its current content from an earlier read_content_file call in this same conversation.
- content passed to update_content_file must be the COMPLETE file content, not a partial patch — you are replacing the whole file. Any field not mentioned by the user must be carried over unchanged from what you read. Losing existing data is the single worst failure mode here — be careful to preserve every field and every array item you were not explicitly asked to change.
- If the user's instruction is ambiguous — for example "update the second service" when you're not sure which one they mean, or a request that doesn't clearly map to any of the three files — do not guess. Respond with a clarifying question and do not call update_content_file.
- You may make multiple edits (calling update_content_file more than once) if the user's message clearly asks for changes to more than one file in a single message.
- The field lists above for each file are COMPLETE and FIXED — you may only ever set values for fields that already exist in a file's schema. Never invent a new field name, and never offer "add a new field" as an option when asking a clarifying question, even if it sounds like the obvious solution. If a request genuinely requires a field that doesn't exist (e.g. a second email address, when "site" only has one "email" field), say plainly that adding a new field requires a code-level schema change you cannot make through chat, and then offer only the options that ARE possible within the current schema (e.g. replace the existing value, or combine multiple values into the single existing field as a formatted string).
- Your final text response goes straight to the site owner over Telegram. Be brief, and confirm exactly what changed in plain language.`;

export async function runAgent(
  env: Env,
  userMessage: string,
  history: ConversationTurn[],
): Promise<{ finalText: string; commits: CommitRecord[] }> {
  const commits: CommitRecord[] = [];

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
      console.log(`[agent] iteration ${iteration + 1}/${MAX_ITERATIONS}`);
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });

      if (response.stop_reason !== "tool_use") {
        return { finalText: extractText(response), commits };
      }

      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const { content, isError } = await executeTool(env, block, commits);
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
    return {
      finalText:
        "This request was too complex or ambiguous for me to finish automatically — I hit my step limit." +
        doneSoFar +
        " Please rephrase your request or break it into smaller steps.",
      commits,
    };
  } catch (err) {
    const commitNote =
      commits.length > 0
        ? `Before the error, I did commit: ${commits.map((c) => `${c.file} (${c.commitUrl})`).join(", ")}.`
        : "No changes were committed.";
    return {
      finalText: `Something went wrong while processing your request: ${errMessage(err)}. ${commitNote}`,
      commits,
    };
  }
}

async function executeTool(
  env: Env,
  block: Anthropic.ToolUseBlock,
  commits: CommitRecord[],
): Promise<{ content: string; isError: boolean }> {
  if (block.name === READ_TOOL_NAME) {
    return handleReadContentFile(env, block.input);
  }
  if (block.name === UPDATE_TOOL_NAME) {
    return handleUpdateContentFile(env, block.input, commits);
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
  const commitMessage = input.commit_message?.trim() || `bot: update ${key}`;

  let result: { commitUrl: string; commitSha: string };
  try {
    result = await updateFile(env, entry.path, newFileText, commitMessage, fresh.sha);
  } catch (err) {
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
    previousInner as Record<string, unknown>,
    newContent as Record<string, unknown>,
  );
}

function summarizeObjectDiff(
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
  return changedKeys.length > 0 ? `Changed field(s): ${changedKeys.join(", ")}.` : "No fields changed.";
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
