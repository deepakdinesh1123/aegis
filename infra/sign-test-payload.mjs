// Run from infra/: node sign-test-payload.mjs
//
// Builds a realistic pull_request.synchronize payload for a REAL PR in
// your test repo, signs it with your real WEBHOOK_SECRET, and writes
// both the payload and the signature so you can curl/invoke with them.
//
// Edit the constants below before running.

import { writeFileSync } from "node:fs";
import { sign } from "@octokit/webhooks-methods";
import * as dotenv from "dotenv";

dotenv.config();

const OWNER = "Sujay-J-Reddy";
const REPO = "ekl-agents";
const PR_NUMBER = 5; // ← set to a real, currently-open PR number
const INSTALLATION_ID = 162966900; // ← from your earlier bot logs

const payload = {
  action: "synchronize",
  installation: { id: INSTALLATION_ID },
  repository: {
    name: REPO,
    full_name: `${OWNER}/${REPO}`,
    owner: { login: OWNER },
  },
  pull_request: {
    number: PR_NUMBER,
    merged: false,
    user: { login: OWNER },
    head: { ref: `feature-${PR_NUMBER}`, sha: "placeholder" },
    base: { ref: "main", sha: "placeholder" },
    mergeable: null,
    mergeable_state: "unknown",
  },
};

const body = JSON.stringify(payload);
const secret = process.env.WEBHOOK_SECRET;

if (!secret) {
  throw new Error("Set WEBHOOK_SECRET in infra/.env first");
}

const signature = await sign(secret, body);

writeFileSync("test-payload.json", body);
writeFileSync("test-signature.txt", signature);

console.log("Wrote test-payload.json and test-signature.txt");
console.log("Signature:", signature);
