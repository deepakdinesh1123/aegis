import type { AppContext } from "../github.js";
import {
  type FileOverlap,
  findFileOverlaps,
  upsertOverlapComment,
} from "../overlap.js";
import {
  getPullRequestState,
  isConditionalCheckFailed,
  savePullRequestState,
  savePullRequestStateIfOverlapPeersMatch,
} from "../state.js";
import { enqueueJob } from "../queue/sqs.js";
import type { ReevaluateOverlapJob } from "../queue/messages.js";

const OVERLAP_EDGE_MAX_ATTEMPTS = 8;

function unionNumbers(a: number[], b: number[]): number[] {
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
}

function sortedUnique(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function samePeers(a: number[] | undefined, b: number[]): boolean {
  const left = sortedUnique(a ?? []);
  if (left.length !== b.length) {
    return false;
  }
  return left.every((value, index) => value === b[index]);
}

/**
 * Mutate one peer's overlapping_pr_numbers with optimistic concurrency so
 * concurrent workers cannot clobber each other's edge updates.
 */
async function updatePeerOverlapEdges(
  repository: string,
  peer: number,
  mutate: (current: number[]) => number[],
  options: { skipIfClosed?: boolean } = {},
): Promise<void> {
  for (let attempt = 1; attempt <= OVERLAP_EDGE_MAX_ATTEMPTS; attempt++) {
    const state = await getPullRequestState(repository, peer);
    if (!state) {
      return;
    }
    if (options.skipIfClosed && state.status === "closed") {
      return;
    }

    const previousPeers = sortedUnique(state.overlapping_pr_numbers ?? []);
    const nextPeers = sortedUnique(mutate(previousPeers));
    if (samePeers(previousPeers, nextPeers)) {
      return;
    }

    try {
      await savePullRequestStateIfOverlapPeersMatch(
        {
          ...state,
          overlapping_pr_numbers: nextPeers,
          observed_at: new Date().toISOString(),
        },
        state.overlapping_pr_numbers,
      );
      return;
    } catch (error) {
      if (
        isConditionalCheckFailed(error) &&
        attempt < OVERLAP_EDGE_MAX_ATTEMPTS
      ) {
        continue;
      }
      throw error;
    }
  }
}

/**
 * Keep reverse edges in sync: if A overlaps B, B.overlapping_pr_numbers
 * should include A (and drop A when the edge disappears).
 */
export async function syncPeerOverlapEdges(
  repository: string,
  sourcePr: number,
  previousPeers: number[],
  nextPeers: number[],
): Promise<void> {
  const previous = new Set(previousPeers);
  const next = new Set(nextPeers);

  const added = nextPeers.filter((n) => !previous.has(n));
  const removed = previousPeers.filter((n) => !next.has(n));

  for (const peer of added) {
    await updatePeerOverlapEdges(
      repository,
      peer,
      (current) => [...current, sourcePr],
      { skipIfClosed: true },
    );
  }

  for (const peer of removed) {
    await updatePeerOverlapEdges(repository, peer, (current) =>
      current.filter((n) => n !== sourcePr),
    );
  }
}

/**
 * Drop a closed PR from every peer's overlap index and return those peers
 * so their overlap comments can be refreshed.
 */
export async function detachClosedPullRequestFromOverlaps(
  repository: string,
  closedPr: number,
): Promise<number[]> {
  const previous = await getPullRequestState(repository, closedPr);
  const peers = previous?.overlapping_pr_numbers ?? [];

  if (peers.length === 0) {
    return [];
  }

  await syncPeerOverlapEdges(repository, closedPr, peers, []);

  if (previous) {
    await savePullRequestState({
      ...previous,
      overlapping_pr_numbers: [],
      observed_at: new Date().toISOString(),
    });
  }

  return peers;
}

export interface OverlapReportResult {
  overlaps: FileOverlap[];
  previousPeers: number[];
  nextPeers: number[];
  peersToReevaluate: number[];
}

/**
 * Recompute overlaps for a PR, persist reverse indices, and return peers
 * that should be re-evaluated (union of previous and next overlap sets).
 */
export async function reportFileOverlapsWithIndex(
  context: AppContext,
  pullRequestNumber: number,
  options: { baseBranch?: string; headSha?: string } = {},
): Promise<OverlapReportResult> {
  const { owner, repo } = context.repo();
  const repository = `${owner}/${repo}`;

  const previous = await getPullRequestState(repository, pullRequestNumber);
  const previousPeers = previous?.overlapping_pr_numbers ?? [];

  if (previous?.status === "closed") {
    return {
      overlaps: [],
      previousPeers,
      nextPeers: [],
      peersToReevaluate: previousPeers,
    };
  }

  let baseBranch = options.baseBranch ?? previous?.base_branch;

  if (!baseBranch) {
    const { data: pr } = await context.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullRequestNumber,
    });

    if (pr.state !== "open") {
      return {
        overlaps: [],
        previousPeers,
        nextPeers: [],
        peersToReevaluate: previousPeers,
      };
    }

    baseBranch = pr.base.ref;
  }

  const overlaps = await findFileOverlaps(
    context,
    pullRequestNumber,
    baseBranch,
    {
      headSha: options.headSha ?? previous?.head_sha,
    },
  );

  const nextPeers = sortedUnique(
    overlaps.map((overlap) => overlap.pullRequestNumber),
  );

  context.log.info(
    `PR #${pullRequestNumber} overlaps with ${overlaps.length} other open PR(s)`,
  );

  await upsertOverlapComment(context, pullRequestNumber, overlaps);

  const afterComment = await getPullRequestState(repository, pullRequestNumber);
  if (afterComment) {
    await savePullRequestState({
      ...afterComment,
      overlapping_pr_numbers: nextPeers,
      observed_at: new Date().toISOString(),
    });
  }

  await syncPeerOverlapEdges(
    repository,
    pullRequestNumber,
    previousPeers,
    nextPeers,
  );

  return {
    overlaps,
    previousPeers,
    nextPeers,
    peersToReevaluate: unionNumbers(previousPeers, nextPeers),
  };
}

/**
 * Enqueue ReevaluateOverlap jobs for peers affected by a change to `sourcePr`.
 */
export async function enqueuePeerOverlapReevaluations(
  repository: string,
  sourcePr: number,
  peerNumbers: number[],
  installationId: number,
  reason: string,
): Promise<void> {
  for (const peer of peerNumbers) {
    if (peer === sourcePr) {
      continue;
    }

    const job: ReevaluateOverlapJob = {
      type: "ReevaluateOverlap",
      repository,
      pull_request_number: peer,
      installation_id: installationId,
      reason,
      trigger_pr_number: sourcePr,
    };

    await enqueueJob(job);
  }
}

/**
 * Recompute one PR's overlap comment from cached changed_files where possible.
 */
export async function reevaluateOverlapForPullRequest(
  context: AppContext,
  pullRequestNumber: number,
): Promise<OverlapReportResult> {
  return reportFileOverlapsWithIndex(context, pullRequestNumber);
}
