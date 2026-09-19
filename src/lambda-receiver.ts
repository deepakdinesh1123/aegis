import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { verify } from "@octokit/webhooks-methods";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";


// Receiver Lambda: sits behind API Gateway as the GitHub webhook target.

const sqs = new SQSClient({ region: process.env.AWS_REGION ?? "us-east-1" });

const QUEUE_URL = process.env.WEBHOOK_QUEUE_URL;

function getHeader(
  headers: APIGatewayProxyEventV2["headers"],
  name: string,
): string | undefined {
  const lower = name.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }

  return undefined;
}

function getRawBody(event: APIGatewayProxyEventV2): string {
  if (!event.body) {
    return "";
  }

  return event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  if (!QUEUE_URL) {
    console.error("WEBHOOK_QUEUE_URL is not configured");
    return { statusCode: 500, body: "Server misconfigured" };
  }

  const signature = getHeader(event.headers, "x-hub-signature-256");
  const eventName = getHeader(event.headers, "x-github-event");
  const deliveryId = getHeader(event.headers, "x-github-delivery");

  if (!signature || !eventName || !deliveryId) {
    return { statusCode: 400, body: "Missing required GitHub headers" };
  }

  const rawBody = getRawBody(event);

  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("WEBHOOK_SECRET is not configured");
    return { statusCode: 500, body: "Server misconfigured" };
  }

  const isValid = await verify(webhookSecret, rawBody, signature);

  if (!isValid) {
    return { statusCode: 401, body: "Invalid signature" };
  }

  let payload: unknown;

  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: "Invalid JSON payload" };
  }

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify({
        deliveryId,
        eventName,
        payload,
      }),
      MessageAttributes: {
        eventName: {
          DataType: "String",
          StringValue: eventName,
        },
      },
    }),
  );

  return { statusCode: 202, body: "Accepted" };
}