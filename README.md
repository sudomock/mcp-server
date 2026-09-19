# SudoMock MCP Server

> Generate photorealistic product mockups from Claude, Cursor, Windsurf, and VS Code.

[Model Context Protocol](https://modelcontextprotocol.io/introduction) server for the [SudoMock](https://sudomock.com) mockup generation API. Upload PSD templates, place artwork onto smart objects, edit supported text layers, turn a product photo into a reusable photo mockup, and get rendered image URLs -- all through natural language.

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

> **Note:** This package ships the local stdio server shown above. The hosted
> remote transport (OAuth, `https://mcp.sudomock.com`) is documented at
> [sudomock.com/docs/mcp](https://sudomock.com/docs/mcp). From 3.0 the two
> transports use the same tool names.

## Tools

Tools are named after the mockup family they act on: **PSD mockups** are
uploaded Photoshop templates, **photo mockups** are made from a product photo.

| Tool | Description | Credits |
|------|-------------|---------|
| `upload_psd` | Upload a Photoshop PSD/PSB template (sync or async) | 0 |
| `list_psd_mockups` | List your uploaded PSD mockup templates | 0 |
| `get_psd_mockup` | Get smart object UUIDs, editable text layers, dimensions, blend modes | 0 |
| `update_psd_mockup` | Rename a PSD mockup template | 0 |
| `delete_psd_mockup` | Delete a PSD mockup template | 0 |
| `render_psd_mockup` | Render a PSD mockup with artwork and/or editable text | 1 |
| `create_photo_mockup` | Create a photo mockup from a product photo and detect printable surfaces automatically | 25 |
| `list_photo_mockups` | List saved photo mockups; use `customizable_only` for shopper-ready items | 0 |
| `get_photo_mockup` | Get one photo mockup's saved print areas and its product surfaces | 0 |
| `update_photo_mockup_print_areas` | Replace a photo mockup's print-area geometry | 0 |
| `delete_photo_mockup` | Delete a photo mockup | 0 |
| `render_photo_mockup` | Print artwork into one saved print area, or across a whole product surface | 5 |
| `remove_background` | Get a transparent-PNG cutout through a 7-day signed URL | 25 |
| `render_video` | Animate a PSD mockup into a video clip (always async) | cost-based (one per account at no charge, then cost-based) |
| `get_job` | Check the status of an async job by job_id | 0 |
| `wait_for_job` | Poll an async job until it succeeds or fails | 0 |
| `list_jobs` | List async render, video, upload, and photo mockup jobs | 0 |
| `get_account` | Check plan, credits, prepaid balance, and usage | 0 |
| `create_webhook_endpoint` | Register a webhook for async job completion, pinned to an event naming | 0 |
| `list_webhook_endpoints` | List your webhook endpoints | 0 |
| `update_webhook_endpoint` | Edit or enable/disable a webhook endpoint | 0 |
| `delete_webhook_endpoint` | Delete a webhook endpoint | 0 |
| `rotate_webhook_secret` | Rotate a webhook signing secret | 0 |
| `test_webhook_endpoint` | Send a signed `webhook.test` event | 0 |
| `list_webhook_deliveries` | List delivery attempts for an endpoint | 0 |
| `replay_webhook_delivery` | Replay a single failed delivery | 0 |

### Renamed in 3.0

3.0 names every mockup tool after its family and keeps no alias for the old
name, so a client written against 2.x fails at "tool not found" rather than
being redirected to a tool whose arguments have changed.

| 2.x | 3.0 |
|-----|-----|
| `list_mockups` | `list_psd_mockups` |
| `get_mockup_details` | `get_psd_mockup` |
| `update_mockup` | `update_psd_mockup` |
| `delete_mockup` | `delete_psd_mockup` |
| `render_mockup` | `render_psd_mockup` |
| `create_2d_mockup` | `create_photo_mockup` |
| `list_2d_mockups` | `list_photo_mockups` |
| `get_2d_mockup` | `get_photo_mockup` |
| `update_2d_print_areas` | `update_photo_mockup_print_areas` |
| `delete_2d_mockup` | `delete_photo_mockup` |
| `render_2d_surface`, `render_2d_print_area` | `render_photo_mockup` |

Photo mockup tools take `mockup_id`, the field `list_photo_mockups` and
`create_photo_mockup` return. PSD mockup tools keep `mockup_uuid`.

### Async jobs

`render_psd_mockup`, `upload_psd`, `create_photo_mockup`, and
`render_photo_mockup` accept `is_async: true`, and `render_video` is always
async. These return a `job_id` immediately (HTTP 202) instead of a final
result. (`create_photo_mockup` and `render_photo_mockup` are synchronous by
default and return the mockup / render directly.) Poll it with `get_job`, or
let `wait_for_job` block until the job reaches a terminal status and hands back
`result_url`, `mockup_uuid`, `credits_charged`, and `payg`
(`{credits, unit_price, cost}` for pay-as-you-go jobs, otherwise `null`).

A photo mockup render names exactly one target, read from `get_photo_mockup`.
Every printable product in the photo is a surface with its own `surface_uuid`:
pass it to print across the whole of one, with either a `coverage` percentage
or an explicit `width` + `height`. A print area is a bounded zone somebody drew
on a product, such as a chest logo: pass its `print_area_uuid`, with either a
`fit` or an explicit `width` + `height`. A product can have both, and they are
separate targets -- a saved print area does not close off the surface it sits
on. The dial of the other kind of target (`fit` on a surface, `coverage` on a
print area) is refused by name rather than dropped.

Sizing has one answer per render: send the relative option or the exact box,
never both, and send `width` and `height` together. `position`, `offset_x`,
`offset_y` and `rotation` place the artwork on either kind of target. Anything
you leave out is left out of the request, so the renderer's own default
applies rather than a copy of it kept here.

### Background removal

`remove_background` returns a transparent-PNG URL valid for 7 days. You can
pass that URL straight back as `artwork_url` during that window. To clean
artwork inline during a single render instead, pass
`remove_background: true` to `render_psd_mockup` or `render_photo_mockup`. Either
way it costs 25 credits per artwork, refunded automatically if processing fails.

### Webhooks

Register an endpoint with `create_webhook_endpoint` to be notified when async
jobs finish. Deliveries are signed with TWO headers: `X-SudoMock-Signature`
(a hex HMAC-SHA256 over `${timestamp}.${rawBody}` using the secret returned at
creation/rotation) and `X-SudoMock-Timestamp` (unix seconds). Verify in constant
time and reject if `|now - timestamp| > 300s`.

Render, upload, and video job deliveries use
`{event, job_id, kind, status, result_url, error, created_at}`. The typed photo
mockup creation events add `version`, `mockup_id`, `name`, and either
`print_areas` (`ready`) or `reason` (`rejected`). The typed photo mockup render
events carry `mockup_id`, `result_url`, a public `{error_code, message}` failure
when applicable, and optional `export_format` / `duration_ms`. Event types:
`render.succeeded`, `render.failed`, `upload.succeeded`, `video.succeeded`,
`video.failed`, `photo_mockup.ready`, `photo_mockup.rejected`,
`photo_mockup.failed`, `photo_mockup_render.succeeded`,
`photo_mockup_render.failed`, `webhook.test`.

The five photo mockup events also have a legacy spelling: `2d_mockup.ready`,
`2d_mockup.rejected`, `2d_mockup.failed`, `2d_render.succeeded`,
`2d_render.failed` (with `kind` `2d_create` / `2d_render` in the payload).
Which spelling an endpoint receives is its `event_naming` pin, set at
`create_webhook_endpoint` and returned on every endpoint: `current` (the names
above, the default for new endpoints) or `legacy`. Endpoints registered before
the pin existed stay on `legacy`, so a receiver written against the old names
keeps working unchanged. Once that receiver handles the new names, move it with
`update_webhook_endpoint` and `event_naming: "current"`; sent on its own, the
re-pin re-spells the endpoint's stored subscription list to match.

### Logs

Each tool call writes one JSON line to stderr, which your MCP host keeps in its
log file: the tool name, how long the call took, and whether it succeeded, for
example `{"event":"mcp_tool_call","tool":"list_psd_mockups","duration_ms":312,"ok":true}`.
Arguments, API keys, file contents and API responses are never logged. Every
API request identifies this package as `mcp-stdio/<version>` in its
`User-Agent` and `X-SudoMock-Client` headers.

## Pricing and account limits

Pay as you go is the entry tier, and it has no subscription. One PSD render costs
**$0.10**, so $1 covers 10 of them. The minimum first payment is **$5**. Photo mockups
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

- "List my PSD mockup templates"
- "Render the t-shirt mockup with this design: https://example.com/logo.png"
- "Replace the editable headline text, then render the mockup"
- "Cut out the background from this product photo, then render it on the tote bag"
- "Turn this product photo into a mockup: https://example.com/tote.jpg"
- "List my photo mockups, then render the first one with this artwork: https://example.com/logo.png"
- "Render this design asynchronously and wait for it to finish"
- "Queue that photo mockup render async and give me the job id to track"
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
