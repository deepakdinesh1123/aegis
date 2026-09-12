import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

import type { PullRequestState } from "./types.js";

const client = new DynamoDBClient({
  region: process.env.AWS_REGION ?? "us-east-1",

  ...(process.env.DYNAMODB_ENDPOINT
    ? {
        endpoint: process.env.DYNAMODB_ENDPOINT,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "local",
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "local",
        },
      }
    : {}),
});

const db = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;

if (!TABLE_NAME) {
  throw new Error("DYNAMODB_TABLE_NAME is not configured");
}

export async function getPullRequestState(
  repository: string,
  pullRequestNumber: number,
): Promise<PullRequestState | undefined> {
  const result = await db.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        repository,
        pull_request_number: pullRequestNumber,
      },
    }),
  );

  return result.Item as PullRequestState | undefined;
}

export async function savePullRequestState(
  state: PullRequestState,
): Promise<void> {
  await db.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: state,
    }),
  );
}

export async function deletePullRequestState(
  repository: string,
  pullRequestNumber: number,
): Promise<void> {
  await db.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        repository,
        pull_request_number: pullRequestNumber,
      },
    }),
  );
}
