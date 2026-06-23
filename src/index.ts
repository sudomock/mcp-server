#!/usr/bin/env node

/**
 * SudoMock MCP Server
 *
 * Local stdio MCP server for Claude Desktop, Claude Code, Cursor, and VS Code.
 * Renders photorealistic product mockups from Photoshop PSD templates via the SudoMock API.
 *
 * Auth: SUDOMOCK_API_KEY environment variable
 * Transport: stdio (local process)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = "https://api.sudomock.com";
const DEFAULT_TIMEOUT = 30_000;
const RENDER_TIMEOUT = 120_000;
const USER_AGENT = "SudoMock-MCP/1.3.0 (stdio)";

function getApiKey(): string {
  const key = process.env.SUDOMOCK_API_KEY;
  if (!key) {
    throw new Error(
      "SUDOMOCK_API_KEY environment variable is not set. " +
        "Get your API key at https://sudomock.com/dashboard/api-keys"
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// HTTP helpers (native fetch)
// ---------------------------------------------------------------------------

interface RequestOptions {
  method: string;
  path: string;
  params?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeout?: number;
}

async function apiRequest({ method, path, params, body, timeout = DEFAULT_TIMEOUT }: RequestOptions): Promise<unknown> {
  const apiKey = getApiKey();

  let url = `${BASE_URL}${path}`;
  if (params) {
    const searchParams = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) {
        searchParams.set(k, String(v));
      }
    }
    const qs = searchParams.toString();
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (!resp.ok) {
      let detail: string;
      try {
        const json = (await resp.json()) as { detail?: string };
        detail = json.detail ?? resp.statusText;
      } catch {
        detail = resp.statusText;
      }

      const errorMap: Record<number, string> = {
        401: `Invalid API key. Check your key at https://sudomock.com/dashboard/api-keys`,
        402: `Insufficient credits. ${detail}`,
        403: `Access denied. ${detail}`,
        404: `Not found. ${detail}`,
        409: `Conflict. ${detail}`,
        422: `Invalid parameters: ${detail}`,
        429: `Rate limit exceeded. Wait and retry.`,
        500: `SudoMock server error. Try again in a moment.`,
      };

      throw new Error(errorMap[resp.status] ?? `${method} ${path} failed (${resp.status}): ${detail}`);
    }

    // 204 No Content
    if (resp.status === 204) {
      return { success: true };
    }

    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Async job helpers
// ---------------------------------------------------------------------------

/**
 * A queued (202 Accepted) async submission carries a render_uuid + status_url.
 * Surface that contract plainly so an agent knows to poll instead of hunting
 * for a result_url that does not exist yet.
 */
function formatJobAccepted(result: unknown): string {
  const r = (result ?? {}) as Record<string, unknown>;
  const renderUuid = r.render_uuid ?? r.mockup_uuid ?? null;
  const statusUrl = r.status_url ?? (renderUuid ? `/api/v1/jobs/${renderUuid}` : null);
  const summary = {
    accepted: true,
    render_uuid: renderUuid,
    kind: r.kind ?? null,
    status: r.status ?? "queued",
    status_url: statusUrl,
    next_step:
      "Poll get_job with this render_uuid, or call wait_for_job to block until it finishes.",
    raw: result,
  };
  return JSON.stringify(summary, null, 2);
}

const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed"]);

/** GET /api/v1/jobs/{render_uuid} -- owner-scoped job status snapshot. */
async function getJob(renderUuid: string): Promise<Record<string, unknown>> {
  const result = (await apiRequest({
    method: "GET",
    path: `/api/v1/jobs/${renderUuid}`,
  })) as Record<string, unknown>;
  return result;
}

/**
 * A job is done when its status is terminal. The poll response field is
 * `status`; we also accept a legacy `state` key for forward/backward
 * compatibility.
 */
function isTerminalJob(job: Record<string, unknown>): boolean {
  const status =
    typeof job.status === "string"
      ? job.status
      : typeof job.state === "string"
        ? job.state
        : "";
  return TERMINAL_JOB_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "SudoMock",
  version: "1.3.0",
});

// ---------------------------------------------------------------------------
// Tool 1: list_mockups
// ---------------------------------------------------------------------------

server.tool(
  "list_mockups",
  "List your uploaded mockup templates with UUIDs, names, and thumbnails. Use returned UUIDs with render_mockup or get_mockup_details.",
  {
    limit: z.number().min(1).max(100).default(20).describe("Results per page (1-100, default 20)"),
    offset: z.number().min(0).default(0).describe("Pagination offset (default 0)"),
    name: z.string().optional().describe("Filter by name (case-insensitive substring match)"),
    created_after: z.string().optional().describe("Only mockups created after this ISO 8601 timestamp"),
    created_before: z.string().optional().describe("Only mockups created before this ISO 8601 timestamp"),
    sort_by: z.enum(["created_at", "updated_at", "name"]).default("created_at").describe("Sort field"),
    sort_order: z.enum(["asc", "desc"]).default("desc").describe("Sort direction"),
  },
  async ({ limit, offset, name, created_after, created_before, sort_by, sort_order }) => {
    const result = await apiRequest({
      method: "GET",
      path: "/api/v1/mockups",
      params: { limit, offset, name, created_after, created_before, sort: sort_by, order: sort_order },
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool 2: get_mockup_details
// ---------------------------------------------------------------------------

server.tool(
  "get_mockup_details",
  "Get full details of a mockup: smart object UUIDs, layer names, dimensions, positions, blend modes, and thumbnail URLs.",
  {
    mockup_uuid: z.string().describe("The UUID of the mockup to inspect"),
  },
  async ({ mockup_uuid }) => {
    const result = await apiRequest({
      method: "GET",
      path: `/api/v1/mockups/${mockup_uuid}`,
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool 3: update_mockup
// ---------------------------------------------------------------------------

server.tool(
  "update_mockup",
  "Rename a mockup template.",
  {
    mockup_uuid: z.string().describe("The UUID of the mockup to rename"),
    name: z.string().describe("New display name for the mockup"),
  },
  async ({ mockup_uuid, name }) => {
    const result = await apiRequest({
      method: "PATCH",
      path: `/api/v1/mockups/${mockup_uuid}`,
      body: { name },
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool 4: delete_mockup
// ---------------------------------------------------------------------------

server.tool(
  "delete_mockup",
  "Permanently delete a mockup template. Cannot be undone.",
  {
    mockup_uuid: z.string().describe("The UUID of the mockup to delete"),
  },
  async ({ mockup_uuid }) => {
    await apiRequest({
      method: "DELETE",
      path: `/api/v1/mockups/${mockup_uuid}`,
    });
    return { content: [{ type: "text" as const, text: `Mockup ${mockup_uuid} deleted successfully.` }] };
  }
);

// ---------------------------------------------------------------------------
// Tool 5: render_mockup
// ---------------------------------------------------------------------------

server.tool(
  "render_mockup",
  "Render a mockup by placing artwork onto a PSD template's smart object. Returns the CDN URL of the rendered image. Costs 1 credit. Use list_mockups to find mockup_uuid, then get_mockup_details for smart_object_uuid.",
  {
    mockup_uuid: z.string().describe("UUID of the mockup template (from list_mockups)"),
    smart_object_uuid: z.string().describe("UUID of the smart object layer (from get_mockup_details)"),
    artwork_url: z.string().describe("Public URL of the artwork image (PNG/JPG/WebP) to place on the mockup"),
    fit: z.enum(["fill", "contain", "cover"]).default("fill").describe("How artwork fills the smart object area"),
    image_format: z.enum(["webp", "png", "jpg"]).default("webp").describe("Output format"),
    image_size: z.number().min(100).max(10000).default(2048).describe("Output width in pixels (default 2048)"),
    quality: z.number().min(1).max(100).default(90).describe("Compression quality for webp/jpg (default 90)"),
    dpi: z.number().int().min(72).max(2400).optional().describe("Print resolution 72-2400. Embeds a resolution tag into output metadata (JPEG Exif / PNG pHYs / WebP Exif). Does not change pixel size -- use image_size. jpg/png recommended for max compatibility."),
    rotate: z.number().min(-360).max(360).default(0).describe("Rotate artwork in degrees"),
    flip_horizontal: z.boolean().default(false).describe("Mirror artwork left-right"),
    flip_vertical: z.boolean().default(false).describe("Mirror artwork top-bottom"),
    color_hex: z.string().optional().describe("Optional color overlay hex code (e.g. '#FF5733')"),
    color_blend_mode: z.string().optional().describe("Blend mode for color overlay (e.g. 'multiply', 'screen', 'overlay')"),
    brightness: z.number().min(-150).max(150).default(0).describe("Brightness adjustment"),
    contrast: z.number().min(-100).max(100).default(0).describe("Contrast adjustment"),
    opacity: z.number().min(0).max(100).default(100).describe("Layer opacity percentage"),
    saturation: z.number().min(-100).max(100).default(0).describe("Saturation adjustment"),
    vibrance: z.number().min(-100).max(100).default(0).describe("Vibrance adjustment (-100 to 100)"),
    blur: z.number().min(0).max(100).default(0).describe("Gaussian blur strength (0 to 100)"),
    export_label: z.string().optional().describe("Optional label for file naming"),
    is_async: z
      .boolean()
      .default(false)
      .describe(
        "Queue the render instead of waiting for it. When true the API returns 202 with a render_uuid immediately (no result_url yet) -- poll with get_job, or call wait_for_job to block until it finishes. Use for long renders or when running many in parallel."
      ),
  },
  async (args) => {
    const smartObject: Record<string, unknown> = {
      uuid: args.smart_object_uuid,
      asset: {
        url: args.artwork_url,
        fit: args.fit,
        rotate: args.rotate,
        flip_horizontal: args.flip_horizontal,
        flip_vertical: args.flip_vertical,
      },
    };

    if (args.color_hex) {
      smartObject.color = {
        hex: args.color_hex,
        blending_mode: args.color_blend_mode ?? "normal",
      };
    }

    if (
      args.brightness ||
      args.contrast ||
      args.opacity !== 100 ||
      args.saturation ||
      args.vibrance ||
      args.blur
    ) {
      smartObject.adjustment_layers = {
        brightness: args.brightness,
        contrast: args.contrast,
        opacity: args.opacity,
        saturation: args.saturation,
        vibrance: args.vibrance,
        blur: args.blur,
      };
    }

    const body: Record<string, unknown> = {
      mockup_uuid: args.mockup_uuid,
      smart_objects: [smartObject],
      export_options: {
        image_format: args.image_format,
        image_size: args.image_size,
        quality: args.quality,
        ...(args.dpi !== undefined ? { dpi: args.dpi } : {}),
      },
    };

    if (args.export_label) {
      body.export_label = args.export_label;
    }

    if (args.is_async) {
      body.is_async = true;
    }

    const result = await apiRequest({
      method: "POST",
      path: "/api/v1/renders",
      body,
      timeout: RENDER_TIMEOUT,
    });

    if (args.is_async) {
      return { content: [{ type: "text" as const, text: formatJobAccepted(result) }] };
    }

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool 6: render_2d_mockup
// ---------------------------------------------------------------------------

server.tool(
  "render_2d_mockup",
  "Render artwork onto a saved 2D mockup template (no PSD needed) with perspective correction. Needs mockup_uuid + print_area_uuid. Use list_2d_mockups to find mockup_uuid, then get_2d_mockup to read its quads[].print_area_id for print_area_uuid. Returns the CDN URL of the rendered image. Costs 5 credits. The mockup must be in 'ready' status (depth computation complete).",
  {
    mockup_uuid: z.string().describe("UUID of the 2D mockup template (from list_2d_mockups, returned as mockup_id)."),
    print_area_uuid: z.string().describe("UUID of the print area to render into (from get_2d_mockup, returned as quads[].print_area_id)."),
    artwork_url: z.string().describe("Public URL of the artwork image (PNG/JPG/WebP) to place on the mockup"),
    blend_mode: z.enum(["multiply", "normal"]).default("multiply").describe("How artwork blends with the product surface - 'multiply' (fabric, default), 'normal' (flat)"),
    opacity: z.number().min(0).max(100).default(100).describe("Artwork opacity percentage (0-100)"),
    brightness: z.number().min(-150).max(150).default(0).describe("Brightness adjustment (-150 to 150)"),
    contrast: z.number().min(-100).max(100).default(0).describe("Contrast adjustment (-100 to 100)"),
    saturation: z.number().min(-100).max(100).default(0).describe("Saturation adjustment (-100 to 100)"),
    warp_strength: z.number().min(0).max(2).default(1).describe("Surface displacement intensity (0.0-2.0, default 1.0). Higher = more surface warp effect."),
    rotation: z.number().min(-360).max(360).default(0).describe("Rotate artwork in degrees (-360 to 360)"),
    position: z
      .enum([
        "center",
        "top_left",
        "top_center",
        "top_right",
        "center_left",
        "center_right",
        "bottom_left",
        "bottom_center",
        "bottom_right",
      ])
      .default("center")
      .describe("Placement within the print area (default 'center')"),
    coverage: z.number().min(10).max(100).default(70).describe("Percentage of the print area to cover (10-100, default 70)"),
    fit: z.enum(["contain", "fill", "cover"]).default("contain").describe("How artwork fits the print area - 'contain' (fit inside, default), 'fill' (stretch), 'cover' (fill and crop)"),
    image_format: z.enum(["webp", "png", "jpg"]).default("webp").describe("Output format - 'webp' (smaller, recommended), 'png' (lossless), 'jpg'"),
    image_size: z.number().min(100).max(10000).default(2048).describe("Output width in pixels (100-10000, default 2048)"),
    quality: z.number().min(1).max(100).default(90).describe("Compression quality for webp/jpg (1-100, default 90)"),
  },
  async (args) => {
    const body: Record<string, unknown> = {
      mockup_uuid: args.mockup_uuid,
      print_areas: [
        {
          uuid: args.print_area_uuid,
          artwork_url: args.artwork_url,
          adjustments: {
            blend_mode: args.blend_mode,
            opacity: args.opacity,
            brightness: args.brightness,
            contrast: args.contrast,
            saturation: args.saturation,
            warp_strength: args.warp_strength,
          },
          placement: {
            position: args.position,
            coverage: args.coverage,
            fit: args.fit,
            rotation: args.rotation,
          },
        },
      ],
      export_options: {
        image_format: args.image_format,
        image_size: args.image_size,
        quality: args.quality,
      },
    };

    const result = await apiRequest({
      method: "POST",
      path: "/api/v1/sudoai/2d-mockup/render",
      body,
      timeout: RENDER_TIMEOUT,
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: list_2d_mockups
// ---------------------------------------------------------------------------

server.tool(
  "list_2d_mockups",
  "List your saved SudoAI 2D mockup templates (no PSD). Returns each mockup's mockup_id, name, status, thumbnail, dimensions, and print_areas. Use the mockup_id with get_2d_mockup (to read print_area UUIDs) or render_2d_mockup. Costs 0 credits.",
  {
    limit: z.number().min(1).max(100).default(20).describe("Results per page (1-100, default 20)"),
    offset: z.number().min(0).default(0).describe("Pagination offset (default 0)"),
  },
  async ({ limit, offset }) => {
    const result = await apiRequest({
      method: "GET",
      path: "/api/v1/sudoai/2d-mockups",
      params: { limit, offset },
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: get_2d_mockup
// ---------------------------------------------------------------------------

server.tool(
  "get_2d_mockup",
  "Get one SudoAI 2D mockup's full details: status, thumbnail, source dimensions, and quads[] (each with print_area_id). Use a quads[].print_area_id as the print_area_uuid for render_2d_mockup. Costs 0 credits.",
  {
    mockup_id: z.string().describe("UUID of the 2D mockup (mockup_id from list_2d_mockups)"),
  },
  async ({ mockup_id }) => {
    const result = await apiRequest({
      method: "GET",
      path: `/api/v1/sudoai/2d-mockup/${mockup_id}`,
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: delete_2d_mockup
// ---------------------------------------------------------------------------

server.tool(
  "delete_2d_mockup",
  "Permanently delete a SudoAI 2D mockup template (and its masks, quads, and stored files). Cannot be undone. Costs 0 credits.",
  {
    mockup_id: z.string().describe("UUID of the 2D mockup to delete (mockup_id from list_2d_mockups)"),
  },
  async ({ mockup_id }) => {
    const result = await apiRequest({
      method: "DELETE",
      path: `/api/v1/sudoai/2d-mockup/${mockup_id}`,
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool 7: upload_psd
// ---------------------------------------------------------------------------

server.tool(
  "upload_psd",
  "Upload a Photoshop PSD/PSB file as a new mockup template. The PSD must have at least one Smart Object layer. Processing takes 5-30 seconds.",
  {
    psd_file_url: z.string().describe("Public URL to a .psd or .psb file (up to Adobe's official PSD file size limit)"),
    psd_name: z.string().optional().describe("Display name for the template (auto-generated from filename if omitted)"),
    is_async: z
      .boolean()
      .default(false)
      .describe(
        "Queue the upload instead of blocking. When true the API returns 202 with a render_uuid immediately -- poll with get_job (or wait_for_job) to learn when processing finishes and get the new mockup_uuid. Always free (0 credits), sync or async."
      ),
  },
  async ({ psd_file_url, psd_name, is_async }) => {
    const body: Record<string, unknown> = { psd_file_url };
    if (psd_name) body.psd_name = psd_name;
    if (is_async) body.is_async = true;

    const result = await apiRequest({
      method: "POST",
      path: "/api/v1/psd/upload",
      body,
      timeout: RENDER_TIMEOUT,
    });

    if (is_async) {
      return { content: [{ type: "text" as const, text: formatJobAccepted(result) }] };
    }

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: get_job
// ---------------------------------------------------------------------------

server.tool(
  "get_job",
  "Get the current status of an async job (render, video, or PSD upload) by its render_uuid. Returns status (queued|running|succeeded|failed), and once succeeded: result_url, mockup_uuid, model, credits_charged, and payg ({credits, unit_price, cost} for pay-as-you-go jobs, else null) -- or error if failed. Get the render_uuid from a render_mockup/upload_psd call with is_async=true, or from render_video. To block until done, use wait_for_job instead.",
  {
    render_uuid: z.string().describe("The render_uuid returned by an async submission (render_mockup is_async, upload_psd is_async, or render_video)"),
  },
  async ({ render_uuid }) => {
    const result = await getJob(render_uuid);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: list_jobs
// ---------------------------------------------------------------------------

server.tool(
  "list_jobs",
  "List your async jobs (renders, videos, PSD uploads), newest first. Use this to enumerate in-flight or finished jobs when you do not already hold a render_uuid. Keyset-paginated: pass the returned next_cursor to fetch the next page. Each job carries render_uuid, kind, status, model, result_url, mockup_uuid, credits_charged, and (for video) duration_seconds/audio.",
  {
    kind: z.enum(["video", "render", "upload"]).optional().describe("Filter by job kind. Omit for all kinds."),
    mockup_uuid: z.string().optional().describe("Filter by source mockup UUID (e.g. one mockup's videos). Raw-image videos are never returned by this filter."),
    limit: z.number().int().min(1).max(50).default(20).describe("Max jobs per page (1-50, default 20)"),
    cursor: z.string().optional().describe("Opaque keyset cursor from a prior page's next_cursor"),
  },
  async ({ kind, mockup_uuid, limit, cursor }) => {
    const result = await apiRequest({
      method: "GET",
      path: "/api/v1/jobs",
      params: { kind, mockup_uuid, limit, cursor },
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: wait_for_job
// ---------------------------------------------------------------------------

server.tool(
  "wait_for_job",
  "Poll an async job until it reaches a terminal status (succeeded or failed), then return the final job. Blocks while polling. Use after render_mockup/upload_psd with is_async=true or after render_video. On success the result includes result_url, mockup_uuid, model, credits_charged, and payg ({credits, unit_price, cost} or null); on failure it includes error.",
  {
    render_uuid: z.string().describe("The render_uuid to wait on (from an async submission or render_video)"),
    poll_interval_seconds: z
      .number()
      .min(1)
      .max(30)
      .default(3)
      .describe("Seconds between status checks (1-30, default 3)"),
    timeout_seconds: z
      .number()
      .min(5)
      .max(900)
      .default(300)
      .describe("Give up after this many seconds if the job has not finished (5-900, default 300)"),
  },
  async ({ render_uuid, poll_interval_seconds, timeout_seconds }) => {
    const deadline = Date.now() + timeout_seconds * 1000;
    let job = await getJob(render_uuid);

    while (!isTerminalJob(job)) {
      if (Date.now() >= deadline) {
        const timedOut = {
          timed_out: true,
          render_uuid,
          waited_seconds: timeout_seconds,
          last_status: job.status ?? job.state ?? "unknown",
          message:
            "Job did not reach a terminal state within timeout_seconds. It may still be running -- call get_job later to check.",
          last_job: job,
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(timedOut, null, 2) }] };
      }
      await new Promise((resolve) => setTimeout(resolve, poll_interval_seconds * 1000));
      job = await getJob(render_uuid);
    }

    return { content: [{ type: "text" as const, text: JSON.stringify(job, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: render_video
// ---------------------------------------------------------------------------

server.tool(
  "render_video",
  "Animate a mockup into an AI video clip. Produces a still render from the mockup (same shape as render_mockup), then animates it with an auto-routed image-to-video model. ALWAYS async: returns 202 with a render_uuid immediately -- pair with get_job or wait_for_job. Credit cost is computed from model x duration x audio (free tier: 1 video for the lifetime of the account). duration_seconds must be one of the chosen model's allowed durations or the call fails with 400.",
  {
    mockup_uuid: z.string().describe("UUID of the mockup to animate (from list_mockups or upload_psd)"),
    smart_object_uuid: z.string().describe("UUID of the smart object layer to place artwork on (from get_mockup_details)"),
    artwork_url: z.string().describe("Public URL of the artwork image (PNG/JPG/WebP) to place on the mockup before animating"),
    fit: z.enum(["fill", "contain", "cover"]).default("fill").describe("How artwork fills the smart object area in the still frame"),
    duration_seconds: z
      .number()
      .int()
      .min(1)
      .max(15)
      .default(4)
      .describe("Clip length in seconds. Must be one of the auto-routed model's allowed durations or the call is rejected with 400 (INVALID_VIDEO_DURATION). Allowed sets: Veo [4,6,8] (the default-tier primary), Kling v3 Pro [3..15], Kling 2.6 Pro / Seedance / Wan [5,10]. Default 4 is the only value valid across the default-tier Veo route. Cost scales with this value."),
    audio: z
      .boolean()
      .default(false)
      .describe("Generate audio. Default off (muted clips are cheaper). Audio cost depends on the routed model: Veo bundles audio at a premium, Kling v3/2.6 charge an audio premium; Seedance and Wan add no audio cost."),
    motion: z
      .enum(["ambient", "showcase"])
      .default("ambient")
      .describe("'ambient' = subtle looping hero motion that keeps the print readable; 'showcase' = one deliberate camera/product move."),
    advanced_model: z
      .string()
      .optional()
      .describe("Escape hatch: explicit roster model id to override the auto-router (e.g. 'kling-v3-pro'). Eliminated/unknown ids are rejected. Omit to auto-route (recommended)."),
    image_format: z.enum(["webp", "png", "jpg"]).default("webp").describe("Output format of the still input frame"),
    image_size: z.number().min(100).max(10000).default(2048).describe("Width in pixels of the still input frame (default 2048)"),
    quality: z.number().min(1).max(100).default(90).describe("Compression quality for the still input frame (webp/jpg, default 90)"),
    webhook_url: z
      .string()
      .optional()
      .describe("Optional completion webhook URL. Best-effort push; polling get_job remains the source of truth."),
  },
  async (args) => {
    const video: Record<string, unknown> = {
      duration_seconds: args.duration_seconds,
      audio: args.audio,
      motion: args.motion,
    };
    if (args.advanced_model) {
      video.advanced_model = args.advanced_model;
    }

    const body: Record<string, unknown> = {
      mockup_uuid: args.mockup_uuid,
      smart_objects: [
        {
          uuid: args.smart_object_uuid,
          asset: { url: args.artwork_url, fit: args.fit },
        },
      ],
      export_options: {
        image_format: args.image_format,
        image_size: args.image_size,
        quality: args.quality,
      },
      video,
    };

    if (args.webhook_url) {
      body.webhook = { url: args.webhook_url };
    }

    const result = await apiRequest({
      method: "POST",
      path: "/api/v1/renders/video",
      body,
      timeout: RENDER_TIMEOUT,
    });

    return { content: [{ type: "text" as const, text: formatJobAccepted(result) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool 8: get_account
// ---------------------------------------------------------------------------

server.tool(
  "get_account",
  "Get your account info: subscription plan, credit balance, usage stats, billing period, and API key details.",
  {},
  async () => {
    const result = await apiRequest({
      method: "GET",
      path: "/api/v1/me",
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool 9: create_studio_session
// ---------------------------------------------------------------------------

server.tool(
  "create_studio_session",
  "Create an embedded studio session for interactive mockup editing in a web page. Returns a 15-minute session token (sess_...) for iframe embedding; the token auto-extends on use. Authenticated with your API key.",
  {
    mockup_uuid: z.string().describe("UUID of the mockup to edit"),
    product_id: z.string().optional().describe("Optional platform product ID to associate with the session"),
  },
  async ({ mockup_uuid, product_id }) => {
    const body: Record<string, unknown> = { mockup_uuid };
    if (product_id) body.product_id = product_id;
    const result = await apiRequest({
      method: "POST",
      path: "/api/v1/studio/create-session",
      body,
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Webhook endpoints
//
// Manage outbound webhooks so your endpoint is notified when async jobs finish.
// Deliveries are signed with TWO headers: "X-SudoMock-Signature: <hex>" (the
// HMAC-SHA256 over `${timestamp}.${rawBody}` with the endpoint's secret) and
// "X-SudoMock-Timestamp: <unix-seconds>". Verify in constant time and reject if
// |now - timestamp| > 300s (User-Agent SudoMock-Webhook/1.0). The delivery body
// is {event, render_uuid, kind, status, result_url, error, created_at}.
//
// Event types: render.succeeded, render.failed, upload.succeeded,
// video.succeeded, video.failed, webhook.test.
// ---------------------------------------------------------------------------

const WEBHOOK_EVENT_TYPES = [
  "render.succeeded",
  "render.failed",
  "upload.succeeded",
  "video.succeeded",
  "video.failed",
  "webhook.test",
] as const;

server.tool(
  "create_webhook_endpoint",
  "Register a webhook endpoint that SudoMock calls when async jobs finish. The signing secret is returned IN FULL exactly once here -- store it to verify the HMAC carried in the X-SudoMock-Signature header (with X-SudoMock-Timestamp) on incoming deliveries. URL must be https and publicly routable.",
  {
    url: z.string().describe("https endpoint URL to receive POST deliveries (publicly routable; private/loopback hosts are rejected)"),
    event_types: z
      .array(z.enum(WEBHOOK_EVENT_TYPES))
      .default([])
      .describe("Event types to subscribe to (render.succeeded, render.failed, upload.succeeded, video.succeeded, video.failed, webhook.test). Pass an empty array (the default) to subscribe to ALL events."),
    description: z.string().max(255).optional().describe("Optional human-readable label for this endpoint"),
  },
  async ({ url, event_types, description }) => {
    const body: Record<string, unknown> = { url, event_types };
    if (description) body.description = description;

    const result = await apiRequest({
      method: "POST",
      path: "/api/v1/webhook-endpoints",
      body,
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "list_webhook_endpoints",
  "List your registered webhook endpoints (id, url, subscribed event_types, enabled state). Secrets are NOT returned here -- only at creation and rotation.",
  {},
  async () => {
    const result = await apiRequest({
      method: "GET",
      path: "/api/v1/webhook-endpoints",
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "update_webhook_endpoint",
  "Update a webhook endpoint in place: change its url, description, subscribed event_types, or enable/disable it (enabled:false pauses deliveries without losing the signing secret). All fields optional -- only the ones you pass are changed. The secret is NOT rotated or returned here.",
  {
    endpoint_id: z.string().describe("The id of the webhook endpoint to update (from list_webhook_endpoints)"),
    url: z.string().optional().describe("New https endpoint URL (publicly routable; private/loopback hosts are rejected)"),
    description: z.string().max(255).optional().describe("New human-readable label"),
    event_types: z
      .array(z.enum(WEBHOOK_EVENT_TYPES))
      .optional()
      .describe("Replacement list of subscribed event types. Pass an empty array to subscribe to ALL events."),
    enabled: z.boolean().optional().describe("Set false to pause deliveries (secret preserved), true to resume"),
  },
  async ({ endpoint_id, url, description, event_types, enabled }) => {
    const body: Record<string, unknown> = {};
    if (url !== undefined) body.url = url;
    if (description !== undefined) body.description = description;
    if (event_types !== undefined) body.event_types = event_types;
    if (enabled !== undefined) body.enabled = enabled;

    const result = await apiRequest({
      method: "PATCH",
      path: `/api/v1/webhook-endpoints/${endpoint_id}`,
      body,
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "delete_webhook_endpoint",
  "Permanently delete a webhook endpoint. SudoMock stops delivering to it. Cannot be undone.",
  {
    endpoint_id: z.string().describe("The id of the webhook endpoint to delete (from list_webhook_endpoints)"),
  },
  async ({ endpoint_id }) => {
    await apiRequest({
      method: "DELETE",
      path: `/api/v1/webhook-endpoints/${endpoint_id}`,
    });
    return { content: [{ type: "text" as const, text: `Webhook endpoint ${endpoint_id} deleted successfully.` }] };
  }
);

server.tool(
  "rotate_webhook_secret",
  "Rotate the signing secret for a webhook endpoint. A new secret is returned IN FULL exactly once -- update your verifier with it. The old secret stops being valid.",
  {
    endpoint_id: z.string().describe("The id of the webhook endpoint to rotate (from list_webhook_endpoints)"),
  },
  async ({ endpoint_id }) => {
    const result = await apiRequest({
      method: "POST",
      path: `/api/v1/webhook-endpoints/${endpoint_id}/rotate-secret`,
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "test_webhook_endpoint",
  "Send a synthetic webhook.test event through the real signed delivery path to verify your endpoint is reachable and your signature verification works. Returns the enqueued test job_uuid; check the result with list_webhook_deliveries.",
  {
    endpoint_id: z.string().describe("The id of the webhook endpoint to test (from list_webhook_endpoints)"),
  },
  async ({ endpoint_id }) => {
    const result = await apiRequest({
      method: "POST",
      path: `/api/v1/webhook-endpoints/${endpoint_id}/test`,
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "list_webhook_deliveries",
  "List delivery attempts for a webhook endpoint (status, event_type, response code, timestamps). Use this to debug failed deliveries before replaying them.",
  {
    endpoint_id: z.string().describe("The id of the webhook endpoint (from list_webhook_endpoints)"),
    status: z.string().optional().describe("Filter by delivery status (e.g. 'failed', 'succeeded')"),
    event_type: z.enum(WEBHOOK_EVENT_TYPES).optional().describe("Filter by event type"),
    limit: z.number().int().min(1).max(200).default(50).describe("Max deliveries to return (1-200, default 50)"),
  },
  async ({ endpoint_id, status, event_type, limit }) => {
    const result = await apiRequest({
      method: "GET",
      path: `/api/v1/webhook-endpoints/${endpoint_id}/deliveries`,
      params: { status, event_type, limit },
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "replay_webhook_delivery",
  "Re-enqueue a single webhook delivery with the SAME idempotency key (job_uuid:event_type), e.g. after fixing your endpoint. Get delivery_id from list_webhook_deliveries.",
  {
    endpoint_id: z.string().describe("The id of the webhook endpoint (from list_webhook_endpoints)"),
    delivery_id: z.string().describe("The id of the delivery to replay (from list_webhook_deliveries)"),
  },
  async ({ endpoint_id, delivery_id }) => {
    const result = await apiRequest({
      method: "POST",
      path: `/api/v1/webhook-endpoints/${endpoint_id}/deliveries/${delivery_id}/replay`,
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("SudoMock MCP server failed to start:", err);
  process.exit(1);
});
