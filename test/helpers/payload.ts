export const REPOSITORY = "test-owner/test-repo";
export const OWNER = "test-owner";
export const REPO = "test-repo";

export interface PullRequestPayloadOptions {
  action: string;
  number: number;
  merged?: boolean;
  owner?: string;
  repo?: string;
  author?: string;
  baseRef?: string;
  baseSha?: string;
  headSha?: string;
  mergeable?: boolean | null;
  mergeableState?: string;
}

export function pullRequestPayload(
  options: PullRequestPayloadOptions,
) {
  const owner = options.owner ?? OWNER;
  const repo = options.repo ?? REPO;
  const author = options.author ?? "test-user";
  const baseRef = options.baseRef ?? "main";
  const number = options.number;

  return {
    action: options.action,
    installation: {
      id: 123,
    },
    repository: {
      name: repo,
      full_name: `${owner}/${repo}`,
      owner: {
        login: owner,
      },
    },
    pull_request: {
      number,
      merged: options.merged ?? false,
      user: {
        login: author,
      },
      head: {
        ref: `feature-${number}`,
        sha: options.headSha ?? `head-${number}`,
      },
      base: {
        ref: baseRef,
        sha: options.baseSha ?? "base-1",
      },
      mergeable: options.mergeable ?? true,
      mergeable_state: options.mergeableState ?? "clean",
    },
  };
}
