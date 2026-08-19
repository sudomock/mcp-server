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
| `remove_background` | Get a transparent-PNG cutout through a 7-day signed URL | 25 |
| `create_2d_mockup` | Create a 2D mockup and detect printable surfaces automatically | 25 |
| `render_2d_surface` | Print artwork across a whole product surface (all-over) | 5 |
| `render_2d_print_area` | Print artwork into one saved print area (a drawn zone) | 5 |
| `render_video` | Animate a mockup into a video clip (always async) | cost-based (one per account at no charge, then cost-based) |
| `upload_psd` | Upload a Photoshop PSD/PSB template (sync or async) | 0 |
| `list_2d_mockups` | List saved 2D templates; use `customizable_only` for shopper-ready items | 0 |
| `get_2d_mockup` | Get one 2D mockup's saved print areas and its product surfaces | 0 |
| `update_2d_print_areas` | Replace a 2D mockup's print-area geometry | 0 |
| `delete_2d_mockup` | Delete a 2D mockup template | 0 |
| `get_job` | Check the status of an async job by job_id | 0 |
| `wait_for_job` | Poll an async job until it succeeds or fails | 0 |
| `list_jobs` | List async render, video, upload, and 2D jobs | 0 |
| `get_account` | Check plan, credits, prepaid balance, and usage | 0 |
| `update_mockup` | Rename a mockup template | 0 |
| `delete_mockup` | Delete a mockup template | 0 |
| `create_webhook_endpoint` | Register a webhook for async job completion | 0 |
| `list_webhook_endpoints` | List your webhook endpoints | 0 |
| `update_webhook_endpoint` | Edit or enable/disable a webhook endpoint | 0 |
| `delete_webhook_endpoint` | Delete a webhook endpoint | 0 |
| `rotate_webhook_secret` | Rotate a webhook signing secret | 0 |
| `test_webhook_endpoint` | Send a signed `webhook.test` event | 0 |
| `list_webhook_deliveries` | List delivery attempts for an endpoint | 0 |
| `replay_webhook_delivery` | Replay a single failed delivery | 0 |

### Async jobs

`render_mockup`, `upload_psd`, `create_2d_mockup`, and both 2D render tools
accept `is_async: true`, and `render_video` is always async. These return a
`job_id` immediately (HTTP 202) instead of a final result. (`create_2d_mockup`
and the 2D render tools are synchronous by default and return the mockup /
render directly.) Poll it with `get_job`, or let `wait_for_job` block until the job
reaches a terminal status and hands back `result_url`, `mockup_uuid`,
`credits_charged`, and `payg` (`{credits, unit_price, cost}` for pay-as-you-go
jobs, otherwise `null`).

For a 2D render, pick the tool that matches the target you read from
`get_2d_mockup`. Every printable product in the photo is a surface with its own
`surface_uuid`: `render_2d_surface` prints across the whole of one, and takes
either a `coverage` percentage or an explicit `width` + `height`. A print area
is a bounded zone somebody drew on a product, such as a chest logo:
`render_2d_print_area` takes its `print_area_uuid`, and either a `fit` or an
explicit `width` + `height`. A product can have both, and they are separate
targets -- a saved print area does not close off the surface it sits on.

Sizing has one answer per render: send the relative option or the exact box,
never both, and send `width` and `height` together. `position`, `offset_x`,
`offset_y` and `rotation` place the artwork on either kind of target. Anything
you leave out is left out of the request, so the renderer's own default
applies rather than a copy of it kept here.

### Background removal

`remove_background` returns a transparent-PNG URL valid for 7 days. You can
pass that URL straight back as `artwork_url` during that window. To clean
artwork inline during a single render instead, pass
`remove_background: true` to `render_mockup` or either 2D render tool. Either way it
costs 25 credits per artwork, refunded automatically if processing fails.

### Webhooks

Register an endpoint with `create_webhook_endpoint` to be notified when async
jobs finish. Deliveries are signed with TWO headers: `X-SudoMock-Signature`
(a hex HMAC-SHA256 over `${timestamp}.${rawBody}` using the secret returned at
creation/rotation) and `X-SudoMock-Timestamp` (unix seconds). Verify in constant
time and reject if `|now - timestamp| > 300s`.

Render, upload, and video job deliveries use
`{event, job_id, kind, status, result_url, error, created_at}`. The typed 2D
creation events add `version`, `mockup_id`, `name`, and either `print_areas`
(`ready`) or `reason` (`rejected`). The typed 2D render events carry
`mockup_id`, `result_url`, a public `{error_code, message}` failure when
applicable, and optional `export_format` / `duration_ms`. Event types:
`render.succeeded`, `render.failed`, `upload.succeeded`, `video.succeeded`,
`video.failed`, `2d_mockup.ready`, `2d_mockup.rejected`, `2d_mockup.failed`,
`2d_render.succeeded`, `2d_render.failed`, `webhook.test`.

## Pricing and account limits

Pay as you go is the entry tier, and it has no subscription. One PSD render costs
**$0.10**, so $1 covers 10 of them. The minimum first payment is **$5**. 2D Mockups
and video are priced by what they cost to produce rather than at the flat render
rate, which is why the Credits column above is not uniform.

Volume plans start at **$25/month** for 5,000 renders. The lowest self-serve rate is
**$2.42 per 1,000 renders**, on the annual Pro 50K plan.

A new account starts with **500 credits, granted once**, and needs no card to spend
them. Until a card is verified and the $5 minimum is funded, that account is in
trial, and every render it makes is watermarked and capped at **1,024 px**. It can
keep **5** PSD templates, run **one** render at a time, and a template that has gone
13 days without a render is removed.

Funding the balance lifts all of it at once. The watermark and the width cap come
off, stored templates go to **150**, renders run **25** at a time alongside **10**
concurrent uploads, and templates stop being removed for sitting idle.

Trial is not a separate plan. It is the unfunded state of the pay-as-you-go tier, so
`get_account` reports the same tier before and after funding; the balance is what
changes.

Because of that, an account paying as it goes has no monthly allowance, and
`get_account` reports `credits_limit` and `credits_remaining` as `0` while the
account is perfectly able to pay. Read `prepaid_balance` alongside them, or read
`funding_summary`, which states both in one line and never reports a funded account
as `0 / 0`.

## Example requests

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
