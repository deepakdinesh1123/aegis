import {
  deletePullRequestState,
  getPullRequestState,
  savePullRequestState,
} from "../src/state.js";

import { createTestTable } from "./helpers/dynamodb.js";
import { seedPullRequestState } from "./helpers/state.js";

describe("pull request state", () => {
  beforeEach(async () => {
    await createTestTable();
  });

  test("does not mix the same PR number across repositories", async () => {
    await seedPullRequestState({
      repository: "owner-a/repo",
      pull_request_number: 10,
      mergeable: true,
    });

    await seedPullRequestState({
      repository: "owner-b/repo",
      pull_request_number: 10,
      mergeable: false,
    });

    const stateA = await getPullRequestState("owner-a/repo", 10);
    const stateB = await getPullRequestState("owner-b/repo", 10);

    expect(stateA?.mergeable).toBe(true);
    expect(stateB?.mergeable).toBe(false);
  });

  test("saves and deletes stored state", async () => {
    await savePullRequestState({
      repository: "owner-a/repo",
      pull_request_number: 4,
      status: "open",
      merged: false,
      base_branch: "main",
      base_sha: "base",
      head_branch: "feature",
      head_sha: "head",
      author_login: "test-user",
      mergeable: true,
      mergeable_state: "clean",
      conflicted: false,
      observed_at: "2026-01-01T00:00:00.000Z",
      conflict_notified: false,
    });

    await deletePullRequestState("owner-a/repo", 4);

    await expect(
      getPullRequestState("owner-a/repo", 4),
    ).resolves.toBeUndefined();
  });
});
