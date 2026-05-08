# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **ACTIVE BLOCKER:** Bearer token 401 since 2026-05-04; pending Proxyman re-capture per priority #13.

## Project Overview

MCP (Model Context Protocol) server that enables Claude to manage chores on a Skylight Calendar digital display. Deployed as an AWS Lambda with Function URL, using OAuth 2.0 with PKCE for authentication.

## Commands

```bash
# Build TypeScript
npm run build

# Local development (stdio mode - not commonly used)
npm run dev

# Deploy to AWS (requires AWS_PROFILE=personal)
AWS_PROFILE=personal npm run cdk:deploy

# View deployment diff before deploying
AWS_PROFILE=personal npm run cdk:diff

# Synthesize CloudFormation template
AWS_PROFILE=personal npm run cdk:synth

# Tail Lambda logs
AWS_PROFILE=personal aws logs tail /aws/lambda/SkylightMcpStack-SkylightMcpFunction* --follow
```

## Architecture

```
┌─────────────────┐     ┌─────────────────────────┐     ┌──────────────────┐
│ Claude Clients  │────▶│ Lambda + Function URL   │────▶│ Skylight API     │
│ (Desktop/Web/   │     │ (OAuth + MCP Protocol)  │     │ app.ourskylight  │
│  iOS)           │     └─────────────────────────┘     └──────────────────┘
└─────────────────┘                │
                                   ▼
                    ┌──────────────────────────────┐
                    │ AWS Secrets Manager          │
                    │ skylight-mcp/credentials     │
                    └──────────────────────────────┘
```

### Key Files

| File | Purpose |
|------|---------|
| `src/lambda.ts` | Main handler: OAuth endpoints (`/authorize`, `/token`), MCP JSON-RPC protocol, tool dispatch |
| `src/skylight/client.ts` | Skylight API client - all HTTP calls to `app.ourskylight.com` |
| `src/skylight/types.ts` | TypeScript types matching Skylight's JSON:API format |
| `src/tools/index.ts` | MCP tool definitions with Zod schemas (used for SDK registration) |
| `infra/stack.ts` | CDK stack: Lambda, Function URL, Secrets Manager permissions |

### MCP Tools

| Tool | Description |
|------|-------------|
| `list_chores` | List chores for a date range |
| `create_chore` | Create a new chore (supports emoji icons, recurring via RRULE) |
| `update_chore` | Edit an existing chore |
| `complete_chore` | Mark a chore as complete |
| `delete_chore` | Delete a chore (with `apply_to` for recurring: one/all/future) |
| `list_categories` | List family members for chore assignment |

### Skylight API Notes

- Mobile app (v1.95+) uses `/api/frames/{frameId}/chores/create_multiple` with flat JSON, not JSON:API wrapper
- PUT requests for updates also use flat JSON body
- Auth header: `Authorization: Bearer {token}` (token captured via Proxyman from mobile app; the captured value already includes the `Bearer ` prefix and is sent verbatim by the client). Skylight gates on User-Agent: requests must spoof `SkylightMobile/2.3.0 (ios 26.3.1)` (see `src/skylight/client.ts`)
- `recurrence_set` must be an array of RRULE strings: `["FREQ=WEEKLY;BYDAY=MO,WE,FR"]`
- Chore ID formats:
  - One-time chores: `61009429`
  - Recurring (date): `31709442-2026-01-13`
  - Recurring (time): `34163486-2026-01-13-2000`

## AWS Configuration

- **Account:** 241654197557 (personal)
- **Region:** us-east-1
- **Runtime:** Node.js 24 (Lambda) — explicitly pinned to current rather than 22 LTS in `infra/stack.ts` and `ci.yml`; this is intentional, not the default. Revisit pin choice when AWS Lambda announces a Node 24 deprecation date
- **Secret:** `skylight-mcp/credentials` contains:
  - `SKYLIGHT_AUTH_TOKEN` - Skylight auth token
  - `SKYLIGHT_FRAME_ID` - Household frame ID
  - `MCP_API_KEY` - Bearer token for MCP client auth
  - `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` - OAuth credentials

## Known Issues

1. **In-memory OAuth codes** (`lambda.ts:77`) - Auth codes stored in `Map` won't persist across Lambda instances. Production fix: use DynamoDB with TTL.

2. **Duplicate tool definitions** - Tools defined in both `lambda.ts` (for `tools/list` response) and `tools/index.ts` (SDK registration). These should be consolidated to a single source of truth.
