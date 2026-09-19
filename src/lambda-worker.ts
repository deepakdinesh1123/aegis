import { Probot } from "probot";
import type {
  SQSBatchItemFailure,
  SQSBatchResponse,
  SQSEvent,
  SQSRecord,
} from "aws-lambda";

import appFn from "./index.js";
import { StateConflictError } from "./state.js";


//Worker Lambda: triggered by the SQS event source mapping, not by


interface QueueMessage {
  deliveryId: string;
  eventName: string;
  payload: Record<string, unknown>;
}

/**
 * Reused across warm invocations of the same execution environment,
 * so repeated batches on the same container don't redo GitHub App
 * auth setup or re-register the event listeners each time.
 */
let probotPromise: Promise<Probot> | undefined;

function getProbot(): Promise<Probot> {
  probotPromise ??= (async () => {
    const probot = new Probot({
      appId: process.env.APP_ID,
      privateKey: process.env.PRIVATE_KEY,
      // The receiver Lambda already verified the HMAC signature before
      // this message ever reached SQS, so signature checking here is
      // moot — Probot still wants a value configured, it's just unused
      // by `.receive()`.
      secret: process.env.WEBHOOK_SECRET ?? "unused-post-receiver",
    });

    await probot.load(appFn);

    return probot;
  })();

  return probotPromise;
}

function parseMessage(record: SQSRecord): QueueMessage {
  return JSON.parse(record.body) as QueueMessage;
}

/**
 * Process one SQS batch. Failures are reported per-message via
 * `batchItemFailures` (partial batch failure reporting) rather than
 * throwing for the whole batch — a `StateConflictError` or a
 * transient GitHub API error on one message must not cause SQS to
 * redeliver messages in the same batch that already succeeded.
 *
 * Requires the event source mapping to set
 * `functionResponseType: "ReportBatchItemFailures"`.
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const probot = await getProbot();
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      const message = parseMessage(record);

      await probot.receive({
        id: message.deliveryId,
        // Probot's `receive` type is a discriminated union keyed by
        // event name; we only know the shape at runtime, from the
        // header the receiver Lambda forwarded.
        name: message.eventName as never,
        payload: message.payload as never,
      });
    } catch (err) {
      const reason =
        err instanceof StateConflictError
          ? "optimistic-lock conflict"
          : "processing error";

      probot.log.error(
        { err, messageId: record.messageId, reason },
        "Failed to process webhook message; returning to queue",
      );

      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}