import * as cdk from "aws-cdk-lib";
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
