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
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = "https://api.sudomock.com";
const DEFAULT_TIMEOUT = 30_000;
const RENDER_TIMEOUT = 120_000;
const USER_AGENT = "SudoMock-MCP/2.3.0 (stdio)";

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
  headers?: Record<string, string>;
  timeout?: number;
}

async function apiRequest({ method, path, params, body, headers: extraHeaders, timeout = DEFAULT_TIMEOUT }: RequestOptions): Promise<unknown> {
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
    ...extraHeaders,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    let resp: Response;
    try {
      resp = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch {
      throw new Error(
        controller.signal.aborted
          ? "SudoMock request timed out. Retry the request."
          : "Unable to reach SudoMock. Check your connection and retry."
      );
    }

    if (!resp.ok) {
      const errorMap: Record<number, string> = {
        401: `Invalid API key. Check your key at https://sudomock.com/dashboard/api-keys`,
        402: `Insufficient credits. Add credits and retry.`,
        403: `Access denied. Check that your API key can access this item.`,
        404: `Requested item was not found.`,
        409: `Request conflicts with the item's current state. Refresh it and retry.`,
        422: `Invalid parameters. Check the tool arguments and retry.`,
        429: `Rate limit exceeded. Wait and retry.`,
        500: `SudoMock server error. Try again in a moment.`,
      };

      throw new Error(errorMap[resp.status] ?? `SudoMock request failed (${resp.status}).`);
    }

    // 204 No Content
    if (resp.status === 204) {
      return { success: true };
    }

    try {
      return await resp.json();
    } catch {
      throw new Error("SudoMock returned an unreadable response. Try again.");
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Async job helpers
// ---------------------------------------------------------------------------

/**
 * A queued (202 Accepted) async submission carries a job_id + status_url.
 * Surface that contract plainly so an agent knows to poll instead of hunting
 * for a result_url that does not exist yet. Every async submit endpoint
 * (/renders, /psd/upload, /renders/video) returns `job_id` in its 202 body.
 */
export function formatJobAccepted(result: unknown): string {
  const r = (result ?? {}) as Record<string, unknown>;
  const jobId = r.job_id ?? null;
  const statusUrl = r.status_url ?? (jobId ? `/api/v1/jobs/${jobId}` : null);
  const summary = {
    accepted: true,
    job_id: jobId,
    kind: r.kind ?? null,
    status: r.status ?? "queued",
    status_url: statusUrl,
    next_step:
      "Poll get_job with this job_id, or call wait_for_job to block until it finishes.",
    raw: result,
  };
  return JSON.stringify(summary, null, 2);
}

export const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed"]);

/** GET /api/v1/jobs/{job_id} -- owner-scoped job status snapshot. */
async function getJob(jobId: string, timeout = DEFAULT_TIMEOUT): Promise<Record<string, unknown>> {
  const result = (await apiRequest({
    method: "GET",
    path: `/api/v1/jobs/${jobId}`,
    timeout,
  })) as Record<string, unknown>;
  return result;
}

/**
 * A job is done when its status is terminal. The poll response (GET
 * /api/v1/jobs/{job_id}) always reports the job state in the `status` field.
 */
export function isTerminalJob(job: Record<string, unknown>): boolean {
  const status = typeof job.status === "string" ? job.status : "";
  return TERMINAL_JOB_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "SudoMock",
  version: "2.3.0",
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

const smartObjectInputSchema = z
  .object({
    uuid: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      .describe("UUID of the smart object layer"),
    asset: z
      .object({
        url: z.string().optional().describe("Public URL or data URL of the artwork image"),
        base64: z.string().optional().describe("Raw base64-encoded artwork bytes without a data URL prefix"),
        content_type: z
          .enum(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"])
          .optional()
          .describe("MIME type for base64 artwork; defaults to image/png"),
        fit: z.enum(["fill", "contain", "cover"]).default("fill").describe("How artwork fills the smart object area"),
        size: z
          .object({
            width: z.number().int().min(1).optional().describe("Artwork width in pixels"),
            height: z.number().int().min(1).optional().describe("Artwork height in pixels"),
          })
          .optional()
          .describe("Optional custom artwork size"),
        position: z
          .object({
            top: z.number().int().optional().describe("Top offset in pixels"),
            left: z.number().int().optional().describe("Left offset in pixels"),
          })
          .optional()
          .describe("Optional custom artwork position"),
        rotate: z.number().min(-360).max(360).default(0).describe("Rotate artwork in degrees"),
        flip_horizontal: z.boolean().default(false).describe("Mirror artwork left-right"),
        flip_vertical: z.boolean().default(false).describe("Mirror artwork top-bottom"),
        remove_background: z
          .boolean()
          .optional()
          .describe("Remove the artwork's background before placing it. Adds 25 credits per artwork."),
      })
      .refine((asset) => asset.url || asset.base64, "Provide asset.url or asset.base64")
      .optional(),
    color: z
      .object({
        hex: z.string().regex(/^#[0-9a-fA-F]{6}$/).describe("Color overlay as a six-digit hex code"),
        blending_mode: z.string().default("normal").describe("Blend mode for the color overlay"),
      })
      .optional(),
    adjustment_layers: z
      .object({
        brightness: z.number().int().min(-150).max(150).default(0),
        contrast: z.number().int().min(-100).max(100).default(0),
        opacity: z.number().int().min(0).max(100).default(100),
        saturation: z.number().int().min(-100).max(100).default(0),
        vibrance: z.number().int().min(-100).max(100).default(0),
        blur: z.number().int().min(0).max(100).default(0),
      })
      .optional()
      .describe("Optional artwork adjustments"),
  })
  .refine((smartObject) => smartObject.asset || smartObject.color, "Provide asset or color");

const textLayerInputSchema = z
  .object({
    uuid: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      .describe("UUID from get_mockup_details text_layers"),
    text: z.string().min(1).max(500).optional().describe("Replacement text for a single-style layer"),
    segments: z
      .array(
        z.object({
          index: z.number().int().min(0).max(31).describe("Zero-based segment index"),
          text: z.string().min(1).max(200).describe("Replacement text for this segment"),
        })
      )
      .min(1)
      .max(32)
      .optional()
      .describe("Styled-segment replacements for a multi-style layer"),
    font: z.string().max(255).optional().describe("Font UUID or PostScript name for a single-style layer"),
    font_size: z.number().positive().max(2000).optional().describe("Font size in pixels at the mockup's native resolution"),
    color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional().describe("Text color as a six-digit hex code"),
    stroke_color: z
      .union([
        z.string().regex(/^#?[0-9a-fA-F]{6}$/),
        z.array(z.string().regex(/^#?[0-9a-fA-F]{6}$/).nullable()).min(1).max(8),
      ])
      .optional()
      .describe("One outline color, or up to eight front-to-back outline colors; null keeps an original color"),
    fit: z
      .enum(["shrink", "clip", "overflow"])
      .default("overflow")
      .describe("Long-text handling for single-style point text; default overflow"),
  })
  .superRefine((layer, ctx) => {
    if ((layer.text === undefined) === (layer.segments === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of text or segments",
      });
    }
    if (
      layer.segments &&
      (layer.font !== undefined ||
        layer.font_size !== undefined ||
        layer.color !== undefined ||
        layer.stroke_color !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "font, font_size, color, and stroke_color apply to single-style layers only",
      });
    }
    if (layer.segments && new Set(layer.segments.map((segment) => segment.index)).size !== layer.segments.length) {
      ctx.addIssue({ code: "custom", message: "Segment indexes must be unique" });
    }
  });

server.tool(
  "render_mockup",
  "Render a PSD mockup with artwork, editable text, or both. Supports one or multiple smart objects and preserves the template's authored appearance. Returns the rendered image URL. Costs 1 credit. Use list_mockups and get_mockup_details to find target UUIDs.",
  {
    mockup_uuid: z.string().describe("UUID of the mockup template (from list_mockups)"),
    smart_object_uuid: z.string().optional().describe("UUID of one smart object layer. Provide with artwork_url, or use smart_objects for one or more entries."),
    artwork_url: z.string().optional().describe("Public artwork URL for smart_object_uuid. Provide both singular fields, or use smart_objects."),
    smart_objects: z
      .array(smartObjectInputSchema)
      .min(1)
      .optional()
      .describe("One or more smart object overrides, each with asset or color. Do not combine with smart_object_uuid/artwork_url."),
    text_layers: z
      .array(textLayerInputSchema)
      .min(1)
      .max(50)
      .optional()
      .describe("Editable text overrides from get_mockup_details. Each entry needs exactly one of text or segments. May be used alone or with smart objects."),
    fit: z.enum(["fill", "contain", "cover"]).default("fill").describe("How singular artwork_url fills its smart object area"),
    image_format: z.enum(["webp", "png", "jpg"]).default("webp").describe("Output format"),
    image_size: z.number().min(100).max(10000).default(2048).describe("Output width in pixels (default 2048)"),
    quality: z.number().min(1).max(100).default(90).describe("Compression quality for webp/jpg (default 90)"),
    dpi: z.number().int().min(72).max(2400).optional().describe("Print resolution metadata (72-2400). Does not change pixel size -- use image_size. jpg/png recommended for widest print-tool compatibility."),
    rotate: z.number().min(-360).max(360).default(0).describe("Rotate artwork in degrees"),
    flip_horizontal: z.boolean().default(false).describe("Mirror artwork left-right"),
    flip_vertical: z.boolean().default(false).describe("Mirror artwork top-bottom"),
    remove_background: z.boolean().default(false).describe("Remove the artwork's background before placing it. Adds 25 credits per artwork."),
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
        "Queue the render instead of waiting for it. When true the API returns 202 with a job_id immediately (no result_url yet) -- poll with get_job, or call wait_for_job to block until it finishes. Use for long renders or when running many in parallel."
      ),
  },
  async (args) => {
    const hasSmartObjectUuid = args.smart_object_uuid !== undefined;
    const hasArtworkUrl = args.artwork_url !== undefined;
    if (hasSmartObjectUuid !== hasArtworkUrl) {
      throw new Error("Provide both smart_object_uuid and artwork_url, or use smart_objects.");
    }
    if (args.smart_objects && hasSmartObjectUuid) {
      throw new Error("Provide smart_objects or smart_object_uuid/artwork_url, not both.");
    }
    if (!args.smart_objects && !hasSmartObjectUuid && !args.text_layers) {
      throw new Error("Provide smart_objects, smart_object_uuid/artwork_url, or text_layers.");
    }

    const smartObjects: Array<Record<string, unknown>> = args.smart_objects
      ? [...args.smart_objects]
      : [];
    if (hasSmartObjectUuid && hasArtworkUrl) {
      const smartObject: Record<string, unknown> = {
        uuid: args.smart_object_uuid,
        asset: {
          url: args.artwork_url,
          fit: args.fit,
          rotate: args.rotate,
          flip_horizontal: args.flip_horizontal,
          flip_vertical: args.flip_vertical,
          ...(args.remove_background ? { remove_background: true } : {}),
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
      smartObjects.push(smartObject);
    }

    const body: Record<string, unknown> = {
      mockup_uuid: args.mockup_uuid,
      export_options: {
        image_format: args.image_format,
        image_size: args.image_size,
        quality: args.quality,
        ...(args.dpi !== undefined ? { dpi: args.dpi } : {}),
      },
    };
    if (smartObjects.length) body.smart_objects = smartObjects;
    if (args.text_layers) body.text_layers = args.text_layers;

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
// Tool: remove_background
// ---------------------------------------------------------------------------

server.tool(
  "remove_background",
  "Remove the background from any image and get a permanent transparent-PNG cutout URL with clean, production-ready edges. Use the returned URL as artwork_url in render tools -- clean once, reuse across renders. Costs 25 credits per image; credits are refunded automatically if processing fails.",
  {
    image_url: z.string().url().describe("Public URL of the image (PNG/JPG/WebP) to process"),
  },
  async ({ image_url }) => {
    const result = await apiRequest({
      method: "POST",
      path: "/api/v1/remove-background",
      body: { url: image_url },
      timeout: RENDER_TIMEOUT,
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: create_2d_mockup
// ---------------------------------------------------------------------------

server.tool(
  "create_2d_mockup",
  "Create a reusable 2D mockup from an image URL or base64 data. Detects printable surfaces automatically and returns the mockup ID and print-area geometry synchronously. Costs 25 credits. If the image is unsuitable, the 25 credits are refunded automatically. Set is_async=true to queue instead and receive a job_id to poll with get_job or wait_for_job. Use the dashboard for visual fine-tuning.",
  {
    source_url: z.string().optional().describe("Public HTTPS URL of the product image. Provide exactly one of source_url or source_base64."),
    source_base64: z.string().optional().describe("Raw base64-encoded JPEG, PNG, or WebP bytes. Provide exactly one of source_url or source_base64."),
    source_content_type: z.enum(["image/png", "image/jpeg", "image/webp"]).optional().describe("MIME type for source_base64"),
    name: z.string().optional().describe("Optional display name for the 2D mockup"),
    print_areas: z
      .array(
        z.object({
          points: z
            .array(z.tuple([z.number(), z.number()]))
            .length(4)
            .describe("Four [x, y] points in top-left, top-right, bottom-right, bottom-left order"),
          name: z.string().optional().describe("Optional display name for this print area"),
        })
      )
      .min(1)
      .max(8)
      .optional()
      .describe("Optional seed print areas (1-8 four-point quads). Omit to let printable surfaces be detected automatically."),
    is_async: z
      .boolean()
      .default(false)
      .describe(
        "Queue creation instead of waiting. When true the API returns 202 with a job_id immediately -- poll with get_job, or call wait_for_job to block until it finishes and returns the mockup. Default false returns the mockup synchronously (201)."
      ),
  },
  async ({ source_url, source_base64, source_content_type, name, print_areas, is_async }) => {
    const hasUrl = Boolean(source_url?.trim());
    const hasBase64 = Boolean(source_base64?.trim());
    if (hasUrl === hasBase64) {
      throw new Error("Provide exactly one of source_url or source_base64.");
    }
    if (source_content_type && !hasBase64) {
      throw new Error("source_content_type requires source_base64.");
    }

    const body: Record<string, unknown> = hasUrl
      ? { source_url: source_url!.trim() }
      : {
          source_base64: source_content_type
            ? `data:${source_content_type};base64,${source_base64!.trim()}`
            : source_base64!.trim(),
        };
    if (name) body.name = name;
    if (print_areas) body.print_areas = print_areas;
    if (is_async) body.is_async = true;

    const result = (await apiRequest({
      method: "POST",
      path: "/api/v1/sudoai/2d-mockups",
      body,
      headers: { "Idempotency-Key": randomUUID() },
    })) as Record<string, unknown>;

    // is_async=true -> 202 + job_id; hand back the poll contract.
    if (is_async) {
      return { content: [{ type: "text" as const, text: formatJobAccepted(result) }] };
    }

    // Default sync -> 201 {data, success}. Read the mockup directly, no poll.
    const details =
      result.data && typeof result.data === "object"
        ? (result.data as Record<string, unknown>)
        : result;
    const summary = {
      mockup_id: details.mockup_id ?? null,
      name: details.name ?? null,
      status: details.status ?? "ready",
      source_width: details.source_width ?? null,
      source_height: details.source_height ?? null,
      print_areas: Array.isArray(details.quads)
        ? details.quads
        : Array.isArray(details.print_areas)
          ? details.print_areas
          : [],
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool 6: render_2d_mockup
// ---------------------------------------------------------------------------

server.tool(
  "render_2d_mockup",
  "Render artwork onto a saved 2D mockup template. Returns print_files (each with an export_path) and a render_uuid. Costs 5 credits. Create a template with create_2d_mockup or choose one with list_2d_mockups, then use get_2d_mockup to choose a print area. Use the dashboard for visual fine-tuning.",
  {
    mockup_uuid: z.string().describe("UUID of the 2D mockup template (from list_2d_mockups, returned as mockup_id)."),
    print_area_uuid: z.string().describe("UUID of the print area to render into (from get_2d_mockup, returned as print_areas[].print_area_id)."),
    artwork_url: z.string().describe("Public URL of the artwork image (PNG/JPG/WebP) to place on the mockup"),
    remove_background: z.boolean().default(false).describe("Remove the artwork's background before placing it. Adds 25 credits per artwork."),
    blend_mode: z.string().default("multiply").describe("Blend mode for artwork over the product surface: 'multiply' (fabric texture, default) or 'normal' (no texture). Free-form string -- other Photoshop blend modes the API supports are accepted too."),
    opacity: z.number().min(0).max(100).default(100).describe("Artwork opacity percentage (0-100)"),
    brightness: z.number().min(-150).max(150).default(0).describe("Brightness adjustment (-150 to 150)"),
    contrast: z.number().min(-100).max(100).default(0).describe("Contrast adjustment (-100 to 100)"),
    saturation: z.number().min(-100).max(100).default(0).describe("Saturation adjustment (-100 to 100)"),
    warp_strength: z.number().min(0).max(2).default(1.5).describe("Warp strength for fabric curvature (0.0-2.0, 0=disabled, default 1.5). Higher = artwork conforms more closely to the surface."),
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
    is_async: z
      .boolean()
      .default(false)
      .describe(
        "Queue the render instead of waiting. When true the API returns 202 with a job_id immediately -- poll with get_job, or call wait_for_job to block until it finishes and hands back result_url. Default false returns print_files + render_uuid synchronously (200). Use for long renders or when running many in parallel."
      ),
  },
  async (args) => {
    const body: Record<string, unknown> = {
      print_areas: [
        {
          uuid: args.print_area_uuid,
          artwork_url: args.artwork_url,
          ...(args.remove_background ? { remove_background: true } : {}),
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

    if (args.is_async) body.is_async = true;

    const result = await apiRequest({
      method: "POST",
      path: `/api/v1/sudoai/2d-mockups/${args.mockup_uuid}/render`,
      body,
      timeout: RENDER_TIMEOUT,
    });

    // is_async=true -> 202 + job_id (kind "2d_render"); hand back the poll contract.
    // Reuse get_job / wait_for_job to reach the terminal job (result_url).
    if (args.is_async) {
      return { content: [{ type: "text" as const, text: formatJobAccepted(result) }] };
    }

    // Default sync -> 200 {data, success}.
    // Whitelist the render output to WHAT-only fields; never surface pipeline internals.
    const renderData =
      (result as { data?: { render_uuid?: string; print_files?: Array<Record<string, unknown>> } })?.data ?? {};
    const rendered = {
      data: {
        render_uuid: renderData.render_uuid,
        print_files: (renderData.print_files ?? []).map((f) => ({
          export_path: f.export_path,
          export_format: f.export_format,
          duration_ms: f.duration_ms,
        })),
      },
      success: true,
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(rendered, null, 2) }] };
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
  "Get one SudoAI 2D mockup's full details: status, thumbnail, source dimensions, and print_areas[] (each with print_area_id). Use a print_areas[].print_area_id as the print_area_uuid for render_2d_mockup. Costs 0 credits.",
  {
    mockup_id: z.string().describe("UUID of the 2D mockup (mockup_id from list_2d_mockups)"),
  },
  async ({ mockup_id }) => {
    const result = (await apiRequest({
      method: "GET",
      path: `/api/v1/sudoai/2d-mockups/${mockup_id}`,
    })) as Record<string, unknown>;
    const details =
      result.data && typeof result.data === "object"
        ? (result.data as Record<string, unknown>)
        : result;
    const { quads, ...rest } = details;
    const normalized = {
      ...rest,
      print_areas: Array.isArray(quads)
        ? quads
        : Array.isArray(rest.print_areas)
          ? rest.print_areas
          : [],
    };
    const output = details === result ? normalized : { ...result, data: normalized };
    return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: update_2d_print_areas
// ---------------------------------------------------------------------------

server.tool(
  "update_2d_print_areas",
  "Replace a 2D mockup's print areas with 1 to 8 four-point quads and return the updated geometry. Costs 0 credits. Use the dashboard for visual fine-tuning.",
  {
    mockup_id: z.string().describe("UUID of the 2D mockup to update"),
    print_areas: z
      .array(
        z.object({
          points: z
            .array(z.tuple([z.number(), z.number()]))
            .length(4)
            .describe("Four [x, y] points in top-left, top-right, bottom-right, bottom-left order"),
          name: z.string().optional().describe("Optional display name for this print area"),
        })
      )
      .min(1)
      .max(8)
      .describe("Replacement print areas (1-8 four-point quads, each with an optional name)"),
  },
  async ({ mockup_id, print_areas }) => {
    const result = await apiRequest({
      method: "PUT",
      path: `/api/v1/sudoai/2d-mockups/${mockup_id}/print-areas`,
      body: { print_areas },
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: delete_2d_mockup
// ---------------------------------------------------------------------------

server.tool(
  "delete_2d_mockup",
  "Permanently delete a SudoAI 2D mockup template and all of its data. Cannot be undone. Costs 0 credits.",
  {
    mockup_id: z.string().describe("UUID of the 2D mockup to delete (mockup_id from list_2d_mockups)"),
  },
  async ({ mockup_id }) => {
    const result = await apiRequest({
      method: "DELETE",
      path: `/api/v1/sudoai/2d-mockups/${mockup_id}`,
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
        "Queue the upload instead of blocking. When true the API returns 202 with a job_id immediately -- poll with get_job (or wait_for_job) to learn when processing finishes and get the new mockup_uuid. Always free (0 credits), sync or async."
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
  "Get the current status of any async render, video, upload, or 2D job by its job_id. Returns status (queued|running|succeeded|failed), completed-result details and credits charged, or an error if failed. To block until done, use wait_for_job instead.",
  {
    job_id: z.string().describe("The job_id returned by any async submission"),
  },
  async ({ job_id }) => {
    const result = await getJob(job_id);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: list_jobs
// ---------------------------------------------------------------------------

server.tool(
  "list_jobs",
  "List your async jobs, including PSD renders, videos, uploads, and 2D creation/renders, newest first. Use this when you do not already hold a job_id. Pass the returned next_cursor to fetch the next page.",
  {
    kind: z.enum(["video", "render", "upload", "2d_create", "2d_render"]).optional().describe("Filter by job kind. Omit for all kinds."),
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
  "Poll any async render, video, upload, or 2D job until it succeeds or fails, then return the final result and credits charged. Blocks while polling.",
  {
    job_id: z.string().describe("The job_id to wait on (from an async submission or render_video)"),
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
  async ({ job_id, poll_interval_seconds, timeout_seconds }) => {
    const deadline = Date.now() + timeout_seconds * 1000;
    let job = await getJob(job_id);

    while (!isTerminalJob(job)) {
      if (Date.now() >= deadline) {
        const timedOut = {
          timed_out: true,
          job_id,
          waited_seconds: timeout_seconds,
          last_status: job.status ?? "unknown",
          message:
            "Job did not reach a terminal state within timeout_seconds. It may still be running -- call get_job later to check.",
          last_job: job,
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(timedOut, null, 2) }] };
      }
      await new Promise((resolve) => setTimeout(resolve, poll_interval_seconds * 1000));
      job = await getJob(job_id);
    }

    return { content: [{ type: "text" as const, text: JSON.stringify(job, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool: render_video
// ---------------------------------------------------------------------------

server.tool(
  "render_video",
  "Create a short AI video from either a mockup with artwork or a public image URL. Supply exactly one input mode. Always async: returns a job_id immediately for get_job or wait_for_job. Credit cost depends on clip length, audio, and the selected quality option. Supported durations vary by quality option; unsupported values are rejected.",
  {
    mockup_uuid: z.string().optional().describe("RENDER MODE: UUID of the mockup to animate (from list_mockups or upload_psd). Required in render mode. In raw-image mode it is an optional association (groups the clip under that mockup's 'Past clips')."),
    smart_object_uuid: z.string().optional().describe("RENDER MODE: UUID of the smart object layer to place artwork on (from get_mockup_details). Required in render mode; omit in raw-image mode."),
    artwork_url: z.string().optional().describe("RENDER MODE: public URL of the artwork image (PNG/JPG/WebP) to place on the mockup before animating. Provide this OR artwork_base64. Omit in raw-image mode."),
    artwork_base64: z.string().optional().describe("RENDER MODE: raw base64-encoded artwork bytes (no data: prefix). Provide this OR artwork_url."),
    artwork_content_type: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]).optional().describe("MIME type for artwork_base64 (defaults to image/png if omitted)."),
    image_url: z.string().optional().describe("RAW-IMAGE MODE: a public https png/jpg URL to animate without a mockup. Supply this OR (mockup_uuid + smart_object_uuid + artwork), never both."),
    fit: z.enum(["fill", "contain", "cover"]).default("fill").describe("RENDER MODE: how artwork fills the smart object area in the still frame"),
    asset_width: z.number().int().min(1).optional().describe("RENDER MODE: custom artwork width in pixels (overrides fit sizing)."),
    asset_height: z.number().int().min(1).optional().describe("RENDER MODE: custom artwork height in pixels (overrides fit sizing)."),
    asset_top: z.number().int().optional().describe("RENDER MODE: artwork top offset in pixels within the smart object area."),
    asset_left: z.number().int().optional().describe("RENDER MODE: artwork left offset in pixels within the smart object area."),
    duration_seconds: z
      .number()
      .int()
      .min(1)
      .max(15)
      .default(5)
      .describe("Clip length in seconds. Available durations depend on the selected quality option; unsupported values are rejected. The 1-15 range is broad validation, not a guarantee of support. Longer clips cost more credits."),
    audio: z
      .boolean()
      .default(false)
      .describe("Generate audio. Default off; enabling it may cost more credits depending on the selected quality option."),
    motion: z
      .enum(["ambient", "showcase"])
      .default("ambient")
      .describe("'ambient' = subtle looping hero motion that keeps the print readable; 'showcase' = one deliberate camera/product move."),
    advanced_model: z
      .string()
      .optional()
      .describe("Optional advanced quality profile identifier. Unknown or unavailable identifiers are rejected. Omit for automatic selection (recommended)."),
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
      export_options: {
        image_format: args.image_format,
        image_size: args.image_size,
        quality: args.quality,
      },
      video,
    };

    if (args.image_url) {
      // RAW-IMAGE mode: animate the URL directly (no render). mockup_uuid, when
      // present, is an optional association only -- the API ignores it as a render
      // input. The two render-vs-raw modes are mutually exclusive (BE enforces XOR).
      body.image_url = args.image_url;
      if (args.mockup_uuid) body.mockup_uuid = args.mockup_uuid;
    } else {
      // RENDER mode: build the i2v input still from the mockup + artwork.
      const asset: Record<string, unknown> = { fit: args.fit };
      if (args.artwork_url) asset.url = args.artwork_url;
      if (args.artwork_base64) {
        asset.base64 = args.artwork_base64;
        if (args.artwork_content_type) asset.content_type = args.artwork_content_type;
      }
      if (args.asset_width !== undefined || args.asset_height !== undefined) {
        asset.size = { width: args.asset_width, height: args.asset_height };
      }
      if (args.asset_top !== undefined || args.asset_left !== undefined) {
        asset.position = { top: args.asset_top, left: args.asset_left };
      }
      body.mockup_uuid = args.mockup_uuid;
      body.smart_objects = [{ uuid: args.smart_object_uuid, asset }];
    }

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
  "Create an embedded studio session for interactive PSD or 2D mockup editing in a web page. Returns session details for opening the editor. Authenticated with your API key.",
  {
    mockup_uuid: z.string().optional().describe("UUID of an existing mockup. Optional for 2D setup and full-session flows."),
    mockup_type: z.enum(["psd", "2d"]).default("psd").describe("Mockup type. PSD sessions support customize; 2D sessions support customize, setup, and full flows."),
    session_kind: z
      .enum(["customize", "2d-setup", "2d-full"])
      .default("customize")
      .describe("Session purpose. customize requires an existing mockup; 2d-setup and 2d-full may start without one."),
    product_id: z.string().optional().describe("Platform product ID. Required for 2d-full sessions."),
    allowed_origin: z.string().optional().describe("Web page origin allowed to open a 2D session. Required for 2D API-key sessions."),
  },
  async ({ mockup_uuid, mockup_type, session_kind, product_id, allowed_origin }) => {
    const body: Record<string, unknown> = { mockup_type, session_kind };
    if (mockup_uuid) body.mockup_uuid = mockup_uuid;
    if (product_id) body.product_id = product_id;
    if (allowed_origin) body.allowed_origin = allowed_origin;
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
// is {event, job_id, kind, status, result_url, error, created_at}.
//
// Event types: render.succeeded, render.failed, upload.succeeded,
// video.succeeded, video.failed, 2d_mockup.ready, 2d_mockup.rejected,
// 2d_mockup.failed, 2d_render.succeeded, 2d_render.failed, webhook.test.
// ---------------------------------------------------------------------------

const WEBHOOK_EVENT_TYPES = [
  "render.succeeded",
  "render.failed",
  "upload.succeeded",
  "video.succeeded",
  "video.failed",
  "2d_mockup.ready",
  "2d_mockup.rejected",
  "2d_mockup.failed",
  "2d_render.succeeded",
  "2d_render.failed",
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
      .describe("Event types to subscribe to. Supports render, upload, video, 2D mockup, 2D render, and webhook.test events. Pass an empty array (the default) to subscribe to ALL events."),
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
  "Send a signed webhook.test event to verify endpoint reachability and signature handling. Returns a test job_id; check the result with list_webhook_deliveries.",
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
  "Replay a single webhook delivery while preserving its event identity, e.g. after fixing your endpoint. Get delivery_id from list_webhook_deliveries.",
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

// Only start the stdio transport when this file is executed directly (the bin
// entrypoint). When imported (e.g. by the test suite) we expose `server` without
// connecting, so tests can introspect it over an in-memory transport.
const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch(() => {
    console.error("SudoMock MCP server failed to start. Check configuration and retry.");
    process.exit(1);
  });
}

export { server };
