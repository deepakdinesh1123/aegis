import { mapWithConcurrency } from "./concurrency.js";
import type { AppContext } from "./github.js";
import {
  getPullRequestState,
  savePullRequestState,
} from "./state.js";

export const OVERLAP_COMMENT_MARKER = "<!-- aegis-file-overlap -->";

const MAX_CONCURRENT_FILE_FETCHES = 10;
const MAX_FILES_SHOWN = 5;

export interface FileOverlap {
  pullRequestNumber: number;
  overlappingFiles: string[];
}

export interface OverlapReportOptions {
  maxConcurrentFetches?: number;
}

/**
 * List changed filenames for a pull request from GitHub.
 */
export async function listPullRequestFiles(
  context: AppContext,
  pullRequestNumber: number,
): Promise<string[]> {
  const { owner, repo } = context.repo();

  const files = await context.octokit.paginate(
    context.octokit.rest.pulls.listFiles,
    {
      owner,
      repo,
      pull_number: pullRequestNumber,
      per_page: 100,
    },
  );

  return files.map((file) => file.filename);
}

/**
 * Return changed files for a PR, preferring the DynamoDB cache when it
 * matches the given head SHA. Only hits GitHub when the cache is missing
 * or stale, then writes the fresh list back when state already exists.
 */
export async function getChangedFiles(
  context: AppContext,
  repository: string,
  pullRequestNumber: number,
  headSha: string,
): Promise<string[]> {
  const previous = await getPullRequestState(repository, pullRequestNumber);

  if (
    previous?.changed_files &&
    previous.changed_files_sha === headSha
  ) {
    return previous.changed_files;
  }

  const files = await listPullRequestFiles(context, pullRequestNumber);

  if (previous) {
    await savePullRequestState({
      ...previous,
      changed_files: files,
      changed_files_sha: headSha,
      observed_at: new Date().toISOString(),
    });
  }

  return files;
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function formatFileList(files: string[]): string {
  const shown = files.slice(0, MAX_FILES_SHOWN).map(basename);
  const extra = files.length - shown.length;

  if (extra > 0) {
    return `${shown.join(", ")} +${extra} more`;
  }

  return shown.join(", ");
}

function overlapEmoji(count: number): string {
  if (count >= 2) {
    return "🔴";
  }

  return "🟠";
}

function pad(value: string, width: number): string {
  if (value.length >= width) {
    return value.slice(0, width);
  }

  return value + " ".repeat(width - value.length);
}

/**
 * Build the ASCII overlap table shown in the PR comment.
 */
export function formatOverlapTable(overlaps: FileOverlap[]): string {
  const rows = overlaps.map((overlap) => {
    const count = overlap.overlappingFiles.length;
    const pr = `#${overlap.pullRequestNumber}`;
    const files = formatFileList(overlap.overlappingFiles);
    const summary = `${count} file${count === 1 ? "" : "s"} ${overlapEmoji(count)}`;

    return { pr, files, summary };
  });

  const prWidth = Math.max(6, ...rows.map((row) => row.pr.length));
  const filesWidth = Math.max(5, ...rows.map((row) => row.files.length));
  const overlapWidth = Math.max(7, ...rows.map((row) => row.summary.length));

  const line = (left: string, mid: string, right: string, fill: string) =>
    left +
    fill.repeat(prWidth + 2) +
    mid +
    fill.repeat(filesWidth + 2) +
    mid +
    fill.repeat(overlapWidth + 2) +
    right;

  const row = (pr: string, files: string, summary: string) =>
    `│ ${pad(pr, prWidth)} │ ${pad(files, filesWidth)} │ ${pad(summary, overlapWidth)} │`;

  const lines = [
    line("┌", "┬", "┐", "─"),
    row("PR", "Files", "Overlap"),
    line("├", "┼", "┤", "─"),
    ...rows.map((entry) => row(entry.pr, entry.files, entry.summary)),
    line("└", "┴", "┘", "─"),
  ];

  return lines.join("\n");
}

export function buildOverlapCommentBody(overlaps: FileOverlap[]): string {
  if (overlaps.length === 0) {
    return [
      OVERLAP_COMMENT_MARKER,
      "",
      "### File overlap check",
      "",
      "No overlapping file changes with other open PRs targeting the same base branch.",
    ].join("\n");
  }

  const sorted = [...overlaps].sort(
    (a, b) =>
      b.overlappingFiles.length - a.overlappingFiles.length ||
      a.pullRequestNumber - b.pullRequestNumber,
  );

  return [
    OVERLAP_COMMENT_MARKER,
    "",
    "### File overlap with other open PRs",
    "",
    "These open PRs modify some of the same files as this one:",
    "",
    "```",
    formatOverlapTable(sorted),
    "```",
  ].join("\n");
}

/**
 * Compare this PR's files against other open PRs on the same base branch.
 *
 * Fetches files from GitHub only for PRs whose cached `changed_files` is
 * missing or was captured for a different head SHA. Peer PRs that were
 * already synced use DynamoDB and are not re-listed from the API.
 */
export async function findFileOverlaps(
  context: AppContext,
  pullRequestNumber: number,
  baseBranch: string,
  options: OverlapReportOptions & { headSha?: string } = {},
): Promise<FileOverlap[]> {
  const { owner, repo } = context.repo();
  const repository = `${owner}/${repo}`;
  const concurrency =
    options.maxConcurrentFetches ?? MAX_CONCURRENT_FILE_FETCHES;

  const currentState = await getPullRequestState(repository, pullRequestNumber);
  const currentHeadSha = options.headSha ?? currentState?.head_sha;

  if (!currentHeadSha) {
    context.log.warn(
      `No head SHA available for PR #${pullRequestNumber}; skipping overlap report`,
    );
    return [];
  }

  const currentFiles = await getChangedFiles(
    context,
    repository,
    pullRequestNumber,
    currentHeadSha,
  );
  const currentSet = new Set(currentFiles);

  if (currentSet.size === 0) {
    return [];
  }

  const openPRs = (await context.octokit.paginate(
    context.octokit.rest.pulls.list,
    {
      owner,
      repo,
      state: "open",
      base: baseBranch,
      per_page: 100,
    },
  )) as Array<{ number: number; head: { sha: string } }>;

  const others = openPRs.filter((pr) => pr.number !== pullRequestNumber);

  const overlaps = await mapWithConcurrency(
    others,
    concurrency,
    async (pr) => {
      const peerState = await getPullRequestState(repository, pr.number);
      if (peerState?.status === "closed") {
        return null;
      }

      const files = await getChangedFiles(
        context,
        repository,
        pr.number,
        pr.head.sha,
      );
      const overlappingFiles = files.filter((file) => currentSet.has(file));

      if (overlappingFiles.length === 0) {
        return null;
      }

      return {
        pullRequestNumber: pr.number,
        overlappingFiles,
      } satisfies FileOverlap;
    },
  );

  return overlaps.filter((overlap): overlap is FileOverlap => overlap !== null);
}

async function findOverlapCommentId(
  context: AppContext,
  pullRequestNumber: number,
  knownId?: number,
): Promise<number | undefined> {
  if (knownId) {
    return knownId;
  }

  const { owner, repo } = context.repo();

  const comments = await context.octokit.paginate(
    context.octokit.rest.issues.listComments,
    {
      owner,
      repo,
      issue_number: pullRequestNumber,
      per_page: 100,
    },
  );

  for (const comment of comments) {
    if (comment.body?.includes(OVERLAP_COMMENT_MARKER)) {
      return comment.id;
    }
  }

  return undefined;
}

/**
 * Upsert the overlap report comment on a PR and persist its comment id.
 *
 * Creates a comment only when there is at least one overlap.
 * If a prior comment exists and overlaps clear, updates that comment
 * instead of posting a new one.
 */
export async function upsertOverlapComment(
  context: AppContext,
  pullRequestNumber: number,
  overlaps: FileOverlap[],
): Promise<number | undefined> {
  const { owner, repo } = context.repo();
  const repository = `${owner}/${repo}`;
  const body = buildOverlapCommentBody(overlaps);

  const previous = await getPullRequestState(repository, pullRequestNumber);

  if (overlaps.length === 0 && !previous?.overlap_comment_id) {
    return undefined;
  }

  let existingId = previous?.overlap_comment_id;

  if (!existingId && overlaps.length > 0) {
    existingId = await findOverlapCommentId(context, pullRequestNumber);
  }

  let commentId: number;

  if (existingId) {
    try {
      await context.octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existingId,
        body,
      });
      commentId = existingId;
    } catch (error) {
      context.log.warn(
        `Failed to update overlap comment ${existingId} on PR #${pullRequestNumber}; creating a new one`,
      );
      context.log.warn(error as Error);

      if (overlaps.length === 0) {
        return existingId;
      }

      const { data: comment } =
        await context.octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: pullRequestNumber,
          body,
        });
      commentId = comment.id;
    }
  } else {
    const { data: comment } =
      await context.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullRequestNumber,
        body,
      });
    commentId = comment.id;
  }

  if (previous) {
    await savePullRequestState({
      ...previous,
      overlap_comment_id: commentId,
      observed_at: new Date().toISOString(),
    });
  }

  return commentId;
}

/**
 * Resolve base branch / open status from stored state when possible,
 * falling back to the GitHub API (e.g. mergeability refresh failed).
 */
async function resolveOpenPullRequestBase(
  context: AppContext,
  pullRequestNumber: number,
): Promise<string | null> {
  const { owner, repo } = context.repo();
  const repository = `${owner}/${repo}`;
  const previous = await getPullRequestState(repository, pullRequestNumber);

  if (previous) {
    if (previous.status === "closed") {
      return null;
    }

    return previous.base_branch;
  }

  const { data: pr } = await context.octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullRequestNumber,
  });

  if (pr.state !== "open") {
    return null;
  }

  return pr.base.ref;
}

/**
 * Scan peer PRs for overlapping files and post/update the report comment.
 */
export async function reportFileOverlaps(
  context: AppContext,
  pullRequestNumber: number,
): Promise<FileOverlap[]> {
  const { owner, repo } = context.repo();
  const repository = `${owner}/${repo}`;

  const baseBranch = await resolveOpenPullRequestBase(
    context,
    pullRequestNumber,
  );

  if (!baseBranch) {
    context.log.debug(
      `PR #${pullRequestNumber} is not open; skipping overlap report`,
    );
    return [];
  }

  const previous = await getPullRequestState(repository, pullRequestNumber);

  const overlaps = await findFileOverlaps(
    context,
    pullRequestNumber,
    baseBranch,
    {
      headSha: previous?.head_sha,
    },
  );

  context.log.info(
    `PR #${pullRequestNumber} overlaps with ${overlaps.length} other open PR(s)`,
  );

  await upsertOverlapComment(context, pullRequestNumber, overlaps);

  return overlaps;
}
