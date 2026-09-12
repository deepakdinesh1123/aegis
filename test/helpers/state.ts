import { savePullRequestState } from "../../src/state.js";
import type { PullRequestState } from "../../src/types.js";

import { REPOSITORY } from "./payload.js";

export async function seedPullRequestState(
  overrides: Partial<PullRequestState> & {
    pull_request_number: number;
  },
): Promise<PullRequestState> {
  const mergeable = overrides.mergeable ?? true;
  const state: PullRequestState = {
    repository: REPOSITORY,
    status: "open",
    merged: false,
    base_branch: "main",
    base_sha: "base-1",
    head_branch: `feature-${overrides.pull_request_number}`,
    head_sha: `head-${overrides.pull_request_number}`,
    author_login: "test-user",
    mergeable,
    mergeable_state:
      overrides.mergeable_state ??
      (mergeable === false ? "dirty" : "clean"),
    conflicted: mergeable === false,
    observed_at: "2026-01-01T00:00:00.000Z",
    conflict_notified: false,
    ...overrides,
  };

  await savePullRequestState(state);

  return state;
}
