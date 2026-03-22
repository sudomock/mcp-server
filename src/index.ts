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
const USER_AGENT = "SudoMock-MCP/1.0 (stdio)";

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
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "SudoMock",
  version: "1.0.0",
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
    sort_by: z.enum(["created_at", "name"]).default("created_at").describe("Sort field"),
    sort_order: z.enum(["asc", "desc"]).default("desc").describe("Sort direction"),
  },
  async ({ limit, offset, name, sort_by, sort_order }) => {
    const result = await apiRequest({
      method: "GET",
      path: "/api/v1/mockups",
      params: { limit, offset, name, sort_by, sort_order },
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
    image_size: z.number().min(100).max(10000).default(1920).describe("Output width in pixels"),
    quality: z.number().min(1).max(100).default(95).describe("Compression quality for webp/jpg"),
    rotate: z.number().min(-360).max(360).default(0).describe("Rotate artwork in degrees"),
    flip_horizontal: z.boolean().default(false).describe("Mirror artwork left-right"),
    flip_vertical: z.boolean().default(false).describe("Mirror artwork top-bottom"),
    color_hex: z.string().optional().describe("Optional color overlay hex code (e.g. '#FF5733')"),
    color_blend_mode: z.string().optional().describe("Blend mode for color overlay (e.g. 'multiply', 'screen', 'overlay')"),
    brightness: z.number().min(-150).max(150).default(0).describe("Brightness adjustment"),
    contrast: z.number().min(-100).max(100).default(0).describe("Contrast adjustment"),
    opacity: z.number().min(0).max(100).default(100).describe("Layer opacity percentage"),
    saturation: z.number().min(-100).max(100).default(0).describe("Saturation adjustment"),
    export_label: z.string().optional().describe("Optional label for file naming"),
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

    if (args.brightness || args.contrast || args.opacity !== 100 || args.saturation) {
      smartObject.adjustment_layers = {
        brightness: args.brightness,
        contrast: args.contrast,
        opacity: args.opacity,
        saturation: args.saturation,
      };
    }

    const body: Record<string, unknown> = {
      mockup_uuid: args.mockup_uuid,
      smart_objects: [smartObject],
      export_options: {
        image_format: args.image_format,
        image_size: args.image_size,
        quality: args.quality,
      },
    };

    if (args.export_label) {
      body.export_label = args.export_label;
    }

    const result = await apiRequest({
      method: "POST",
      path: "/api/v1/renders",
      body,
      timeout: RENDER_TIMEOUT,
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Tool 6: ai_render
// ---------------------------------------------------------------------------

server.tool(
  "ai_render",
  "AI-powered mockup render without needing a PSD template. Upload any product photo + artwork, AI detects the printable surface and renders with perspective correction. Costs 5 credits.",
  {
    source_url: z.string().describe("Public URL of the product photo (e.g. a plain t-shirt photo)"),
    artwork_url: z.string().describe("Public URL of the artwork/design to place on the product"),
    product_type: z.string().optional().describe("Optional product category hint (e.g. 'tshirt', 'hoodie', 'mug')"),
    segment_index: z.number().optional().describe("Optional specific segment index (0-based) if the product has multiple printable areas"),
    image_format: z.enum(["webp", "png"]).default("webp").describe("Output format"),
    quality: z.number().min(1).max(100).default(95).describe("Compression quality"),
  },
  async ({ source_url, artwork_url, product_type, segment_index, image_format, quality }) => {
    const body: Record<string, unknown> = {
      source_url,
      artwork_url,
      export_options: { image_format, quality },
    };
    if (product_type) body.product_type = product_type;
    if (segment_index !== undefined) body.segment_index = segment_index;

    const result = await apiRequest({
      method: "POST",
      path: "/api/v1/sudoai/render",
      body,
      timeout: RENDER_TIMEOUT,
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
    psd_file_url: z.string().describe("Public URL to a .psd or .psb file (max 500MB)"),
    psd_name: z.string().optional().describe("Display name for the template (auto-generated from filename if omitted)"),
  },
  async ({ psd_file_url, psd_name }) => {
    const body: Record<string, unknown> = { psd_file_url };
    if (psd_name) body.psd_name = psd_name;

    const result = await apiRequest({
      method: "POST",
      path: "/api/v1/psd/upload",
      body,
      timeout: RENDER_TIMEOUT,
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
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
  "Create an embedded studio session for interactive mockup editing in a web page. Returns a 15-minute session token for iframe embedding.",
  {
    mockup_uuid: z.string().describe("UUID of the mockup to edit"),
    smart_object_uuid: z.string().describe("UUID of the smart object to customize"),
  },
  async ({ mockup_uuid, smart_object_uuid }) => {
    const result = await apiRequest({
      method: "POST",
      path: "/api/v1/studio/create-session",
      body: { mockup_uuid, smart_object_uuid },
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
