import {
  approximateQueueDepth,
  purgeQueue,
  receiveJobs,
  deleteJob,
  enqueueJob,
} from "../../src/queue/sqs.js";
import { parseAegisJob, type AegisJob } from "../../src/queue/messages.js";
import {
  drainWorkerOnce,
} from "../../src/queue/poller.js";
import type { InstallationAuth } from "../../src/handlers/worker.js";
import type { AppContext } from "../../src/github.js";

export async function resetQueue(): Promise<void> {
  try {
    await purgeQueue();
  } catch {
    // Purge can fail if queue was just created; drain instead.
    for (let i = 0; i < 20; i++) {
      const messages = await receiveJobs({
        maxMessages: 10,
        waitTimeSeconds: 0,
        visibilityTimeout: 1,
      });
      if (messages.length === 0) {
        break;
      }
      for (const message of messages) {
        if (message.ReceiptHandle) {
          await deleteJob(message.ReceiptHandle);
        }
      }
    }
  }
}

export async function peekJobs(limit = 10): Promise<AegisJob[]> {
  const messages = await receiveJobs({
    maxMessages: limit,
    waitTimeSeconds: 1,
    visibilityTimeout: 1,
  });

  const jobs: AegisJob[] = [];

  for (const message of messages) {
    if (!message.Body || !message.ReceiptHandle) {
      continue;
    }
    jobs.push(parseAegisJob(message.Body));
    // Visibility will expire; for assertions we may need to re-receive.
    // Delete so we don't leave them invisible forever in tests that only peek.
    await deleteJob(message.ReceiptHandle);
  }

  return jobs;
}

/**
 * Process queued jobs until the queue is empty or maxRounds hit.
 */
export async function processUntilEmpty(
  auth: InstallationAuth,
  options: { maxRounds?: number; waitTimeSeconds?: number } = {},
): Promise<number> {
  const maxRounds = options.maxRounds ?? 30;
  let total = 0;

  for (let round = 0; round < maxRounds; round++) {
    const depth = await approximateQueueDepth();
    const processed = await drainWorkerOnce({
      auth,
      waitTimeSeconds: options.waitTimeSeconds ?? 1,
      maxMessages: 10,
    });
    total += processed;

    if (processed === 0 && depth === 0) {
      break;
    }

    if (processed === 0) {
      // Delayed messages may still be waiting.
      await new Promise((r) => setTimeout(r, 1100));
    }
  }

  return total;
}

/**
 * Auth that returns a fixed AppContext octokit (for nock-backed tests).
 */
export function staticAuth(
  octokit: AppContext["octokit"],
): InstallationAuth {
  return async () => octokit;
}

export async function enqueueAndCount(job: AegisJob): Promise<void> {
  await enqueueJob(job);
}
