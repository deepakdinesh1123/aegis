import {
  DeleteMessageCommand,
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";

import {
  type AegisJob,
  serializeAegisJob,
} from "./messages.js";

function requireQueueUrl(): string {
  const url = process.env.SQS_QUEUE_URL;
  if (!url) {
    throw new Error("SQS_QUEUE_URL is not configured");
  }
  return url;
}

let cachedClient: SQSClient | undefined;

export function createSqsClient(): SQSClient {
  if (cachedClient) {
    return cachedClient;
  }

  cachedClient = new SQSClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    ...(process.env.SQS_ENDPOINT
      ? {
          endpoint: process.env.SQS_ENDPOINT,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "local",
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "local",
          },
        }
      : {}),
  });

  return cachedClient;
}

/** Reset the cached client (tests). */
export function resetSqsClient(): void {
  cachedClient = undefined;
}

export async function enqueueJob(
  job: AegisJob,
  options: { delaySeconds?: number; client?: SQSClient } = {},
): Promise<string | undefined> {
  const client = options.client ?? createSqsClient();
  const queueUrl = requireQueueUrl();

  const result = await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: serializeAegisJob(job),
      DelaySeconds: options.delaySeconds ?? 0,
    }),
  );

  return result.MessageId;
}

export async function receiveJobs(
  options: {
    maxMessages?: number;
    waitTimeSeconds?: number;
    visibilityTimeout?: number;
    client?: SQSClient;
  } = {},
): Promise<Message[]> {
  const client = options.client ?? createSqsClient();
  const queueUrl = requireQueueUrl();

  const result = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: options.maxMessages ?? 10,
      WaitTimeSeconds: options.waitTimeSeconds ?? 1,
      VisibilityTimeout: options.visibilityTimeout ?? 60,
    }),
  );

  return result.Messages ?? [];
}

export async function deleteJob(
  receiptHandle: string,
  options: { client?: SQSClient } = {},
): Promise<void> {
  const client = options.client ?? createSqsClient();
  const queueUrl = requireQueueUrl();

  await client.send(
    new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle,
    }),
  );
}

export async function deleteJobs(
  receiptHandles: string[],
  options: { client?: SQSClient } = {},
): Promise<void> {
  if (receiptHandles.length === 0) {
    return;
  }

  const client = options.client ?? createSqsClient();
  const queueUrl = requireQueueUrl();

  await client.send(
    new DeleteMessageBatchCommand({
      QueueUrl: queueUrl,
      Entries: receiptHandles.map((handle, index) => ({
        Id: String(index),
        ReceiptHandle: handle,
      })),
    }),
  );
}

export async function purgeQueue(
  options: { client?: SQSClient } = {},
): Promise<void> {
  const client = options.client ?? createSqsClient();
  const queueUrl = requireQueueUrl();

  await client.send(
    new PurgeQueueCommand({
      QueueUrl: queueUrl,
    }),
  );
}

export async function approximateQueueDepth(
  options: { client?: SQSClient } = {},
): Promise<number> {
  const client = options.client ?? createSqsClient();
  const queueUrl = requireQueueUrl();

  const result = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages"],
    }),
  );

  const raw = result.Attributes?.ApproximateNumberOfMessages ?? "0";
  return Number.parseInt(raw, 10) || 0;
}
