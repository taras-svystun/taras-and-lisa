import type { Env } from "./bot";
import {
  listRecentCommits,
  getChangedFilesInCommit,
  getFile,
  updateFile,
  GitHubApiError,
} from "./github";

/**
 * Reverts the most recent bot-made commit to the site's content data files.
 * Doesn't import grammY — bot.ts is expected to call this from the /undo
 * command handler and reply with the returned text.
 */

const CONTENT_DIR = "site/src/data";
const BOT_COMMITTER_NAME = "TypeToDeploy Bot";
const RECENT_COMMITS_TO_SCAN = 5;

interface UndoFileResult {
  file: string;
  success: boolean;
  commitUrl?: string;
  error?: string;
}

export async function undoLastBotChange(env: Env): Promise<string> {
  try {
    const commits = await listRecentCommits(env, CONTENT_DIR, RECENT_COMMITS_TO_SCAN);
    // Skip any manual commits made directly by the owner through GitHub's UI —
    // only revert changes the bot itself made.
    const target = commits.find((c) => c.committerName === BOT_COMMITTER_NAME);

    if (!target) {
      return "No recent bot changes found to undo.";
    }
    if (!target.parentSha) {
      return "The most recent bot change has no parent commit to revert to — can't undo it.";
    }

    const changedFiles = (await getChangedFilesInCommit(env, target.sha)).filter((f) =>
      f.startsWith(`${CONTENT_DIR}/`),
    );
    if (changedFiles.length === 0) {
      return "No recent bot changes found to undo.";
    }

    const results: UndoFileResult[] = [];
    for (const file of changedFiles) {
      try {
        const before = await getFile(env, file, target.parentSha);
        // Fetch main's current sha fresh right before writing — never reuse
        // a sha read earlier, it may be stale (same rule as update_content_file).
        const current = await getFile(env, file, "main");
        const { commitUrl } = await updateFile(
          env,
          file,
          before.content,
          `bot: undo previous change to ${file} (reverting: ${target.message})`,
          current.sha,
        );
        results.push({ file, success: true, commitUrl });
      } catch (err) {
        results.push({ file, success: false, error: errMessage(err) });
      }
    }

    return formatUndoReply(results);
  } catch (err) {
    return `Undo failed: ${errMessage(err)}`;
  }
}

function formatUndoReply(results: UndoFileResult[]): string {
  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  const lines: string[] = [];
  if (succeeded.length > 0) {
    lines.push("Reverted:");
    for (const r of succeeded) lines.push(`✅ ${r.file} — ${r.commitUrl}`);
  }
  if (failed.length > 0) {
    if (succeeded.length > 0) lines.push("");
    lines.push("Failed to revert:");
    for (const r of failed) lines.push(`❌ ${r.file}: ${r.error}`);
  }
  return lines.join("\n");
}

function errMessage(err: unknown): string {
  if (err instanceof GitHubApiError) {
    return `GitHub error (status ${err.status}): ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
