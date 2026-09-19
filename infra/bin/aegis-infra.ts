#!/usr/bin/env node
import * as dotenv from "dotenv";
import * as cdk from "aws-cdk-lib";

import { AegisInfraStack } from "../lib/aegis-infra-stack";

// Loads infra/.env — NOT committed (see .gitignore). Holds the GitHub
// App credentials as plain values for this first-pass setup.
//
// This is fine to get the pipeline running end-to-end, but for a real
// production deployment these should move to AWS Secrets Manager
// instead of living as plaintext Lambda environment variables (see
// the README note in this directory).
dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Missing required env var ${name}. Copy infra/.env.example to infra/.env and fill it in.`,
    );
  }

  return value;
}

const app = new cdk.App();

new AegisInfraStack(app, "AegisInfraStack", {
  appId: requireEnv("APP_ID"),
  privateKey: requireEnv("PRIVATE_KEY"),
  webhookSecret: requireEnv("WEBHOOK_SECRET"),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
});
