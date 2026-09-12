import type { Context } from "probot";

import {
  fetchPullRequestSnapshot,
  type MergeabilityOptions,
  type PullRequestSnapshot,
} from "./mergeability.js";
import {
  getPullRequestState,
  savePullRequestState,
} from "./state.js";
import type { PullRequestState } from "./types.js";

export const COMMENT_MARKER = "<!-- merge-conflict-bot -->";

export type PullRequestInfo = PullRequestSnapshot;

export type PullRequestFetchOptions = MergeabilityOptions;

/**
 * Narrow view of a Probot pull_request context.
 * Avoids exploding TypeScript unions from Context<"pull_request.*">.
 */
export interface AppContext {
  repo: <T extends Record<string, unknown> = Record<string, never>>(
    object?: T,
  ) => { owner: string; repo: string } & T;
  octokit: Context["octokit"];
  log: Context["log"];
}

function buildPullRequestState(
  repository: string,
  pr: PullRequestInfo,
  notification: {
    conflict_notified: boolean;
    conflict_comment_id?: number;
  },
  options: {
    status?: PullRequestState["status"];
    merged?: boolean;
    overlap_comment_id?: number;
    changed_files?: string[];
    changed_files_sha?: string;
  } = {},
): PullRequestState {
  const conflicted = pr.mergeable === false;
  const status = options.status ?? (pr.state === "closed" ? "closed" : "open");

  return {
    repository,
    pull_request_number: pr.number,
    status,
    merged: options.merged ?? false,
    base_branch: pr.baseBranch,
    base_sha: pr.baseSha,
    head_branch: pr.headBranch,
    head_sha: pr.headSha,
    author_login: pr.authorLogin,
    mergeable: pr.mergeable,
    mergeable_state: pr.mergeableState,
    conflicted,
    observed_at: new Date().toISOString(),
    conflict_notified: notification.conflict_notified,
    conflict_comment_id: notification.conflict_comment_id,
    overlap_comment_id: options.overlap_comment_id,
    changed_files: options.changed_files,
    changed_files_sha: options.changed_files_sha,
  };
}

/**
 * Notification flags stay sticky while a PR is conflicted, but must
 * reset once it becomes mergeable so a later conflict can notify again.
 */
function nextNotificationFlags(
  previous: PullRequestState | undefined,
  currentlyConflicted: boolean,
): {
  conflict_notified: boolean;
  conflict_comment_id?: number;
} {
  if (!currentlyConflicted) {
    return {
      conflict_notified: false,
      conflict_comment_id: undefined,
    };
  }

  return {
    conflict_notified: previous?.conflict_notified ?? false,
    conflict_comment_id: previous?.conflict_comment_id,
  };
}

/**
 * Mark a PR closed so later merge scans never re-check it.
 * Preserves whatever we last knew about mergeability / notifications.
 */
export async function markPullRequestClosed(
  repository: string,
  pullRequestNumber: number,
  options: {
    merged: boolean;
    baseBranch?: string;
    authorLogin?: string;
  },
): Promise<PullRequestState> {
  const previous = await getPullRequestState(repository, pullRequestNumber);

  const state: PullRequestState = {
    repository,
    pull_request_number: pullRequestNumber,
    status: "closed",
    merged: options.merged,
    base_branch: previous?.base_branch ?? options.baseBranch ?? "unknown",
    base_sha: previous?.base_sha ?? "unknown",
    head_branch: previous?.head_branch ?? "unknown",
    head_sha: previous?.head_sha ?? "unknown",
    author_login: previous?.author_login ?? options.authorLogin ?? "unknown",
    mergeable: previous?.mergeable ?? null,
    mergeable_state: previous?.mergeable_state ?? null,
    conflicted: previous?.conflicted ?? false,
    observed_at: new Date().toISOString(),
    conflict_notified: previous?.conflict_notified ?? false,
    conflict_comment_id: previous?.conflict_comment_id,
    overlap_comment_id: previous?.overlap_comment_id,
    changed_files: previous?.changed_files,
    changed_files_sha: previous?.changed_files_sha,
  };

  await savePullRequestState(state);
  return state;
}

/**
 * Fetch a PR and wait for GitHub to finish calculating mergeability.
 */
export async function getPullRequestWithMergeability(
  context: AppContext,
  pullRequestNumber: number,
  options: PullRequestFetchOptions = {},
): Promise<PullRequestInfo | null> {
  const { owner, repo } = context.repo();

  const snapshot = await fetchPullRequestSnapshot(
    context.octokit,
    owner,
    repo,
    pullRequestNumber,
    options,
  );

  if (!snapshot) {
    context.log.warn(
      `Unable to determine mergeability for PR #${pullRequestNumber}`,
    );
  }

  return snapshot;
}

/**
 * Save the current state of a PR.
 * If the PR is conflicted and the author has not been notified yet,
 * post a conflict comment (opened / reopened / synchronize included).
 */
export async function refreshPullRequestState(
  context: AppContext,
  pullRequestNumber: number,
): Promise<PullRequestInfo | null> {
  const { owner, repo } = context.repo();
  const repository = `${owner}/${repo}`;

  const pr = await getPullRequestWithMergeability(
    context,
    pullRequestNumber,
  );

  if (!pr) {
    return null;
  }

  const previous = await getPullRequestState(
    repository,
    pullRequestNumber,
  );

  if (pr.state === "closed") {
    await savePullRequestState(
      buildPullRequestState(
        repository,
        pr,
        {
          conflict_notified: previous?.conflict_notified ?? false,
          conflict_comment_id: previous?.conflict_comment_id,
        },
        {
          status: "closed",
          merged: previous?.merged ?? false,
          overlap_comment_id: previous?.overlap_comment_id,
          changed_files: previous?.changed_files,
          changed_files_sha: previous?.changed_files_sha,
        },
      ),
    );

    return pr;
  }

  const notification = nextNotificationFlags(
    previous,
    pr.mergeable === false,
  );

  await savePullRequestState(
    buildPullRequestState(repository, pr, notification, {
      status: "open",
      merged: false,
      overlap_comment_id: previous?.overlap_comment_id,
      changed_files: previous?.changed_files,
      changed_files_sha: previous?.changed_files_sha,
    }),
  );

  const needsConflictNotification =
    pr.mergeable === false && !notification.conflict_notified;

  if (!needsConflictNotification) {
    return pr;
  }

  context.log.info(
    `PR #${pullRequestNumber} is conflicted; notifying author`,
  );

  const commentId = await notifyAuthor(
    context,
    pullRequestNumber,
    pr.authorLogin,
  );

  await savePullRequestState(
    buildPullRequestState(
      repository,
      pr,
      {
        conflict_notified: true,
        conflict_comment_id: commentId,
      },
      {
        status: "open",
        merged: false,
        overlap_comment_id: previous?.overlap_comment_id,
        changed_files: previous?.changed_files,
        changed_files_sha: previous?.changed_files_sha,
      },
    ),
  );

  return pr;
}

/**
 * Find all of the bot's conflict comments on a PR.
 */
export async function findConflictComments(
  context: AppContext,
  pullRequestNumber: number,
): Promise<number[]> {
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

  return comments
    .filter((comment) => comment.body?.includes(COMMENT_MARKER))
    .map((comment) => comment.id);
}

/**
 * Find the bot's existing conflict comment.
 */
export async function findConflictComment(
  context: AppContext,
  pullRequestNumber: number,
): Promise<number | undefined> {
  const ids = await findConflictComments(context, pullRequestNumber);
  return ids[0];
}

/**
 * Delete leftover bot comments, then create a fresh conflict notification.
 *
 * Callers only invoke this when the author is not currently marked notified
 * (e.g. conflicts were cleared, then reintroduced).
 */
export async function notifyAuthor(
  context: AppContext,
  pullRequestNumber: number,
  authorLogin: string,
): Promise<number> {
  const { owner, repo } = context.repo();

  const existingComments = await findConflictComments(
    context,
    pullRequestNumber,
  );

  for (const commentId of existingComments) {
    await context.octokit.rest.issues.deleteComment({
      owner,
      repo,
      comment_id: commentId,
    });

    context.log.info(
      `Deleted stale conflict comment ${commentId} on PR #${pullRequestNumber}`,
    );
  }

  const body = [
    COMMENT_MARKER,
    "",
    `@${authorLogin} ⚠️ **This pull request now has merge conflicts.**`,
    "",
    "This can happen after another pull request is merged into the base branch, or after new commits on this branch.",
    "",
    "Please resolve the conflicts before merging.",
  ].join("\n");

  const { data: comment } =
    await context.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullRequestNumber,
      body,
    });

  return comment.id;
}

export { buildPullRequestState, nextNotificationFlags };
