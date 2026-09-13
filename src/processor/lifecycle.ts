import { mapWithConcurrency } from "../concurrency.js";
import {
  type AppContext,
  buildPullRequestState,
  getPullRequestWithMergeability,
  markPullRequestClosed,
  nextNotificationFlags,
  notifyAuthor,
  refreshPullRequestState,
} from "../github.js";
import {
  type PullRequestLifecycleJob,
  type RetryMergeabilityJob,
  maxMergeabilityQueueAttempts,
  mergeabilityRetryDelaySeconds,
} from "../queue/messages.js";
import { enqueueJob } from "../queue/sqs.js";
import {
  getPullRequestState,
  savePullRequestState,
} from "../state.js";
import {
  detachClosedPullRequestFromOverlaps,
  enqueuePeerOverlapReevaluations,
  reevaluateOverlapForPullRequest,
  reportFileOverlapsWithIndex,
} from "./overlap.js";

const MAX_CONCURRENT_PR_CHECKS = 10;

export function isDefaultBranchTarget(
  baseBranch: string,
  defaultBranch: string,
): boolean {
  return baseBranch === defaultBranch;
}

async function scheduleMergeabilityRetry(
  context: AppContext,
  repository: string,
  pullRequestNumber: number,
  installationId: number,
  attempt: number,
  reason: string,
): Promise<void> {
  const maxAttempts = maxMergeabilityQueueAttempts();

  if (attempt > maxAttempts) {
    context.log.warn(
      `Giving up on mergeability for PR #${pullRequestNumber} after ${maxAttempts} queue attempts`,
    );
    return;
  }

  const delaySeconds = mergeabilityRetryDelaySeconds(attempt);

  context.log.info(
    `Scheduling RetryMergeability for PR #${pullRequestNumber} attempt=${attempt} delay=${delaySeconds}s (${reason})`,
  );

  await enqueueJob(
    {
      type: "RetryMergeability",
      repository,
      pull_request_number: pullRequestNumber,
      attempt,
      installation_id: installationId,
      reason,
    } satisfies RetryMergeabilityJob,
    { delaySeconds },
  );
}

/**
 * Refresh mergeability; if still unknown, enqueue a deferred retry.
 */
export async function refreshOrDeferMergeability(
  context: AppContext,
  repository: string,
  pullRequestNumber: number,
  installationId: number,
  attempt = 1,
  mergeabilityOptions?: Parameters<typeof refreshPullRequestState>[2],
): Promise<boolean> {
  const pr = await refreshPullRequestState(
    context,
    pullRequestNumber,
    mergeabilityOptions,
  );

  if (pr) {
    return true;
  }

  await scheduleMergeabilityRetry(
    context,
    repository,
    pullRequestNumber,
    installationId,
    attempt + 1,
    "mergeability_unknown",
  );

  return false;
}

async function checkAffectedPullRequest(
  context: AppContext,
  pullRequestNumber: number,
  installationId: number,
): Promise<void> {
  const { owner, repo } = context.repo();
  const repository = `${owner}/${repo}`;

  const previous = await getPullRequestState(repository, pullRequestNumber);

  if (previous?.status === "closed") {
    context.log.debug(
      `PR #${pullRequestNumber} is closed; skipping conflict check`,
    );
    return;
  }

  if (!previous) {
    context.log.debug(
      `No previous state for PR #${pullRequestNumber}; seeding via refresh`,
    );
    await refreshOrDeferMergeability(
      context,
      repository,
      pullRequestNumber,
      installationId,
    );
    return;
  }

  const current = await getPullRequestWithMergeability(
    context,
    pullRequestNumber,
  );

  if (!current) {
    await scheduleMergeabilityRetry(
      context,
      repository,
      pullRequestNumber,
      installationId,
      2,
      "affected_pr_mergeability_unknown",
    );
    return;
  }

  if (current.state === "closed") {
    await closePullRequestAndRefreshPeers(context, repository, pullRequestNumber, {
      merged: false,
      baseBranch: current.baseBranch,
      authorLogin: current.authorLogin,
    });
    return;
  }

  const becameConflicted =
    previous.mergeable === true && current.mergeable === false;

  const notification = nextNotificationFlags(
    previous,
    current.mergeable === false,
  );

  await savePullRequestState(
    buildPullRequestState(repository, current, notification, {
      status: "open",
      merged: false,
      overlap_comment_id: previous.overlap_comment_id,
      changed_files: previous.changed_files,
      changed_files_sha: previous.changed_files_sha,
      overlapping_pr_numbers: previous.overlapping_pr_numbers,
    }),
  );

  if (!becameConflicted) {
    return;
  }

  if (previous.conflict_notified) {
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
        overlap_comment_id: previous.overlap_comment_id,
        changed_files: previous.changed_files,
        changed_files_sha: previous.changed_files_sha,
        overlapping_pr_numbers: previous.overlapping_pr_numbers,
      },
    ),
  );
}

/**
 * Mark a PR closed, drop it from the overlap graph, and refresh peer
 * overlap comments inline so tables stop listing the closed PR.
 */
async function closePullRequestAndRefreshPeers(
  context: AppContext,
  repository: string,
  pullRequestNumber: number,
  options: {
    merged: boolean;
    baseBranch?: string;
    authorLogin?: string;
  },
): Promise<void> {
  const peers = await detachClosedPullRequestFromOverlaps(
    repository,
    pullRequestNumber,
  );

  await markPullRequestClosed(repository, pullRequestNumber, options);

  if (peers.length === 0) {
    return;
  }

  context.log.info(
    `PR #${pullRequestNumber} closed; refreshing overlap comments on ${peers.length} peer PR(s)`,
  );

  await mapWithConcurrency(peers, MAX_CONCURRENT_PR_CHECKS, async (peer) => {
    await reevaluateOverlapForPullRequest(context, peer);
  });
}

async function handleClosedLifecycle(
  context: AppContext,
  job: PullRequestLifecycleJob,
): Promise<void> {
  const { repository, pull_request_number: number, installation_id } = job;

  await closePullRequestAndRefreshPeers(context, repository, number, {
    merged: job.merged,
    baseBranch: job.base_branch,
    authorLogin: job.author_login,
  });

  if (!job.merged) {
    return;
  }

  if (!isDefaultBranchTarget(job.base_branch, job.default_branch)) {
    context.log.info(
      `Merged PR #${number} targets ${job.base_branch}, not default ${job.default_branch}; skipping conflict scan`,
    );
    return;
  }

  const { owner, repo } = context.repo();

  const openPRs = (await context.octokit.paginate(
    context.octokit.rest.pulls.list,
    {
      owner,
      repo,
      state: "open",
      base: job.default_branch,
      per_page: 100,
    },
  )) as Array<{ number: number }>;

  await mapWithConcurrency(openPRs, MAX_CONCURRENT_PR_CHECKS, async (pr) => {
    await checkAffectedPullRequest(context, pr.number, installation_id);
  });
}

/**
 * Process an opened / reopened / synchronize job for a default-branch PR.
 */
async function handleOpenLifecycle(
  context: AppContext,
  job: PullRequestLifecycleJob,
): Promise<void> {
  const { repository, pull_request_number: number, installation_id } = job;

  const refreshed = await refreshOrDeferMergeability(
    context,
    repository,
    number,
    installation_id,
  );

  if (!refreshed) {
    return;
  }

  const report = await reportFileOverlapsWithIndex(context, number, {
    baseBranch: job.base_branch,
    headSha: job.head_sha,
  });

  await enqueuePeerOverlapReevaluations(
    repository,
    number,
    report.peersToReevaluate,
    installation_id,
    `lifecycle_${job.action}`,
  );
}

export async function processPullRequestLifecycle(
  context: AppContext,
  job: PullRequestLifecycleJob,
): Promise<void> {
  if (!isDefaultBranchTarget(job.base_branch, job.default_branch)) {
    context.log.info(
      `Skipping PR #${job.pull_request_number}: base ${job.base_branch} is not default ${job.default_branch}`,
    );
    return;
  }

  if (job.action === "closed") {
    await handleClosedLifecycle(context, job);
    return;
  }

  await handleOpenLifecycle(context, job);
}

export async function processRetryMergeability(
  context: AppContext,
  job: RetryMergeabilityJob,
): Promise<void> {
  const refreshed = await refreshOrDeferMergeability(
    context,
    job.repository,
    job.pull_request_number,
    job.installation_id,
    job.attempt,
  );

  if (!refreshed) {
    return;
  }

  const report = await reportFileOverlapsWithIndex(
    context,
    job.pull_request_number,
  );

  await enqueuePeerOverlapReevaluations(
    job.repository,
    job.pull_request_number,
    report.peersToReevaluate,
    job.installation_id,
    "retry_mergeability",
  );
}

export async function processReevaluateOverlap(
  context: AppContext,
  pullRequestNumber: number,
): Promise<void> {
  await reevaluateOverlapForPullRequest(context, pullRequestNumber);
}
