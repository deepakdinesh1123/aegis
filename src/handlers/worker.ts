import type { AppContext } from "../github.js";
import { createAppContext } from "../github/context.js";
import {
  type AegisJob,
  parseAegisJob,
} from "../queue/messages.js";
import {
  processPullRequestLifecycle,
  processReevaluateOverlap,
  processRetryMergeability,
} from "../processor/lifecycle.js";

export type InstallationAuth = (
  installationId: number,
) => Promise<AppContext["octokit"]>;

export interface ProcessJobOptions {
  auth: InstallationAuth;
  log?: AppContext["log"];
}

/**
 * Dispatch a single Aegis queue job using an installation-authenticated Octokit.
 */
export async function processAegisJob(
  job: AegisJob,
  options: ProcessJobOptions,
): Promise<void> {
  const octokit = await options.auth(job.installation_id);
  const context = createAppContext(
    octokit,
    job.repository,
    options.log as never,
  );

  switch (job.type) {
    case "PullRequestLifecycle":
      await processPullRequestLifecycle(context, job);
      break;
    case "RetryMergeability":
      await processRetryMergeability(context, job);
      break;
    case "ReevaluateOverlap":
      await processReevaluateOverlap(context, job.pull_request_number);
      break;
    default: {
      const exhaustive: never = job;
      throw new Error(`Unhandled job: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export async function processAegisJobBody(
  body: string,
  options: ProcessJobOptions,
): Promise<void> {
  await processAegisJob(parseAegisJob(body), options);
}
