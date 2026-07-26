# SudoMock MCP Server

> Generate photorealistic product mockups from Claude, Cursor, Windsurf, and VS Code.

[Model Context Protocol](https://modelcontextprotocol.io/introduction) server for the [SudoMock](https://sudomock.com) mockup generation API. Upload PSD templates, place artwork onto smart objects, edit supported text layers, and get rendered image URLs -- all through natural language.

## Quick Start

This is a local **stdio** server: your MCP client launches it as a child process
via `npx` and authenticates with your `SUDOMOCK_API_KEY`.

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

> **Note:** A hosted remote (HTTP/OAuth) transport is not available yet. This
> package only ships the local stdio server shown above.

## Tools

| Tool | Description | Credits |
|------|-------------|---------|
| `list_mockups` | List your uploaded mockup templates | 0 |
| `get_mockup_details` | Get smart object UUIDs, dimensions, blend modes | 0 |
| `render_mockup` | Render a mockup with artwork and/or editable text | 1 |
| `remove_background` | Turn any image into a permanent transparent-PNG cutout URL | 25 |
| `create_2d_mockup` | Create a 2D mockup and detect printable surfaces automatically | 25 |
| `render_2d_mockup` | Render artwork onto a saved 2D mockup template (no PSD) | 5 |
| `render_video` | Animate a mockup into an AI video clip (always async) | cost-based (free: 1/lifetime) |
| `upload_psd` | Upload a Photoshop PSD/PSB template (sync or async) | 0 |
| `list_2d_mockups` | List your saved SudoAI 2D mockup templates | 0 |
| `get_2d_mockup` | Get one 2D mockup's details + print-area UUIDs | 0 |
| `update_2d_print_areas` | Update a 2D mockup's print-area geometry | 0 |
| `delete_2d_mockup` | Delete a 2D mockup template | 0 |
| `get_job` | Check the status of an async job by job_id | 0 |
| `wait_for_job` | Poll an async job until it succeeds or fails | 0 |
| `list_jobs` | List async render, video, upload, and 2D jobs | 0 |
| `get_account` | Check plan, credits, and usage | 0 |
| `update_mockup` | Rename a mockup template | 0 |
| `delete_mockup` | Delete a mockup template | 0 |
| `create_studio_session` | Create an embedded editor session | 0 |
| `create_webhook_endpoint` | Register a webhook for async job completion | 0 |
| `list_webhook_endpoints` | List your webhook endpoints | 0 |
| `update_webhook_endpoint` | Edit or enable/disable a webhook endpoint | 0 |
| `delete_webhook_endpoint` | Delete a webhook endpoint | 0 |
| `rotate_webhook_secret` | Rotate a webhook signing secret | 0 |
| `test_webhook_endpoint` | Send a signed `webhook.test` event | 0 |
| `list_webhook_deliveries` | List delivery attempts for an endpoint | 0 |
| `replay_webhook_delivery` | Replay a single failed delivery | 0 |

### Async jobs

`render_mockup`, `upload_psd`, `create_2d_mockup`, and `render_2d_mockup` accept
`is_async: true`, and `render_video` is always async. These return a `job_id`
immediately (HTTP 202) instead of a final result. (`create_2d_mockup` and
`render_2d_mockup` are synchronous by default and return the mockup / render
directly.) Poll it with `get_job`, or let `wait_for_job` block until the job
reaches a terminal status and hands back `result_url`, `mockup_uuid`, `model`,
`credits_charged`, and `payg` (`{credits, unit_price, cost}` for pay-as-you-go
jobs, otherwise `null`).

### Background removal

`remove_background` returns a permanent transparent-PNG cutout URL you can pass
straight back as `artwork_url` -- clean the artwork once, then reuse the cutout
across renders. To clean artwork inline during a single render instead, pass
`remove_background: true` to `render_mockup` or `render_2d_mockup`. Either way it
costs 25 credits per artwork, refunded automatically if processing fails.

### Webhooks

Register an endpoint with `create_webhook_endpoint` to be notified when async
jobs finish. Deliveries are signed with TWO headers: `X-SudoMock-Signature`
(a hex HMAC-SHA256 over `${timestamp}.${rawBody}` using the secret returned at
creation/rotation) and `X-SudoMock-Timestamp` (unix seconds). Verify in constant
time and reject if `|now - timestamp| > 300s`. The delivery body is
`{event, job_id, kind, status, result_url, error, created_at}`. Event types:
`render.succeeded`, `render.failed`, `upload.succeeded`, `video.succeeded`,
`video.failed`, `2d_mockup.ready`, `2d_mockup.rejected`, `2d_mockup.failed`,
`2d_render.succeeded`, `2d_render.failed`, `webhook.test`.

## Example Prompts

- "List my mockup templates"
- "Render the t-shirt mockup with this design: https://example.com/logo.png"
- "Replace the editable headline text, then render the mockup"
- "Cut out the background from this product photo, then render it on the tote bag"
- "List my 2D mockups, then render the first one with this artwork: https://example.com/logo.png"
- "Render this design asynchronously and wait for it to finish"
- "Queue that 2D mockup render async and give me the job id to track"
- "Animate the hoodie mockup into a 5-second video clip"
- "Upload this PSD as a new template: https://example.com/mockup.psd"
- "Set up a webhook at https://example.com/hooks so I get notified when renders finish"
- "How many credits do I have left?"

## Links

- [Dashboard](https://sudomock.com/dashboard) -- Manage mockups and API keys
- [API Docs](https://sudomock.com/docs) -- Full REST API reference
- [Pricing](https://sudomock.com/pricing)
- [Status](https://sudomock.statuspage.io) -- Service uptime

## License

MIT
