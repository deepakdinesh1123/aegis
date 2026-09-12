import { Probot, ProbotOctokit } from "probot";
import nock from "nock";

import app from "../../src/index.js";

export function createTestProbot() {
  nock.disableNetConnect();
  nock.enableNetConnect(
    (host) =>
      host.includes("localhost") ||
      host.includes("127.0.0.1"),
  );

  const probot = new Probot({
    githubToken: "test",

    Octokit: ProbotOctokit.defaults({
      retry: {
        enabled: false,
      },

      throttle: {
        enabled: false,
      },
    }),
  });

  probot.load(app);

  return probot;
}
