/**
 * Basic test suite for the SudoMock MCP server.
 *
 * Covers:
 *   - tool list (the server registers the expected tools, introspected over an
 *     in-memory MCP transport),
 *   - a happy-path tool-call shape (the async 202 envelope produced by
 *     formatJobAccepted, which is exactly what the async render/upload/video tools
 *     return as text), and
 *   - terminal-job detection (isTerminalJob over the `status` field).
 *
 * Runs on Node's built-in test runner (`node --test`) -- no extra dependencies.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  server,
  formatJobAccepted,
  isTerminalJob,
  TERMINAL_JOB_STATUSES,
} from "../src/index.js";

/** Connect a fresh in-memory client to the server and return both for the test. */
async function connectClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

const EXPECTED_TOOLS = [
  "list_mockups",
  "get_mockup_details",
  "update_mockup",
  "delete_mockup",
  "create_2d_mockup",
  "render_mockup",
  "remove_background",
  "render_2d_surface",
  "render_2d_print_area",
  "list_2d_mockups",
  "get_2d_mockup",
  "update_2d_print_areas",
  "delete_2d_mockup",
  "upload_psd",
  "get_job",
  "list_jobs",
  "wait_for_job",
  "render_video",
  "get_account",
  "create_webhook_endpoint",
  "list_webhook_endpoints",
  "update_webhook_endpoint",
  "delete_webhook_endpoint",
  "rotate_webhook_secret",
  "test_webhook_endpoint",
  "list_webhook_deliveries",
  "replay_webhook_delivery",
];

test("registers every expected tool with a description + object input schema", async () => {
  const client = await connectClient();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    for (const expected of EXPECTED_TOOLS) {
      assert.ok(names.includes(expected), `missing tool: ${expected}`);
    }
    assert.ok(!names.includes("create_studio_session"));

    for (const tool of tools) {
      assert.equal(typeof tool.description, "string", `${tool.name} has no description`);
      assert.ok((tool.description ?? "").length > 0, `${tool.name} description is empty`);
      assert.equal(tool.inputSchema.type, "object", `${tool.name} input schema is not an object`);
    }

    const create2D = tools.find((tool) => tool.name === "create_2d_mockup");
    const create2DProps = create2D?.inputSchema.properties ?? {};
    assert.ok("idempotency_key" in create2DProps);
    assert.ok(!("source_base64" in create2DProps));
    assert.ok(!("source_content_type" in create2DProps));
    assert.ok(!("print_areas" in create2DProps));
  } finally {
    await client.close();
    await server.close();
  }
});

test("render_video exposes raw-image mode + asset base64 + asset size/position", async () => {
  const client = await connectClient();
  try {
    const { tools } = await client.listTools();
    const video = tools.find((t) => t.name === "render_video");
    assert.ok(video, "render_video tool not found");

    const props = (video!.inputSchema.properties ?? {}) as Record<string, unknown>;
    for (const key of [
      "image_url",
      "artwork_base64",
      "artwork_content_type",
      "asset_width",
      "asset_height",
      "asset_top",
      "asset_left",
    ]) {
      assert.ok(key in props, `render_video missing param: ${key}`);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("exposes the deployed render, Studio, webhook, and job contracts", async () => {
  type Schema = {
    default?: unknown;
    enum?: string[];
    items?: Schema;
    properties?: Record<string, Schema>;
    required?: string[];
  };

  const client = await connectClient();
  try {
    const { tools } = await client.listTools();
    const schema = (name: string) => {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} tool not found`);
      return tool.inputSchema as Schema;
    };

    const render = schema("render_mockup");
    const renderProps = render.properties ?? {};
    assert.ok("smart_objects" in renderProps);
    assert.ok("text_layers" in renderProps);
    assert.ok(!("group_layers" in renderProps));
    assert.equal(renderProps.text_layers.items?.properties?.fit.default, "overflow");
    assert.deepEqual(render.required, ["mockup_uuid"]);

    const webhook = schema("create_webhook_endpoint");
    assert.deepEqual(webhook.properties?.event_types.items?.enum, [
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
    ]);

    const jobs = schema("list_jobs");
    assert.deepEqual(jobs.properties?.kind.enum, [
      "video",
      "render",
      "upload",
      "2d_create",
      "2d_render",
    ]);
    for (const name of ["render_2d_surface", "render_2d_print_area"]) {
      assert.ok(!("blend_mode" in (schema(name).properties ?? {})));
    }
    // The RELATIVE dials do not cross, and only those. A surface is sized
    // relative to itself by a percentage, a print area relative to its bounds
    // by a fit, and neither reads on the other -- which is the whole reason
    // there are two tools.
    //
    // An exact box in pixels is not relative to anything, so it belongs to
    // both. It used to be listed here as print-area-only; the shared placement
    // wire fixture accepts `surface_explicit_box` and says why: a percentage
    // cannot express a box whose proportions differ from the surface, and
    // refusing it made every all-over print somebody had resized on a canvas
    // unsendable. See test/placement-wire.test.ts, which reads that fixture.
    const surfaceProps = schema("render_2d_surface").properties ?? {};
    const areaProps = schema("render_2d_print_area").properties ?? {};
    assert.ok("coverage" in surfaceProps);
    for (const absent of ["fit", "print_area_uuid"]) {
      assert.ok(!(absent in surfaceProps), `render_2d_surface offers ${absent}`);
    }
    for (const present of ["fit", "width", "height"]) {
      assert.ok(present in areaProps, `render_2d_print_area is missing ${present}`);
    }
    for (const present of ["width", "height"]) {
      assert.ok(present in surfaceProps, `render_2d_surface is missing ${present}`);
    }
    for (const absent of ["coverage", "surface_uuid"]) {
      assert.ok(!(absent in areaProps), `render_2d_print_area offers ${absent}`);
    }
    // Anchoring is shared and, like sizing, carries no client-side default:
    // an option the caller never names must not reach the wire.
    for (const props of [surfaceProps, areaProps]) {
      for (const anchor of ["position", "offset_x", "offset_y", "rotation"]) {
        assert.ok(anchor in props, `a render tool is missing ${anchor}`);
        assert.equal(props[anchor].default, undefined, `${anchor} carries a client-side default`);
      }
    }
    const video = schema("render_video");
    assert.ok(!("advanced_model" in (video.properties ?? {})));

    const publicToolCopy = JSON.stringify(tools).toLowerCase();
    for (const forbidden of [
      "veo",
      "kling",
      "seedance",
      "birefnet",
      "fal.ai",
      "ideogram",
      "server-side download",
      "auto-router",
      "cdn url",
      "mask_uuid",
      "region_index",
      "segmentation",
      "displacement",
      "shading",
      "advanced_model",
    ]) {
      assert.ok(!publicToolCopy.includes(forbidden), `public tool copy contains ${forbidden}`);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("render tools pass the new inputs without adding group_layers", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.SUDOMOCK_API_KEY;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return Response.json({ success: true });
  };
  process.env.SUDOMOCK_API_KEY = "sm_test";

  const client = await connectClient();
  try {
    await client.callTool({
      name: "render_mockup",
      arguments: {
        mockup_uuid: "123e4567-e89b-12d3-a456-426614174000",
        smart_objects: [
          {
            uuid: "223e4567-e89b-12d3-a456-426614174001",
            asset: { url: "https://example.com/front.png" },
          },
          {
            uuid: "323e4567-e89b-12d3-a456-426614174002",
            color: { hex: "#112233" },
          },
        ],
        text_layers: [
          {
            uuid: "423e4567-e89b-12d3-a456-426614174003",
            text: "New headline",
          },
        ],
      },
    });
    await client.callTool({
      name: "render_mockup",
      arguments: {
        mockup_uuid: "123e4567-e89b-12d3-a456-426614174000",
        text_layers: [
          {
            uuid: "423e4567-e89b-12d3-a456-426614174003",
            segments: [{ index: 1, text: "Styled replacement" }],
          },
        ],
      },
    });
    await client.callTool({
      name: "render_mockup",
      arguments: {
        mockup_uuid: "123e4567-e89b-12d3-a456-426614174000",
        smart_object_uuid: "223e4567-e89b-12d3-a456-426614174001",
        artwork_url: "https://example.com/legacy.png",
      },
    });
    const firstRender = requests[0].body;
    assert.equal((firstRender.smart_objects as unknown[]).length, 2);
    assert.equal((firstRender.text_layers as Array<{ fit: string }>)[0].fit, "overflow");
    assert.ok(!("group_layers" in firstRender));

    const textOnlyRender = requests[1].body;
    assert.ok(!("smart_objects" in textOnlyRender));
    assert.deepEqual(
      (textOnlyRender.text_layers as Array<{ segments: unknown[] }>)[0].segments,
      [{ index: 1, text: "Styled replacement" }]
    );

    const legacyRender = requests[2].body;
    assert.equal((legacyRender.smart_objects as Array<{ uuid: string }>)[0].uuid, "223e4567-e89b-12d3-a456-426614174001");

  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.SUDOMOCK_API_KEY;
    else process.env.SUDOMOCK_API_KEY = originalApiKey;
  }
});

test("render_mockup returns only public output fields and safe warnings", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.SUDOMOCK_API_KEY;

  globalThis.fetch = async () =>
    Response.json({
      success: true,
      data: {
        print_files: [
          {
            export_path: "https://cdn.sudomock.com/render.webp",
            smart_object_uuid: "223e4567-e89b-12d3-a456-426614174001",
            render_uuid: "render-123",
            private_storage_key: "renders/private.webp",
          },
        ],
        render_uuid: "render-123",
        text_layers: [{ resolved_font: { postscript_name: "PrivateFont" } }],
        model: "private-engine",
      },
      warnings: [
        {
          code: "MODEL_PROMPT_FALLBACK",
          message: "Private model prompt failed for mask_uuid.",
          debug: "private",
        },
      ],
    });
  process.env.SUDOMOCK_API_KEY = "sm_test";

  const client = await connectClient();
  try {
    const result = await client.callTool({
      name: "render_mockup",
      arguments: {
        mockup_uuid: "123e4567-e89b-12d3-a456-426614174000",
        smart_object_uuid: "223e4567-e89b-12d3-a456-426614174001",
        artwork_url: "https://example.com/artwork.png",
      },
    });
    const output = JSON.parse(
      (result.content as Array<{ type: "text"; text: string }>)[0].text
    );

    assert.deepEqual(output, {
      success: true,
      data: {
        print_files: [
          {
            export_path: "https://cdn.sudomock.com/render.webp",
            smart_object_uuid: "223e4567-e89b-12d3-a456-426614174001",
            render_uuid: "render-123",
          },
        ],
        render_uuid: "render-123",
      },
      warnings: [
        {
          code: "PROCESSING_FAILED",
          message: "The render completed with an advisory.",
        },
      ],
    });
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.SUDOMOCK_API_KEY;
    else process.env.SUDOMOCK_API_KEY = originalApiKey;
  }
});

test("read tools project undocumented backend fields out of public results", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.SUDOMOCK_API_KEY;
  const mockup = {
    uuid: "mockup-123",
    name: "Template",
    thumbnail: "https://cdn.sudomock.com/thumb.webp",
    width: 1200,
    height: 900,
    smart_objects: [
      {
        uuid: "smart-1",
        name: "Front",
        size: { width: 800, height: 600 },
        position: { x: 0, y: 0, width: 800, height: 600 },
        print_area_presets: [],
        mask_uuid: "private-surface",
      },
    ],
    text_layers: [],
    thumbnails: [],
    model: "private-engine",
  };

  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/mockups") {
      return Response.json({
        success: true,
        data: { mockups: [mockup], total: 1, limit: 20, offset: 0 },
      });
    }
    if (path === "/api/v1/mockups/mockup-123") {
      return Response.json({ success: true, data: mockup });
    }
    if (path === "/api/v1/remove-background") {
      return Response.json({
        success: true,
        data: {
          url: "https://cdn.sudomock.com/cutout.png",
          width: 100,
          height: 200,
          credits_charged: 25,
          private_storage_key: "cutouts/private.png",
        },
      });
    }
    if (path === "/api/v1/me") {
      return Response.json({
        success: true,
        data: {
          account: {
            uuid: "account-1",
            email: "test@example.com",
            name: "Test",
            created_at: "2026-07-26T00:00:00Z",
            private_state: "internal",
          },
          subscription: {
            plan: "pro",
            tier: "pro",
            status: "active",
            cancel_at_period_end: false,
          },
          usage: {
            credits_used_this_month: 1,
            credits_limit: 100,
            credits_remaining: 99,
          },
          api_key: { name: "Production", total_requests: 3 },
        },
      });
    }
    if (path === "/api/v1/webhook-endpoints") {
      return Response.json([
        {
          id: "endpoint-1",
          url: "https://example.com/hook",
          event_types: ["render.succeeded"],
          enabled: true,
          private_endpoint_state: "internal",
        },
      ]);
    }
    throw new Error(`unexpected path: ${path}`);
  };
  process.env.SUDOMOCK_API_KEY = "sm_test";

  const client = await connectClient();
  try {
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return JSON.parse(
        (result.content as Array<{ type: "text"; text: string }>)[0].text
      );
    };

    const list = await call("list_mockups");
    assert.equal(list.data.mockups[0].uuid, "mockup-123");
    assert.ok(!("model" in list.data.mockups[0]));
    assert.ok(!("mask_uuid" in list.data.mockups[0].smart_objects[0]));

    const detail = await call("get_mockup_details", {
      mockup_uuid: "mockup-123",
    });
    assert.ok(!("model" in detail.data));

    const cutout = await call("remove_background", {
      image_url: "https://example.com/photo.jpg",
    });
    assert.ok(!("private_storage_key" in cutout.data));

    const account = await call("get_account");
    assert.ok(!("private_state" in account.data.account));

    const endpoints = await call("list_webhook_endpoints");
    assert.ok(!("private_endpoint_state" in endpoints[0]));
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.SUDOMOCK_API_KEY;
    else process.env.SUDOMOCK_API_KEY = originalApiKey;
  }
});

test("background removal: standalone tool + opt-in flag at the right body level", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.SUDOMOCK_API_KEY;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return Response.json({ success: true });
  };
  process.env.SUDOMOCK_API_KEY = "sm_test";

  const client = await connectClient();
  try {
    await client.callTool({
      name: "remove_background",
      arguments: { image_url: "https://example.com/photo.jpg" },
    });
    await client.callTool({
      name: "render_mockup",
      arguments: {
        mockup_uuid: "123e4567-e89b-12d3-a456-426614174000",
        smart_object_uuid: "223e4567-e89b-12d3-a456-426614174001",
        artwork_url: "https://example.com/photo.jpg",
        remove_background: true,
      },
    });
    await client.callTool({
      name: "render_mockup",
      arguments: {
        mockup_uuid: "123e4567-e89b-12d3-a456-426614174000",
        smart_object_uuid: "223e4567-e89b-12d3-a456-426614174001",
        artwork_url: "https://example.com/photo.jpg",
      },
    });
    await client.callTool({
      name: "render_2d_print_area",
      arguments: {
        mockup_uuid: "mockup-123",
        print_area_uuid: "area-1",
        artwork_url: "https://example.com/photo.jpg",
        remove_background: true,
      },
    });
    await client.callTool({
      name: "render_2d_print_area",
      arguments: {
        mockup_uuid: "mockup-123",
        print_area_uuid: "area-1",
        artwork_url: "https://example.com/photo.jpg",
      },
    });

    // Standalone tool posts the single image source as `url`.
    assert.ok(requests[0].url.endsWith("/api/v1/remove-background"));
    assert.deepEqual(requests[0].body, { url: "https://example.com/photo.jpg" });

    // PSD render: the flag rides on the ASSET, not the smart object.
    const asset = (requests[1].body.smart_objects as Array<{ asset: Record<string, unknown> }>)[0]
      .asset;
    assert.equal(asset.remove_background, true);
    // Opt-in only: an omitted flag must not put the key on the wire.
    const defaultAsset = (
      requests[2].body.smart_objects as Array<{ asset: Record<string, unknown> }>
    )[0].asset;
    assert.ok(!("remove_background" in defaultAsset));

    // 2D render: the flag rides on the PRINT AREA, not adjustments/placement.
    const printArea = (
      requests[3].body.print_areas as Array<{
        remove_background?: boolean;
        adjustments: Record<string, unknown>;
        placement?: Record<string, unknown>;
      }>
    )[0];
    assert.equal(printArea.remove_background, true);
    assert.ok(!("remove_background" in printArea.adjustments));
    // This caller named no placement option at all, so there is no placement
    // on the wire to hide the flag in -- which is itself the stronger check.
    assert.equal(printArea.placement, undefined);
    const defaultPrintArea = (
      requests[4].body.print_areas as Array<Record<string, unknown>>
    )[0];
    assert.ok(!("remove_background" in defaultPrintArea));

    // A non-URL image source fails validation before any request is sent.
    const badUrl = await client.callTool({
      name: "remove_background",
      arguments: { image_url: "not-a-url" },
    });
    assert.equal(badUrl.isError, true);
    assert.equal(requests.length, 5);
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.SUDOMOCK_API_KEY;
    else process.env.SUDOMOCK_API_KEY = originalApiKey;
  }
});

test("2D create is sync-default (201) and every 2D path is plural + black-box", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.SUDOMOCK_API_KEY;
  const quad = [[10, 20], [110, 20], [110, 120], [10, 120]];
  const idempotencyKeys = new Set<string>();
  const renderBodies: Array<Record<string, unknown>> = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (method === "POST" && url.endsWith("/api/v1/sudoai/2d-mockups")) {
      const body = JSON.parse(String(init?.body));
      const headers = new Headers(init?.headers);
      const idempotencyKey = headers.get("Idempotency-Key") ?? "";
      if (body.is_async === true) {
        assert.equal(idempotencyKey, "catalog-import-42");
      } else {
        assert.match(idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      }
      assert.ok(!idempotencyKeys.has(idempotencyKey), "create calls must use unique idempotency keys");
      idempotencyKeys.add(idempotencyKey);

      // is_async=true -> 202 + job_id (poll path preserved).
      if (body.is_async === true) {
        return new Response(
          JSON.stringify({
            job_id: "job-async",
            kind: "2d_create",
            status: "queued",
            status_url: "/api/v1/jobs/job-async",
          }),
          { status: 202, headers: { "Content-Type": "application/json" } }
        );
      }

      // Unsuitable image -> BE rejects with an error body (credits refunded),
      // no async job in the sync-default flow.
      if (body.source_url.includes("unsuitable")) {
        return Response.json(
          { detail: "The image is not suitable for mockup generation." },
          { status: 422 }
        );
      }

      return Response.json(
        {
          data: {
            mockup_id: "mockup-123",
            name: body.name ?? null,
            status: "ready",
            customizable: true,
            source_width: 1200,
            source_height: 900,
            quads: [{ print_area_id: "area-1", points: quad }],
            surfaces: [{ surface_uuid: "surface-1", coverage: "full" }],
          },
          success: true,
        },
        { status: 201 }
      );
    }

    if (method === "GET" && url.endsWith("/api/v1/sudoai/2d-mockups/mockup-123")) {
      return Response.json({
        data: {
          mockup_id: "mockup-123",
          status: "ready",
          customizable: true,
          source_width: 1200,
          source_height: 900,
          quads: [{ print_area_id: "area-1", points: quad }],
          // The stub above still sends the retired `coverage: "full"`, the way a
          // server one deploy behind would during a rollout. It does not reach
          // the caller: this reply is a whitelist, so a field we stopped
          // publishing cannot come back through a stale upstream.
          surfaces: [{ surface_uuid: "surface-1" }],
        },
        success: true,
      });
    }

    if (method === "GET" && new URL(url).pathname === "/api/v1/sudoai/2d-mockups") {
      assert.equal(new URL(url).searchParams.get("customizable_only"), "true");
      return Response.json({
        data: [{
          mockup_id: "mockup-123",
          status: "ready",
          customizable: true,
          print_areas: [{ print_area_id: "area-1", points: quad }],
        }],
        total: 1,
        limit: 20,
        offset: 0,
        success: true,
      });
    }

    if (method === "POST" && url.endsWith("/api/v1/sudoai/2d-mockups/mockup-123/render")) {
      const body = JSON.parse(String(init?.body));
      renderBodies.push(body);
      // render carries the mockup id in the PATH, never in the body.
      assert.ok(!("mockup_uuid" in body), "render body must not carry mockup_uuid");
      assert.ok(
        body.print_areas[0].uuid === "area-1"
        || body.print_areas[0].surface_uuid === "surface-1"
      );
      assert.ok(!("mockup_uuid" in body.print_areas[0]));
      // is_async=true -> 202 + job_id (kind "2d_render"), poll path preserved.
      if (body.is_async === true) {
        return new Response(
          JSON.stringify({
            job_id: "render-job-async",
            kind: "2d_render",
            status: "queued",
            status_url: "/api/v1/jobs/render-job-async",
          }),
          { status: 202, headers: { "Content-Type": "application/json" } }
        );
      }
      return Response.json({
        data: {
          print_files: [{ export_path: "/renders/out.webp" }],
          render_uuid: "render-1",
        },
        success: true,
      });
    }

    if (method === "PUT" && url.endsWith("/api/v1/sudoai/2d-mockups/mockup-123/print-areas")) {
      const body = JSON.parse(String(init?.body));
      if (body.print_areas.length > 0) {
        assert.deepEqual(body.print_areas, [{ points: quad, name: "Front" }]);
      }
      return Response.json({
        data: {
          print_areas: body.print_areas.length === 0
            ? []
            : [{ print_area_id: "area-2", points: quad, name: "Front" }],
        },
        success: true,
      });
    }

    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  process.env.SUDOMOCK_API_KEY = "sm_test";

  const client = await connectClient();
  try {
    // Sync-default create returns the mockup directly (201), no poll.
    const createdResult = await client.callTool({
      name: "create_2d_mockup",
      arguments: {
        source_url: "https://example.com/product.jpg",
        name: "Product",
      },
    });
    const created = JSON.parse(
      (createdResult.content as Array<{ type: "text"; text: string }>)[0].text
    );
    assert.equal(created.mockup_id, "mockup-123");
    assert.equal(created.name, "Product");
    assert.equal(created.status, "ready");
    assert.equal(created.customizable, true);
    assert.equal(created.source_width, 1200);
    assert.deepEqual(created.print_areas, [{ print_area_id: "area-1", points: quad }]);
    // A surface is named and nothing else. The retired `coverage: "full"` that
    // rode along stated nothing a caller could act on while reading exactly
    // like a dial they could turn.
    assert.deepEqual(created.surfaces, [{ surface_uuid: "surface-1" }]);

    const detailsResult = await client.callTool({
      name: "get_2d_mockup",
      arguments: { mockup_id: "mockup-123" },
    });
    const details = JSON.parse(
      (detailsResult.content as Array<{ type: "text"; text: string }>)[0].text
    );
    assert.deepEqual(details.data.print_areas, [{ print_area_id: "area-1", points: quad }]);
    assert.deepEqual(details.data.surfaces, [{ surface_uuid: "surface-1" }]);
    assert.ok(!("quads" in details.data));

    const listResult = await client.callTool({
      name: "list_2d_mockups",
      arguments: { customizable_only: true },
    });
    const listing = JSON.parse(
      (listResult.content as Array<{ type: "text"; text: string }>)[0].text
    );
    assert.equal(listing.data[0].customizable, true);

    // Unsuitable image -> error body -> tool surfaces an error result.
    const rejectedResult = await client.callTool({
      name: "create_2d_mockup",
      arguments: { source_url: "https://example.com/unsuitable.jpg" },
    });
    assert.equal(rejectedResult.isError, true);
    const rejectedText = (rejectedResult.content as Array<{ type: "text"; text: string }>)[0].text;
    assert.match(rejectedText, /Invalid parameters/);
    assert.doesNotMatch(rejectedText, /not suitable for mockup generation/);

    const missingSource = await client.callTool({
      name: "create_2d_mockup",
      arguments: {},
    });
    assert.equal(missingSource.isError, true);

    // is_async=true still returns the job-accepted contract.
    const asyncResult = await client.callTool({
      name: "create_2d_mockup",
      arguments: {
        source_url: "https://example.com/async.jpg",
        idempotency_key: "catalog-import-42",
        is_async: true,
      },
    });
    const asyncJob = JSON.parse(
      (asyncResult.content as Array<{ type: "text"; text: string }>)[0].text
    );
    assert.equal(asyncJob.accepted, true);
    assert.equal(asyncJob.job_id, "job-async");
    assert.equal(asyncJob.status_url, "/api/v1/jobs/job-async");

    // render posts to the plural path with the id in the path + print_files/render_uuid back.
    const renderResult = await client.callTool({
      name: "render_2d_print_area",
      arguments: {
        mockup_uuid: "mockup-123",
        print_area_uuid: "area-1",
        artwork_url: "https://example.com/art.png",
      },
    });
    const rendered = JSON.parse(
      (renderResult.content as Array<{ type: "text"; text: string }>)[0].text
    );
    assert.equal(rendered.data.render_uuid, "render-1");
    assert.equal(rendered.data.print_files[0].export_path, "/renders/out.webp");

    await client.callTool({
      name: "render_2d_surface",
      arguments: {
        mockup_uuid: "mockup-123",
        surface_uuid: "surface-1",
        artwork_url: "https://example.com/art.png",
      },
    });
    assert.equal(
      (renderBodies.at(-1)?.print_areas as Array<Record<string, unknown>>)[0]?.surface_uuid,
      "surface-1"
    );
    assert.ok(
      !("uuid" in (renderBodies.at(-1)?.print_areas as Array<Record<string, unknown>>)[0])
    );
    // Naming two targets at once is no longer something a caller can express:
    // there is no tool that takes both fields. What is still refusable is
    // naming none, and each tool refuses that on its own behalf.
    assert.equal((await client.callTool({
      name: "render_2d_print_area",
      arguments: {
        mockup_uuid: "mockup-123",
        artwork_url: "https://example.com/art.png",
      },
    })).isError, true);
    assert.equal((await client.callTool({
      name: "render_2d_surface",
      arguments: {
        mockup_uuid: "mockup-123",
        artwork_url: "https://example.com/art.png",
      },
    })).isError, true);

    // render is_async=true returns the job-accepted contract (mirrors create).
    const asyncRenderResult = await client.callTool({
      name: "render_2d_print_area",
      arguments: {
        mockup_uuid: "mockup-123",
        print_area_uuid: "area-1",
        artwork_url: "https://example.com/art.png",
        is_async: true,
      },
    });
    const asyncRender = JSON.parse(
      (asyncRenderResult.content as Array<{ type: "text"; text: string }>)[0].text
    );
    assert.equal(asyncRender.accepted, true);
    assert.equal(asyncRender.job_id, "render-job-async");
    assert.equal(asyncRender.kind, "2d_render");
    assert.equal(asyncRender.status_url, "/api/v1/jobs/render-job-async");

    const updatedResult = await client.callTool({
      name: "update_2d_print_areas",
      arguments: { mockup_id: "mockup-123", print_areas: [{ points: quad, name: "Front" }] },
    });
    const updated = JSON.parse(
      (updatedResult.content as Array<{ type: "text"; text: string }>)[0].text
    );
    assert.equal(updated.data.print_areas[0].print_area_id, "area-2");
    assert.equal(updated.data.print_areas[0].name, "Front");

    const emptiedResult = await client.callTool({
      name: "update_2d_print_areas",
      arguments: { mockup_id: "mockup-123", print_areas: [] },
    });
    const emptied = JSON.parse(
      (emptiedResult.content as Array<{ type: "text"; text: string }>)[0].text
    );
    assert.deepEqual(emptied.data.print_areas, []);

    // Three creates reached the POST (sync, unsuitable, async); missing source
    // fails schema validation before any request.
    assert.equal(idempotencyKeys.size, 3);
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.SUDOMOCK_API_KEY;
    else process.env.SUDOMOCK_API_KEY = originalApiKey;
  }
});

test("formatJobAccepted surfaces the async 202 job contract", () => {
  const out = JSON.parse(
    formatJobAccepted({
      job_id: "job-123",
      kind: "render",
      status: "queued",
      model: "private-engine",
      prompt: "private instruction",
    })
  );
  assert.equal(out.accepted, true);
  assert.equal(out.job_id, "job-123");
  assert.equal(out.kind, "render");
  assert.equal(out.status, "queued");
  assert.equal(out.status_url, "/api/v1/jobs/job-123");
  assert.ok(!("raw" in out));
  assert.ok(!("model" in out));
  assert.ok(!("prompt" in out));
});

test("job tools return only outcome fields and redact engine errors", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.SUDOMOCK_API_KEY;
  globalThis.fetch = async () =>
    Response.json({
      job_id: "job-123",
      kind: "2d_render",
      status: "failed",
      error: {
        error_code: "MODEL_PROMPT_FAILED",
        message: "Private model prompt failed for mask_uuid.",
      },
      model: "private-engine",
      prompt: "private instruction",
      mask_uuid: "private-surface",
    });
  process.env.SUDOMOCK_API_KEY = "sm_test";

  const client = await connectClient();
  try {
    const result = await client.callTool({
      name: "get_job",
      arguments: { job_id: "job-123" },
    });
    const job = JSON.parse(
      (result.content as Array<{ type: "text"; text: string }>)[0].text
    );
    assert.equal(job.error_code, "PROCESSING_FAILED");
    assert.equal(
      job.error,
      "Processing failed. Retry or contact support with the job ID."
    );
    assert.ok(!("model" in job));
    assert.ok(!("prompt" in job));
    assert.ok(!("mask_uuid" in job));
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.SUDOMOCK_API_KEY;
    else process.env.SUDOMOCK_API_KEY = originalApiKey;
  }
});

test("formatJobAccepted does NOT fall back to mockup_uuid for the job id", () => {
  // Every async submit endpoint returns job_id; a payload without one must not
  // borrow mockup_uuid as the id (the removed dead fallback).
  const out = JSON.parse(formatJobAccepted({ mockup_uuid: "mock-999", status: "queued" }));
  assert.equal(out.job_id, null);
  assert.equal(out.status_url, null);
});

test("isTerminalJob detects terminal statuses via the `status` field", () => {
  assert.equal(isTerminalJob({ status: "succeeded" }), true);
  assert.equal(isTerminalJob({ status: "failed" }), true);
  assert.equal(isTerminalJob({ status: "queued" }), false);
  assert.equal(isTerminalJob({ status: "running" }), false);
  assert.equal(isTerminalJob({}), false);
});

test("isTerminalJob ignores the legacy `state` key (the API returns `status`)", () => {
  // The poll endpoint (GET /api/v1/jobs/{id}) only ever returns `status`; a stray
  // legacy `state` key must not be read.
  assert.equal(isTerminalJob({ state: "succeeded" }), false);
  assert.deepEqual([...TERMINAL_JOB_STATUSES].sort(), ["failed", "succeeded"]);
});
