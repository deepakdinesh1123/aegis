import type {
  PullRequestLifecycleAction,
  PullRequestLifecycleJob,
} from "./queue/messages.js";
import { enqueueJob } from "./queue/sqs.js";
import { isDefaultBranchTarget } from "./processor/lifecycle.js";

export interface PullRequestWebhookPayload {
  action: string;
  installation?: { id: number } | null;
  repository: {
    full_name: string;
    default_branch: string;
  };
  pull_request: {
    number: number;
    merged: boolean | null;
    user?: { login?: string } | null;
    head: { sha: string };
    base: { ref: string };
  };
}

function toLifecycleAction(
  action: string,
): PullRequestLifecycleAction | null {
  if (
    action === "opened" ||
    action === "reopened" ||
    action === "synchronize" ||
    action === "closed"
  ) {
    return action;
  }

  return null;
}

/**
 * Enqueue a pull_request webhook as an SQS job. Processing happens later
 * in the in-process SQS poller (or a separate Lambda worker in AWS).
 */
export async function enqueuePullRequestWebhook(
  payload: PullRequestWebhookPayload,
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  },
): Promise<string | undefined> {
  const action = toLifecycleAction(payload.action);

  if (!action) {
    log.info(`Ignoring pull_request.${payload.action}`);
    return undefined;
  }

  const installationId = payload.installation?.id;

  if (!installationId) {
    log.warn("Missing installation id; cannot enqueue job");
    return undefined;
  }

  const baseBranch = payload.pull_request.base.ref;
  const defaultBranch = payload.repository.default_branch;

  if (!isDefaultBranchTarget(baseBranch, defaultBranch)) {
    log.info(
      `Skipping PR #${payload.pull_request.number}: base ${baseBranch} ≠ default ${defaultBranch}`,
    );
    return undefined;
  }

  const job: PullRequestLifecycleJob = {
    type: "PullRequestLifecycle",
    action,
    repository: payload.repository.full_name,
    pull_request_number: payload.pull_request.number,
    base_branch: baseBranch,
    default_branch: defaultBranch,
    head_sha: payload.pull_request.head.sha,
    merged: Boolean(payload.pull_request.merged),
    author_login: payload.pull_request.user?.login ?? "unknown",
    installation_id: installationId,
  };

  const messageId = await enqueueJob(job);
  log.info(
    `Enqueued ${action} for PR #${job.pull_request_number} (message ${messageId ?? "unknown"})`,
  );
  return messageId;
}
