import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";

export const TABLE_NAME = "pull-request-state";

export const dynamodb = new DynamoDBClient({
  region: "us-east-1",
  endpoint: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000",
  credentials: {
    accessKeyId: "local",
    secretAccessKey: "local",
  },
});

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createTestTable() {
  try {
    await dynamodb.send(
      new DeleteTableCommand({
        TableName: TABLE_NAME,
      }),
    );
  } catch {
    // Table may not exist.
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await dynamodb.send(
        new CreateTableCommand({
          TableName: TABLE_NAME,

          AttributeDefinitions: [
            {
              AttributeName: "repository",
              AttributeType: "S",
            },
            {
              AttributeName: "pull_request_number",
              AttributeType: "N",
            },
          ],

          KeySchema: [
            {
              AttributeName: "repository",
              KeyType: "HASH",
            },
            {
              AttributeName: "pull_request_number",
              KeyType: "RANGE",
            },
          ],

          BillingMode: "PAY_PER_REQUEST",
        }),
      );

      return;
    } catch (error) {
      const name = (error as { name?: string }).name;

      if (name === "ResourceInUseException" && attempt < 19) {
        await sleep(50);
        continue;
      }

      throw error;
    }
  }
}
