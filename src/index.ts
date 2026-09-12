import type { Probot } from "probot";

import { mapWithConcurrency } from "./concurrency.js";
import {
  type AppContext,
  buildPullRequestState,
  getPullRequestWithMergeability,
  markPullRequestClosed,
  nextNotificationFlags,
  notifyAuthor,
  refreshPullRequestState,
} from "./github.js";
import {
  getPullRequestState,
  savePullRequestState,
} from "./state.js";

const MAX_CONCURRENT_PR_CHECKS = 10;

interface ListedPullRequest {
  number: number;
}

/**
 * Keep PR state up to date so we know what a PR looked like
 * before another PR was merged.
 */
async function handlePullRequestStateEvent(
  context: AppContext & {
    pullRequest: () => { pull_number: number };
  },
): Promise<void> {
  const { pull_number: number } = context.pullRequest();

  context.log.info(`Refreshing state for PR #${number}`);

  await refreshPullRequestState(context, number);
}

/**
 * Handle a PR being closed.
 *
 * Always mark the PR closed in DynamoDB so it is never re-checked.
 * If it was merged, also inspect open PRs targeting the same base branch.
 */
async function handlePullRequestClosed(
  context: AppContext & {
    payload: {
      pull_request: {
        number: number;
        merged: boolean | null;
        base: { ref: string };
        user?: { login?: string } | null;
      };
    };
  },
): Promise<void> {
  const closedPR = context.payload.pull_request;
  const { owner, repo } = context.repo();
  const repository = `${owner}/${repo}`;
  const merged = Boolean(closedPR.merged);

  await markPullRequestClosed(repository, closedPR.number, {
    merged,
    baseBranch: closedPR.base.ref,
    authorLogin: closedPR.user?.login,
  });

  context.log.info(
    `Marked PR #${closedPR.number} as closed` +
      (merged ? " (merged)" : " (not merged)"),
  );

  if (!merged) {
    return;
  }

  const baseBranch = closedPR.base.ref;

  context.log.info(
    `PR #${closedPR.number} was merged into ${baseBranch}`,
  );

  const openPRs = (await context.octokit.paginate(
    context.octokit.rest.pulls.list,
    {
      owner,
      repo,
      state: "open",
      base: baseBranch,
      per_page: 100,
    },
  )) as ListedPullRequest[];

  context.log.info(
    `Found ${openPRs.length} open PRs targeting ${baseBranch}`,
  );

  await mapWithConcurrency(
    openPRs,
    MAX_CONCURRENT_PR_CHECKS,
    async (pr) => {
      await checkAffectedPullRequest(context, pr.number);
    },
  );
}

/**
 * Determine whether a PR became conflicted because of the merged PR.
 */
async function checkAffectedPullRequest(
  context: AppContext,
  pullRequestNumber: number,
): Promise<void> {
  const { owner, repo } = context.repo();
  const repository = `${owner}/${repo}`;

  const previous = await getPullRequestState(
    repository,
    pullRequestNumber,
  );

  if (previous?.status === "closed") {
    context.log.debug(
      `PR #${pullRequestNumber} is closed; skipping conflict check`,
    );
    return;
  }

  /*
   * Without a previous state we cannot prove this merge caused the
   * conflict. Still seed state for future events.
   */
  if (!previous) {
    context.log.debug(
      `No previous state for PR #${pullRequestNumber}; skipping`,
    );

    await refreshPullRequestState(context, pullRequestNumber);
    return;
  }

  const current = await getPullRequestWithMergeability(
    context,
    pullRequestNumber,
  );

  if (!current) {
    return;
  }

  if (current.state === "closed") {
    await markPullRequestClosed(repository, pullRequestNumber, {
      merged: false,
      baseBranch: current.baseBranch,
      authorLogin: current.authorLogin,
    });

    context.log.info(
      `PR #${pullRequestNumber} is already closed on GitHub; marked closed`,
    );
    return;
  }

  const becameConflicted =
    previous.mergeable === true && current.mergeable === false;

  const notification = nextNotificationFlags(
    previous,
    current.mergeable === false,
  );

  /*
   * Persist the latest observation before deciding whether to notify.
   * Notification flags stay sticky while conflicted, and reset when clean.
   */
  await savePullRequestState(
    buildPullRequestState(repository, current, notification, {
      status: "open",
      merged: false,
    }),
  );

  if (!becameConflicted) {
    context.log.debug(
      `PR #${pullRequestNumber} did not transition clean → conflicted`,
    );
    return;
  }

  if (previous.conflict_notified) {
    context.log.debug(
      `PR #${pullRequestNumber} was already notified`,
    );
    return;
  }

  context.log.info(`PR #${pullRequestNumber} became conflicted`);

  const commentId = await notifyAuthor(
    context,
    pullRequestNumber,
    current.authorLogin,
  );

  await savePullRequestState(
    buildPullRequestState(
      repository,
      current,
      {
        conflict_notified: true,
        conflict_comment_id: commentId,
      },
      {
        status: "open",
        merged: false,
      },
    ),
  );
}

export { mapWithConcurrency } from "./concurrency.js";

export default function (app: Probot): void {
  app.on("pull_request.opened", async (context) => {
    await handlePullRequestStateEvent(context);
  });

  app.on("pull_request.reopened", async (context) => {
    await handlePullRequestStateEvent(context);
  });

  app.on("pull_request.synchronize", async (context) => {
    await handlePullRequestStateEvent(context);
  });

  app.on("pull_request.closed", async (context) => {
    await handlePullRequestClosed(context);
  });
}
