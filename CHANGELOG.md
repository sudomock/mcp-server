# Changelog

## [Unreleased]

## [3.0.0] - 2026-09-19

### Changed (BREAKING)
- Every mockup tool is named after its family, PSD mockups or photo mockups.
  No alias answers to a 2.x name: a client written against 2.x fails at
  "tool not found" rather than being redirected to a tool whose arguments
  have changed. The hosted server (`mcp.sudomock.com`) uses the same names.

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

- `render_photo_mockup` is one tool for both kinds of target, shaped like the
  hosted server's: exactly one of `print_area_uuid` or `surface_uuid`, and the
  sizing dials of both (`coverage` or `width` + `height` on a surface, `fit`
  or `width` + `height` on a print area). Naming both targets, or neither, is
  refused before anything is sent. The dial of the other kind of target is
  refused by name, with the same sentence the two tools used to answer, rather
  than dropped; the retired `scale` is still refused by name. Anchoring and
  sizing carry no client-side default, as in 2.6.
- Photo mockup tools take `mockup_id`, the field `list_photo_mockups` and
  `create_photo_mockup` return and the REST API uses. `render_2d_surface` and
  `render_2d_print_area` took it as `mockup_uuid`. PSD mockup tools keep
  `mockup_uuid`.
- Requests go to the family paths, `/api/v1/psd-mockups` and
  `/api/v1/photo-mockups`. An async photo mockup job submitted through 3.0
  reports its family kind, `photo_mockup_create` / `photo_mockup_render`,
  where 2.x reported `2d_create` / `2d_render`; `list_jobs` selects a job by
  either spelling and a webhook endpoint's `event_naming` pin still decides
  which spelling its deliveries carry.

### Removed (BREAKING)
- `render_2d_surface` and `render_2d_print_area`, folded into
  `render_photo_mockup` above.

## [2.8.0] - 2026-09-18

### Added
- The photo mockup webhook events are subscribable under their own names:
  `photo_mockup.ready`, `photo_mockup.rejected`, `photo_mockup.failed`,
  `photo_mockup_render.succeeded`, `photo_mockup_render.failed`. The legacy
  `2d_mockup.*` / `2d_render.*` spellings stay accepted everywhere an event
  type is taken (`create_webhook_endpoint`, `update_webhook_endpoint`,
  `list_webhook_deliveries`).
- `create_webhook_endpoint` takes `event_naming` (`legacy` | `current`): the
  spelling of the photo mockup events this endpoint receives, with the
  payload's `kind` following the same pin. Omitted, the API default (`current`)
  applies. Every endpoint result now carries its `event_naming`, so an
  existing endpoint's pin (`legacy` for endpoints registered before the pin)
  can be read from `list_webhook_endpoints`.
- `update_webhook_endpoint` takes the same `event_naming`, so an endpoint
  registered before the family names existed can be moved to them once its
  receiver is ready. Sent on its own, the re-pin re-spells the endpoint's
  stored subscription list to match; omitted, the pin is left as it is.
- `list_jobs` filters by `kind` `photo_mockup_create` / `photo_mockup_render`
  as well as the legacy `2d_create` / `2d_render`; either spelling selects
  both.


## [2.7.1] - 2026-09-18

### Added
- Every tool call writes one JSON line to stderr (`event`, `tool`,
  `duration_ms`, `ok`, `error_type`), which MCP hosts keep in their log file.
  Arguments, API keys, file contents and API responses are never written.
- Every API request carries `X-SudoMock-Client: mcp-stdio/<version>` and the
  same value as `User-Agent`, so a request can be attributed to this package
  and version.

### Fixed
- The version sent to the API and reported in the MCP handshake is read from
  package.json. It was hand-written and had stayed at 2.4.0 across the last
  three releases.

## [2.7.0] - 2026-08-24

### Added
- `upload_local_file` takes a path on this machine and returns a `file_url` to
  hand to `upload_psd` (as `psd_file_url`) or any render tool (as
  `artwork_url`). Until now every tool needed a URL, so a file sitting on disk
  had to be hosted somewhere first. MCP itself offers no way to carry file
  bytes: the three attempts to add one never landed, `roots` carries paths and
  is deprecated as of 2026-07-28, and elicitation results are limited to
  scalars. Running on the user's own machine is what lets this server close the
  gap, and it closes it better than a hosted server can -- it reads the file and
  uploads it itself, so the signed upload URL is never returned to the model and
  never enters the transcript.
- `SUDOMOCK_UPLOAD_DIR` confines reads to a single directory tree. The model
  chooses the path, so the path is untrusted; symlinks are resolved before the
  containment check, so a link inside the tree cannot point outside it. Unset by
  default, which leaves any accepted extension readable.

## [2.6.0] - 2026-08-21

### Added
- `get_account` now reports `prepaid_balance` and `prepaid_balance_currency`,
  the money an account holds and spends per render. An account funded this way
  carries no subscription allowance, so its `credits_*` fields are legitimately
  `0` and a model reading only those told the customer they were out of credits.
- `usage.funding_summary`, a plain-language line covering both funding routes.
  The consumer here is a language model, and `0` credits beside a positive
  balance is exactly the pair it reads wrong, so the answer is stated rather
  than left to be inferred.
- The `get_account` tool description now tells the model to read both routes and
  to quote `funding_summary` instead of the credits fields alone.
- `render_2d_surface` prints artwork across a whole product surface and takes a
  `coverage` percentage (10-100, whole surface when omitted), or an explicit
  `width` + `height` instead. A percentage cannot express a box whose
  proportions differ from the surface, which is what an artwork resized on a
  canvas is; without the box every such all-over print was unsendable. Every
  printable product in a photo is a surface with its own `surface_uuid`.
- `render_2d_print_area` prints into one saved print area -- a bounded zone
  somebody drew, such as a chest logo -- and takes either a `fit` or an explicit
  `width` + `height`.

### Changed (BREAKING)
- `render_2d_mockup` is replaced by the two tools above. It offered `coverage`
  and `fit` on the same call and sent both on every render, which the API now
  answers with a 422: a percentage belongs to a surface and a fit belongs to a
  print area, and neither tool can be handed the other's. A product can have
  both a surface and print areas, and they are separate targets -- a saved
  print area no longer closes off the surface it sits on.
- No placement option is defaulted client-side any more. `coverage` and `fit`
  were already optional; `position` and `rotation` were not, and shipped
  `"center"` and `0` on every single render whether or not the caller had ever
  mentioned them. What the caller does not name does not travel, and a render
  that names no placement at all now sends no `placement` at all, so the
  renderer's default applies instead of a second copy of it kept here.
- `offset_x` and `offset_y` are accepted on both render tools. They anchor the
  artwork on either kind of target and were the one part of the placement
  contract these tools could not express.
- Sizing is answered once, or refused here rather than at the API. `width` and
  `height` must be sent together, and cannot be combined with `coverage` or
  `fit`. The wording matches the API's, so the reason reads the same whichever
  side answers.

### Removed (BREAKING)
- `surfaces[].coverage`. It was always the string `"full"`, so it stated nothing
  a caller could act on while reading exactly like a dial they could turn.
  Membership in `surfaces[]` is the whole statement.

## [2.5.0] - 2026-08-04

### Changed (BREAKING)
- 2D placement sizing moved from a single `scale` multiplier to independent
  `width` and `height` in print-area pixels. A one-axis stretch is now a
  supported placement; the aspect ratio is the caller's choice. Send the two
  together -- the API rejects half a size instead of guessing the other axis.

### Removed (BREAKING)
- `placement.scale`. No alias is kept: the API rejects it with 422 rather than
  ignoring it, so a stale integration fails visibly instead of quietly
  rendering the wrong size. For the old behaviour, send
  `width = artwork_width * scale` and `height = artwork_height * scale`.

## 2.4.0 - 2026-07-27

- Removed `create_studio_session` from MCP. Session and bootstrap credentials
  must be created server-to-server through the REST API, outside assistant output.
- `create_2d_mockup` accepts an optional retry-stable `idempotency_key`.
  Assistant-visible create input is limited to a public image URL and display
  name; raw image bytes and initial area geometry remain REST-only inputs.
- `get_2d_mockup` returns verified full product surfaces and
  `render_2d_mockup` accepts exactly one `print_area_uuid` or `surface_uuid`.
- `list_2d_mockups` accepts `customizable_only` and list/detail results expose
  the canonical `customizable` eligibility flag.
- `update_2d_print_areas` accepts an empty list; the API permits it only for
  verified full product surfaces.
- Job, render, delivery-log, and error results are restricted to documented
  outcome fields and safe customer messages.
- Video quality selection is automatic.

## 2.3.0

- New `remove_background` tool: turns any image into a transparent-PNG cutout.
  The returned URL is valid for 7 days. Use it as `artwork_url` during that
  window. Costs 25 credits per image;
  credits are refunded automatically if processing fails.
- `render_mockup` and `render_2d_mockup` accept an optional `remove_background`
  flag to clean the artwork inline during a render (25 credits per artwork). The
  flag is written only when `true`, so existing calls are unchanged. On
  `render_mockup` it can also be set per entry via `smart_objects[].asset`.

## 2.2.0

- `render_mockup` accepts one or more `smart_objects` and editable `text_layers`
  while preserving the existing singular smart-object arguments.
- `create_studio_session` supports PSD and 2D session types.
- Webhook subscriptions include all 11 current events, and job filtering includes
  `2d_create` and `2d_render`.
- Public descriptions and caller-visible errors now use outcome-only copy.

## 2.1.0

- `render_2d_mockup` now accepts optional `is_async` (mirrors `create_2d_mockup`).
  Default `false` returns `print_files` + `render_uuid` synchronously (200,
  unchanged). Pass `is_async: true` to queue the render and receive a `job_id`
  (202, `kind: "2d_render"`) to poll with `get_job` / `wait_for_job`; the
  terminal job hands back `result_url`. Additive and backward-compatible.

## 2.0.0

**BREAKING** — aligns the 2D-mockup tools with the finalized API contract.

- `create_2d_mockup` is now **synchronous by default**: it returns the mockup
  (`mockup_id`, `name`, `status`, `source_width`, `source_height`, `print_areas`)
  directly from the 201 response with no polling. Pass `is_async: true` to queue
  and receive a `job_id` to poll with `get_job` / `wait_for_job`. The previous
  always-async "wait up to 50s then return job details" behavior is removed.
- All 2D-mockup paths are now **plural** (`/api/v1/sudoai/2d-mockups...`):
  - `render_2d_mockup` posts to `/api/v1/sudoai/2d-mockups/{mockup_uuid}/render`
    with the mockup id in the **path** (removed from the request body). It now
    returns `print_files[].export_path` + `render_uuid`.
  - `get_2d_mockup`, `delete_2d_mockup`, and `update_2d_print_areas` use the
    plural `/2d-mockups/{id}` paths.
- `create_2d_mockup` accepts optional customer-seeded `print_areas`, and
  `update_2d_print_areas` print areas now accept an optional `name`.
- Version strings realigned (USER_AGENT + server manifest were still `1.4.0`
  while the package was `1.4.1`).

## 1.4.1

- MCP registry publish + `server.json` description fix.
</content>
