import { jest } from "@jest/globals";
import nock from "nock";

import { enqueuePullRequestWebhook } from "../src/enqueue.js";
import { processAegisJob } from "../src/handlers/worker.js";
import type { AppContext } from "../src/github.js";
import {
  parseAegisJob,
  type PullRequestLifecycleJob,
  type RetryMergeabilityJob,
} from "../src/queue/messages.js";
import {
  enqueueJob,
  receiveJobs,
  deleteJob,
} from "../src/queue/sqs.js";
import { getPullRequestState } from "../src/state.js";

import { createTestTable } from "./helpers/dynamodb.js";
import {
  mockComment,
  mockListComments,
  mockOpenPullRequests,
  mockOverlapComment,
  mockOverlapScan,
  mockPullRequest,
  mockUpdateOverlapComment,
} from "./helpers/github.js";
import { REPOSITORY } from "./helpers/payload.js";
import { seedPullRequestState } from "./helpers/state.js";
import {
  processUntilEmpty,
  resetQueue,
  staticAuth,
} from "./helpers/sqs.js";

describe("event-driven queue behaviour", () => {
  beforeEach(async () => {
    await createTestTable();
    await resetQueue();
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect(
      (host) =>
        host.includes("localhost") || host.includes("127.0.0.1"),
    );
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  test("webhook enqueue skips non-default-branch PRs", async () => {
    const messageId = await enqueuePullRequestWebhook(
      {
        action: "opened",
        installation: { id: 123 },
        repository: {
          full_name: REPOSITORY,
          default_branch: "main",
        },
        pull_request: {
          number: 9,
          merged: false,
          user: { login: "alice" },
          head: { sha: "h9" },
          base: { ref: "develop" },
        },
      },
      { info: jest.fn(), warn: jest.fn() },
    );

    expect(messageId).toBeUndefined();

    const messages = await receiveJobs({ waitTimeSeconds: 1 });
    expect(messages).toHaveLength(0);
  });

  test("webhook enqueue puts a lifecycle job on the queue", async () => {
    const messageId = await enqueuePullRequestWebhook(
      {
        action: "opened",
        installation: { id: 123 },
        repository: {
          full_name: REPOSITORY,
          default_branch: "main",
        },
        pull_request: {
          number: 1,
          merged: false,
          user: { login: "alice" },
          head: { sha: "head-1" },
          base: { ref: "main" },
        },
      },
      { info: jest.fn(), warn: jest.fn() },
    );

    expect(messageId).toBeDefined();

    const messages = await receiveJobs({ waitTimeSeconds: 1 });
    expect(messages).toHaveLength(1);
    const job = parseAegisJob(messages[0]!.Body!) as PullRequestLifecycleJob;
    expect(job).toMatchObject({
      type: "PullRequestLifecycle",
      action: "opened",
      pull_request_number: 1,
      default_branch: "main",
      base_branch: "main",
    });
    await deleteJob(messages[0]!.ReceiptHandle!);
  });

  test("worker stores PR state and overlap comment for opened jobs", async () => {
    const { Octokit } = await import("@octokit/rest");
    const octokit = new Octokit({ auth: "test" });
    const auth = staticAuth(octokit as unknown as AppContext["octokit"]);

    await seedPullRequestState({
      pull_request_number: 128,
      mergeable: true,
      head_sha: "h-128",
      changed_files: ["src/service.py", "src/models.py"],
      changed_files_sha: "h-128",
    });

    mockPullRequest(REPOSITORY, {
      number: 1,
      headSha: "head-1",
      baseSha: "base-1",
      mergeable: true,
    });
    mockOverlapScan(REPOSITORY, 1, {
      files: ["src/service.py", "src/models.py", "README.md"],
      openPRs: [{ number: 128, headSha: "h-128", baseSha: "base-1" }],
    });
    mockListComments(REPOSITORY, 1);
    mockOverlapComment(REPOSITORY, 1, 501);

    mockOverlapScan(REPOSITORY, 128, {
      files: ["src/service.py", "src/models.py"],
      openPRs: [{ number: 1, headSha: "head-1", baseSha: "base-1" }],
    });
    mockListComments(REPOSITORY, 128);
    mockOverlapComment(REPOSITORY, 128, 601);

    await enqueueJob({
      type: "PullRequestLifecycle",
      action: "opened",
      repository: REPOSITORY,
      pull_request_number: 1,
      base_branch: "main",
      default_branch: "main",
      head_sha: "head-1",
      merged: false,
      author_login: "alice",
      installation_id: 123,
    });

    await processUntilEmpty(auth, { maxRounds: 15 });

    const saved = await getPullRequestState(REPOSITORY, 1);
    expect(saved).toMatchObject({
      status: "open",
      mergeable: true,
      overlap_comment_id: 501,
      changed_files_sha: "head-1",
      overlapping_pr_numbers: [128],
    });
  });

  test("defers mergeability then completes on RetryMergeability", async () => {
    const { Octokit } = await import("@octokit/rest");
    const octokit = new Octokit({ auth: "test" });
    const auth = staticAuth(octokit as unknown as AppContext["octokit"]);
    const sleep = jest.fn(async () => undefined);

    nock("https://api.github.com")
      .get("/repos/test-owner/test-repo/pulls/42")
      .times(5)
      .reply(200, {
        number: 42,
        state: "open",
        user: { login: "alice" },
        head: { ref: "feature-42", sha: "head-42" },
        base: { ref: "main", sha: "base-1" },
        mergeable: null,
        mergeable_state: "unknown",
      });

    // Bypass processAegisJob so we can inject fast mergeability retries.
    const { createAppContext } = await import("../src/github/context.js");
    const { refreshOrDeferMergeability } = await import(
      "../src/processor/lifecycle.js"
    );
    const context = createAppContext(
      octokit as unknown as AppContext["octokit"],
      REPOSITORY,
    );

    const refreshed = await refreshOrDeferMergeability(
      context,
      REPOSITORY,
      42,
      123,
      1,
      { maxAttempts: 5, retryDelayMs: 1, sleep },
    );

    expect(refreshed).toBe(false);
    expect(sleep).toHaveBeenCalled();

    const queued = await receiveJobs({ waitTimeSeconds: 1 });
    expect(queued.length).toBeGreaterThanOrEqual(1);
    const retryJob = parseAegisJob(queued[0]!.Body!) as RetryMergeabilityJob;
    expect(retryJob).toMatchObject({
      type: "RetryMergeability",
      pull_request_number: 42,
      attempt: 2,
    });
    await deleteJob(queued[0]!.ReceiptHandle!);
    await resetQueue();

    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect(
      (host) =>
        host.includes("localhost") || host.includes("127.0.0.1"),
    );

    mockPullRequest(REPOSITORY, {
      number: 42,
      headSha: "head-42",
      baseSha: "base-1",
      mergeable: true,
    });
    mockOverlapScan(REPOSITORY, 42, { files: [] });

    await processAegisJob(
      {
        type: "RetryMergeability",
        repository: REPOSITORY,
        pull_request_number: 42,
        attempt: 2,
        installation_id: 123,
        reason: "mergeability_unknown",
      },
      { auth },
    );

    const saved = await getPullRequestState(REPOSITORY, 42);
    expect(saved).toMatchObject({
      mergeable: true,
      status: "open",
    });
  }, 15_000);

  test("synchronize re-evaluates peers in overlapping_pr_numbers", async () => {
    const { Octokit } = await import("@octokit/rest");
    const octokit = new Octokit({ auth: "test" });
    const auth = staticAuth(octokit as unknown as AppContext["octokit"]);

    await seedPullRequestState({
      pull_request_number: 1,
      mergeable: true,
      head_sha: "old-head",
      changed_files: ["src/service.py"],
      changed_files_sha: "old-head",
      overlapping_pr_numbers: [2],
      overlap_comment_id: 501,
    });
    await seedPullRequestState({
      pull_request_number: 2,
      mergeable: true,
      head_sha: "head-2",
      changed_files: ["src/service.py"],
      changed_files_sha: "head-2",
      overlapping_pr_numbers: [1],
      overlap_comment_id: 502,
    });

    mockPullRequest(REPOSITORY, {
      number: 1,
      headSha: "new-head",
      baseSha: "base-1",
      mergeable: true,
    });
    mockOverlapScan(REPOSITORY, 1, {
      files: ["src/service.py", "other.py"],
      openPRs: [{ number: 2, headSha: "head-2", baseSha: "base-1" }],
    });
    mockUpdateOverlapComment(REPOSITORY, 501);

    mockOpenPullRequests(REPOSITORY, [
      { number: 1, headSha: "new-head", baseSha: "base-1" },
      { number: 2, headSha: "head-2", baseSha: "base-1" },
    ]);
    nock("https://api.github.com")
      .get("/repos/test-owner/test-repo/pulls/1/files")
      .query(true)
      .reply(200, [
        { filename: "src/service.py" },
        { filename: "other.py" },
      ]);
    mockUpdateOverlapComment(REPOSITORY, 502);

    await processAegisJob(
      {
        type: "PullRequestLifecycle",
        action: "synchronize",
        repository: REPOSITORY,
        pull_request_number: 1,
        base_branch: "main",
        default_branch: "main",
        head_sha: "new-head",
        merged: false,
        author_login: "alice",
        installation_id: 123,
      },
      { auth },
    );

    await processUntilEmpty(auth, { maxRounds: 15 });

    const peer = await getPullRequestState(REPOSITORY, 2);
    expect(peer?.overlapping_pr_numbers).toContain(1);
    expect(peer?.overlap_comment_id).toBe(502);
  });

  test("closing a PR removes it from peer overlap comments", async () => {
    const { Octokit } = await import("@octokit/rest");
    const octokit = new Octokit({ auth: "test" });
    const auth = staticAuth(octokit as unknown as AppContext["octokit"]);

    await seedPullRequestState({
      pull_request_number: 1,
      mergeable: true,
      head_sha: "head-1",
      changed_files: ["src/service.py"],
      changed_files_sha: "head-1",
      overlapping_pr_numbers: [2],
      overlap_comment_id: 501,
    });
    await seedPullRequestState({
      pull_request_number: 2,
      mergeable: true,
      head_sha: "head-2",
      changed_files: ["src/service.py"],
      changed_files_sha: "head-2",
      overlapping_pr_numbers: [1],
      overlap_comment_id: 502,
    });

    // Peer #2 re-eval after #1 closes: only open PR is #2 itself.
    mockOpenPullRequests(REPOSITORY, [
      { number: 2, headSha: "head-2", baseSha: "base-1" },
    ]);
    const update = mockUpdateOverlapComment(REPOSITORY, 502);

    await processAegisJob(
      {
        type: "PullRequestLifecycle",
        action: "closed",
        repository: REPOSITORY,
        pull_request_number: 1,
        base_branch: "main",
        default_branch: "main",
        head_sha: "head-1",
        merged: false,
        author_login: "alice",
        installation_id: 123,
      },
      { auth },
    );

    const closed = await getPullRequestState(REPOSITORY, 1);
    expect(closed).toMatchObject({
      status: "closed",
      overlapping_pr_numbers: [],
    });

    const peer = await getPullRequestState(REPOSITORY, 2);
    expect(peer?.overlapping_pr_numbers ?? []).not.toContain(1);
    expect(update.isDone()).toBe(true);
  });

  test("merged default-branch PR notifies conflicted open PRs", async () => {
    const { Octokit } = await import("@octokit/rest");
    const octokit = new Octokit({ auth: "test" });
    const auth = staticAuth(octokit as unknown as AppContext["octokit"]);

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
    mockComment(REPOSITORY, 11, 99);

    await processAegisJob(
      {
        type: "PullRequestLifecycle",
        action: "closed",
        repository: REPOSITORY,
        pull_request_number: 10,
        base_branch: "main",
        default_branch: "main",
        head_sha: "head-10",
        merged: true,
        author_login: "alice",
        installation_id: 123,
      },
      { auth },
    );

    const closed = await getPullRequestState(REPOSITORY, 10);
    expect(closed).toMatchObject({ status: "closed", merged: true });

    const affected = await getPullRequestState(REPOSITORY, 11);
    expect(affected).toMatchObject({
      mergeable: false,
      conflict_notified: true,
      conflict_comment_id: 99,
    });
  });
});
