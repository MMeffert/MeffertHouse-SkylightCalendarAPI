#!/usr/bin/env node
/**
 * Skylight Calendar MCP Server
 * Entry point for the local MCP server using stdio transport
 *
 * Usage with Claude Desktop:
 * Configure in ~/.claude/settings.json or Claude Desktop MCP settings
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SkylightClient } from "./skylight/client.js";
import { registerTools } from "./tools/index.js";

// Read configuration from environment variables
const SKYLIGHT_AUTH_TOKEN = process.env.SKYLIGHT_AUTH_TOKEN;
const SKYLIGHT_FRAME_ID = process.env.SKYLIGHT_FRAME_ID;

// Validate required environment variables
if (!SKYLIGHT_AUTH_TOKEN) {
  console.error(
    "Error: SKYLIGHT_AUTH_TOKEN environment variable is required."
  );
  console.error(
    "Set it in your Claude Desktop MCP configuration or export it before running."
  );
  process.exit(1);
}

if (!SKYLIGHT_FRAME_ID) {
  console.error("Error: SKYLIGHT_FRAME_ID environment variable is required.");
  console.error(
    "Set it in your Claude Desktop MCP configuration or export it before running."
  );
  process.exit(1);
}

// Create the MCP server
const server = new McpServer({
  name: "skylight-calendar",
  version: "1.0.0",
});

// Create the Skylight API client
const skylightClient = new SkylightClient({
  authToken: SKYLIGHT_AUTH_TOKEN,
  frameId: SKYLIGHT_FRAME_ID,
});

// Register all tools
registerTools(server, skylightClient);

// Start the server with stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr since stdout is used for MCP communication
  console.error("Skylight Calendar MCP server started");
  console.error(`Frame ID: ${SKYLIGHT_FRAME_ID}`);
}

main().catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exit(1);
});
