import type { SQSHandler, SQSEvent, SQSBatchResponse } from "aws-lambda";

import { createInstallationOctokit } from "../github/app-octokit.js";
import { processAegisJobBody, type InstallationAuth } from "./worker.js";

/**
 * SQS-triggered processor Lambda.
 * AWS invokes this when messages arrive on the queue.
 * Locally, `src/local/worker-poller.ts` receives from ElasticMQ and calls this handler.
 */
export function createSqsLambdaHandler(
  auth: InstallationAuth = createInstallationOctokit,
): SQSHandler {
  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];

    for (const record of event.Records) {
      try {
        await processAegisJobBody(record.body, { auth });
      } catch (error) {
        console.error("Failed to process SQS record", error);
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }

    return { batchItemFailures };
  };
}

export const handler = createSqsLambdaHandler();
