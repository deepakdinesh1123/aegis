import { jest } from "@jest/globals";

import { mapWithConcurrency } from "../src/concurrency.js";

describe("mapWithConcurrency", () => {
  test("never exceeds the concurrency limit", async () => {
    const limit = 3;
    let running = 0;
    let maximumRunning = 0;

    const items = Array.from({ length: 20 }, (_, i) => i);

    const results = await mapWithConcurrency(
      items,
      limit,
      async (item) => {
        running += 1;
        maximumRunning = Math.max(maximumRunning, running);

        await new Promise((resolve) => setTimeout(resolve, 10));

        running -= 1;
        return item * 2;
      },
    );

    expect(maximumRunning).toBeLessThanOrEqual(limit);
    expect(results).toEqual(items.map((item) => item * 2));
  });

  test("returns an empty array for no items", async () => {
    const worker = jest.fn(async () => 0);

    await expect(
      mapWithConcurrency([], 5, worker),
    ).resolves.toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });

  test("returns an empty array when concurrency is zero", async () => {
    const worker = jest.fn(async (item: number) => item);

    await expect(
      mapWithConcurrency([1, 2], 0, worker),
    ).resolves.toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });
});
