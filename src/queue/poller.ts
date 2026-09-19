import type { Logger } from "probot";

import { processAegisJobBody, type InstallationAuth } from "../handlers/worker.js";
import { parseAegisJob } from "./messages.js";
import { deleteJob, receiveJobs } from "./sqs.js";

export interface PollerOptions {
  auth: InstallationAuth;
  log?: Pick<Logger, "info" | "warn" | "error" | "debug">;
  waitTimeSeconds?: number;
  maxMessages?: number;
  /** When true, stop after one empty receive (tests). */
  stopOnEmpty?: boolean;
  /** Abort signal / flag checked each loop. */
  shouldContinue?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Long-poll SQS/ElasticMQ and process jobs.
 * Used by the **processor** service / tests only — never by the webhook Lambda.
 */
export async function runWorkerPoller(
  options: PollerOptions,
): Promise<void> {
  const log = options.log;
  const sleep = options.sleep ?? defaultSleep;
  const shouldContinue = options.shouldContinue ?? (() => true);

  log?.info("SQS processor poller started");

  while (shouldContinue()) {
    try {
      const messages = await receiveJobs({
        maxMessages: options.maxMessages ?? 5,
        waitTimeSeconds: options.waitTimeSeconds ?? 10,
      });

      if (messages.length === 0) {
        if (options.stopOnEmpty) {
          return;
        }
        continue;
      }

      for (const message of messages) {
        if (!message.Body || !message.ReceiptHandle) {
          continue;
        }

        try {
          const job = parseAegisJob(message.Body);
          log?.info(
            `Processing ${job.type} for ${"pull_request_number" in job ? `#${job.pull_request_number}` : "n/a"}`,
          );
          await processAegisJobBody(message.Body, {
            auth: options.auth,
            log: log as never,
          });
          await deleteJob(message.ReceiptHandle);
        } catch (error) {
          log?.error(error as Error, "Failed processing SQS message");
        }
      }
    } catch (error) {
      log?.error(error as Error, "SQS poller loop error");
      await sleep(2000);
    }
  }
}

/**
 * Receive and process up to `maxMessages` once (tests / drain helpers).
 */
export async function drainWorkerOnce(
  options: Omit<PollerOptions, "stopOnEmpty" | "shouldContinue"> & {
    maxMessages?: number;
    waitTimeSeconds?: number;
  },
): Promise<number> {
  const messages = await receiveJobs({
    maxMessages: options.maxMessages ?? 10,
    waitTimeSeconds: options.waitTimeSeconds ?? 1,
  });

  let processed = 0;

  for (const message of messages) {
    if (!message.Body || !message.ReceiptHandle) {
      continue;
    }

    await processAegisJobBody(message.Body, {
      auth: options.auth,
      log: options.log as never,
    });
    await deleteJob(message.ReceiptHandle);
    processed += 1;
  }

  return processed;
}
