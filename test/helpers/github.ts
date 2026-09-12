import nock from "nock";

const GITHUB_API = "https://api.github.com";

export interface PullRequestMock {
  number: number;
  headSha: string;
  baseSha: string;
  baseBranch?: string;
  author?: string;
  mergeable: boolean | null;
  mergeableState?: string;
  state?: "open" | "closed";
}

export function mockPullRequest(
  repository: string,
  pr: PullRequestMock,
) {
  const [owner, repo] = repository.split("/");

  return nock(GITHUB_API)
    .get(`/repos/${owner}/${repo}/pulls/${pr.number}`)
    .reply(200, {
      number: pr.number,
      state: pr.state ?? "open",

      user: {
        login: pr.author ?? "test-user",
      },

      head: {
        ref: `feature-${pr.number}`,
        sha: pr.headSha,
      },

      base: {
        ref: pr.baseBranch ?? "main",
        sha: pr.baseSha,
      },

      mergeable: pr.mergeable,
      mergeable_state:
        pr.mergeableState ??
        (pr.mergeable === false ? "dirty" : "clean"),
    });
}

export function mockOpenPullRequests(
  repository: string,
  prs: Array<{
    number: number;
    headSha: string;
    baseSha: string;
    baseBranch?: string;
  }>,
  options: {
    base?: string;
  } = {},
) {
  const [owner, repo] = repository.split("/");
  const expectedBase = options.base ?? "main";

  return nock(GITHUB_API)
    .get(`/repos/${owner}/${repo}/pulls`)
    .query((query) => {
      return (
        query.state === "open" &&
        query.per_page === "100" &&
        query.base === expectedBase
      );
    })
    .reply(
      200,
      prs.map((pr) => ({
        number: pr.number,

        state: "open",

        user: {
          login: "test-user",
        },

        head: {
          ref: `feature-${pr.number}`,
          sha: pr.headSha,
        },

        base: {
          ref: pr.baseBranch ?? "main",
          sha: pr.baseSha,
        },
      })),
    );
}

export function mockPullRequestFiles(
  repository: string,
  prNumber: number,
  files: string[],
) {
  const [owner, repo] = repository.split("/");

  return nock(GITHUB_API)
    .get(`/repos/${owner}/${repo}/pulls/${prNumber}/files`)
    .query(true)
    .reply(
      200,
      files.map((filename) => ({
        filename,
      })),
    );
}

/**
 * Minimal GitHub mocks needed after opened / reopened / synchronize
 * so the file-overlap scan does not fail with unmatched nock requests.
 */
export function mockOverlapScan(
  repository: string,
  pullRequestNumber: number,
  options: {
    files?: string[];
    openPRs?: Array<{
      number: number;
      headSha: string;
      baseSha: string;
      baseBranch?: string;
      files?: string[];
    }>;
    base?: string;
  } = {},
) {
  const files = options.files ?? [];
  const openPRs = options.openPRs ?? [];

  mockPullRequestFiles(repository, pullRequestNumber, files);

  if (files.length > 0) {
    mockOpenPullRequests(repository, openPRs, { base: options.base });
  }

  for (const peer of openPRs) {
    if (peer.number === pullRequestNumber) {
      continue;
    }

    mockPullRequestFiles(repository, peer.number, peer.files ?? []);
  }
}

export function mockOverlapComment(
  repository: string,
  prNumber: number,
  commentId = 55555,
) {
  const [owner, repo] = repository.split("/");

  return nock(GITHUB_API)
    .post(
      `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
      (body) => {
        expect(body.body).toContain("<!-- aegis-file-overlap -->");
        return true;
      },
    )
    .reply(201, {
      id: commentId,
      body: "file overlap",
    });
}

export function mockUpdateOverlapComment(
  repository: string,
  commentId: number,
) {
  const [owner, repo] = repository.split("/");

  return nock(GITHUB_API)
    .patch(
      `/repos/${owner}/${repo}/issues/comments/${commentId}`,
      (body) => {
        expect(body.body).toContain("<!-- aegis-file-overlap -->");
        return true;
      },
    )
    .reply(200, {
      id: commentId,
      body: "file overlap",
    });
}

export function mockListComments(
  repository: string,
  prNumber: number,
  comments: Array<{ id: number; body: string }> = [],
) {
  const [owner, repo] = repository.split("/");

  return nock(GITHUB_API)
    .get(`/repos/${owner}/${repo}/issues/${prNumber}/comments`)
    .query(true)
    .reply(200, comments);
}

export function mockDeleteComment(
  repository: string,
  commentId: number,
) {
  const [owner, repo] = repository.split("/");

  return nock(GITHUB_API)
    .delete(`/repos/${owner}/${repo}/issues/comments/${commentId}`)
    .reply(204);
}

export function mockComment(
  repository: string,
  prNumber: number,
  commentId = 12345,
) {
  const [owner, repo] = repository.split("/");

  return nock(GITHUB_API)
    .post(
      `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
      (body) => {
        expect(body.body).toContain("<!-- merge-conflict-bot -->");
        expect(body.body).toContain("merge conflicts");
        return true;
      },
    )
    .reply(201, {
      id: commentId,
      body: "merge conflicts",
    });
}
