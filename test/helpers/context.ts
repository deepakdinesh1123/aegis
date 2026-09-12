import { jest } from "@jest/globals";

import type { AppContext } from "../../src/github.js";

export function prApiData(
  overrides: Record<string, unknown> = {},
) {
  return {
    number: 11,
    state: "open",
    user: {
      login: "test-user",
    },
    head: {
      ref: "feature-11",
      sha: "head-11",
    },
    base: {
      ref: "main",
      sha: "base-1",
    },
    mergeable: true,
    mergeable_state: "clean",
    ...overrides,
  };
}

export function createGithubContext(options?: {
  pullsGet?: ReturnType<typeof jest.fn>;
  paginate?: ReturnType<typeof jest.fn>;
  createComment?: ReturnType<typeof jest.fn>;
  deleteComment?: ReturnType<typeof jest.fn>;
}) {
  const pullsGet =
    options?.pullsGet ??
    jest.fn(async () => ({
      data: prApiData(),
    }));

  const createComment =
    options?.createComment ??
    jest.fn(async () => ({
      data: {
        id: 99,
      },
    }));

  const deleteComment =
    options?.deleteComment ?? jest.fn(async () => ({}));

  const paginate =
    options?.paginate ?? jest.fn(async () => []);

  const context = {
    repo: () => ({
      owner: "test-owner",
      repo: "test-repo",
    }),
    octokit: {
      rest: {
        pulls: {
          get: pullsGet,
        },
        issues: {
          listComments: jest.fn(),
          createComment,
          deleteComment,
        },
      },
      paginate,
    },
    log: {
      debug: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
      fatal: jest.fn(),
      trace: jest.fn(),
      child: jest.fn(),
    },
  } as unknown as AppContext;

  return {
    context,
    pullsGet,
    createComment,
    deleteComment,
    paginate,
  };
}
