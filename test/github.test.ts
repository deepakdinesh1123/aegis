import { jest } from "@jest/globals";

import {
  COMMENT_MARKER,
  findConflictComment,
  getPullRequestWithMergeability,
  nextNotificationFlags,
  notifyAuthor,
  refreshPullRequestState,
} from "../src/github.js";
import { getPullRequestState } from "../src/state.js";
import type { PullRequestState } from "../src/types.js";

import {
  createGithubContext,
  prApiData,
} from "./helpers/context.js";
import { createTestTable } from "./helpers/dynamodb.js";
import { REPOSITORY } from "./helpers/payload.js";
import { seedPullRequestState } from "./helpers/state.js";

describe("getPullRequestWithMergeability", () => {
  test("returns PR details once mergeable is known", async () => {
    const { context, pullsGet } = createGithubContext({
      pullsGet: jest.fn(async () => ({
        data: prApiData({
          mergeable: false,
          mergeable_state: "dirty",
        }),
      })),
    });

    const result = await getPullRequestWithMergeability(context, 11);

    expect(result).toMatchObject({
      number: 11,
      authorLogin: "test-user",
      mergeable: false,
      mergeableState: "dirty",
    });
    expect(pullsGet).toHaveBeenCalledTimes(1);
  });

  test("retries while mergeable is null", async () => {
    const sleep = jest.fn(async () => undefined);
    const pullsGet = jest
      .fn()
      .mockResolvedValueOnce({
        data: prApiData({
          mergeable: null,
          mergeable_state: "unknown",
        }),
      })
      .mockResolvedValueOnce({
        data: prApiData({
          mergeable: true,
          mergeable_state: "clean",
        }),
      });

    const { context } = createGithubContext({ pullsGet });

    const result = await getPullRequestWithMergeability(context, 11, {
      sleep,
      retryDelayMs: 15,
    });

    expect(result?.mergeable).toBe(true);
    expect(pullsGet).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  test("returns null instead of retrying forever", async () => {
    const sleep = jest.fn(async () => undefined);
    const pullsGet = jest.fn(async () => ({
      data: prApiData({
        mergeable: null,
        mergeable_state: "unknown",
      }),
    }));
    const { context } = createGithubContext({ pullsGet });

    const result = await getPullRequestWithMergeability(context, 11, {
      maxAttempts: 5,
      retryDelayMs: 1,
      sleep,
    });

    expect(result).toBeNull();
    expect(pullsGet).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(context.log.warn).toHaveBeenCalled();
  });
});

describe("notifyAuthor", () => {
  test("creates a conflict comment when none exists", async () => {
    const paginate = jest.fn(async () => []);
    const createComment = jest.fn(async () => ({
      data: { id: 42 },
    }));
    const { context } = createGithubContext({
      paginate,
      createComment,
    });

    const commentId = await notifyAuthor(context, 11, "alice");

    expect(commentId).toBe(42);
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 11,
        body: expect.stringContaining("@alice"),
      }),
    );

    const [payload] = createComment.mock.calls[0] as [
      { body: string },
    ];
    expect(payload.body).toContain(COMMENT_MARKER);
  });

  test("deletes a stale conflict comment and creates a new one", async () => {
    const paginate = jest.fn(async () => [
      {
        id: 7,
        body: "unrelated",
      },
      {
        id: 88,
        body: `${COMMENT_MARKER}\nalready notified`,
      },
    ]);
    const deleteComment = jest.fn(async () => ({}));
    const createComment = jest.fn(async () => ({
      data: { id: 99 },
    }));
    const { context } = createGithubContext({
      paginate,
      deleteComment,
      createComment,
    });

    const commentId = await notifyAuthor(context, 11, "alice");

    expect(deleteComment).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      comment_id: 88,
    });
    expect(createComment).toHaveBeenCalled();
    expect(commentId).toBe(99);
  });
});

describe("findConflictComment", () => {
  test("returns undefined when the bot has not commented", async () => {
    const paginate = jest.fn(async () => [
      {
        id: 1,
        body: "looks good",
      },
    ]);
    const { context } = createGithubContext({ paginate });

    await expect(
      findConflictComment(context, 11),
    ).resolves.toBeUndefined();
  });
});

describe("nextNotificationFlags", () => {
  test("clears notification flags when the PR is clean", () => {
    const previous: PullRequestState = {
      repository: REPOSITORY,
      pull_request_number: 11,
      status: "open",
      merged: false,
      base_branch: "main",
      base_sha: "base",
      head_branch: "feature",
      head_sha: "head",
      author_login: "test-user",
      mergeable: false,
      mergeable_state: "dirty",
      conflicted: true,
      observed_at: "2026-01-01T00:00:00.000Z",
      conflict_notified: true,
      conflict_comment_id: 55,
    };

    expect(nextNotificationFlags(previous, false)).toEqual({
      conflict_notified: false,
      conflict_comment_id: undefined,
    });
  });

  test("preserves notification flags while still conflicted", () => {
    const previous: PullRequestState = {
      repository: REPOSITORY,
      pull_request_number: 11,
      status: "open",
      merged: false,
      base_branch: "main",
      base_sha: "base",
      head_branch: "feature",
      head_sha: "head",
      author_login: "test-user",
      mergeable: false,
      mergeable_state: "dirty",
      conflicted: true,
      observed_at: "2026-01-01T00:00:00.000Z",
      conflict_notified: true,
      conflict_comment_id: 55,
    };

    expect(nextNotificationFlags(previous, true)).toEqual({
      conflict_notified: true,
      conflict_comment_id: 55,
    });
  });
});

describe("refreshPullRequestState", () => {
  beforeEach(async () => {
    await createTestTable();
  });

  test("preserves previous notification metadata while conflicted", async () => {
    await seedPullRequestState({
      pull_request_number: 11,
      mergeable: false,
      conflict_notified: true,
      conflict_comment_id: 55,
    });

    const { context } = createGithubContext({
      pullsGet: jest.fn(async () => ({
        data: prApiData({
          mergeable: false,
          mergeable_state: "dirty",
        }),
      })),
    });

    await refreshPullRequestState(context, 11);

    const saved = await getPullRequestState(REPOSITORY, 11);

    expect(saved?.conflict_notified).toBe(true);
    expect(saved?.conflict_comment_id).toBe(55);
    expect(saved?.mergeable).toBe(false);
  });

  test("notifies on refresh when conflicted and not yet notified", async () => {
    await seedPullRequestState({
      pull_request_number: 11,
      mergeable: true,
      conflict_notified: false,
    });

    const paginate = jest.fn(async () => []);
    const createComment = jest.fn(async () => ({
      data: { id: 77 },
    }));

    const { context } = createGithubContext({
      pullsGet: jest.fn(async () => ({
        data: prApiData({
          mergeable: false,
          mergeable_state: "dirty",
        }),
      })),
      paginate,
      createComment,
    });

    await refreshPullRequestState(context, 11);

    expect(createComment).toHaveBeenCalled();

    const saved = await getPullRequestState(REPOSITORY, 11);

    expect(saved).toMatchObject({
      mergeable: false,
      conflict_notified: true,
      conflict_comment_id: 77,
    });
  });

  test("clears notification metadata once the PR is clean again", async () => {
    await seedPullRequestState({
      pull_request_number: 11,
      mergeable: false,
      conflict_notified: true,
      conflict_comment_id: 55,
    });

    const { context } = createGithubContext({
      pullsGet: jest.fn(async () => ({
        data: prApiData({
          mergeable: true,
          mergeable_state: "clean",
        }),
      })),
    });

    await refreshPullRequestState(context, 11);

    const saved = await getPullRequestState(REPOSITORY, 11);

    expect(saved?.conflict_notified).toBe(false);
    expect(saved?.conflict_comment_id).toBeUndefined();
    expect(saved?.mergeable).toBe(true);
  });
});
