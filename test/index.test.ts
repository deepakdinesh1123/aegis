import nock from "nock";

import { COMMENT_MARKER } from "../src/github.js";
import {
  deletePullRequestState,
  getPullRequestState,
} from "../src/state.js";

import { createTestTable } from "./helpers/dynamodb.js";
import { loadFixture } from "./helpers/fixtures.js";
import {
  mockComment,
  mockDeleteComment,
  mockListComments,
  mockOpenPullRequests,
  mockOverlapComment,
  mockOverlapScan,
  mockPullRequest,
  mockUpdateOverlapComment,
} from "./helpers/github.js";
import {
  REPOSITORY,
} from "./helpers/payload.js";
import { createTestProbot } from "./helpers/probot.js";
import { seedPullRequestState } from "./helpers/state.js";

const openedFixture = () =>
  loadFixture("pull_request.opened.json");
const reopenedFixture = () =>
  loadFixture("pull_request.reopened.json");
const synchronizeFixture = () =>
  loadFixture("pull_request.synchronize.json");
const closedUnmergedFixture = () =>
  loadFixture("pull_request.closed.json");
const closedMergedFixture = () =>
  loadFixture("pull_request.closed.merged.json");

async function receivePullRequest(payload: unknown) {
  const probot = createTestProbot();

  await probot.receive({
    id: "test-delivery-id",
    name: "pull_request",
    payload: payload as never,
  });
}

describe("merge-conflict-bot", () => {
  beforeEach(async () => {
    await createTestTable();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  test("event fixtures are present and non-empty", () => {
    expect(openedFixture()).toMatchObject({ action: "opened" });
    expect(reopenedFixture()).toMatchObject({ action: "reopened" });
    expect(synchronizeFixture()).toMatchObject({
      action: "synchronize",
    });
    expect(closedUnmergedFixture()).toMatchObject({
      action: "closed",
      pull_request: { merged: false },
    });
    expect(closedMergedFixture()).toMatchObject({
      action: "closed",
      pull_request: { merged: true },
    });
  });

  describe("pull_request.opened", () => {
    test("stores a clean PR", async () => {
      mockPullRequest(REPOSITORY, {
        number: 1,
        headSha: "head-1",
        baseSha: "base-1",
        mergeable: true,
      });
      mockOverlapScan(REPOSITORY, 1);

      await receivePullRequest(openedFixture());

      const saved = await getPullRequestState(REPOSITORY, 1);

      expect(saved).toMatchObject({
        repository: REPOSITORY,
        pull_request_number: 1,
        status: "open",
        merged: false,
        mergeable: true,
        conflicted: false,
        conflict_notified: false,
        author_login: "test-user",
      });
    });

    test("posts an overlap table when peer PRs share files", async () => {
      await seedPullRequestState({
        pull_request_number: 128,
        mergeable: true,
        head_sha: "h-128",
        changed_files: ["src/service.py", "src/models.py"],
        changed_files_sha: "h-128",
      });
      await seedPullRequestState({
        pull_request_number: 125,
        mergeable: true,
        head_sha: "h-125",
        changed_files: ["src/service.py"],
        changed_files_sha: "h-125",
      });

      mockPullRequest(REPOSITORY, {
        number: 1,
        headSha: "head-1",
        baseSha: "base-1",
        mergeable: true,
      });
      // Only the synced PR's files are fetched from GitHub; peers use cache.
      mockOverlapScan(REPOSITORY, 1, {
        files: ["src/service.py", "src/models.py", "README.md"],
        openPRs: [
          {
            number: 128,
            headSha: "h-128",
            baseSha: "base-1",
          },
          {
            number: 125,
            headSha: "h-125",
            baseSha: "base-1",
          },
        ],
      });
      mockListComments(REPOSITORY, 1);
      const comment = mockOverlapComment(REPOSITORY, 1, 501);

      await receivePullRequest(openedFixture());

      expect(comment.isDone()).toBe(true);

      const saved = await getPullRequestState(REPOSITORY, 1);
      expect(saved).toMatchObject({
        overlap_comment_id: 501,
        changed_files: ["src/service.py", "src/models.py", "README.md"],
        changed_files_sha: "head-1",
      });
    });
  });

  describe("pull_request.reopened", () => {
    test("refreshes PR state", async () => {
      await seedPullRequestState({
        pull_request_number: 1,
        mergeable: false,
        head_sha: "old-head",
      });

      mockPullRequest(REPOSITORY, {
        number: 1,
        headSha: "new-head",
        baseSha: "base-1",
        mergeable: true,
      });
      mockOverlapScan(REPOSITORY, 1);

      await receivePullRequest(reopenedFixture());

      const saved = await getPullRequestState(REPOSITORY, 1);

      expect(saved).toMatchObject({
        head_sha: "new-head",
        mergeable: true,
        conflicted: false,
      });
    });
  });

  describe("pull_request.synchronize", () => {
    test("updates PR state after new commits while conflicted", async () => {
      await seedPullRequestState({
        pull_request_number: 1,
        mergeable: false,
        head_sha: "old-head",
        conflict_notified: true,
        conflict_comment_id: 77,
      });

      mockPullRequest(REPOSITORY, {
        number: 1,
        headSha: "synced-head",
        baseSha: "base-1",
        mergeable: false,
      });
      mockOverlapScan(REPOSITORY, 1);

      await receivePullRequest(synchronizeFixture());

      const saved = await getPullRequestState(REPOSITORY, 1);

      expect(saved).toMatchObject({
        head_sha: "synced-head",
        conflict_notified: true,
        conflict_comment_id: 77,
      });
    });

    test("notifies on synchronize when the PR becomes conflicted", async () => {
      await seedPullRequestState({
        pull_request_number: 1,
        mergeable: true,
        conflict_notified: false,
      });

      mockPullRequest(REPOSITORY, {
        number: 1,
        headSha: "synced-head",
        baseSha: "base-1",
        mergeable: false,
      });
      mockListComments(REPOSITORY, 1);
      const comment = mockComment(REPOSITORY, 1, 88);
      mockOverlapScan(REPOSITORY, 1);

      await receivePullRequest(synchronizeFixture());

      expect(comment.isDone()).toBe(true);

      const saved = await getPullRequestState(REPOSITORY, 1);
      expect(saved).toMatchObject({
        mergeable: false,
        conflict_notified: true,
        conflict_comment_id: 88,
      });
    });

    test("clears notification flags once the PR is clean again", async () => {
      await seedPullRequestState({
        pull_request_number: 1,
        mergeable: false,
        conflict_notified: true,
        conflict_comment_id: 77,
      });

      mockPullRequest(REPOSITORY, {
        number: 1,
        headSha: "fixed-head",
        baseSha: "base-1",
        mergeable: true,
      });
      mockOverlapScan(REPOSITORY, 1);

      await receivePullRequest(synchronizeFixture());

      const saved = await getPullRequestState(REPOSITORY, 1);

      expect(saved).toMatchObject({
        head_sha: "fixed-head",
        mergeable: true,
        conflict_notified: false,
      });
      expect(saved?.conflict_comment_id).toBeUndefined();
    });

    test("updates the existing overlap comment instead of creating another", async () => {
      await seedPullRequestState({
        pull_request_number: 1,
        mergeable: true,
        overlap_comment_id: 501,
      });
      await seedPullRequestState({
        pull_request_number: 125,
        mergeable: true,
        head_sha: "h-125",
        changed_files: ["src/service.py", "other.py"],
        changed_files_sha: "h-125",
      });

      mockPullRequest(REPOSITORY, {
        number: 1,
        headSha: "synced-head",
        baseSha: "base-1",
        mergeable: true,
      });
      mockOverlapScan(REPOSITORY, 1, {
        files: ["src/service.py"],
        openPRs: [
          {
            number: 125,
            headSha: "h-125",
            baseSha: "base-1",
          },
        ],
      });
      const update = mockUpdateOverlapComment(REPOSITORY, 501);

      await receivePullRequest(synchronizeFixture());

      expect(update.isDone()).toBe(true);

      const saved = await getPullRequestState(REPOSITORY, 1);
      expect(saved).toMatchObject({
        overlap_comment_id: 501,
        changed_files: ["src/service.py"],
        changed_files_sha: "synced-head",
      });
    });
  });

  describe("pull_request.closed", () => {
    test("marks closed unmerged PRs as closed and does not scan others", async () => {
      await seedPullRequestState({
        pull_request_number: 10,
        mergeable: true,
      });

      await receivePullRequest(closedUnmergedFixture());

      const saved = await getPullRequestState(REPOSITORY, 10);

      expect(saved).toMatchObject({
        status: "closed",
        merged: false,
        pull_request_number: 10,
      });

      expect(
        nock.pendingMocks().some((mock) => mock.includes("/pulls")),
      ).toBe(false);
    });

    test("skips already-closed PRs when scanning after a merge", async () => {
      await seedPullRequestState({
        pull_request_number: 11,
        mergeable: true,
        status: "closed",
        merged: false,
      });

      mockOpenPullRequests(REPOSITORY, [
        {
          number: 11,
          headSha: "head-11",
          baseSha: "base-2",
        },
      ]);

      await receivePullRequest(closedMergedFixture());

      expect(
        nock.pendingMocks().some((mock) => mock.includes("/pulls/11")),
      ).toBe(false);

      const saved = await getPullRequestState(REPOSITORY, 11);
      expect(saved).toMatchObject({
        status: "closed",
        conflict_notified: false,
      });
    });

    test("marks the merged PR itself as closed", async () => {
      await seedPullRequestState({
        pull_request_number: 10,
        mergeable: true,
      });

      mockOpenPullRequests(REPOSITORY, []);

      await receivePullRequest(closedMergedFixture());

      const saved = await getPullRequestState(REPOSITORY, 10);
      expect(saved).toMatchObject({
        status: "closed",
        merged: true,
      });
    });

    test("clean → clean does not notify", async () => {
      await seedPullRequestState({
        pull_request_number: 11,
        mergeable: true,
      });

      mockOpenPullRequests(REPOSITORY, [
        {
          number: 11,
          headSha: "head-11",
          baseSha: "base-2",
        },
      ]);

      mockPullRequest(REPOSITORY, {
        number: 11,
        headSha: "head-11",
        baseSha: "base-2",
        mergeable: true,
      });

      await receivePullRequest(closedMergedFixture());

      expect(
        nock.pendingMocks().some((mock) => mock.includes("/comments")),
      ).toBe(false);

      const saved = await getPullRequestState(REPOSITORY, 11);
      expect(saved?.conflict_notified).toBe(false);
    });

    test("clean → conflicted notifies the author", async () => {
      await seedPullRequestState({
        pull_request_number: 11,
        mergeable: true,
        author_login: "alice",
      });

      mockOpenPullRequests(REPOSITORY, [
        {
          number: 11,
          headSha: "head-11",
          baseSha: "base-2",
        },
      ]);

      mockPullRequest(REPOSITORY, {
        number: 11,
        headSha: "head-11",
        baseSha: "base-2",
        author: "alice",
        mergeable: false,
      });

      mockListComments(REPOSITORY, 11);
      const comment = mockComment(REPOSITORY, 11, 123);

      await receivePullRequest(closedMergedFixture());

      expect(comment.isDone()).toBe(true);

      const saved = await getPullRequestState(REPOSITORY, 11);
      expect(saved).toMatchObject({
        mergeable: false,
        conflicted: true,
        conflict_notified: true,
        conflict_comment_id: 123,
      });
    });

    test("conflicted → conflicted does not notify", async () => {
      await seedPullRequestState({
        pull_request_number: 11,
        mergeable: false,
      });

      mockOpenPullRequests(REPOSITORY, [
        {
          number: 11,
          headSha: "head-11",
          baseSha: "base-2",
        },
      ]);

      mockPullRequest(REPOSITORY, {
        number: 11,
        headSha: "head-11",
        baseSha: "base-2",
        mergeable: false,
      });

      await receivePullRequest(closedMergedFixture());

      expect(
        nock.pendingMocks().some((mock) => mock.includes("/comments")),
      ).toBe(false);
    });

    test("conflicted → clean does not notify", async () => {
      await seedPullRequestState({
        pull_request_number: 11,
        mergeable: false,
      });

      mockOpenPullRequests(REPOSITORY, [
        {
          number: 11,
          headSha: "head-11",
          baseSha: "base-2",
        },
      ]);

      mockPullRequest(REPOSITORY, {
        number: 11,
        headSha: "head-11",
        baseSha: "base-2",
        mergeable: true,
      });

      await receivePullRequest(closedMergedFixture());

      const saved = await getPullRequestState(REPOSITORY, 11);
      expect(saved?.mergeable).toBe(true);
      expect(saved?.conflict_notified).toBe(false);
    });

    test("only notifies PRs that became conflicted", async () => {
      await seedPullRequestState({
        pull_request_number: 11,
        mergeable: true,
        author_login: "alice",
      });
      await seedPullRequestState({
        pull_request_number: 12,
        mergeable: true,
        author_login: "bob",
      });
      await seedPullRequestState({
        pull_request_number: 13,
        mergeable: false,
        author_login: "charlie",
      });

      mockOpenPullRequests(REPOSITORY, [
        { number: 11, headSha: "head-11", baseSha: "base-2" },
        { number: 12, headSha: "head-12", baseSha: "base-2" },
        { number: 13, headSha: "head-13", baseSha: "base-2" },
      ]);

      mockPullRequest(REPOSITORY, {
        number: 11,
        headSha: "head-11",
        baseSha: "base-2",
        author: "alice",
        mergeable: false,
      });
      mockPullRequest(REPOSITORY, {
        number: 12,
        headSha: "head-12",
        baseSha: "base-2",
        author: "bob",
        mergeable: true,
      });
      mockPullRequest(REPOSITORY, {
        number: 13,
        headSha: "head-13",
        baseSha: "base-2",
        author: "charlie",
        mergeable: false,
      });

      mockListComments(REPOSITORY, 11);
      const comment = mockComment(REPOSITORY, 11, 111);

      await receivePullRequest(closedMergedFixture());

      expect(comment.isDone()).toBe(true);
      expect(
        nock.pendingMocks().some((mock) =>
          mock.includes("/issues/12/comments"),
        ),
      ).toBe(false);
      expect(
        nock.pendingMocks().some((mock) =>
          mock.includes("/issues/13/comments"),
        ),
      ).toBe(false);
    });

    test("seeds and notifies when there is no previous state but the PR is conflicted", async () => {
      mockOpenPullRequests(REPOSITORY, [
        {
          number: 11,
          headSha: "head-11",
          baseSha: "base-2",
        },
      ]);

      mockPullRequest(REPOSITORY, {
        number: 11,
        headSha: "head-11",
        baseSha: "base-2",
        mergeable: false,
      });
      mockListComments(REPOSITORY, 11);
      const comment = mockComment(REPOSITORY, 11, 42);

      await receivePullRequest(closedMergedFixture());

      expect(comment.isDone()).toBe(true);

      const saved = await getPullRequestState(REPOSITORY, 11);
      expect(saved).toMatchObject({
        mergeable: false,
        conflict_notified: true,
        conflict_comment_id: 42,
      });
    });

    test("does not notify again when a conflict was already reported", async () => {
      await seedPullRequestState({
        pull_request_number: 11,
        mergeable: true,
        conflict_notified: true,
        conflict_comment_id: 9,
      });

      mockOpenPullRequests(REPOSITORY, [
        {
          number: 11,
          headSha: "head-11",
          baseSha: "base-2",
        },
      ]);

      mockPullRequest(REPOSITORY, {
        number: 11,
        headSha: "head-11",
        baseSha: "base-2",
        mergeable: false,
      });

      await receivePullRequest(closedMergedFixture());

      expect(
        nock.pendingMocks().some((mock) => mock.includes("/comments")),
      ).toBe(false);
    });

    test("deletes a stale conflict comment and posts a new one when conflicts return", async () => {
      await seedPullRequestState({
        pull_request_number: 11,
        mergeable: true,
        conflict_notified: false,
      });

      mockOpenPullRequests(REPOSITORY, [
        {
          number: 11,
          headSha: "head-11",
          baseSha: "base-2",
        },
      ]);

      mockPullRequest(REPOSITORY, {
        number: 11,
        headSha: "head-11",
        baseSha: "base-2",
        mergeable: false,
      });

      mockListComments(REPOSITORY, 11, [
        {
          id: 555,
          body: `${COMMENT_MARKER}\nAlready posted`,
        },
      ]);
      const deleted = mockDeleteComment(REPOSITORY, 555);
      const comment = mockComment(REPOSITORY, 11, 999);

      await receivePullRequest(closedMergedFixture());

      expect(deleted.isDone()).toBe(true);
      expect(comment.isDone()).toBe(true);

      const saved = await getPullRequestState(REPOSITORY, 11);
      expect(saved?.conflict_comment_id).toBe(999);
      expect(saved?.conflict_notified).toBe(true);
    });

    test("does not inspect PRs targeting another base branch", async () => {
      const list = mockOpenPullRequests(REPOSITORY, [], {
        base: "main",
      });

      await receivePullRequest(closedMergedFixture());

      expect(list.isDone()).toBe(true);
      expect(
        nock.pendingMocks().some((mock) => mock.includes("/pulls/11")),
      ).toBe(false);
    });

    test("checks PRs on subsequent list pages", async () => {
      await seedPullRequestState({
        pull_request_number: 101,
        mergeable: true,
        author_login: "affected-user",
      });

      nock("https://api.github.com")
        .get("/repos/test-owner/test-repo/pulls")
        .query((query) => {
          return (
            query.state === "open" &&
            query.base === "main" &&
            query.per_page === "100" &&
            (query.page === undefined || query.page === "1")
          );
        })
        .reply(
          200,
          Array.from({ length: 100 }, (_, index) => ({
            number: index + 1,
            user: { login: "user" },
            head: { sha: `head-${index + 1}`, ref: `feature-${index + 1}` },
            base: { ref: "main", sha: "base-2" },
          })),
          {
            Link: '<https://api.github.com/repos/test-owner/test-repo/pulls?state=open&base=main&per_page=100&page=2>; rel="next"',
          },
        );

      nock("https://api.github.com")
        .get("/repos/test-owner/test-repo/pulls")
        .query((query) => {
          return (
            query.state === "open" &&
            query.page === "2"
          );
        })
        .reply(200, [
          {
            number: 101,
            user: { login: "affected-user" },
            head: { sha: "head-101", ref: "feature-101" },
            base: { ref: "main", sha: "base-2" },
          },
        ]);

      nock("https://api.github.com")
        .persist()
        .get(/\/repos\/test-owner\/test-repo\/pulls\/\d+$/)
        .reply(200, (uri) => {
          const number = Number(uri.split("/").pop());

          return {
            number,
            user: {
              login: number === 101 ? "affected-user" : "user",
            },
            head: {
              ref: `feature-${number}`,
              sha: `head-${number}`,
            },
            base: {
              ref: "main",
              sha: "base-2",
            },
            mergeable: number === 101 ? false : true,
            mergeable_state: number === 101 ? "dirty" : "clean",
          };
        });

      mockListComments(REPOSITORY, 101);
      const comment = mockComment(REPOSITORY, 101, 1010);

      await receivePullRequest(closedMergedFixture());

      expect(comment.isDone()).toBe(true);
    });

    test("notifies again after a PR was fixed and later re-conflicted", async () => {
      await seedPullRequestState({
        pull_request_number: 11,
        mergeable: true,
        conflict_notified: false,
      });

      mockOpenPullRequests(REPOSITORY, [
        { number: 11, headSha: "head-11", baseSha: "base-2" },
      ]);
      mockPullRequest(REPOSITORY, {
        number: 11,
        headSha: "head-11",
        baseSha: "base-2",
        mergeable: false,
      });
      mockListComments(REPOSITORY, 11);
      const comment = mockComment(REPOSITORY, 11, 222);

      await receivePullRequest(closedMergedFixture());

      expect(comment.isDone()).toBe(true);

      const saved = await getPullRequestState(REPOSITORY, 11);
      expect(saved?.conflict_notified).toBe(true);
    });

    test("does not create duplicate notifications across repeated merge events", async () => {
      await seedPullRequestState({
        pull_request_number: 11,
        mergeable: true,
      });

      const payload = closedMergedFixture();

      mockOpenPullRequests(REPOSITORY, [
        { number: 11, headSha: "head-11", baseSha: "base-2" },
      ]);
      mockPullRequest(REPOSITORY, {
        number: 11,
        headSha: "head-11",
        baseSha: "base-2",
        mergeable: false,
      });
      mockListComments(REPOSITORY, 11);
      const firstComment = mockComment(REPOSITORY, 11, 1);

      await receivePullRequest(payload);
      expect(firstComment.isDone()).toBe(true);

      mockOpenPullRequests(REPOSITORY, [
        { number: 11, headSha: "head-11", baseSha: "base-2" },
      ]);
      mockPullRequest(REPOSITORY, {
        number: 11,
        headSha: "head-11",
        baseSha: "base-2",
        mergeable: false,
      });

      await receivePullRequest(payload);

      expect(
        nock.pendingMocks().some((mock) =>
          mock.includes("POST") && mock.includes("/comments"),
        ),
      ).toBe(false);
    });

    test("surfaces GitHub API failures", async () => {
      await seedPullRequestState({
        pull_request_number: 11,
        mergeable: true,
      });

      mockOpenPullRequests(REPOSITORY, [
        { number: 11, headSha: "head-11", baseSha: "base-2" },
      ]);

      nock("https://api.github.com")
        .get("/repos/test-owner/test-repo/pulls/11")
        .reply(500);

      await expect(
        receivePullRequest(closedMergedFixture()),
      ).rejects.toThrow();
    });
  });

  describe("unrelated events", () => {
    test("ignores issue webhooks", async () => {
      const probot = createTestProbot();

      await probot.receive({
        id: "test-delivery-id",
        name: "issues",
        payload: {
          action: "opened",
          installation: { id: 123 },
          repository: {
            name: "test-repo",
            full_name: REPOSITORY,
            owner: { login: "test-owner" },
          },
          issue: {
            number: 1,
          },
        } as never,
      });

      expect(nock.pendingMocks()).toHaveLength(0);
    });
  });

  test("deletePullRequestState is a no-op when nothing was stored", async () => {
    await expect(
      deletePullRequestState(REPOSITORY, 999),
    ).resolves.toBeUndefined();
  });
});
