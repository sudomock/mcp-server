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
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  "list_psd_mockups",
  "get_psd_mockup",
  "update_psd_mockup",
  "delete_psd_mockup",
  "render_psd_mockup",
  "remove_background",
  "create_photo_mockup",
  "render_photo_mockup",
  "list_photo_mockups",
  "get_photo_mockup",
  "update_photo_mockup_print_areas",
  "delete_photo_mockup",
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
  "upload_local_file",
];

// The 2.x names. 3.0 is a clean cut: no alias answers to any of them, so a
// client written against 2.x fails loudly at "tool not found" instead of
// being quietly redirected to a tool whose arguments have changed.
const RETIRED_TOOLS = [
  "list_mockups",
  "get_mockup_details",
  "update_mockup",
  "delete_mockup",
  "render_mockup",
  "create_2d_mockup",
  "render_2d_mockup",
  "render_2d_surface",
  "render_2d_print_area",
  "list_2d_mockups",
  "get_2d_mockup",
  "update_2d_print_areas",
  "delete_2d_mockup",
  "create_studio_session",
];

/** The first text block of a tool result. */
function firstText(result: unknown): string {
  return (result as { content: Array<{ type: "text"; text: string }> }).content[0].text;
}

test("registers every expected tool with a description + object input schema", async () => {
  const client = await connectClient();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    for (const expected of EXPECTED_TOOLS) {
      assert.ok(names.includes(expected), `missing tool: ${expected}`);
    }
    for (const retired of RETIRED_TOOLS) {
      assert.ok(!names.includes(retired), `retired tool still registered: ${retired}`);
    }
    assert.equal(names.length, EXPECTED_TOOLS.length);

    for (const tool of tools) {
      assert.equal(typeof tool.description, "string", `${tool.name} has no description`);
      assert.ok((tool.description ?? "").length > 0, `${tool.name} description is empty`);
      assert.equal(tool.inputSchema.type, "object", `${tool.name} input schema is not an object`);
    }

    const create2D = tools.find((tool) => tool.name === "create_photo_mockup");
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

    const render = schema("render_psd_mockup");
    const renderProps = render.properties ?? {};
    assert.ok("smart_objects" in renderProps);
    assert.ok("text_layers" in renderProps);
    assert.ok(!("group_layers" in renderProps));
    assert.equal(renderProps.text_layers.items?.properties?.fit.default, "overflow");
    assert.deepEqual(render.required, ["mockup_uuid"]);

    const webhook = schema("create_webhook_endpoint");
    // The five photo-mockup events carry two spellings (ADR 2026-09-18): the
    // family names and the legacy 2d_* names. Both stay subscribable; the
    // endpoint's event_naming pin decides which one a delivery carries. The
    // order is the API's own (webhook_schemas.EVENT_TYPES).
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
      "photo_mockup.ready",
      "photo_mockup.rejected",
      "photo_mockup.failed",
      "photo_mockup_render.succeeded",
      "photo_mockup_render.failed",
      "webhook.test",
    ]);
    assert.deepEqual(webhook.properties?.event_naming.enum, ["legacy", "current"]);
    assert.ok(!(webhook.required ?? []).includes("event_naming"));
    // The same enum feeds update_webhook_endpoint and the deliveries filter.
    assert.deepEqual(
      schema("update_webhook_endpoint").properties?.event_types.items?.enum,
      webhook.properties?.event_types.items?.enum
    );
    assert.deepEqual(
      schema("list_webhook_deliveries").properties?.event_type.enum,
      webhook.properties?.event_types.items?.enum
    );
    // The pin is not frozen at registration: update_webhook_endpoint takes the
    // same optional event_naming, so an endpoint registered before the family
    // names existed can be moved to them once its receiver is ready.
    const update = schema("update_webhook_endpoint");
    assert.deepEqual(update.properties?.event_naming?.enum, ["legacy", "current"]);
    assert.deepEqual(update.required, ["endpoint_id"]);

    const jobs = schema("list_jobs");
    assert.deepEqual(jobs.properties?.kind.enum, [
      "video",
      "render",
      "upload",
      "2d_create",
      "2d_render",
      "photo_mockup_create",
      "photo_mockup_render",
    ]);
    // One photo render tool, shaped like the hosted server's: the target is
    // exactly one of print_area_uuid or surface_uuid, and the sizing dials of
    // both target kinds sit on the same schema. Which dial belongs to which
    // target is settled in the handler, by name, with the sentence that sends
    // the caller to the option that works (exercised further down).
    const photoRender = schema("render_photo_mockup");
    const photoProps = photoRender.properties ?? {};
    assert.ok(!("blend_mode" in photoProps));
    assert.ok(!("mockup_uuid" in photoProps));
    assert.deepEqual(photoRender.required, ["mockup_id", "artwork_url"]);
    for (const present of ["print_area_uuid", "surface_uuid", "coverage", "fit", "width", "height"]) {
      assert.ok(present in photoProps, `render_photo_mockup is missing ${present}`);
    }
    // Anchoring and sizing carry no client-side default: an option the caller
    // never names must not reach the wire. The renderer owns the answer.
    for (const dial of ["position", "offset_x", "offset_y", "rotation", "coverage", "fit", "width", "height"]) {
      assert.equal(photoProps[dial].default, undefined, `${dial} carries a client-side default`);
    }
    // Export defaults are this package's own and stay where 2.x had them.
    assert.equal(photoProps.quality.default, 90);
    assert.equal(photoProps.image_size.default, 2048);
    assert.equal(photoProps.image_format.default, "webp");
    const video = schema("render_video");
    assert.ok(!("advanced_model" in (video.properties ?? {})));

    const publicToolCopy = JSON.stringify(tools).toLowerCase();
    // Terimler kodlu: bu depo PUBLIC ve liste, gizlemeye calistigi her ismi
    // (saglayici adlari, boru hatti kavramlari) tek yerde toplayarak sizintinin
    // kendisi haline geliyordu. Assert davranisi ayni.
    const FORBIDDEN = Buffer.from(
      "dmVvLGtsaW5nLHNlZWRhbmNlLGJpcmVmbmV0LGZhbC5haSxpZGVvZ3JhbSxzZXJ2ZXItc2lkZSBkb3dubG9hZCxhdXRvLXJvdXRlcixjZG4gdXJsLG1hc2tfdXVpZCxyZWdpb25faW5kZXgsc2VnbWVudGF0aW9uLGRpc3BsYWNlbWVudCxzaGFkaW5nLGFkdmFuY2VkX21vZGVs",
      "base64",
    ).toString().split(",");
    for (const forbidden of FORBIDDEN) {
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
      name: "render_psd_mockup",
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
      name: "render_psd_mockup",
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
      name: "render_psd_mockup",
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

test("render_psd_mockup returns only public output fields and safe warnings", async () => {
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
      name: "render_psd_mockup",
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
    if (path === "/api/v1/psd-mockups") {
      return Response.json({
        success: true,
        data: { mockups: [mockup], total: 1, limit: 20, offset: 0 },
      });
    }
    if (path === "/api/v1/psd-mockups/mockup-123") {
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
          event_naming: "legacy",
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

    const list = await call("list_psd_mockups");
    assert.equal(list.data.mockups[0].uuid, "mockup-123");
    assert.ok(!("model" in list.data.mockups[0]));
    assert.ok(!("mask_uuid" in list.data.mockups[0].smart_objects[0]));

    const detail = await call("get_psd_mockup", {
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
    // The pin is public: it is what tells the caller which spelling of the
    // photo-mockup events this endpoint receives.
    assert.equal(endpoints[0].event_naming, "legacy");
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.SUDOMOCK_API_KEY;
    else process.env.SUDOMOCK_API_KEY = originalApiKey;
  }
});

test("create_webhook_endpoint forwards the event_naming pin and the photo-mockup event names", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.SUDOMOCK_API_KEY;
  const posts: Array<Record<string, unknown>> = [];

  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    assert.equal(path, "/api/v1/webhook-endpoints");
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    posts.push(body);
    return Response.json({
      id: "endpoint-9",
      url: body.url,
      secret: "whsec_once",
      description: body.description ?? null,
      event_types: body.event_types,
      // The API answers with the pin it stored (its default is 'current').
      event_naming: body.event_naming ?? "current",
      enabled: true,
      created_at: "2026-09-18T00:00:00Z",
      updated_at: "2026-09-18T00:00:00Z",
      private_endpoint_state: "internal",
    });
  };
  process.env.SUDOMOCK_API_KEY = "sm_test";

  const client = await connectClient();
  try {
    const call = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: "create_webhook_endpoint", arguments: args });
      return JSON.parse(
        (result.content as Array<{ type: "text"; text: string }>)[0].text
      );
    };

    // Explicit pin + family names travel as-is.
    const pinned = await call({
      url: "https://example.com/hook",
      event_types: ["photo_mockup.ready", "photo_mockup_render.succeeded"],
      event_naming: "current",
    });
    assert.deepEqual(posts[0], {
      url: "https://example.com/hook",
      event_types: ["photo_mockup.ready", "photo_mockup_render.succeeded"],
      event_naming: "current",
    });
    assert.equal(pinned.event_naming, "current");
    assert.deepEqual(pinned.event_types, ["photo_mockup.ready", "photo_mockup_render.succeeded"]);
    assert.ok(!("private_endpoint_state" in pinned));

    // A legacy pin is an explicit choice, and the legacy names still pass.
    await call({
      url: "https://example.com/hook",
      event_types: ["2d_render.succeeded"],
      event_naming: "legacy",
    });
    assert.equal(posts[1].event_naming, "legacy");
    assert.deepEqual(posts[1].event_types, ["2d_render.succeeded"]);

    // Omitted = not sent, so the API's own default ('current') applies rather
    // than a default this server would have to keep in step with it.
    const defaulted = await call({ url: "https://example.com/hook" });
    assert.ok(!("event_naming" in posts[2]));
    assert.deepEqual(posts[2].event_types, []);
    assert.equal(defaulted.event_naming, "current");
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.SUDOMOCK_API_KEY;
    else process.env.SUDOMOCK_API_KEY = originalApiKey;
  }
});

test("update_webhook_endpoint forwards the event_naming re-pin and leaves it out when not given", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.SUDOMOCK_API_KEY;
  const patches: Array<Record<string, unknown>> = [];
  // What the API holds for the endpoint; a PATCH without event_naming leaves
  // the stored pin alone, so the response keeps echoing it.
  let storedNaming = "legacy";

  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    assert.equal(path, "/api/v1/webhook-endpoints/endpoint-9");
    assert.equal(init?.method, "PATCH");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    patches.push(body);
    if (typeof body.event_naming === "string") storedNaming = body.event_naming;
    return Response.json({
      id: "endpoint-9",
      url: body.url ?? "https://example.com/hook",
      secret: "whsec_****ab12",
      description: body.description ?? null,
      event_types: body.event_types ?? ["2d_render.succeeded"],
      event_naming: storedNaming,
      enabled: body.enabled ?? true,
      created_at: "2026-09-18T00:00:00Z",
      updated_at: "2026-09-18T00:00:00Z",
      private_endpoint_state: "internal",
    });
  };
  process.env.SUDOMOCK_API_KEY = "sm_test";

  const client = await connectClient();
  try {
    const call = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: "update_webhook_endpoint", arguments: args });
      return JSON.parse(
        (result.content as Array<{ type: "text"; text: string }>)[0].text
      );
    };

    // A re-pin on its own is a valid patch: the body carries only the pin.
    const repinned = await call({ endpoint_id: "endpoint-9", event_naming: "current" });
    assert.deepEqual(patches[0], { event_naming: "current" });
    assert.equal(repinned.event_naming, "current");
    assert.ok(!("private_endpoint_state" in repinned));

    // Pin and subscription list travel together, spelled as given.
    await call({
      endpoint_id: "endpoint-9",
      event_naming: "legacy",
      event_types: ["2d_render.succeeded", "render.failed"],
    });
    assert.deepEqual(patches[1], {
      event_naming: "legacy",
      event_types: ["2d_render.succeeded", "render.failed"],
    });

    // Omitted = not sent: a patch that only pauses the endpoint must not
    // touch the pin, and the stored pin comes back unchanged.
    const paused = await call({ endpoint_id: "endpoint-9", enabled: false });
    assert.deepEqual(patches[2], { enabled: false });
    assert.equal(paused.event_naming, "legacy");
    assert.equal(paused.enabled, false);
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
      name: "render_psd_mockup",
      arguments: {
        mockup_uuid: "123e4567-e89b-12d3-a456-426614174000",
        smart_object_uuid: "223e4567-e89b-12d3-a456-426614174001",
        artwork_url: "https://example.com/photo.jpg",
        remove_background: true,
      },
    });
    await client.callTool({
      name: "render_psd_mockup",
      arguments: {
        mockup_uuid: "123e4567-e89b-12d3-a456-426614174000",
        smart_object_uuid: "223e4567-e89b-12d3-a456-426614174001",
        artwork_url: "https://example.com/photo.jpg",
      },
    });
    await client.callTool({
      name: "render_photo_mockup",
      arguments: {
        mockup_id: "mockup-123",
        print_area_uuid: "area-1",
        artwork_url: "https://example.com/photo.jpg",
        remove_background: true,
      },
    });
    await client.callTool({
      name: "render_photo_mockup",
      arguments: {
        mockup_id: "mockup-123",
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

    // Photo render: the flag rides on the PRINT AREA, not adjustments/placement.
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

test("photo mockup create is sync-default (201) and every photo path is the family path + black-box", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.SUDOMOCK_API_KEY;
  const quad = [[10, 20], [110, 20], [110, 120], [10, 120]];
  const idempotencyKeys = new Set<string>();
  const renderBodies: Array<Record<string, unknown>> = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (method === "POST" && url.endsWith("/api/v1/photo-mockups")) {
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

      // is_async=true -> 202 + job_id (poll path preserved). The family path
      // stamps the family kind.
      if (body.is_async === true) {
        return new Response(
          JSON.stringify({
            job_id: "job-async",
            kind: "photo_mockup_create",
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

    if (method === "GET" && url.endsWith("/api/v1/photo-mockups/mockup-123")) {
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

    if (method === "GET" && new URL(url).pathname === "/api/v1/photo-mockups") {
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

    if (method === "POST" && url.endsWith("/api/v1/photo-mockups/mockup-123/render")) {
      const body = JSON.parse(String(init?.body));
      renderBodies.push(body);
      // render carries the mockup id in the PATH, never in the body.
      assert.ok(!("mockup_uuid" in body), "render body must not carry mockup_uuid");
      assert.ok(!("mockup_id" in body), "render body must not carry mockup_id");
      assert.ok(
        body.print_areas[0].uuid === "area-1"
        || body.print_areas[0].surface_uuid === "surface-1"
      );
      assert.ok(!("mockup_uuid" in body.print_areas[0]));
      // is_async=true -> 202 + job_id (family kind), poll path preserved.
      if (body.is_async === true) {
        return new Response(
          JSON.stringify({
            job_id: "render-job-async",
            kind: "photo_mockup_render",
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

    if (method === "PUT" && url.endsWith("/api/v1/photo-mockups/mockup-123/print-areas")) {
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
      name: "create_photo_mockup",
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
      name: "get_photo_mockup",
      arguments: { mockup_id: "mockup-123" },
    });
    const details = JSON.parse(
      (detailsResult.content as Array<{ type: "text"; text: string }>)[0].text
    );
    assert.deepEqual(details.data.print_areas, [{ print_area_id: "area-1", points: quad }]);
    assert.deepEqual(details.data.surfaces, [{ surface_uuid: "surface-1" }]);
    assert.ok(!("quads" in details.data));

    const listResult = await client.callTool({
      name: "list_photo_mockups",
      arguments: { customizable_only: true },
    });
    const listing = JSON.parse(
      (listResult.content as Array<{ type: "text"; text: string }>)[0].text
    );
    assert.equal(listing.data[0].customizable, true);

    // Unsuitable image -> error body -> tool surfaces an error result.
    const rejectedResult = await client.callTool({
      name: "create_photo_mockup",
      arguments: { source_url: "https://example.com/unsuitable.jpg" },
    });
    assert.equal(rejectedResult.isError, true);
    const rejectedText = (rejectedResult.content as Array<{ type: "text"; text: string }>)[0].text;
    assert.match(rejectedText, /Invalid parameters/);
    assert.doesNotMatch(rejectedText, /not suitable for mockup generation/);

    const missingSource = await client.callTool({
      name: "create_photo_mockup",
      arguments: {},
    });
    assert.equal(missingSource.isError, true);

    // is_async=true still returns the job-accepted contract.
    const asyncResult = await client.callTool({
      name: "create_photo_mockup",
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

    // render posts to the family path with the id in the path + print_files/render_uuid back.
    const renderResult = await client.callTool({
      name: "render_photo_mockup",
      arguments: {
        mockup_id: "mockup-123",
        print_area_uuid: "area-1",
        artwork_url: "https://example.com/art.png",
      },
    });
    const rendered = JSON.parse(
      (renderResult.content as Array<{ type: "text"; text: string }>)[0].text
    );
    assert.equal(rendered.data.render_uuid, "render-1");
    assert.equal(rendered.data.print_files[0].export_path, "/renders/out.webp");

    // A surface target travels as surface_uuid, with its own sizing dial.
    await client.callTool({
      name: "render_photo_mockup",
      arguments: {
        mockup_id: "mockup-123",
        surface_uuid: "surface-1",
        artwork_url: "https://example.com/art.png",
        coverage: 60,
      },
    });
    const surfaceEntry = (renderBodies.at(-1)?.print_areas as Array<Record<string, unknown>>)[0];
    assert.equal(surfaceEntry.surface_uuid, "surface-1");
    assert.ok(!("uuid" in surfaceEntry));
    assert.deepEqual(surfaceEntry.placement, { coverage: 60 });

    // A print area target travels as uuid; fit, or an exact box, sizes it.
    await client.callTool({
      name: "render_photo_mockup",
      arguments: {
        mockup_id: "mockup-123",
        print_area_uuid: "area-1",
        artwork_url: "https://example.com/art.png",
        fit: "cover",
        position: "top_left",
      },
    });
    assert.deepEqual(
      (renderBodies.at(-1)?.print_areas as Array<Record<string, unknown>>)[0].placement,
      { position: "top_left", fit: "cover" }
    );
    await client.callTool({
      name: "render_photo_mockup",
      arguments: {
        mockup_id: "mockup-123",
        print_area_uuid: "area-1",
        artwork_url: "https://example.com/art.png",
        width: 300,
        height: 120,
      },
    });
    assert.deepEqual(
      (renderBodies.at(-1)?.print_areas as Array<Record<string, unknown>>)[0].placement,
      { width: 300, height: 120 }
    );

    // The target is named exactly once. Both fields at once and neither are
    // refused before anything reaches the wire, with the hosted server's
    // sentence.
    const sentBefore = renderBodies.length;
    const refuse = async (args: Record<string, unknown>) => {
      const result = await client.callTool({
        name: "render_photo_mockup",
        arguments: { mockup_id: "mockup-123", artwork_url: "https://example.com/art.png", ...args },
      });
      assert.equal(result.isError, true, `expected a refusal for ${JSON.stringify(args)}`);
      return firstText(result);
    };
    assert.match(
      await refuse({ print_area_uuid: "area-1", surface_uuid: "surface-1" }),
      /Provide exactly one of print_area_uuid or surface_uuid/
    );
    assert.match(await refuse({}), /Provide exactly one of print_area_uuid or surface_uuid/);
    // The sizing dial of the other kind of target is refused by name, with
    // the sentence that sends the caller to the option that works. Dropping
    // it instead would render a size the caller never asked for in silence.
    assert.match(
      await refuse({ surface_uuid: "surface-1", fit: "contain" }),
      /A surface covers the whole product, so fit has nothing to fit against/
    );
    assert.match(
      await refuse({ print_area_uuid: "area-1", coverage: 50 }),
      /coverage has no meaning on one/
    );
    // The retired scale is still refused by name rather than dropped.
    assert.match(await refuse({ print_area_uuid: "area-1", scale: 2 }), /scale has been retired/);
    // Half a size, and two sizing answers at once, never reach the wire.
    assert.match(
      await refuse({ print_area_uuid: "area-1", width: 300 }),
      /width and height must be provided together/
    );
    assert.match(
      await refuse({ surface_uuid: "surface-1", coverage: 60, width: 300, height: 120 }),
      /coverage and an explicit width and height/
    );
    assert.match(
      await refuse({ print_area_uuid: "area-1", fit: "fill", width: 300, height: 120 }),
      /fit and an explicit width and height/
    );
    assert.equal(renderBodies.length, sentBefore);

    // render is_async=true returns the job-accepted contract (mirrors create).
    const asyncRenderResult = await client.callTool({
      name: "render_photo_mockup",
      arguments: {
        mockup_id: "mockup-123",
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
    assert.equal(asyncRender.kind, "photo_mockup_render");
    assert.equal(asyncRender.status_url, "/api/v1/jobs/render-job-async");

    const updatedResult = await client.callTool({
      name: "update_photo_mockup_print_areas",
      arguments: { mockup_id: "mockup-123", print_areas: [{ points: quad, name: "Front" }] },
    });
    const updated = JSON.parse(
      (updatedResult.content as Array<{ type: "text"; text: string }>)[0].text
    );
    assert.equal(updated.data.print_areas[0].print_area_id, "area-2");
    assert.equal(updated.data.print_areas[0].name, "Front");

    const emptiedResult = await client.callTool({
      name: "update_photo_mockup_print_areas",
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

// ---------------------------------------------------------------------------
// Client identity + tool-call log
// ---------------------------------------------------------------------------

/** The version npm publishes; the test build sits two levels below the package root. */
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
).version;

interface ToolLogLine {
  event: string;
  ts: string;
  client: string;
  tool: string;
  duration_ms: number;
  ok: boolean;
  error_type?: string;
}

/** Capture what the server writes to stderr; only the tool-log lines are parsed. */
function captureStderr(): { raw: () => string; lines: () => ToolLogLine[]; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as unknown as typeof process.stderr.write;
  return {
    raw: () => chunks.join(""),
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.startsWith('{"event":"mcp_tool_call"'))
        .map((line) => JSON.parse(line) as ToolLogLine),
    restore: () => {
      process.stderr.write = original;
    },
  };
}

test("every API request carries X-SudoMock-Client mcp-stdio/<version> and User-Agent SudoMock-MCP/<version> (stdio)", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.SUDOMOCK_API_KEY;
  const seen: Headers[] = [];

  globalThis.fetch = async (_input, init) => {
    seen.push(new Headers(init?.headers));
    return Response.json({ data: [], total: 0 });
  };
  process.env.SUDOMOCK_API_KEY = "sm_test";

  const client = await connectClient();
  try {
    assert.match(PACKAGE_VERSION, /^\d+\.\d+\.\d+/);
    const expected = `mcp-stdio/${PACKAGE_VERSION}`;
    const expectedUa = `SudoMock-MCP/${PACKAGE_VERSION} (stdio)`;

    // The MCP handshake reports the same version the API sees.
    assert.equal(client.getServerVersion()?.version, PACKAGE_VERSION);

    await client.callTool({ name: "list_psd_mockups", arguments: { limit: 1 } });
    await client.callTool({ name: "get_account", arguments: {} });

    assert.equal(seen.length, 2);
    for (const headers of seen) {
      assert.equal(headers.get("X-SudoMock-Client"), expected);
      assert.equal(headers.get("User-Agent"), expectedUa);
      assert.equal(headers.get("x-api-key"), "sm_test");
    }
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.SUDOMOCK_API_KEY;
    else process.env.SUDOMOCK_API_KEY = originalApiKey;
  }
});

test("each tool call writes one JSON line to stderr that names the tool and outcome, never the key", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.SUDOMOCK_API_KEY;
  let nextStatus = 200;

  globalThis.fetch = async () => {
    if (nextStatus !== 200) return new Response("", { status: nextStatus });
    return Response.json({ data: [{ uuid: "m-1", name: "Tote bag" }], total: 1 });
  };
  process.env.SUDOMOCK_API_KEY = "sm_test_secret_value";

  const stderr = captureStderr();
  const client = await connectClient();
  try {
    // Success.
    const okResult = await client.callTool({ name: "list_psd_mockups", arguments: { limit: 1, name: "tote" } });
    assert.notEqual(okResult.isError, true);

    // API failure surfaces as a tool error and is logged with the HTTP status.
    nextStatus = 401;
    const failed = await client.callTool({ name: "get_account", arguments: {} });
    assert.equal(failed.isError, true);

    // A tool that reports its own error result (no API call) is logged as tool_error.
    const local = await client.callTool({
      name: "upload_local_file",
      arguments: { file_path: join(tmpdir(), "sudomock-does-not-exist.psd"), kind: "psd" },
    });
    assert.equal(local.isError, true);

    const lines = stderr.lines();
    assert.equal(lines.length, 3, `expected three log lines, got: ${stderr.raw()}`);

    const [ok, http, tool] = lines;
    assert.equal(ok.tool, "list_psd_mockups");
    assert.equal(ok.ok, true);
    assert.equal(ok.error_type, undefined);
    assert.equal(ok.client, `mcp-stdio/${PACKAGE_VERSION}`);
    assert.equal(typeof ok.duration_ms, "number");
    assert.ok(ok.duration_ms >= 0);
    assert.ok(!Number.isNaN(Date.parse(ok.ts)));

    assert.equal(http.tool, "get_account");
    assert.equal(http.ok, false);
    assert.equal(http.error_type, "http_401");

    assert.equal(tool.tool, "upload_local_file");
    assert.equal(tool.ok, false);
    assert.equal(tool.error_type, "tool_error");

    // A log file is a retained channel: no key, no arguments, no response body.
    const raw = stderr.raw();
    assert.ok(!raw.includes("sm_test_secret_value"));
    assert.ok(!raw.includes("tote"));
    assert.ok(!raw.includes("Tote bag"));
    assert.ok(!raw.includes("m-1"));
    assert.ok(!raw.includes("sudomock-does-not-exist"));
  } finally {
    stderr.restore();
    await client.close();
    await server.close();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.SUDOMOCK_API_KEY;
    else process.env.SUDOMOCK_API_KEY = originalApiKey;
  }
});

test("the signed upload PUT carries no API identity headers", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.SUDOMOCK_API_KEY;
  const dir = await mkdtemp(join(tmpdir(), "sudomock-client-header-"));
  const file = join(dir, "template.psd");
  await writeFile(file, Buffer.concat([Buffer.from("8BPS"), Buffer.alloc(60)]));
  const calls: Array<{ url: string; method: string; headers: Headers }> = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers) });
    if (url.endsWith("/api/v1/uploads/sign")) {
      return Response.json({
        data: { upload_url: "https://uploads.example/put?sig=abc", file_url: "https://files.example/template.psd" },
      });
    }
    return new Response(null, { status: 200 });
  };
  process.env.SUDOMOCK_API_KEY = "sm_test";

  const client = await connectClient();
  try {
    const result = await client.callTool({ name: "upload_local_file", arguments: { file_path: file, kind: "psd" } });
    assert.notEqual(result.isError, true);

    const sign = calls.find((c) => c.url.endsWith("/api/v1/uploads/sign"));
    const put = calls.find((c) => c.method === "PUT");
    assert.ok(sign && put, "expected a sign request and a PUT");
    assert.equal(sign.headers.get("X-SudoMock-Client"), `mcp-stdio/${PACKAGE_VERSION}`);
    assert.equal(put.headers.get("X-SudoMock-Client"), null);
    assert.equal(put.headers.get("x-api-key"), null);
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.SUDOMOCK_API_KEY;
    else process.env.SUDOMOCK_API_KEY = originalApiKey;
    await rm(dir, { recursive: true, force: true });
  }
});
