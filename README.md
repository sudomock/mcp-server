# SudoMock MCP Server

> Generate photorealistic product mockups from Claude, Cursor, Windsurf, and VS Code.

[Model Context Protocol](https://modelcontextprotocol.io/introduction) server for the [SudoMock](https://sudomock.com) mockup generation API. Upload PSD templates, place artwork onto smart objects, and get CDN-hosted renders -- all through natural language.

## Quick Start

### Option 1: Local (npx)

```bash
claude mcp add sudomock \
  -e SUDOMOCK_API_KEY=sm_your_key_here \
  -- npx -y @sudomock/mcp
```

Get your API key at [sudomock.com/dashboard/api-keys](https://sudomock.com/dashboard/api-keys).

<details>
<summary>JSON config for other clients (Cursor, Windsurf, VS Code)</summary>

```json
{
  "mcpServers": {
    "sudomock": {
      "command": "npx",
      "args": ["-y", "@sudomock/mcp"],
      "env": {
        "SUDOMOCK_API_KEY": "sm_your_key_here"
      }
    }
  }
}
```

</details>

### Option 2: Remote (OAuth)

No API key needed. Your client opens a browser for login.

```bash
claude mcp add --transport http sudomock https://mcp.sudomock.com
```

<details>
<summary>JSON config for other clients</summary>

```json
{
  "mcpServers": {
    "sudomock": {
      "type": "http",
      "url": "https://mcp.sudomock.com"
    }
  }
}
```

</details>

## Tools

| Tool | Description | Credits |
|------|-------------|---------|
| `list_mockups` | List your uploaded mockup templates | 0 |
| `get_mockup_details` | Get smart object UUIDs, dimensions, blend modes | 0 |
| `render_mockup` | Render a mockup with your artwork | 1 |
| `render_2d_mockup` | Render artwork onto a saved 2D mockup template (no PSD) | 5 |
| `render_video` | Animate a mockup into an AI video clip (always async) | cost-based (free: 1/lifetime) |
| `upload_psd` | Upload a Photoshop PSD/PSB template (sync or async) | 0 |
| `get_job` | Check the status of an async job by render_uuid | 0 |
| `wait_for_job` | Poll an async job until it succeeds or fails | 0 |
| `get_account` | Check plan, credits, and usage | 0 |
| `update_mockup` | Rename a mockup template | 0 |
| `delete_mockup` | Delete a mockup template | 0 |
| `create_studio_session` | Create an embedded editor session | 0 |
| `create_webhook_endpoint` | Register a webhook for async job completion | 0 |
| `list_webhook_endpoints` | List your webhook endpoints | 0 |
| `delete_webhook_endpoint` | Delete a webhook endpoint | 0 |
| `rotate_webhook_secret` | Rotate a webhook signing secret | 0 |
| `test_webhook_endpoint` | Send a signed `webhook.test` event | 0 |
| `list_webhook_deliveries` | List delivery attempts for an endpoint | 0 |
| `replay_webhook_delivery` | Replay a single failed delivery | 0 |

### Async jobs

`render_mockup` and `upload_psd` accept `is_async: true`, and `render_video` is
always async. These return a `render_uuid` immediately (HTTP 202) instead of a
final result. Poll it with `get_job`, or let `wait_for_job` block until the job
reaches a terminal status and hands back `result_url`, `mockup_uuid`, `model`,
`credits_charged`, and `payg` (`{credits, unit_price, cost}` for pay-as-you-go
jobs, otherwise `null`).

### Webhooks

Register an endpoint with `create_webhook_endpoint` to be notified when async
jobs finish. Deliveries are signed with TWO headers: `X-SudoMock-Signature`
(a hex HMAC-SHA256 over `${timestamp}.${rawBody}` using the secret returned at
creation/rotation) and `X-SudoMock-Timestamp` (unix seconds). Verify in constant
time and reject if `|now - timestamp| > 300s`. The delivery body is
`{event, render_uuid, kind, status, result_url, error, created_at}`. Event types:
`render.succeeded`, `render.failed`, `upload.succeeded`, `video.succeeded`,
`video.failed`, `webhook.test`.

## Example Prompts

- "List my mockup templates"
- "Render the t-shirt mockup with this design: https://example.com/logo.png"
- "Render my 2D mockup with this artwork (UUIDs from the dashboard Code tab)"
- "Render this design asynchronously and wait for it to finish"
- "Animate the hoodie mockup into a 5-second video clip"
- "Upload this PSD as a new template: https://example.com/mockup.psd"
- "Set up a webhook at https://example.com/hooks so I get notified when renders finish"
- "How many credits do I have left?"

## Resources

The server provides built-in documentation:

- **Quick Start Guide** -- How to use the tools step by step
- **Pricing** -- Live plan and credit information
- **Formats** -- Supported output formats, blend modes, and PSD requirements

## Links

- [Dashboard](https://sudomock.com/dashboard) -- Manage mockups and API keys
- [API Docs](https://sudomock.com/docs) -- Full REST API reference
- [Pricing](https://sudomock.com/pricing)
- [Status](https://sudomock.statuspage.io) -- Service uptime

## License

MIT
