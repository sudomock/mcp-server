# Changelog

## 2.3.0

- New `remove_background` tool: turns any image into a transparent-PNG cutout.
  The cutout remains stored, and the returned signed URL is valid for 7 days.
  Use it as `artwork_url` during that window. Costs 25 credits per image;
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
