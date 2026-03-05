/**
 * AWS Lambda handler for Skylight MCP Server
 * Handles MCP protocol over HTTP via Lambda Function URL
 */

import { timingSafeEqual } from "crypto";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SkylightClient } from "./skylight/client.js";
import { registerTools } from "./tools/index.js";

// Constants
const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const ACCESS_TOKEN_TTL_SECONDS = 31536000; // 1 year
const ALLOWED_REDIRECT_HOSTS = [
  "claude.ai",
  "localhost",
  "127.0.0.1",
];

// Types for Lambda Function URL events
interface LambdaFunctionUrlEvent {
  version: string;
  routeKey: string;
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string>;
  requestContext: {
    http: {
      method: string;
      path: string;
    };
  };
  body?: string;
  isBase64Encoded: boolean;
}

interface LambdaFunctionUrlResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

// Cache secrets to avoid repeated API calls
let cachedCredentials: {
  authToken: string;
  frameId: string;
  apiKey: string;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthPin: string | null;
} | null = null;

async function getCredentials() {
  if (cachedCredentials) return cachedCredentials;

  const client = new SecretsManagerClient({});
  const secretArn = process.env.SECRET_ARN;

  if (!secretArn) {
    throw new Error("SECRET_ARN environment variable not set");
  }

  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );

  if (!response.SecretString) {
    throw new Error("Secret value is empty");
  }

  const secret = JSON.parse(response.SecretString);
  cachedCredentials = {
    authToken: secret.SKYLIGHT_AUTH_TOKEN,
    frameId: secret.SKYLIGHT_FRAME_ID,
    apiKey: secret.MCP_API_KEY,
    oauthClientId: secret.OAUTH_CLIENT_ID || "skylight-mcp",
    oauthClientSecret: secret.OAUTH_CLIENT_SECRET || secret.MCP_API_KEY,
    oauthPin: secret.OAUTH_PIN || null,
  };

  return cachedCredentials;
}

// Simple in-memory store for PKCE codes (in production, use DynamoDB or similar)
const authCodes: Map<string, { codeChallenge: string; clientId: string; redirectUri: string; expiresAt: number }> = new Map();

// HTML helpers for consent page
function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function renderConsentPage(params: {
  responseType: string; clientId: string; redirectUri: string;
  codeChallenge: string; codeChallengeMethod: string; state: string | null;
  error?: string;
}): string {
  const e = escapeHtml;
  const errorHtml = params.error ? `<p class="error">${e(params.error)}</p>` : "";
  const stateField = params.state
    ? `<input type="hidden" name="state" value="${e(params.state)}">`
    : "";
  return `<!DOCTYPE html><html><head><title>Skylight MCP - Authorize</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5}
.card{background:#fff;padding:2rem;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.1);max-width:360px;width:100%}
h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#666;font-size:.9rem;margin:0 0 1.5rem}
input[type=password]{width:100%;padding:.75rem;border:1px solid #ddd;border-radius:8px;font-size:1rem;box-sizing:border-box}
button{width:100%;padding:.75rem;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer;margin-top:1rem}
button:hover{background:#1d4ed8}.error{color:#dc2626;font-size:.85rem;margin-top:.5rem}</style></head>
<body><div class="card"><h1>Skylight Calendar</h1>
<p>Enter your PIN to authorize MCP access.</p>
<form method="POST" action="/authorize">
<input type="hidden" name="response_type" value="${e(params.responseType)}">
<input type="hidden" name="client_id" value="${e(params.clientId)}">
<input type="hidden" name="redirect_uri" value="${e(params.redirectUri)}">
<input type="hidden" name="code_challenge" value="${e(params.codeChallenge)}">
<input type="hidden" name="code_challenge_method" value="${e(params.codeChallengeMethod)}">
${stateField}
<input type="password" name="pin" placeholder="Enter PIN" required autofocus>
${errorHtml}
<button type="submit">Authorize</button>
</form></div></body></html>`;
}

// Handle OAuth authorize endpoint (Authorization Code flow with PKCE)
async function handleOAuthAuthorize(
  event: LambdaFunctionUrlEvent,
  headers: Record<string, string>
): Promise<LambdaFunctionUrlResponse> {
  const credentials = await getCredentials();
  const method = event.requestContext.http.method;

  // Parse params from query string (GET) or form body (POST)
  let params: URLSearchParams;
  if (method === "POST") {
    const body = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf-8")
      : event.body || "";
    params = new URLSearchParams(body);
  } else {
    params = new URLSearchParams(event.rawQueryString);
  }

  const responseType = params.get("response_type") || "";
  const clientId = params.get("client_id") || "";
  const redirectUri = params.get("redirect_uri") || "";
  const codeChallenge = params.get("code_challenge") || "";
  const codeChallengeMethod = params.get("code_challenge_method") || "";
  const state = params.get("state");

  // Validate required params
  if (responseType !== "code") {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "unsupported_response_type" }) };
  }

  if (clientId !== credentials.oauthClientId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "invalid_client" }) };
  }

  if (!redirectUri || !codeChallenge || codeChallengeMethod !== "S256") {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "invalid_request" }) };
  }

  // Validate redirect URI against allowlist
  try {
    const redirectHost = new URL(redirectUri).hostname;
    if (!ALLOWED_REDIRECT_HOSTS.includes(redirectHost)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "invalid_redirect_uri" }) };
    }
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "invalid_redirect_uri" }) };
  }

  // If PIN is configured, require interactive approval
  if (credentials.oauthPin) {
    const consentParams = { responseType, clientId, redirectUri, codeChallenge, codeChallengeMethod, state };

    if (method === "GET") {
      return {
        statusCode: 200,
        headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
        body: renderConsentPage(consentParams),
      };
    }

    // POST - validate PIN with timing-safe comparison
    const pin = params.get("pin") || "";
    const pinBuf = Buffer.from(pin);
    const expectedBuf = Buffer.from(credentials.oauthPin);
    const pinMatch = pinBuf.length === expectedBuf.length && timingSafeEqual(pinBuf, expectedBuf);

    if (!pinMatch) {
      return {
        statusCode: 200,
        headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
        body: renderConsentPage({ ...consentParams, error: "Invalid PIN" }),
      };
    }
  } else {
    console.warn("OAUTH_PIN not set in secrets - auto-approving OAuth requests. Set OAUTH_PIN for security.");
  }

  // Generate authorization code
  const code = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

  // Store code with PKCE challenge
  authCodes.set(code, {
    codeChallenge,
    clientId,
    redirectUri,
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
  });

  // Redirect back with code
  const redirectUrl = new URL(redirectUri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);

  return {
    statusCode: 302,
    headers: { ...headers, Location: redirectUrl.toString() },
    body: "",
  };
}

// Handle OAuth token endpoint for Claude Web/iOS
async function handleOAuthToken(
  event: LambdaFunctionUrlEvent,
  headers: Record<string, string>
): Promise<LambdaFunctionUrlResponse> {
  const credentials = await getCredentials();

  // Parse body (application/x-www-form-urlencoded or JSON)
  const body = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf-8")
    : event.body || "";

  let clientId: string | undefined;
  let clientSecret: string | undefined;
  let grantType: string | undefined;

  // Check for Basic auth header first
  const authHeader = event.headers["authorization"] || "";
  if (authHeader.toLowerCase().startsWith("basic ")) {
    const base64Creds = authHeader.slice(6);
    const decoded = Buffer.from(base64Creds, "base64").toString("utf-8");
    const [id, secret] = decoded.split(":");
    clientId = id;
    clientSecret = secret;
  }

  // Parse body for grant_type and possibly credentials
  const contentType = event.headers["content-type"] || "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(body);
    grantType = params.get("grant_type") || undefined;
    if (!clientId) clientId = params.get("client_id") || undefined;
    if (!clientSecret) clientSecret = params.get("client_secret") || undefined;
  } else if (contentType.includes("application/json")) {
    try {
      const json = JSON.parse(body);
      grantType = json.grant_type;
      if (!clientId) clientId = json.client_id;
      if (!clientSecret) clientSecret = json.client_secret;
    } catch {
      // Ignore parse errors
    }
  }

  // Handle authorization_code grant (PKCE flow from Claude Web)
  if (grantType === "authorization_code") {
    let code: string | null = null;
    let codeVerifier: string | null = null;
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(body);
      code = params.get("code");
      codeVerifier = params.get("code_verifier");
    } else {
      try {
        const json = JSON.parse(body);
        code = json.code || null;
        codeVerifier = json.code_verifier || null;
      } catch {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "invalid_request", error_description: "Invalid JSON body" }),
        };
      }
    }

    if (!code || !codeVerifier) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "invalid_request",
          error_description: "Missing code or code_verifier",
        }),
      };
    }

    // Look up the stored authorization code
    const storedCode = authCodes.get(code);
    if (!storedCode || storedCode.expiresAt < Date.now()) {
      authCodes.delete(code);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "invalid_grant",
          error_description: "Invalid or expired authorization code",
        }),
      };
    }

    // Verify redirect_uri matches the one from /authorize
    const providedRedirectUri = contentType.includes("application/x-www-form-urlencoded")
      ? new URLSearchParams(body).get("redirect_uri")
      : (() => { try { return JSON.parse(body).redirect_uri; } catch { return null; } })();
    if (providedRedirectUri && providedRedirectUri !== storedCode.redirectUri) {
      authCodes.delete(code);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "invalid_grant",
          error_description: "redirect_uri mismatch",
        }),
      };
    }

    // Verify PKCE: SHA256(code_verifier) should match code_challenge
    const encoder = new TextEncoder();
    const data = encoder.encode(codeVerifier);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = new Uint8Array(hashBuffer);
    const computedChallenge = Buffer.from(hashArray).toString("base64url");

    if (computedChallenge !== storedCode.codeChallenge) {
      authCodes.delete(code);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "invalid_grant",
          error_description: "PKCE verification failed",
        }),
      };
    }

    // Clean up used code
    authCodes.delete(code);

    // Return access token
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        access_token: credentials.apiKey,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
      }),
    };
  }

  // Handle client_credentials grant (for direct API testing)
  if (grantType === "client_credentials") {
    if (
      clientId !== credentials.oauthClientId ||
      clientSecret !== credentials.oauthClientSecret
    ) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({
          error: "invalid_client",
          error_description: "Invalid client credentials",
        }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        access_token: credentials.apiKey,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
      }),
    };
  }

  return {
    statusCode: 400,
    headers,
    body: JSON.stringify({
      error: "unsupported_grant_type",
      error_description: "Supported grant types: authorization_code, client_credentials",
    }),
  };
}

// Create MCP server instance (reused across invocations)
let mcpServer: McpServer | null = null;
let skylightClient: SkylightClient | null = null;

async function getMcpServer() {
  if (mcpServer && skylightClient) return { mcpServer, skylightClient };

  const credentials = await getCredentials();

  skylightClient = new SkylightClient({
    authToken: credentials.authToken,
    frameId: credentials.frameId,
  });

  mcpServer = new McpServer({
    name: "skylight-calendar",
    version: "1.0.0",
  });

  registerTools(mcpServer, skylightClient);

  return { mcpServer, skylightClient };
}

// JSON-RPC response helpers
function jsonRpcResponse(id: number | string | null, result: unknown) {
  return {
    jsonrpc: "2.0" as const,
    id,
    result,
  };
}

function jsonRpcError(
  id: number | string | null,
  code: number,
  message: string
) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: { code, message },
  };
}

export async function handler(
  event: LambdaFunctionUrlEvent
): Promise<LambdaFunctionUrlResponse> {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, mcp-session-id",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  // Handle CORS preflight
  if (event.requestContext.http.method === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const path = event.rawPath || "/";
  const method = event.requestContext.http.method;

  // Handle OAuth authorize endpoint (GET = consent page, POST = PIN validation)
  if (path === "/authorize" && (method === "GET" || method === "POST")) {
    return handleOAuthAuthorize(event, headers);
  }

  // Handle OAuth token endpoint (POST)
  if ((path === "/oauth/token" || path === "/token") && method === "POST") {
    return handleOAuthToken(event, headers);
  }

  // OAuth Authorization Server Metadata (RFC 8414)
  if (path === "/.well-known/oauth-authorization-server" && method === "GET") {
    const baseUrl = `https://${event.headers["host"]}`;
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      }),
    };
  }

  // OAuth Protected Resource Metadata
  if (path === "/.well-known/oauth-protected-resource" && method === "GET") {
    const baseUrl = `https://${event.headers["host"]}`;
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        resource: baseUrl,
        authorization_servers: [baseUrl],
        bearer_methods_supported: ["header"],
      }),
    };
  }

  // Dynamic Client Registration (RFC 7591)
  if (path === "/register" && method === "POST") {
    const reqBody = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf-8")
      : event.body || "";

    let clientMetadata;
    try {
      clientMetadata = JSON.parse(reqBody);
    } catch {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "invalid_request" }),
      };
    }

    const credentials = await getCredentials();
    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({
        client_id: credentials.oauthClientId,
        client_name: clientMetadata.client_name || "MCP Client",
        redirect_uris: clientMetadata.redirect_uris || [],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    };
  }

  // Only accept POST for MCP endpoints
  if (method !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    // Authenticate
    const credentials = await getCredentials();
    const authHeader = event.headers["authorization"] || "";
    const providedKey = authHeader.replace(/^Bearer\s+/i, "");

    // Timing-safe comparison to prevent timing attacks
    const providedKeyBuf = Buffer.from(providedKey);
    const apiKeyBuf = Buffer.from(credentials.apiKey);
    const keysMatch = providedKeyBuf.length === apiKeyBuf.length &&
      timingSafeEqual(providedKeyBuf, apiKeyBuf);

    if (!keysMatch) {
      const baseUrl = `https://${event.headers["host"]}`;
      return {
        statusCode: 401,
        headers: {
          ...headers,
          "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
        },
        body: JSON.stringify(
          jsonRpcError(null, -32001, "Unauthorized: Invalid API key")
        ),
      };
    }

    // Parse request body
    const body = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf-8")
      : event.body || "";

    let request;
    try {
      request = JSON.parse(body);
    } catch {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify(jsonRpcError(null, -32700, "Parse error: Invalid JSON")),
      };
    }

    // Handle MCP protocol messages
    const { skylightClient: client } = await getMcpServer();
    if (!client) {
      throw new Error("Failed to initialize Skylight client");
    }

    // Handle different MCP methods
    switch (request.method) {
      case "initialize":
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify(
            jsonRpcResponse(request.id, {
              protocolVersion: "2024-11-05",
              serverInfo: {
                name: "skylight-calendar",
                version: "1.0.0",
              },
              capabilities: {
                tools: {},
              },
            })
          ),
        };

      case "tools/list":
        // Return list of available tools
        const tools = [
          {
            name: "list_chores",
            description:
              "List chores from the Skylight Calendar for a date range",
            inputSchema: {
              type: "object",
              properties: {
                after: {
                  type: "string",
                  description: "Start date in YYYY-MM-DD format",
                },
                before: {
                  type: "string",
                  description: "End date in YYYY-MM-DD format",
                },
                include_late: {
                  type: "boolean",
                  description: "Include overdue chores",
                  default: true,
                },
              },
              required: ["after", "before"],
            },
          },
          {
            name: "create_chore",
            description: "Create a new chore on the Skylight Calendar. Use list_categories first to get valid category IDs for assigning chores.",
            inputSchema: {
              type: "object",
              properties: {
                summary: { type: "string", description: "Chore name/title (required)" },
                date: { type: "string", description: "Date in YYYY-MM-DD format (required)" },
                time: { type: "string", description: "Optional time in HH:MM format (24-hour)" },
                category_id: {
                  type: "string",
                  description: "Family member ID (numeric) OR name to assign the chore to. Get IDs from list_categories. Example: '123' or 'Elliot'",
                },
                emoji_icon: { type: "string", description: "Emoji icon for the chore (helps young kids). Example: '🧹' or '🦷'" },
                recurring: { type: "boolean", default: false },
              },
              required: ["summary", "date"],
            },
          },
          {
            name: "complete_chore",
            description: "Mark a chore as completed",
            inputSchema: {
              type: "object",
              properties: {
                chore_id: { type: "string", description: "Chore ID" },
              },
              required: ["chore_id"],
            },
          },
          {
            name: "delete_chore",
            description: "Delete a chore. For recurring chores, specify apply_to option.",
            inputSchema: {
              type: "object",
              properties: {
                chore_id: { type: "string", description: "Chore ID (for recurring chores, may include date like '123-2026-01-15')" },
                apply_to: {
                  type: "string",
                  enum: ["one", "all", "future"],
                  description: "For recurring chores: 'one' (this instance only), 'all' (entire series), 'future' (this and all future)"
                },
              },
              required: ["chore_id"],
            },
          },
          {
            name: "update_chore",
            description: "Update an existing chore (change name, date, time, assignee, icon, or completion status)",
            inputSchema: {
              type: "object",
              properties: {
                chore_id: { type: "string", description: "Chore ID to update" },
                summary: { type: "string", description: "New chore name/title" },
                date: { type: "string", description: "New date in YYYY-MM-DD format" },
                time: { type: "string", description: "New time in HH:MM format (24-hour)" },
                category_id: { type: "string", description: "New assignee - family member ID or name" },
                emoji_icon: { type: "string", description: "Emoji icon for the chore. Example: '🧹' or '🦷'" },
                status: { type: "string", enum: ["pending", "complete"], description: "Mark as pending (uncomplete) or complete" },
              },
              required: ["chore_id"],
            },
          },
          {
            name: "list_categories",
            description: "List family members available for assigning chores",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
            },
          },
        ];

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify(jsonRpcResponse(request.id, { tools })),
        };

      case "tools/call":
        // Execute a tool
        const toolName = request.params?.name;
        const toolArgs = request.params?.arguments || {};

        let result: { content: Array<{ type: string; text: string }> };

        try {
          switch (toolName) {
            case "list_chores": {
              const chores = await client.getChores(
                toolArgs.after,
                toolArgs.before,
                toolArgs.include_late ?? true
              );
              const choreList = chores
                .map((c) => {
                  const assignee = c.categoryLabel || "Unassigned";
                  const time = c.time ? ` at ${c.time}` : "";
                  const status = c.status === "complete" ? " [DONE]" : "";
                  return `- [${c.id}] ${c.date}${time}: ${c.summary} - ${assignee}${status}`;
                })
                .join("\n");
              result = {
                content: [
                  {
                    type: "text",
                    text:
                      chores.length > 0
                        ? `Found ${chores.length} chores:\n\n${choreList}`
                        : "No chores found for this date range.",
                  },
                ],
              };
              break;
            }

            case "create_chore": {
              // Resolve category_id - could be numeric ID or family member name
              let resolvedCategoryId = toolArgs.category_id;
              let categoryName: string | null = null;

              if (toolArgs.category_id) {
                // Check if it's a name (contains letters) vs numeric ID
                const isNumeric = /^\d+$/.test(toolArgs.category_id);
                if (!isNumeric) {
                  // It's a name, look up the ID
                  const categories = await client.getCategories();
                  const matchedCategory = categories.find(
                    (c) => c.label.toLowerCase() === toolArgs.category_id.toLowerCase()
                  );
                  if (matchedCategory) {
                    resolvedCategoryId = matchedCategory.id;
                    categoryName = matchedCategory.label;
                  } else {
                    // Return friendly error listing valid names
                    const validNames = categories.map((c) => c.label).join(", ");
                    result = {
                      content: [
                        {
                          type: "text",
                          text: `Error: Unknown family member "${toolArgs.category_id}". Valid options: ${validNames}`,
                        },
                      ],
                    };
                    break;
                  }
                }
              }

              // Use native https with exact mobile app headers
              const chore = await client.createChore({
                summary: toolArgs.summary,
                date: toolArgs.date,
                time: toolArgs.time,
                categoryId: resolvedCategoryId,
                recurring: toolArgs.recurring,
                emojiIcon: toolArgs.emoji_icon,
              });

              const assignedTo = categoryName || chore.categoryLabel;
              const assignedMsg = assignedTo ? ` (assigned to ${assignedTo})` : "";
              result = {
                content: [
                  {
                    type: "text",
                    text: `Created chore: "${chore.summary}" on ${chore.date}${assignedMsg}. Chore ID: ${chore.id}`,
                  },
                ],
              };
              break;
            }

            case "complete_chore": {
              const chore = await client.completeChore(toolArgs.chore_id);
              result = {
                content: [
                  {
                    type: "text",
                    text: `Marked "${chore.summary}" as complete`,
                  },
                ],
              };
              break;
            }

            case "delete_chore": {
              await client.deleteChore(toolArgs.chore_id, toolArgs.apply_to);
              const applyMsg = toolArgs.apply_to ? ` (${toolArgs.apply_to})` : "";
              result = {
                content: [
                  { type: "text", text: `Deleted chore ${toolArgs.chore_id}${applyMsg}` },
                ],
              };
              break;
            }

            case "update_chore": {
              // Resolve category_id if it's a name
              let resolvedCategoryId = toolArgs.category_id;
              if (toolArgs.category_id && !/^\d+$/.test(toolArgs.category_id)) {
                const categories = await client.getCategories();
                const matched = categories.find(
                  (c) => c.label.toLowerCase() === toolArgs.category_id.toLowerCase()
                );
                if (matched) {
                  resolvedCategoryId = matched.id;
                } else {
                  const validNames = categories.map((c) => c.label).join(", ");
                  result = {
                    content: [{
                      type: "text",
                      text: `Error: Unknown family member "${toolArgs.category_id}". Valid options: ${validNames}`,
                    }],
                  };
                  break;
                }
              }

              const chore = await client.updateChore(toolArgs.chore_id, {
                summary: toolArgs.summary,
                date: toolArgs.date,
                time: toolArgs.time,
                categoryId: resolvedCategoryId,
                status: toolArgs.status,
                emojiIcon: toolArgs.emoji_icon,
              });

              const changes: string[] = [];
              if (toolArgs.summary) changes.push(`name to "${toolArgs.summary}"`);
              if (toolArgs.date) changes.push(`date to ${toolArgs.date}`);
              if (toolArgs.time) changes.push(`time to ${toolArgs.time}`);
              if (toolArgs.category_id) changes.push(`assignee to ${chore.categoryLabel || toolArgs.category_id}`);
              if (toolArgs.emoji_icon) changes.push(`icon to ${toolArgs.emoji_icon}`);
              if (toolArgs.status) changes.push(`status to ${toolArgs.status}`);

              result = {
                content: [{
                  type: "text",
                  text: `Updated chore: changed ${changes.join(", ")}`,
                }],
              };
              break;
            }

            case "list_categories": {
              const categories = await client.getCategories();
              const catList = categories
                .map((c) => `- ${c.label} (ID: ${c.id})`)
                .join("\n");
              result = {
                content: [
                  {
                    type: "text",
                    text: `Family members:\n\n${catList}`,
                  },
                ],
              };
              break;
            }

            default:
              return {
                statusCode: 200,
                headers,
                body: JSON.stringify(
                  jsonRpcError(request.id, -32601, `Unknown tool: ${toolName}`)
                ),
              };
          }
        } catch (toolError) {
          result = {
            content: [
              {
                type: "text",
                text: `Error: ${toolError instanceof Error ? toolError.message : String(toolError)}`,
              },
            ],
          };
        }

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify(jsonRpcResponse(request.id, result)),
        };

      case "notifications/initialized":
        // MCP notification - acknowledge without error
        return {
          statusCode: 200,
          headers,
          body: "",
        };

      default:
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify(
            jsonRpcError(request.id, -32601, `Unknown method: ${request.method}`)
          ),
        };
    }
  } catch (error) {
    console.error("Lambda error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify(
        jsonRpcError(null, -32000, "Internal server error")
      ),
    };
  }
}
