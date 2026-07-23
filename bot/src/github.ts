import type { Env } from "./bot";
import { logEvent } from "./logger";

/**
 * GitHub REST API access via the Contents and Commits APIs. Cloudflare-Workers-only:
 * no Node `fs`/`child_process`, `fetch()` and the `nodejs_compat`-provided global
 * `Buffer` are the only runtime primitives used here.
 *
 * Base64 MUST go through `Buffer.from(str, "utf-8").toString("base64")` /
 * `Buffer.from(base64, "base64").toString("utf-8")`, NOT `btoa`/`atob`. `btoa`/`atob`
 * operate on Latin1 code units and silently corrupt any non-Latin1 text (e.g. the
 * Ukrainian Cyrillic strings that live in this site's content JSON). Do not "simplify"
 * this to btoa/atob later — it will pass tests on English strings and mangle Cyrillic
 * ones in production.
 */

// Verified live against GitHub REST API docs on 2026-07-17 — this value does get
// bumped over time, so re-check developer.github.com if requests start failing.
const GITHUB_API_VERSION = "2026-03-10";
const USER_AGENT = "TypeToDeploy-Bot";

export class GitHubApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.body = body;
  }
}

function apiUrl(env: Env, path: string): string {
  return `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}${path}`;
}

// GitHub's Contents API takes the path unencoded except per-segment, so '/' between
// directories must survive while special characters within a segment get encoded.
function encodeContentPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function githubHeaders(env: Env, extra?: Record<string, string>): HeadersInit {
  return {
    Authorization: `Bearer ${env.GITHUB_PAT}`,
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    ...extra,
  };
}

async function throwIfNotOk(response: Response): Promise<void> {
  if (response.ok) return;

  const body = await response.text();
  if (response.status === 409) {
    throw new GitHubApiError(
      `GitHub API request failed with 409 Conflict — this usually means the file's ` +
        `sha went stale (it changed on GitHub since it was last read). Re-fetch the ` +
        `file and retry with the new sha. Status ${response.status}. Body: ${body}`,
      response.status,
      body,
    );
  }
  throw new GitHubApiError(
    `GitHub API request failed with status ${response.status}. Body: ${body}`,
    response.status,
    body,
  );
}

export async function getFile(
  env: Env,
  path: string,
  ref?: string,
): Promise<{ content: string; sha: string }> {
  const url = new URL(apiUrl(env, `/contents/${encodeContentPath(path)}`));
  if (ref) url.searchParams.set("ref", ref);

  const response = await fetch(url.toString(), { headers: githubHeaders(env) });
  await throwIfNotOk(response);

  const data = (await response.json()) as { type: string; content: string; sha: string };
  if (data.type !== "file") {
    throw new GitHubApiError(
      `Expected a file at path "${path}" but GitHub returned type "${data.type}"`,
      response.status,
      JSON.stringify(data),
    );
  }

  // GitHub line-wraps the base64 payload with embedded \n characters.
  const base64 = data.content.replace(/\n/g, "");
  const content = Buffer.from(base64, "base64").toString("utf-8");

  return { content, sha: data.sha };
}

export async function updateFile(
  env: Env,
  path: string,
  newContent: string,
  commitMessage: string,
  currentSha: string,
): Promise<{ commitUrl: string; commitSha: string }> {
  const url = apiUrl(env, `/contents/${encodeContentPath(path)}`);

  const body = {
    message: commitMessage,
    content: Buffer.from(newContent, "utf-8").toString("base64"),
    sha: currentSha,
    branch: "main",
    committer: {
      name: "TypeToDeploy Bot",
      email: "bot@taras-and-lisa.com",
    },
  };

  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: githubHeaders(env, { "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    await throwIfNotOk(response);

    const data = (await response.json()) as { commit: { html_url: string; sha: string } };
    logEvent({ type: "github_commit", level: "info", file: path, sha: data.commit.sha });
    return { commitUrl: data.commit.html_url, commitSha: data.commit.sha };
  } catch (err) {
    logEvent({
      type: "github_commit_failed",
      level: "error",
      file: path,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function listRecentCommits(
  env: Env,
  path: string,
  limit: number = 5,
): Promise<Array<{ sha: string; message: string; committerName: string; parentSha: string }>> {
  const url = new URL(apiUrl(env, "/commits"));
  url.searchParams.set("path", path);
  url.searchParams.set("sha", "main");
  url.searchParams.set("per_page", String(limit));

  const response = await fetch(url.toString(), { headers: githubHeaders(env) });
  await throwIfNotOk(response);

  const data = (await response.json()) as Array<{
    sha: string;
    commit: {
      message: string;
      committer: { name: string | null } | null;
      author: { name: string | null } | null;
    };
    parents: Array<{ sha: string }>;
  }>;

  return data.map((entry) => ({
    sha: entry.sha,
    message: entry.commit.message,
    committerName: entry.commit.committer?.name ?? entry.commit.author?.name ?? "unknown",
    // Root/initial commits have no parent; there's nothing to diff against for /undo.
    parentSha: entry.parents[0]?.sha ?? "",
  }));
}

export async function getChangedFilesInCommit(env: Env, commitSha: string): Promise<string[]> {
  const url = apiUrl(env, `/commits/${commitSha}`);

  const response = await fetch(url, { headers: githubHeaders(env) });
  await throwIfNotOk(response);

  const data = (await response.json()) as { files?: Array<{ filename: string }> };
  return (data.files ?? []).map((f) => f.filename);
}
