import { jest } from "@jest/globals";

import { getMergeability } from "../src/mergeability.js";

describe("getMergeability", () => {
  const sleep = jest.fn(async () => undefined);

  beforeEach(() => {
    sleep.mockClear();
  });

  test("returns mergeability when GitHub has finished calculating", async () => {
    const get = jest.fn(async () => ({
      data: {
        number: 11,
        user: { login: "test-user" },
        head: { ref: "feature", sha: "head" },
        base: { ref: "main", sha: "base" },
        mergeable: true,
        mergeable_state: "clean",
      },
    }));

    const result = await getMergeability(
      { rest: { pulls: { get } } },
      "test-owner/test-repo",
      11,
    );

    expect(result).toEqual({
      mergeable: true,
      mergeableState: "clean",
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      pull_number: 11,
    });
  });

  test("retries while mergeable is still null", async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          number: 11,
          user: { login: "test-user" },
          head: { ref: "feature", sha: "head" },
          base: { ref: "main", sha: "base" },
          mergeable: null,
          mergeable_state: "unknown",
        },
      })
      .mockResolvedValueOnce({
        data: {
          number: 11,
          user: { login: "test-user" },
          head: { ref: "feature", sha: "head" },
          base: { ref: "main", sha: "base" },
          mergeable: null,
          mergeable_state: "unknown",
        },
      })
      .mockResolvedValueOnce({
        data: {
          number: 11,
          user: { login: "test-user" },
          head: { ref: "feature", sha: "head" },
          base: { ref: "main", sha: "base" },
          mergeable: false,
          mergeable_state: "dirty",
        },
      });

    const result = await getMergeability(
      { rest: { pulls: { get } } },
      "test-owner/test-repo",
      11,
      {
        sleep,
        retryDelayMs: 25,
      },
    );

    expect(result).toEqual({
      mergeable: false,
      mergeableState: "dirty",
    });
    expect(get).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  test("stops after max attempts and reports unknown", async () => {
    const get = jest.fn(async () => ({
      data: {
        number: 11,
        user: { login: "test-user" },
        head: { ref: "feature", sha: "head" },
        base: { ref: "main", sha: "base" },
        mergeable: null,
        mergeable_state: "unknown",
      },
    }));

    const result = await getMergeability(
      { rest: { pulls: { get } } },
      "test-owner/test-repo",
      11,
      {
        maxAttempts: 5,
        retryDelayMs: 10,
        sleep,
      },
    );

    expect(result).toEqual({
      mergeable: null,
      mergeableState: "unknown",
    });
    expect(get).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  test("rejects an invalid repository name", async () => {
    await expect(
      getMergeability(
        { rest: { pulls: { get: jest.fn() } } },
        "not-a-repo",
        11,
      ),
    ).rejects.toThrow("Invalid repository: not-a-repo");
  });

  test("uses unknown author when GitHub user is missing", async () => {
    const get = jest.fn(async () => ({
      data: {
        number: 11,
        user: null,
        head: { ref: "feature", sha: "head" },
        base: { ref: "main", sha: "base" },
        mergeable: true,
        mergeable_state: "clean",
      },
    }));

    const result = await getMergeability(
      { rest: { pulls: { get } } },
      "test-owner/test-repo",
      11,
    );

    expect(result.mergeable).toBe(true);
  });
});
