# Skylight Calendar MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that enables Claude to manage chores on a [Skylight Calendar](https://www.skylightframe.com/) digital display.

## Features

- **list_chores** - List chores for a date range
- **create_chore** - Create new chores (supports emoji icons, recurring via RRULE)
- **update_chore** - Edit existing chores
- **complete_chore** - Mark chores as complete
- **delete_chore** - Delete chores (with options for recurring: one/all/future)
- **list_categories** - List family members for chore assignment

## Architecture

```
┌─────────────────┐     ┌─────────────────────────┐     ┌──────────────────┐
│ Claude Clients  │────▶│ Lambda + Function URL   │────▶│ Skylight API     │
│ (Desktop/Web/   │     │ (OAuth 2.0 + MCP)       │     │ app.ourskylight  │
│  iOS)           │     └─────────────────────────┘     └──────────────────┘
└─────────────────┘
```

Deployed as an AWS Lambda with Function URL, using OAuth 2.0 with PKCE for authentication from Claude Web/iOS clients.

## Setup

1. **Capture Skylight credentials** using a proxy like [Proxyman](https://proxyman.io/) to intercept traffic from the Skylight mobile app
2. **Store credentials** in AWS Secrets Manager at `skylight-mcp/credentials`:
   - `SKYLIGHT_AUTH_TOKEN` - Auth token from mobile app
   - `SKYLIGHT_FRAME_ID` - Your household frame ID
   - `MCP_API_KEY` - Bearer token for MCP client auth
3. **Deploy**: `AWS_PROFILE=personal npm run cdk:deploy`

## Credits

This project uses the unofficial Skylight API documentation from:

**[MightyBandito/Skylight](https://github.com/mightybandito/Skylight)** - Community-maintained reverse-engineered API reference

## Disclaimer

This is an unofficial integration not affiliated with Skylight. Use responsibly and respect Skylight's Terms of Service.

## License

MIT
