import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

import type { AppContext } from "../github.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

/**
 * Build an installation-authenticated Octokit for the processor Lambda / worker.
 */
export async function createInstallationOctokit(
  installationId: number,
): Promise<AppContext["octokit"]> {
  const appId = requireEnv("APP_ID");
  const privateKey = requireEnv("PRIVATE_KEY");

  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId,
      privateKey,
      installationId,
    },
  });

  return octokit as unknown as AppContext["octokit"];
}
