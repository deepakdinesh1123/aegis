import type { Endpoints } from "@octokit/types";

type PullRequest =
  Endpoints["GET /repos/{owner}/{repo}/pulls/{pull_number}"]["response"]["data"];

export interface PullRequestSnapshot {
  number: number;
  state: "open" | "closed";
  baseBranch: string;
  baseSha: string;
  headBranch: string;
  headSha: string;
  authorLogin: string;
  mergeable: boolean;
  mergeableState: string | null;
}

export interface MergeabilityOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PullsGetClient {
  rest: {
    pulls: {
      get: (params: {
        owner: string;
        repo: string;
        pull_number: number;
      }) => Promise<{ data: PullRequest }>;
    };
  };
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 2_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function parseRepository(repository: string): {
  owner: string;
  repo: string;
} {
  const [owner, repo, ...rest] = repository.split("/");

  if (!owner || !repo || rest.length > 0) {
    throw new Error(`Invalid repository: ${repository}`);
  }

  return { owner, repo };
}

function toSnapshot(pr: PullRequest): PullRequestSnapshot | null {
  // Closed PRs do not need mergeability retries — stop tracking them as open.
  if (pr.state === "closed") {
    return {
      number: pr.number,
      state: "closed",
      baseBranch: pr.base.ref,
      baseSha: pr.base.sha,
      headBranch: pr.head.ref,
      headSha: pr.head.sha,
      authorLogin: pr.user?.login ?? "unknown",
      mergeable: pr.mergeable ?? false,
      mergeableState: pr.mergeable_state ?? null,
    };
  }

  if (pr.mergeable === null) {
    return null;
  }

  return {
    number: pr.number,
    state: "open",
    baseBranch: pr.base.ref,
    baseSha: pr.base.sha,
    headBranch: pr.head.ref,
    headSha: pr.head.sha,
    authorLogin: pr.user?.login ?? "unknown",
    mergeable: pr.mergeable,
    mergeableState: pr.mergeable_state ?? null,
  };
}

/**
 * Fetch a PR, retrying while GitHub is still calculating mergeability.
 * Returns null if mergeability never becomes known.
 */
export async function fetchPullRequestSnapshot(
  octokit: PullsGetClient,
  owner: string,
  repo: string,
  pullNumber: number,
  options: MergeabilityOptions = {},
): Promise<PullRequestSnapshot | null> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });

    const snapshot = toSnapshot(pr);

    if (snapshot) {
      return snapshot;
    }

    if (attempt < maxAttempts) {
      await sleep(retryDelayMs);
    }
  }

  return null;
}

/**
 * Convenience wrapper that only returns mergeability fields.
 */
export async function getMergeability(
  octokit: PullsGetClient,
  repository: string,
  pullNumber: number,
  options: MergeabilityOptions = {},
): Promise<{
  mergeable: boolean | null;
  mergeableState: string;
}> {
  const { owner, repo } = parseRepository(repository);

  const snapshot = await fetchPullRequestSnapshot(
    octokit,
    owner,
    repo,
    pullNumber,
    options,
  );

  if (!snapshot) {
    return {
      mergeable: null,
      mergeableState: "unknown",
    };
  }

  return {
    mergeable: snapshot.mergeable,
    mergeableState: snapshot.mergeableState ?? "unknown",
  };
}
