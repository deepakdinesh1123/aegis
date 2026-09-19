import type { SQSEvent, SQSRecord } from "aws-lambda";
import type { Message } from "@aws-sdk/client-sqs";

import { createInstallationOctokit } from "../github/app-octokit.js";
import { createSqsLambdaHandler } from "../handlers/sqs-lambda.js";
import { deleteJob, receiveJobs } from "../queue/sqs.js";

/**
 * Local adapter that simulates AWS SQS → Lambda invocation.
 * In AWS, this file is unused: SQS triggers `handlers/sqs-lambda` directly.
 */
function toSqsEvent(messages: Message[]): SQSEvent {
  return {
    Records: messages.map(
      (message, index): SQSRecord => ({
        messageId: message.MessageId ?? `local-${index}`,
        receiptHandle: message.ReceiptHandle ?? "",
        body: message.Body ?? "",
        attributes: {
          ApproximateReceiveCount: "1",
          SentTimestamp: String(Date.now()),
          SenderId: "local",
          ApproximateFirstReceiveTimestamp: String(Date.now()),
        },
        messageAttributes: {},
        md5OfBody: message.MD5OfBody ?? "",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:local:000000000000:aegis-events",
        awsRegion: process.env.AWS_REGION ?? "us-east-1",
      }),
    ),
  };
}

async function main(): Promise<void> {
  const handler = createSqsLambdaHandler(createInstallationOctokit);
  const waitTimeSeconds = Number(process.env.SQS_WAIT_TIME_SECONDS ?? "10");

  console.info("Aegis SQS processor started (local ElasticMQ → Lambda adapter)");

  for (;;) {
    try {
      const messages = await receiveJobs({
        maxMessages: 5,
        waitTimeSeconds,
      });

      if (messages.length === 0) {
        continue;
      }

      const event = toSqsEvent(messages);
      const result = await handler(event, {} as never, () => undefined);

      const failedIds = new Set(
        (result?.batchItemFailures ?? []).map((f) => f.itemIdentifier),
      );

      for (const message of messages) {
        if (!message.MessageId || !message.ReceiptHandle) {
          continue;
        }

        if (failedIds.has(message.MessageId)) {
          console.error(
            `Leaving message ${message.MessageId} for retry / DLQ`,
          );
          continue;
        }

        await deleteJob(message.ReceiptHandle);
      }
    } catch (error) {
      console.error("Processor loop error", error);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

void main();
