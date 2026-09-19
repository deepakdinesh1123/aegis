export type PullRequestLifecycleAction =
  | "opened"
  | "reopened"
  | "synchronize"
  | "closed";

export interface PullRequestLifecycleJob {
  type: "PullRequestLifecycle";
  action: PullRequestLifecycleAction;
  repository: string;
  pull_request_number: number;
  base_branch: string;
  default_branch: string;
  head_sha: string;
  merged: boolean;
  author_login: string;
  installation_id: number;
}

export interface RetryMergeabilityJob {
  type: "RetryMergeability";
  repository: string;
  pull_request_number: number;
  attempt: number;
  installation_id: number;
  reason?: string;
}

export interface ReevaluateOverlapJob {
  type: "ReevaluateOverlap";
  repository: string;
  pull_request_number: number;
  installation_id: number;
  reason: string;
  trigger_pr_number?: number;
}

export type AegisJob =
  | PullRequestLifecycleJob
  | RetryMergeabilityJob
  | ReevaluateOverlapJob;

export function parseAegisJob(body: string): AegisJob {
  const parsed = JSON.parse(body) as AegisJob;

  if (
    parsed.type !== "PullRequestLifecycle" &&
    parsed.type !== "RetryMergeability" &&
    parsed.type !== "ReevaluateOverlap"
  ) {
    throw new Error(`Unknown job type: ${(parsed as { type?: string }).type}`);
  }

  return parsed;
}

export function serializeAegisJob(job: AegisJob): string {
  return JSON.stringify(job);
}

/** DelaySeconds for RetryMergeability attempt N (1-based next attempt). */
export function mergeabilityRetryDelaySeconds(attempt: number): number {
  // attempt 2 (first deferred try) is immediate; later attempts back off.
  const delays = [0, 5, 15, 30, 60];
  const index = Math.min(Math.max(attempt - 2, 0), delays.length - 1);
  return delays[index] ?? 60;
}

export function maxMergeabilityQueueAttempts(): number {
  const raw = process.env.MAX_MERGEABILITY_QUEUE_ATTEMPTS;
  const parsed = raw ? Number.parseInt(raw, 10) : 5;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}
