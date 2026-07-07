/**
 * Skylight Token Refresher Lambda
 *
 * Replaces the manual Proxyman/DevTools re-capture of SKYLIGHT_AUTH_TOKEN with
 * a headless login against Skylight's web OAuth/PKCE flow, then rotates the
 * token in AWS Secrets Manager. The MCP Lambda re-reads the secret on a
 * 5-minute cache TTL, so no redeploy is needed to pick up the new value.
 *
 * Triggered weekly by EventBridge. On any failure, the existing secret is left
 * untouched (never replaces a working token with a broken one).
 */

import { randomUUID, createHash } from "crypto";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

// --- Skylight constants (mirrors rjhalvorson/skylight-mcp src/api/constants.ts) ---

const SKYLIGHT_BASE_URL = "https://app.ourskylight.com";
const SKYLIGHT_WEB_APP_URL = "https://ourskylight.com";
const REDIRECT_URI = `${SKYLIGHT_WEB_APP_URL}/welcome`;
const CLIENT_ID = "skylight-mobile";
const SCOPE = "everything";

// Desktop-Firefox UA for login/HTML steps
const WEB_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:149.0) Gecko/20100101 Firefox/149.0";

// Mobile UA for verification call (matches the MCP Lambda's SkylightClient)
const MOBILE_USER_AGENT = "SkylightMobile/2.3.0 (ios 26.3.1)";

const AUTHENTICITY_TOKEN_RE =
  /name=["']authenticity_token["'][^>]*value=["']([^"']+)["']/i;

// --- PKCE helpers ---

function createPkceVerifier(): string {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
}

function createPkceChallenge(verifier: string): string {
  const digest = createHash("sha256").update(verifier, "ascii").digest();
  return digest.toString("base64url");
}

function createState(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

// --- Cookie jar (minimal, handles Set-Cookie across redirects) ---

class CookieJar {
  private cookies: Map<string, string> = new Map();

  update(headers: Headers): void {
    const setCookies = headers.getSetCookie();
    for (const raw of setCookies) {
      const [pair] = raw.split(";");
      const eqIdx = pair.indexOf("=");
      if (eqIdx > 0) {
        this.cookies.set(pair.slice(0, eqIdx).trim(), pair.slice(eqIdx + 1).trim());
      }
    }
  }

  toString(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

// --- OAuth login flow (6 steps) ---

async function skylightLogin(
  email: string,
  password: string
): Promise<string> {
  const jar = new CookieJar();
  const state = createState();
  const codeVerifier = createPkceVerifier();
  const codeChallenge = createPkceChallenge(codeVerifier);

  // Step 1: GET /oauth/authorize -> 302 to /auth/session/new
  const authorizeParams = new URLSearchParams({
    client_id: CLIENT_ID,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    state,
    prompt: "login",
  });

  let resp = await fetch(
    `${SKYLIGHT_BASE_URL}/oauth/authorize?${authorizeParams}`,
    {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": WEB_USER_AGENT,
        Referer: `${SKYLIGHT_WEB_APP_URL}/`,
      },
      redirect: "manual",
    }
  );
  jar.update(resp.headers);

  if (resp.status !== 302 || !resp.headers.get("location")) {
    throw new Error(`Step 1 failed: expected 302, got ${resp.status}`);
  }
  const loginUrl = new URL(resp.headers.get("location")!, SKYLIGHT_BASE_URL).toString();

  // Step 2: GET login form, scrape authenticity_token
  resp = await fetch(loginUrl, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": WEB_USER_AGENT,
      Referer: `${SKYLIGHT_WEB_APP_URL}/`,
      Cookie: jar.toString(),
    },
    redirect: "manual",
  });
  jar.update(resp.headers);

  if (resp.status !== 200) {
    throw new Error(`Step 2 failed: expected 200, got ${resp.status}`);
  }
  const html = await resp.text();
  const tokenMatch = html.match(AUTHENTICITY_TOKEN_RE);
  if (!tokenMatch) {
    throw new Error("Could not find authenticity_token in login form");
  }
  const authenticityToken = tokenMatch[1];

  // Step 3: POST credentials to /auth/session
  resp = await fetch(`${SKYLIGHT_BASE_URL}/auth/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": WEB_USER_AGENT,
      Origin: SKYLIGHT_BASE_URL,
      Referer: `${SKYLIGHT_BASE_URL}/auth/session/new`,
      Cookie: jar.toString(),
    },
    body: new URLSearchParams({
      authenticity_token: authenticityToken,
      email,
      password,
    }).toString(),
    redirect: "manual",
  });
  jar.update(resp.headers);

  if (resp.status === 401 || resp.status === 422) {
    throw new Error(`Skylight rejected credentials (HTTP ${resp.status})`);
  }
  if (resp.status !== 302 || !resp.headers.get("location")) {
    throw new Error(`Step 3 failed: expected 302, got ${resp.status}`);
  }
  const authorizeUrl = new URL(resp.headers.get("location")!, SKYLIGHT_BASE_URL).toString();

  // Step 4: GET authenticated /oauth/authorize -> 302 with ?code=&state=
  resp = await fetch(authorizeUrl, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": WEB_USER_AGENT,
      Referer: `${SKYLIGHT_BASE_URL}/auth/session/new`,
      Cookie: jar.toString(),
    },
    redirect: "manual",
  });
  jar.update(resp.headers);

  if (resp.status !== 302 || !resp.headers.get("location")) {
    throw new Error(`Step 4 failed: expected 302, got ${resp.status}`);
  }
  const callbackUrl = new URL(resp.headers.get("location")!, SKYLIGHT_BASE_URL);
  const authCode = callbackUrl.searchParams.get("code");
  const returnedState = callbackUrl.searchParams.get("state");

  if (!authCode) {
    throw new Error("OAuth redirect did not include an authorization code");
  }
  if (returnedState !== state) {
    throw new Error("OAuth state mismatch (possible CSRF/replay)");
  }

  // Step 5: POST /oauth/token to exchange code for access_token
  const deviceFingerprint = randomUUID();
  resp = await fetch(`${SKYLIGHT_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/javascript; q=0.01",
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: SKYLIGHT_WEB_APP_URL,
      Referer: `${SKYLIGHT_WEB_APP_URL}/`,
      "User-Agent": WEB_USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      scope: SCOPE,
      redirect_uri: REDIRECT_URI,
      code: authCode,
      code_verifier: codeVerifier,
      skylight_api_client_device_fingerprint: deviceFingerprint,
      _device_platform: "web",
      _device_name: "unknown",
      _device_os_version: "unknown",
      _device_app_version: "unknown",
      _device_hardware: "Linux",
    }).toString(),
  });

  if (resp.status !== 200) {
    throw new Error(`Token exchange failed: HTTP ${resp.status}`);
  }
  const tokenData = (await resp.json()) as { access_token?: string; token?: string };
  const accessToken = tokenData.access_token || tokenData.token;
  if (!accessToken) {
    throw new Error("Token exchange did not return an access_token");
  }

  return accessToken;
}

// --- Verification ---

async function verifyToken(bearerToken: string, frameId: string): Promise<void> {
  const resp = await fetch(`${SKYLIGHT_BASE_URL}/api/frames/${frameId}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: bearerToken,
      "User-Agent": MOBILE_USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (resp.status === 401) {
    throw new Error("New token rejected with 401 immediately after login");
  }
  if (resp.status === 404) {
    throw new Error(`SKYLIGHT_FRAME_ID=${frameId} returned 404 -- frame ID may have drifted`);
  }
  if (resp.status !== 200) {
    throw new Error(`Verification failed: HTTP ${resp.status}`);
  }

  const body = (await resp.json()) as Record<string, unknown>;
  if (!body || typeof body !== "object" || !("data" in body)) {
    throw new Error("Verification response missing expected 'data' key");
  }
}

// --- Lambda handler ---

export async function handler(): Promise<{ statusCode: number; body: string }> {
  const secretArn = process.env.SECRET_ARN;
  if (!secretArn) {
    throw new Error("SECRET_ARN environment variable not set");
  }

  const client = new SecretsManagerClient({});

  // 1. Read current secret
  console.log("Reading secret from Secrets Manager");
  const getResp = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );
  if (!getResp.SecretString) {
    throw new Error("Secret value is empty");
  }
  const secret = JSON.parse(getResp.SecretString) as Record<string, string>;

  const email = secret.SKYLIGHT_EMAIL;
  const password = secret.SKYLIGHT_PASSWORD;
  const frameId = secret.SKYLIGHT_FRAME_ID;

  const missing = [
    !email && "SKYLIGHT_EMAIL",
    !password && "SKYLIGHT_PASSWORD",
    !frameId && "SKYLIGHT_FRAME_ID",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`Secret missing required fields: ${missing.join(", ")}`);
  }

  // 2. Login
  console.log("Starting headless Skylight OAuth login");
  const accessToken = await skylightLogin(email, password);
  const bearerToken = `Bearer ${accessToken}`;

  // 3. Verify before writing
  console.log("Verifying new token against live API");
  await verifyToken(bearerToken, frameId);
  console.log("Verification succeeded");

  // 4. Write updated secret (read-modify-write, only SKYLIGHT_AUTH_TOKEN changes)
  console.log("Writing refreshed token to Secrets Manager");
  const updatedSecret = { ...secret, SKYLIGHT_AUTH_TOKEN: bearerToken };
  await client.send(
    new PutSecretValueCommand({
      SecretId: secretArn,
      SecretString: JSON.stringify(updatedSecret),
    })
  );

  console.log("Token refresh complete");
  return {
    statusCode: 200,
    body: JSON.stringify({ message: "Token refreshed successfully" }),
  };
}
