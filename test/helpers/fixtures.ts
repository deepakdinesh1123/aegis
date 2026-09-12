import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

export function loadFixture<T = Record<string, unknown>>(
  name: string,
): T {
  const contents = fs.readFileSync(
    path.join(fixturesDir, name),
    "utf8",
  );

  if (!contents.trim()) {
    throw new Error(`Fixture is empty: ${name}`);
  }

  return JSON.parse(contents) as T;
}
