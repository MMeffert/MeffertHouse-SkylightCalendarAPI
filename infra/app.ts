#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { SkylightMcpStack } from "./stack.js";

const app = new cdk.App();

new SkylightMcpStack(app, "SkylightMcpStack", {
  env: {
    account: "241654197557",
    region: "us-east-1",
  },
  tags: {
    Application: "SkylightMCP",
    Environment: "Production",
    ManagedBy: "CDK",
    Repository: "MeffertHouse-SkylightCalendarAPI",
  },
});
