import nock from "nock";

import { enqueuePullRequestWebhook } from "../src/enqueue.js";
import { parseAegisJob } from "../src/queue/messages.js";
import { receiveJobs, deleteJob } from "../src/queue/sqs.js";

import { createTestTable } from "./helpers/dynamodb.js";
import { loadFixture } from "./helpers/fixtures.js";
import { createTestProbot } from "./helpers/probot.js";
import { resetQueue } from "./helpers/sqs.js";

const openedFixture = () => loadFixture("pull_request.opened.json");
const synchronizeFixture = () =>
  loadFixture("pull_request.synchronize.json");
const closedMergedFixture = () =>
  loadFixture("pull_request.closed.merged.json");

async function receivePullRequest(payload: unknown) {
  const probot = createTestProbot();

  await probot.receive({
    id: "test-delivery-id",
    name: "pull_request",
    payload: payload as never,
  });
}

describe("probot enqueue-only bot", () => {
  beforeEach(async () => {
    await createTestTable();
    await resetQueue();
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect(
      (host) =>
        host.includes("localhost") || host.includes("127.0.0.1"),
    );
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  test("event fixtures are present", () => {
    expect(openedFixture()).toMatchObject({ action: "opened" });
    expect(synchronizeFixture()).toMatchObject({
      action: "synchronize",
    });
    expect(closedMergedFixture()).toMatchObject({
      action: "closed",
      pull_request: { merged: true },
    });
    expect(openedFixture().repository).toMatchObject({
      default_branch: "main",
    });
  });

  test("opened webhook enqueues a lifecycle job", async () => {
    await receivePullRequest(openedFixture());

    const messages = await receiveJobs({ waitTimeSeconds: 1 });
    expect(messages).toHaveLength(1);

    const job = parseAegisJob(messages[0]!.Body!);
    expect(job).toMatchObject({
      type: "PullRequestLifecycle",
      action: "opened",
      pull_request_number: 1,
      repository: "test-owner/test-repo",
      base_branch: "main",
      default_branch: "main",
    });

    await deleteJob(messages[0]!.ReceiptHandle!);
  });

  test("synchronize webhook enqueues a lifecycle job", async () => {
    await receivePullRequest(synchronizeFixture());

    const messages = await receiveJobs({ waitTimeSeconds: 1 });
    expect(messages).toHaveLength(1);
    expect(parseAegisJob(messages[0]!.Body!)).toMatchObject({
      type: "PullRequestLifecycle",
      action: "synchronize",
    });
    await deleteJob(messages[0]!.ReceiptHandle!);
  });

  test("closed merged webhook enqueues a lifecycle job", async () => {
    await receivePullRequest(closedMergedFixture());

    const messages = await receiveJobs({ waitTimeSeconds: 1 });
    expect(messages).toHaveLength(1);
    expect(parseAegisJob(messages[0]!.Body!)).toMatchObject({
      type: "PullRequestLifecycle",
      action: "closed",
      merged: true,
      pull_request_number: 10,
    });
    await deleteJob(messages[0]!.ReceiptHandle!);
  });

  test("non-default base is not enqueued", async () => {
    const payload = openedFixture();
    payload.pull_request.base.ref = "develop";

    await enqueuePullRequestWebhook(payload as never, {
      info: () => undefined,
      warn: () => undefined,
    });

    const messages = await receiveJobs({ waitTimeSeconds: 1 });
    expect(messages).toHaveLength(0);
  });
});
