import type {
  APIGatewayProxyEvent,
  APIGatewayProxyHandler,
  APIGatewayProxyResult,
} from "aws-lambda";
import { Webhooks } from "@octokit/webhooks";

import { enqueuePullRequestWebhook } from "../enqueue.js";

function readBody(event: APIGatewayProxyEvent): string {
  if (!event.body) {
    return "";
  }

  if (event.isBase64Encoded) {
    return Buffer.from(event.body, "base64").toString("utf8");
  }

  return event.body;
}

function header(
  event: APIGatewayProxyEvent,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() === lower && value) {
      return value;
    }
  }
  return undefined;
}

/**
 * GitHub webhook → queue Lambda.
 * Verifies the webhook signature and enqueues an SQS job. Does not process work.
 */
export function createWebhookLambdaHandler(
  secret = process.env.WEBHOOK_SECRET ?? "development",
): APIGatewayProxyHandler {
  const webhooks = new Webhooks({ secret });

  return async (
    event: APIGatewayProxyEvent,
  ): Promise<APIGatewayProxyResult> => {
    const signature = header(event, "x-hub-signature-256");
    const eventName = header(event, "x-github-event");
    const delivery = header(event, "x-github-delivery");
    const body = readBody(event);

    if (!signature || !eventName) {
      return { statusCode: 400, body: "Missing GitHub webhook headers" };
    }

    try {
      await webhooks.verify(body, signature);
    } catch {
      return { statusCode: 401, body: "Invalid signature" };
    }

    if (eventName !== "pull_request") {
      return { statusCode: 202, body: "Ignored event" };
    }

    const payload = JSON.parse(body) as Parameters<
      typeof enqueuePullRequestWebhook
    >[0];

    await enqueuePullRequestWebhook(payload, {
      info: (msg) => console.info(`[webhook ${delivery}] ${msg}`),
      warn: (msg) => console.warn(`[webhook ${delivery}] ${msg}`),
    });

    return { statusCode: 200, body: "enqueued" };
  };
}

export const handler = createWebhookLambdaHandler();
