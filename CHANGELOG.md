# Changelog

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
