#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { SkylightMcpStack } from "./stack.js";

const app = new cdk.App();

new SkylightMcpStack(app, "SkylightMcpStack", {
  env: {
    // Resolved from your AWS credentials at synth/deploy time (CDK sets these
    // from the active profile) -- no account number is hardcoded in this repo.
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || "us-east-1",
  },
  tags: {
    Application: "SkylightMCP",
    Environment: "Production",
    ManagedBy: "CDK",
    Repository: "MeffertHouse-SkylightCalendarAPI",
  },
});
