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

/**
 * Thrown when a save loses an optimistic-locking race — i.e. someone
 * else wrote a newer version of this item between our read and our
 * write. Callers running under multiple concurrent workers (e.g.
 * several Lambda invocations processing SQS messages for the same PR)
 * should catch this and either retry with a fresh read or drop the
 * write, since the winning writer already reflects a state that is at
 * least as current as the one we were about to save.
 */
export class StateConflictError extends Error {
  constructor(repository: string, pullRequestNumber: number) {
    super(
      `Optimistic lock conflict saving state for ${repository}#${pullRequestNumber}`,
    );
    this.name = "StateConflictError";
  }
}

function isConditionalCheckFailure(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: string }).name === "ConditionalCheckFailedException"
  );
}

/**
 * Save a PR's state with optimistic locking.
 *
 * Pass `expectedVersion` as the `version` you last read for this item
 * (e.g. `previous?.version`, or the `.version` of a state you just
 * saved earlier in the same handler). Leave it `undefined` only when
 * you are certain no item exists yet for this key — the write will be
 * conditioned on the item not existing, and will fail if it does.
 *
 * Returns the saved state, including its new version, so callers can
 * thread it into a subsequent save within the same logical operation.
 *
 * Throws `StateConflictError` if the item changed since it was last
 * read (or already existed, when `expectedVersion` was omitted).
 */
export async function savePullRequestState(
  state: PullRequestState,
  expectedVersion?: number,
): Promise<PullRequestState> {
  const nextVersion = (expectedVersion ?? 0) + 1;
  const item: PullRequestState = { ...state, version: nextVersion };

  try {
    await db.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
        ConditionExpression:
          expectedVersion === undefined
            ? "attribute_not_exists(repository)"
            : "version = :expectedVersion",
        ...(expectedVersion === undefined
          ? {}
          : {
              ExpressionAttributeValues: {
                ":expectedVersion": expectedVersion,
              },
            }),
      }),
    );
  } catch (err) {
    if (isConditionalCheckFailure(err)) {
      throw new StateConflictError(
        state.repository,
        state.pull_request_number,
      );
    }

    throw err;
  }

  return item;
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