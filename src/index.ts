import type { Probot } from "probot";

import { enqueuePullRequestWebhook } from "./enqueue.js";

/**
 * Queuing Lambda / webhook service entry (via Probot).
 *
 * GitHub webhooks land here and are enqueued to SQS only.
 * Processing happens in a separate SQS-triggered processor — never here.
 */
export default function (app: Probot): void {
  app.on(
    [
      "pull_request.opened",
      "pull_request.reopened",
      "pull_request.synchronize",
      "pull_request.closed",
    ],
    async (context) => {
      await enqueuePullRequestWebhook(
        context.payload as never,
        context.log,
      );
    },
  );
}

export { enqueuePullRequestWebhook } from "./enqueue.js";
export { mapWithConcurrency } from "./concurrency.js";
export { processAegisJob, processAegisJobBody } from "./handlers/worker.js";
export { drainWorkerOnce, runWorkerPoller } from "./queue/poller.js";
export { enqueueJob, purgeQueue, receiveJobs } from "./queue/sqs.js";
