import { jest } from "@jest/globals";

import {
  OVERLAP_COMMENT_MARKER,
  buildOverlapCommentBody,
  findFileOverlaps,
  formatOverlapTable,
  upsertOverlapComment,
} from "../src/overlap.js";
import { getPullRequestState } from "../src/state.js";

import { createGithubContext } from "./helpers/context.js";
import { createTestTable } from "./helpers/dynamodb.js";
import { REPOSITORY } from "./helpers/payload.js";
import { seedPullRequestState } from "./helpers/state.js";

describe("formatOverlapTable", () => {
  test("renders a Markdown table with clickable PR links and severity markers", () => {
    const table = formatOverlapTable(
      [
        {
          pullRequestNumber: 128,
          overlappingFiles: ["src/service.py", "src/models.py"],
        },
        {
          pullRequestNumber: 125,
          overlappingFiles: ["src/service.py"],
        },
      ],
      "acme/widgets",
    );

    expect(table).toContain("| PR | Files | Overlap |");
    expect(table).toContain("| --- | --- | --- |");
    expect(table).toContain(
      "[#128](https://github.com/acme/widgets/pull/128)",
    );
    expect(table).toContain(
      "[#125](https://github.com/acme/widgets/pull/125)",
    );
    expect(table).toContain("service.py, models.py");
    expect(table).toContain("2 files 🔴");
    expect(table).toContain("1 file 🟠");
  });
});

describe("buildOverlapCommentBody", () => {
  test("includes the marker and a clear empty state", () => {
    const body = buildOverlapCommentBody([], "acme/widgets");

    expect(body).toContain(OVERLAP_COMMENT_MARKER);
    expect(body).toContain("No overlapping file changes");
  });

  test("renders a real Markdown table (no code fence) with PR links, sorted by overlap size", () => {
    const body = buildOverlapCommentBody(
      [
        {
          pullRequestNumber: 125,
          overlappingFiles: ["src/service.py"],
        },
        {
          pullRequestNumber: 128,
          overlappingFiles: ["src/service.py", "src/models.py"],
        },
        {
          pullRequestNumber: 131,
          overlappingFiles: ["api/views.py"],
        },
      ],
      "acme/widgets",
    );

    expect(body).toContain(OVERLAP_COMMENT_MARKER);
    expect(body).not.toContain("```");
    expect(body).toContain(
      "[#128](https://github.com/acme/widgets/pull/128)",
    );
    expect(body.indexOf("#128")).toBeLessThan(body.indexOf("#125"));
    expect(body.indexOf("#125")).toBeLessThan(body.indexOf("#131"));
    expect(body).toContain("views.py");
  });
});

describe("findFileOverlaps", () => {
  beforeEach(async () => {
    await createTestTable();
  });

  test("returns peer PRs that share changed files", async () => {
    await seedPullRequestState({
      pull_request_number: 11,
      mergeable: true,
      head_sha: "head-11",
    });
    await seedPullRequestState({
      pull_request_number: 128,
      mergeable: true,
      head_sha: "head-128",
      changed_files: ["src/service.py", "src/models.py", "other.py"],
      changed_files_sha: "head-128",
    });
    await seedPullRequestState({
      pull_request_number: 99,
      mergeable: true,
      head_sha: "head-99",
      changed_files: ["README.md"],
      changed_files_sha: "head-99",
    });

    const paginate = jest
      .fn()
      .mockResolvedValueOnce([
        { filename: "src/service.py" },
        { filename: "src/models.py" },
      ])
      .mockResolvedValueOnce([
        { number: 128, head: { sha: "head-128" } },
        { number: 11, head: { sha: "head-11" } },
        { number: 99, head: { sha: "head-99" } },
      ]);

    const { context } = createGithubContext({ paginate });

    const overlaps = await findFileOverlaps(context, 11, "main", {
      headSha: "head-11",
    });

    expect(overlaps).toEqual([
      {
        pullRequestNumber: 128,
        overlappingFiles: ["src/service.py", "src/models.py"],
      },
    ]);

    // Current PR files fetched once; peers served from DynamoDB cache.
    expect(paginate).toHaveBeenCalledTimes(2);

    const saved = await getPullRequestState(REPOSITORY, 11);
    expect(saved).toMatchObject({
      changed_files: ["src/service.py", "src/models.py"],
      changed_files_sha: "head-11",
    });
  });

  test("does not re-fetch peer files when the cache matches head SHA", async () => {
    await seedPullRequestState({
      pull_request_number: 11,
      mergeable: true,
      head_sha: "head-11-new",
      changed_files: ["old.py"],
      changed_files_sha: "head-11-old",
    });
    await seedPullRequestState({
      pull_request_number: 125,
      mergeable: true,
      head_sha: "head-125",
      changed_files: ["src/service.py"],
      changed_files_sha: "head-125",
    });

    const paginate = jest
      .fn()
      .mockResolvedValueOnce([{ filename: "src/service.py" }])
      .mockResolvedValueOnce([
        { number: 11, head: { sha: "head-11-new" } },
        { number: 125, head: { sha: "head-125" } },
      ]);

    const { context } = createGithubContext({ paginate });

    const overlaps = await findFileOverlaps(context, 11, "main", {
      headSha: "head-11-new",
    });

    expect(overlaps).toEqual([
      {
        pullRequestNumber: 125,
        overlappingFiles: ["src/service.py"],
      },
    ]);
    expect(paginate).toHaveBeenCalledTimes(2);
  });

  test("fetches a peer only when its cached files are stale", async () => {
    await seedPullRequestState({
      pull_request_number: 11,
      mergeable: true,
      head_sha: "head-11",
      changed_files: ["src/service.py"],
      changed_files_sha: "head-11",
    });
    await seedPullRequestState({
      pull_request_number: 125,
      mergeable: true,
      head_sha: "head-125-old",
      changed_files: ["unrelated.py"],
      changed_files_sha: "head-125-old",
    });

    const paginate = jest
      .fn()
      .mockResolvedValueOnce([
        { number: 11, head: { sha: "head-11" } },
        { number: 125, head: { sha: "head-125-new" } },
      ])
      .mockResolvedValueOnce([{ filename: "src/service.py" }]);

    const { context } = createGithubContext({ paginate });

    const overlaps = await findFileOverlaps(context, 11, "main", {
      headSha: "head-11",
    });

    expect(overlaps).toEqual([
      {
        pullRequestNumber: 125,
        overlappingFiles: ["src/service.py"],
      },
    ]);

    const peer = await getPullRequestState(REPOSITORY, 125);
    expect(peer).toMatchObject({
      changed_files: ["src/service.py"],
      changed_files_sha: "head-125-new",
    });
  });
});

describe("upsertOverlapComment", () => {
  beforeEach(async () => {
    await createTestTable();
  });

  test("creates a comment when overlaps exist and none is stored", async () => {
    await seedPullRequestState({
      pull_request_number: 11,
      mergeable: true,
    });

    const createComment = jest.fn(async () => ({
      data: { id: 501 },
    }));
    const updateComment = jest.fn(async () => ({
      data: { id: 501 },
    }));
    const paginate = jest.fn(async () => []);

    const { context } = createGithubContext({
      createComment,
      updateComment,
      paginate,
    });

    const commentId = await upsertOverlapComment(context, 11, [
      {
        pullRequestNumber: 128,
        overlappingFiles: ["src/service.py"],
      },
    ]);

    expect(commentId).toBe(501);
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(updateComment).not.toHaveBeenCalled();

    const saved = await getPullRequestState(REPOSITORY, 11);
    expect(saved?.overlap_comment_id).toBe(501);
  });

  test("updates the stored comment on later syncs", async () => {
    await seedPullRequestState({
      pull_request_number: 11,
      mergeable: true,
      overlap_comment_id: 501,
    });

    const createComment = jest.fn(async () => ({
      data: { id: 999 },
    }));
    const updateComment = jest.fn(async () => ({
      data: { id: 501 },
    }));

    const { context } = createGithubContext({
      createComment,
      updateComment,
    });

    const commentId = await upsertOverlapComment(context, 11, [
      {
        pullRequestNumber: 125,
        overlappingFiles: ["src/service.py", "src/models.py"],
      },
    ]);

    expect(commentId).toBe(501);
    expect(updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 501,
        body: expect.stringContaining(OVERLAP_COMMENT_MARKER),
      }),
    );
    expect(createComment).not.toHaveBeenCalled();
  });

  test("skips creating a comment when there is no overlap yet", async () => {
    await seedPullRequestState({
      pull_request_number: 11,
      mergeable: true,
    });

    const createComment = jest.fn(async () => ({
      data: { id: 501 },
    }));
    const { context } = createGithubContext({ createComment });

    const commentId = await upsertOverlapComment(context, 11, []);

    expect(commentId).toBeUndefined();
    expect(createComment).not.toHaveBeenCalled();
  });

  test("updates an existing comment when overlaps clear", async () => {
    await seedPullRequestState({
      pull_request_number: 11,
      mergeable: true,
      overlap_comment_id: 501,
    });

    const updateComment = jest.fn(async () => ({
      data: { id: 501 },
    }));
    const createComment = jest.fn(async () => ({
      data: { id: 999 },
    }));

    const { context } = createGithubContext({
      updateComment,
      createComment,
    });

    const commentId = await upsertOverlapComment(context, 11, []);

    expect(commentId).toBe(501);
    expect(updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 501,
        body: expect.stringContaining("No overlapping file changes"),
      }),
    );
    expect(createComment).not.toHaveBeenCalled();
  });
});