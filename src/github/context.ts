import type { AppContext } from "../github.js";

export interface SimpleLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const consoleLogger: SimpleLogger = {
  debug: (...args) => console.debug(...args),
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

/**
 * Build an AppContext from an authenticated Octokit + repository full name.
 */
export function createAppContext(
  octokit: AppContext["octokit"],
  repository: string,
  log: SimpleLogger = consoleLogger,
): AppContext {
  const [owner, repo] = repository.split("/");

  if (!owner || !repo) {
    throw new Error(`Invalid repository: ${repository}`);
  }

  return {
    repo: <T extends Record<string, unknown> = Record<string, never>>(
      object?: T,
    ) =>
      ({
        owner,
        repo,
        ...(object ?? {}),
      }) as { owner: string; repo: string } & T,
    octokit,
    log: log as AppContext["log"],
  };
}
