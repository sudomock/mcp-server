# Changelog

## [Unreleased]

### Changed

- The render tools (`render_mockup`, `render_2d_surface`,
  `render_2d_print_area`, `render_photo_mockup`, `render_video` and their
  family names) send `image_size` only when you name one. Left out, the render
  comes out at the default: 2048, or 1024 while the account is in trial.
- A render refused because the account is in trial and the size is above 1024
  says so, with how to lift it. It was reported as insufficient credits.

## [3.10.0] - 2026-11-08

### Added

- `list_folders` lists the folders in your mockup library. `parent_uuid`
  takes a folder's uuid for the folders inside it, or `root` for the ones at
  the top of the library; left out, it lists every folder. Each folder
  carries `parent_uuid` and how many folders, PSD mockups and photo mockups
  it holds directly. Free.
- `create_folder` creates a folder, at the top of the library or inside
  another one with `parent_uuid`. A name has to be unique among the folders
  beside it, whatever the capitalisation, so the same call can safely be made
  twice. Free.
- `move_to_folder` moves any mix of PSD mockups, photo mockups and folders
  into one folder, or to the top of the library when `target_folder_uuid` is
  left out. Everything named moves together or nothing does, and moving never
  changes a mockup's id. Up to 500 ids per list. Free.
- `list_mockups` and `list_photo_mockups` take `folder_uuid`: a folder's uuid
  for the mockups directly in it, or `root` for the ones at the top of the
  library. A call without it returns every mockup, as it did before.
- Every mockup in both lists, and in `get_mockup_details` and
  `get_2d_mockup`, carries `folder_uuid` (null at the top of the library).

## [3.9.1] - 2026-11-06

### Changed

- A seam fix job's `changes` can read `rearranged`, and the job carries
  `fine_detail` (`unchanged` or `softer`).

## [3.9.0] - 2026-11-06

### Added

- `check_seams` checks whether a repeating pattern tile joins without a
  visible seam. It answers at once with `status` (`seamless`, `faint_seam` or
  `visible_seam`), the sides that do not join cleanly (`left_right`,
  `top_bottom`) with their pixel ranges, `width` and `height`, `fixable` with
  `unfixable_reason`, and `previous_fix`, your latest fix of the same image.
  `crop_aspect` checks the image cropped to the tile shape the way
  `fit: "crop"` crops it. Free.
- `fix_seams` repairs a pattern tile so it repeats without a visible seam. It
  takes the same input as `check_seams` and is always async: it returns a
  `job_id` to read with `get_job` or `wait_for_job`. Costs 60 credits,
  refunded automatically if the fix fails. Pass `idempotency_key` so that a
  retry with the same key returns the same job instead of starting a new fix.
- `get_job`, `wait_for_job` and `list_jobs` return `alternative_url`,
  `result_status`, `changes` and `stage`, which a seam fix job fills.
- `get_job`, `wait_for_job` and `list_jobs` return `error_details` on a
  failed job: its `reason`, and nothing else from the error's details. A
  seam fix that fails with `TILE_NOT_FIXABLE` reports `not_a_pattern_tile` or
  `no_clean_result`, and its credits are refunded.
- `list_jobs` filters by the `seam_fix` kind.
- The webhook tools take the `seam_fix.succeeded` and `seam_fix.failed`
  events.

### Changed

- Every `tile` parameter description ends with "Check the tile with
  check_seams first."
- The registry and npm descriptions read "Turn product photos or PSDs into
  photorealistic mockups: place artwork, edit text, fix tile seams.", and the
  npm keywords add `photo-mockup`, `seamless-pattern` and `seamless-tile`.

## [3.8.4] - 2026-11-03

### Changed

- Background removal is described at 5 credits per image, on the
  `remove_background` tool and on the `remove_background` flag of the render
  tools (5 credits per artwork).

## [3.8.3] - 2026-11-01

### Changed

- A code comment in the published package no longer names an internal
  decision. No behaviour change.

## [3.8.2] - 2026-11-01

### Changed

- Code comments in the published package read in English. No behaviour
  change.

## [3.8.1] - 2026-10-26

### Changed

- `text_fit` and the `fit` of each text entry cover box text: with `shrink`,
  box text is scaled down to fit its box's width and height, point text to its
  width, and `text_font_size`, when sent, is the largest size. Box text always
  wraps in its box and shows the lines that fit.
- `vertical_align` takes single-style layers, point and box.

## [3.8.0] - 2026-10-24

### Added

- `tile_spacing` sets the gap between tiles when `tile` is true, as a
  percentage of the tile size from 0 to 100: the horizontal gap is that percent
  of the tile width, the vertical gap that percent of the tile height. It goes
  in a `smart_objects` entry's `asset` on `render_mockup` and
  `render_psd_mockup`, and it is a parameter of `render_photo_mockup`,
  `render_2d_mockup`, `render_2d_surface` and `render_2d_print_area`. A value
  outside 0 to 100 is refused.
- `render_video` takes `tile` and `tile_spacing` for the smart object it fills,
  with the same descriptions as the PSD render. `asset_width` and
  `asset_height` are the size of one tile.
- `update_2d_print_areas` and `update_photo_mockup_print_areas` take an
  optional `print_area_id` on each area. An area that carries the id of one of
  the mockup's print areas keeps that id; an area without one gets a new id.

## [3.7.0] - 2026-10-24

### Added

- `tile` repeats the artwork as a pattern across the whole target. On a PSD
  template it goes in a `smart_objects` entry's `asset`: `size` is one tile,
  `fit` places the artwork inside each tile, and `position` sets where the
  grid starts. On a photo mockup it is a parameter of `render_photo_mockup`,
  `render_2d_mockup`, `render_2d_surface` and `render_2d_print_area`: the
  sizing answer (`coverage`, `fit`, or `width` and `height`) is one tile, and
  `position` with `offset_x` and `offset_y` sets where the grid starts. A tile
  needs a size; without one the API answers 422. The hosted server at
  mcp.sudomock.com takes `tile` too.
- Each surface of a photo mockup carries a `label`, what was detected there,
  such as `wall` or `pillow`, so you can tell the surfaces apart before
  choosing one.

### Fixed

- `upload_local_file` with kind `artwork` failed with 400 for every image. It
  now sends the image as its own type.

## [3.6.1] - 2026-10-18

### Fixed

- `adjustment_layers.blur` on a `smart_objects` entry of `render_mockup` and
  `render_psd_mockup` takes a decimal amount from 0 to 100, such as `2.5`, as
  the API does. It took only a whole number, while the top-level `blur`
  already took a decimal. A whole number behaves as before.

## [3.6.0] - 2026-10-06

### Added

- `render_mockup` and `render_psd_mockup` take `image_size: "original"` to
  render a template at its own size and resolution: the output has the
  template's own width, its height follows the template's proportions, and
  the file carries the resolution the PSD was saved with unless `dpi` is sent.
  A number still sets the output width, and the default stays 2048. A template
  uploaded before this option existed answers `REUPLOAD_REQUIRED` for
  `"original"`; uploading it again fixes that. The hosted server at
  mcp.sudomock.com takes `"original"` too.

## [3.5.0] - 2026-10-06

### Added

- `render_mockup` and `render_psd_mockup` take `hidden_layers`: up to 50
  layer UUIDs to leave out of one render, including layers inside a smart
  object's contents. Hiding a group hides every layer inside it, and a layer
  clipped to a hidden layer is hidden with it, as in Photoshop. A layer hidden
  inside a smart object's contents is hidden in every copy of that smart
  object. It works on its own, and an empty list counts as not sent.
- `get_mockup_details` and `get_psd_mockup` take `include_layers`. When it is
  true the result also carries `data.layers`, every layer of the template with
  the UUID `hidden_layers` takes, nested the way Photoshop's Layers panel shows
  it. A smart object whose contents hold layers you can fill lists those
  layers as its children. An artboard has kind `artboard`, and its own layers
  are listed right before it at the top level. The hosted server takes the
  same two arguments.

## [3.4.0] - 2026-10-05

### Changed

- A smart object's artwork is fitted inside its area with its proportions kept
  when `fit` is left out, as the API does: `render_mockup`,
  `render_psd_mockup` and `render_video` now default to `fit` instead of
  `fill`. Send `fill` to stretch the artwork to the bounds. The hosted server
  at `mcp.sudomock.com` sends the same default.

## [3.3.0] - 2026-10-05

### Added

- `get_mockup_details` and the other tools that return a PSD mockup keep the
  smart objects and live text found inside a smart object. Each such smart
  object lists them in its own `smart_objects` and `text_layers`, with the same
  fields as a top-level entry; its position and quad are measured in the
  enclosing smart object's own pixels. Fill any of them by UUID in the same
  render, like a top-level one.
- A render that sends artwork to a smart object and also fills a slot inside it
  is refused with `NESTED_SLOT_CONFLICT`. An upload whose smart object contents
  could not be read carries the warning `PSD_NESTED_CONTENTS_UNAVAILABLE`; that
  smart object stays one slot and still renders as designed.

## [3.2.0] - 2026-09-25

### Added

- The package and the hosted server at `mcp.sudomock.com` now take the same
  arguments on every shared tool and send the same request for them.
  `render_mockup` and `render_psd_mockup` take the hosted server's single text
  layer shortcut (`text_layer_uuid`, `text`, `text_segments`, `text_font`,
  `text_font_size`, `text_color`, `text_stroke_color`, `text_fit`,
  `text_vertical_align`) and `group_layer_uuid` with `group_stroke_color`.
  `render_photo_mockup` and `render_2d_mockup` take `blend_mode`,
  `render_photo_mockup` also takes `mockup_uuid`, and `render_video` takes
  `advanced_model`.
- Smart object colours take a `label` as well as a `hex`, text layers take
  `vertical_align`, artwork size and position take fractions, and every `fit`
  takes `fit` and `crop` beside `fill`, `contain` and `cover`.

### Changed

- The single `smart_object_uuid` and `artwork_url` pair can be sent together
  with `smart_objects` or `text_layers`; the pair comes first. An empty list
  counts as not sent.
- The `event_naming` description says what a new webhook endpoint gets when no
  naming is sent.

## [3.1.0] - 2026-09-24

### Changed

- README: the pricing section reads "Subscriptions from $0.002 per render" and
  gives pay as you go at $0.05 per render in one sentence.
- This release is numbered after 3.0.0 so that registries that sort by version
  show it as the latest. Tools, names and arguments are the same as in 2.11.0.

## [2.11.0] - 2026-09-24

### Added

- The package and the hosted server at `mcp.sudomock.com` now serve the same
  tool names. Six names the hosted server already had are added here:
  `list_fonts`, `create_upload_url` and `replay_failed_webhook_deliveries` as
  new tools, and `get_2d_mockup_details`, `send_webhook_test_event` and
  `render_2d_mockup` as second names for existing tools. No tool, name or
  argument was removed or changed.

## [2.10.1] - 2026-09-24

### Changed

- Tool and field descriptions say "photo mockup" where they said "2D mockup",
  matching the product name used across SudoMock. Tool names are unchanged:
  `create_2d_mockup`, `list_2d_mockups` and the rest keep working exactly as
  before, beside their `photo_mockup` family names.

## [2.10.0] - 2026-09-22

### Added

- `get_account` returns an `organization` block (`id`, `name`): the
  organization the API key belongs to. The plan, the credits and the prepaid
  balance it reports are that organization's. Every field `get_account`
  already returned is still there and unchanged.

## [2.9.0] - 2026-09-19

### Added

- **No tool name was removed, renamed or deprecated in this release.** Every
  name 2.8.1 registered is still registered, still takes the same arguments,
  and still sends the same request. An existing setup keeps working with no
  change at all. What follows is added beside it, and both spellings are
  supported from here on.
- The PSD mockup tools answer to the family spelling as well:
  `list_psd_mockups`, `get_psd_mockup`, `update_psd_mockup`,
  `delete_psd_mockup`, `render_psd_mockup`. Each is the same tool as
  `list_mockups`, `get_mockup_details`, `update_mockup`, `delete_mockup` and
  `render_mockup` respectively, with the same arguments and the same behavior.
- The photo mockup tools answer to the family spelling as well:
  `create_photo_mockup`, `list_photo_mockups`, `get_photo_mockup`,
  `update_photo_mockup_print_areas`, `delete_photo_mockup`. Each is the same
  tool as `create_2d_mockup`, `list_2d_mockups`, `get_2d_mockup`,
  `update_2d_print_areas` and `delete_2d_mockup` respectively.
- `render_photo_mockup` renders either kind of target from one tool: name
  exactly one of `surface_uuid` (sized by `coverage` or an explicit
  `width` + `height`) or `print_area_uuid` (sized by `fit` or an explicit
  `width` + `height`), and pass the mockup as `mockup_id`. `render_2d_surface`
  and `render_2d_print_area` are untouched and stay the way to reach the same
  two renders by picking a tool instead of naming a target.

## [2.8.1] - 2026-09-19

### Changed

- The 3.0.0 tool renaming is reverted. Tool names are the ones 2.8.0 shipped, so an existing setup keeps working without any change. Product naming stays on the visible surfaces (site, docs, API paths).

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
