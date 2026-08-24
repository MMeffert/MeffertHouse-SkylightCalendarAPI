import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import * as path from "path";
import { fileURLToPath } from "url";

// ES module compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class SkylightMcpStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Reference existing secret (create manually or via CLI)
    const skylightSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "SkylightSecret",
      "skylight-mcp/credentials"
    );

    // Lambda function
    const mcpFunction = new nodejs.NodejsFunction(this, "SkylightMcpFunction", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "handler",
      entry: path.join(__dirname, "../src/lambda.ts"),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        SECRET_ARN: skylightSecret.secretArn,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node24",
        format: nodejs.OutputFormat.ESM,
        mainFields: ["module", "main"],
        esbuildArgs: {
          "--conditions": "module",
        },
      },
    });

    // Grant Lambda access to read the secret
    skylightSecret.grantRead(mcpFunction);

    // Function URL for direct HTTPS access
    const functionUrl = mcpFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE, // We'll handle auth in code
      cors: {
        allowedOrigins: ["*"],
        allowedMethods: [lambda.HttpMethod.POST],
        allowedHeaders: ["Content-Type", "Authorization", "mcp-session-id"],
      },
    });

    // --- Token Refresher Lambda ---
    // Headless OAuth login to Skylight, verifies the new token, then writes
    // to Secrets Manager. The MCP Lambda picks it up on its 5-min cache TTL.

    const refresherFunction = new nodejs.NodejsFunction(this, "SkylightTokenRefresher", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "handler",
      entry: path.join(__dirname, "../src/refresher.ts"),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        SECRET_ARN: skylightSecret.secretArn,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node24",
        format: nodejs.OutputFormat.ESM,
        mainFields: ["module", "main"],
        esbuildArgs: {
          "--conditions": "module",
        },
      },
    });

    // Refresher needs read + write (read-modify-write pattern)
    skylightSecret.grantRead(refresherFunction);
    skylightSecret.grantWrite(refresherFunction);

    // Four-times-daily schedule with 5-minute jitter to spread load and avoid
    // looking automated. Token TTL is ~12h; 6h spacing leaves a comfortable margin.
    const refreshWindows = [
      { minute: "5", hour: "4", label: "04:05 UTC" },
      { minute: "5", hour: "10", label: "10:05 UTC" },
      { minute: "5", hour: "16", label: "16:05 UTC" },
      { minute: "5", hour: "22", label: "22:05 UTC" },
    ];

    const refreshSchedules = refreshWindows.map((w, i) =>
      new events.Rule(this, `SkylightTokenRefreshSchedule${i}`, {
        schedule: events.Schedule.cron({ minute: w.minute, hour: w.hour }),
        description: `Skylight token refresh (${w.label})`,
      })
    );

    for (const schedule of refreshSchedules) {
      schedule.addTarget(new targets.LambdaFunction(refresherFunction, {
        retryAttempts: 2,
      }));
    }

    // CloudWatch alarm: alert if the refresher fails (token would go stale until next run)
    const refresherAlarm = new cdk.aws_cloudwatch.Alarm(this, "SkylightRefresherErrors", {
      metric: refresherFunction.metricErrors(),
      threshold: 0,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOTBreaching,
    });

    // Outputs
    new cdk.CfnOutput(this, "McpEndpointUrl", {
      value: functionUrl.url,
      description: "MCP Server endpoint URL for Claude clients",
    });

    new cdk.CfnOutput(this, "SecretArn", {
      value: skylightSecret.secretArn,
      description: "ARN of the Skylight credentials secret",
    });
  }
}
