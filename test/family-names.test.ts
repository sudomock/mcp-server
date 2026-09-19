/**
 * Both spellings of every renamed tool, side by side.
 *
 * A name that shipped once is never taken away, so the family spellings are
 * added beside the names 2.8.1 registers rather than replacing them. That
 * makes two things worth testing, and the first matters more than the second:
 *
 *   1. The watchdog. Every name 2.8.1 answered to still exists, still takes
 *      the same arguments, and still puts byte-for-byte the same request on
 *      the wire. The expectations below are written out by hand rather than
 *      read back from the server, so a change in the handler cannot quietly
 *      move the pin with it.
 *   2. The addition. Each family spelling reaches the same handler as the
 *      name it was added beside, which is shown by comparing the request the
 *      two of them send.
 *
 * `render_photo_mockup` is the one that is not a second name for a single
 * tool: it names one target, and which of `print_area_uuid` / `surface_uuid`
 * it is given decides which of the two render tools' shapes it sends. Every
 * branch of that choice, and every refusal it can answer with, is exercised.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { server } from "../src/index.js";

/** One outbound HTTP request, reduced to what the API actually reads. */
type Wire = {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
};

type CallResult = {
  isError: boolean;
  text: string;
  wire: Wire | undefined;
  idempotencyKey: string | undefined;
};

type Call = (name: string, args?: Record<string, unknown>) => Promise<CallResult>;

async function connectClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

/**
 * Run `body` against a connected client whose every request is captured
 * instead of sent. `call` hands back the one request the tool made, if any,
 * alongside the tool's own reply.
 */
async function withCapturedRequests(body: (call: Call, client: Client) => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.SUDOMOCK_API_KEY;
  const captured: Array<{ wire: Wire; idempotencyKey: string | undefined }> = [];

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    captured.push({
      wire: {
        method: String(init?.method),
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: init?.body === undefined || init?.body === null ? undefined : JSON.parse(String(init.body)),
      },
      idempotencyKey: headers["Idempotency-Key"],
    });
    return Response.json({ success: true, data: {} });
  };
  process.env.SUDOMOCK_API_KEY = "sm_test";

  const client = await connectClient();
  try {
    const call: Call = async (name, args = {}) => {
      captured.length = 0;
      const result = await client.callTool({ name, arguments: args });
      const content = (result.content as Array<{ type: string; text?: string }>) ?? [];
      return {
        isError: result.isError === true,
        text: content.map((entry) => entry.text ?? "").join("\n"),
        wire: captured[0]?.wire,
        idempotencyKey: captured[0]?.idempotencyKey,
      };
    };
    await body(call, client);
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.SUDOMOCK_API_KEY;
    else process.env.SUDOMOCK_API_KEY = originalApiKey;
  }
}

const ART = "https://example.com/art.png";

/**
 * Each tool that gained a second name, with arguments that exercise it.
 *
 * The two spellings take the same arguments, so one set of arguments is sent
 * to both and the two requests are compared. `render_photo_mockup` is absent
 * on purpose: it is not a second name for one tool and has its own tests.
 */
const PAIRS: Array<[original: string, family: string, args: Record<string, unknown>]> = [
  [
    "list_mockups",
    "list_psd_mockups",
    {
      limit: 5,
      offset: 2,
      name: "tee",
      created_after: "2026-01-01T00:00:00Z",
      created_before: "2026-02-01T00:00:00Z",
      sort_by: "name",
      sort_order: "asc",
    },
  ],
  ["get_mockup_details", "get_psd_mockup", { mockup_uuid: "m1" }],
  ["update_mockup", "update_psd_mockup", { mockup_uuid: "m1", name: "Renamed" }],
  ["delete_mockup", "delete_psd_mockup", { mockup_uuid: "m1" }],
  [
    "render_mockup",
    "render_psd_mockup",
    { mockup_uuid: "m1", smart_object_uuid: "s1", artwork_url: ART },
  ],
  [
    "create_2d_mockup",
    "create_photo_mockup",
    { source_url: "https://example.com/product.jpg", name: "Mug", idempotency_key: "key-1" },
  ],
  ["list_2d_mockups", "list_photo_mockups", { limit: 7, offset: 1, customizable_only: true }],
  ["get_2d_mockup", "get_photo_mockup", { mockup_id: "p1" }],
  [
    "update_2d_print_areas",
    "update_photo_mockup_print_areas",
    {
      mockup_id: "p1",
      print_areas: [
        {
          points: [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
          ],
          name: "Chest",
        },
      ],
    },
  ],
  ["delete_2d_mockup", "delete_photo_mockup", { mockup_id: "p1" }],
];

/**
 * The request every name that shipped in 2.8.1 puts on the wire, written out
 * rather than recorded. This is the watchdog: if adding the family spellings
 * changes any of these by a single field, this is what says so.
 */
const PINNED_REQUESTS: Array<[tool: string, args: Record<string, unknown>, wire: Wire]> = [
  [
    "list_mockups",
    PAIRS[0][2],
    {
      method: "GET",
      path: "/api/v1/mockups",
      query: {
        limit: "5",
        offset: "2",
        name: "tee",
        created_after: "2026-01-01T00:00:00Z",
        created_before: "2026-02-01T00:00:00Z",
        sort: "name",
        order: "asc",
      },
      body: undefined,
    },
  ],
  [
    "get_mockup_details",
    { mockup_uuid: "m1" },
    { method: "GET", path: "/api/v1/mockups/m1", query: {}, body: undefined },
  ],
  [
    "update_mockup",
    { mockup_uuid: "m1", name: "Renamed" },
    { method: "PATCH", path: "/api/v1/mockups/m1", query: {}, body: { name: "Renamed" } },
  ],
  [
    "delete_mockup",
    { mockup_uuid: "m1" },
    { method: "DELETE", path: "/api/v1/mockups/m1", query: {}, body: undefined },
  ],
  [
    "render_mockup",
    { mockup_uuid: "m1", smart_object_uuid: "s1", artwork_url: ART },
    {
      method: "POST",
      path: "/api/v1/renders",
      query: {},
      body: {
        mockup_uuid: "m1",
        export_options: { image_format: "webp", image_size: 2048, quality: 90 },
        smart_objects: [
          {
            uuid: "s1",
            asset: {
              url: ART,
              fit: "fill",
              rotate: 0,
              flip_horizontal: false,
              flip_vertical: false,
            },
          },
        ],
      },
    },
  ],
  [
    "create_2d_mockup",
    { source_url: "https://example.com/product.jpg", name: "Mug", idempotency_key: "key-1" },
    {
      method: "POST",
      path: "/api/v1/sudoai/2d-mockups",
      query: {},
      body: { source_url: "https://example.com/product.jpg", name: "Mug" },
    },
  ],
  [
    "list_2d_mockups",
    { limit: 7, offset: 1, customizable_only: true },
    {
      method: "GET",
      path: "/api/v1/sudoai/2d-mockups",
      query: { limit: "7", offset: "1", customizable_only: "true" },
      body: undefined,
    },
  ],
  [
    "get_2d_mockup",
    { mockup_id: "p1" },
    { method: "GET", path: "/api/v1/sudoai/2d-mockups/p1", query: {}, body: undefined },
  ],
  [
    "update_2d_print_areas",
    PAIRS[8][2],
    {
      method: "PUT",
      path: "/api/v1/sudoai/2d-mockups/p1/print-areas",
      query: {},
      body: {
        print_areas: [
          {
            points: [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 10],
            ],
            name: "Chest",
          },
        ],
      },
    },
  ],
  [
    "delete_2d_mockup",
    { mockup_id: "p1" },
    { method: "DELETE", path: "/api/v1/sudoai/2d-mockups/p1", query: {}, body: undefined },
  ],
  [
    "render_2d_surface",
    { mockup_uuid: "p1", surface_uuid: "s1", artwork_url: ART, coverage: 80 },
    {
      method: "POST",
      path: "/api/v1/sudoai/2d-mockups/p1/render",
      query: {},
      body: {
        print_areas: [
          {
            surface_uuid: "s1",
            artwork_url: ART,
            adjustments: { opacity: 100, brightness: 0, contrast: 0, saturation: 0 },
            placement: { coverage: 80 },
          },
        ],
        export_options: { image_format: "webp", image_size: 2048, quality: 90 },
      },
    },
  ],
  [
    "render_2d_print_area",
    { mockup_uuid: "p1", print_area_uuid: "a1", artwork_url: ART, fit: "cover" },
    {
      method: "POST",
      path: "/api/v1/sudoai/2d-mockups/p1/render",
      query: {},
      body: {
        print_areas: [
          {
            uuid: "a1",
            artwork_url: ART,
            adjustments: { opacity: 100, brightness: 0, contrast: 0, saturation: 0 },
            placement: { fit: "cover" },
          },
        ],
        export_options: { image_format: "webp", image_size: 2048, quality: 90 },
      },
    },
  ],
];

// ---------------------------------------------------------------------------
// The watchdog: nothing that shipped was taken away or changed.
// ---------------------------------------------------------------------------

test("watchdog: every tool name 2.8.1 registered is still registered", async () => {
  await withCapturedRequests(async (_call, client) => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    const shippedIn281 = [
      "list_mockups",
      "get_mockup_details",
      "update_mockup",
      "delete_mockup",
      "render_mockup",
      "remove_background",
      "create_2d_mockup",
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
      "upload_local_file",
    ];
    for (const name of shippedIn281) {
      assert.ok(names.includes(name), `a name that shipped was removed: ${name}`);
    }
  });
});

test("watchdog: every tool name 2.8.1 registered still sends the same request", async () => {
  await withCapturedRequests(async (call) => {
    for (const [tool, args, expected] of PINNED_REQUESTS) {
      const { isError, wire } = await call(tool, args);
      assert.equal(isError, false, `${tool} refused a call it used to accept`);
      assert.deepEqual(wire, expected, `${tool} no longer sends the request it used to`);
    }
  });
});

test("watchdog: the 2D render tools refuse the same options with the same words", async () => {
  await withCapturedRequests(async (call) => {
    const surface = { mockup_uuid: "p1", surface_uuid: "s1", artwork_url: ART };
    const printArea = { mockup_uuid: "p1", print_area_uuid: "a1", artwork_url: ART };

    const fitOnSurface = await call("render_2d_surface", { ...surface, fit: "cover" });
    assert.equal(fitOnSurface.isError, true);
    assert.match(fitOnSurface.text, /so fit has nothing to fit against/);

    const coverageOnArea = await call("render_2d_print_area", { ...printArea, coverage: 50 });
    assert.equal(coverageOnArea.isError, true);
    assert.match(coverageOnArea.text, /so coverage has no meaning on one/);

    for (const [tool, args] of [
      ["render_2d_surface", surface],
      ["render_2d_print_area", printArea],
    ] as const) {
      const scale = await call(tool, { ...args, scale: 2 });
      assert.equal(scale.isError, true, `${tool} stopped refusing scale`);
      assert.match(scale.text, /scale has been retired/, `${tool} changed its scale refusal`);
    }

    const halfASize = await call("render_2d_surface", { ...surface, width: 100 });
    assert.equal(halfASize.isError, true);
    assert.match(halfASize.text, /width and height must be provided together/);
  });
});

// ---------------------------------------------------------------------------
// The addition: the family spellings reach the same handlers.
// ---------------------------------------------------------------------------

test("every family spelling is registered beside the name it was added to", async () => {
  await withCapturedRequests(async (_call, client) => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const [original, family] of PAIRS) {
      assert.ok(names.includes(original), `missing original: ${original}`);
      assert.ok(names.includes(family), `missing family spelling: ${family}`);
    }
    assert.ok(names.includes("render_photo_mockup"));
  });
});

test("a family spelling takes exactly the arguments its original takes", async () => {
  await withCapturedRequests(async (_call, client) => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const [original, family] of PAIRS) {
      assert.deepEqual(
        byName.get(family)?.inputSchema,
        byName.get(original)?.inputSchema,
        `${family} and ${original} do not take the same arguments`
      );
      const familyDescription = byName.get(family)?.description ?? "";
      assert.ok(
        familyDescription.includes(byName.get(original)?.description ?? " "),
        `${family} does not carry ${original}'s description`
      );
      assert.ok(familyDescription.includes(original), `${family} does not name ${original}`);
    }
  });
});

test("a family spelling sends the same request as the name it was added beside", async () => {
  await withCapturedRequests(async (call) => {
    for (const [original, family, args] of PAIRS) {
      const before = await call(original, args);
      const after = await call(family, args);
      assert.equal(after.isError, false, `${family} refused a call ${original} accepts`);
      assert.deepEqual(after.wire, before.wire, `${family} does not send what ${original} sends`);
      assert.deepEqual(
        after.idempotencyKey,
        before.idempotencyKey,
        `${family} does not carry ${original}'s idempotency key`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// render_photo_mockup: one tool, one target, both branches.
// ---------------------------------------------------------------------------

test("render_photo_mockup on a surface sends what render_2d_surface sends", async () => {
  await withCapturedRequests(async (call) => {
    const before = await call("render_2d_surface", {
      mockup_uuid: "p1",
      surface_uuid: "s1",
      artwork_url: ART,
      coverage: 80,
      position: "top_left",
      offset_x: 12,
      rotation: 15,
      image_format: "png",
      quality: 77,
    });
    const after = await call("render_photo_mockup", {
      mockup_id: "p1",
      surface_uuid: "s1",
      artwork_url: ART,
      coverage: 80,
      position: "top_left",
      offset_x: 12,
      rotation: 15,
      image_format: "png",
      quality: 77,
    });
    assert.equal(after.isError, false);
    assert.deepEqual(after.wire, before.wire);
  });
});

test("render_photo_mockup on a print area sends what render_2d_print_area sends", async () => {
  await withCapturedRequests(async (call) => {
    const before = await call("render_2d_print_area", {
      mockup_uuid: "p1",
      print_area_uuid: "a1",
      artwork_url: ART,
      width: 400,
      height: 250,
      remove_background: true,
      opacity: 60,
      is_async: true,
    });
    const after = await call("render_photo_mockup", {
      mockup_id: "p1",
      print_area_uuid: "a1",
      artwork_url: ART,
      width: 400,
      height: 250,
      remove_background: true,
      opacity: 60,
      is_async: true,
    });
    assert.equal(after.isError, false);
    assert.deepEqual(after.wire, before.wire);
  });
});

test("render_photo_mockup refuses every shape that names the wrong number of targets", async () => {
  await withCapturedRequests(async (call) => {
    const base = { mockup_id: "p1", artwork_url: ART };

    const noTarget = await call("render_photo_mockup", base);
    assert.equal(noTarget.isError, true);
    assert.match(noTarget.text, /exactly one of print_area_uuid or surface_uuid/);
    assert.equal(noTarget.wire, undefined, "a refused call still reached the API");

    const twoTargets = await call("render_photo_mockup", {
      ...base,
      surface_uuid: "s1",
      print_area_uuid: "a1",
    });
    assert.equal(twoTargets.isError, true);
    assert.match(twoTargets.text, /exactly one of print_area_uuid or surface_uuid/);
    assert.equal(twoTargets.wire, undefined, "a refused call still reached the API");
  });
});

test("render_photo_mockup refuses the dial that belongs to the other kind of target", async () => {
  await withCapturedRequests(async (call) => {
    const base = { mockup_id: "p1", artwork_url: ART };

    const fitOnSurface = await call("render_photo_mockup", {
      ...base,
      surface_uuid: "s1",
      fit: "cover",
    });
    assert.equal(fitOnSurface.isError, true);
    assert.match(fitOnSurface.text, /so fit has nothing to fit against/);
    assert.equal(fitOnSurface.wire, undefined);

    const coverageOnArea = await call("render_photo_mockup", {
      ...base,
      print_area_uuid: "a1",
      coverage: 50,
    });
    assert.equal(coverageOnArea.isError, true);
    assert.match(coverageOnArea.text, /so coverage has no meaning on one/);
    assert.equal(coverageOnArea.wire, undefined);
  });
});

test("render_photo_mockup refuses a retired option and a half-written size", async () => {
  await withCapturedRequests(async (call) => {
    const surface = { mockup_id: "p1", artwork_url: ART, surface_uuid: "s1" };
    const printArea = { mockup_id: "p1", artwork_url: ART, print_area_uuid: "a1" };

    const scale = await call("render_photo_mockup", { ...surface, scale: 2 });
    assert.equal(scale.isError, true);
    assert.match(scale.text, /scale has been retired/);

    const unknown = await call("render_photo_mockup", { ...surface, sharpen: 3 });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /sharpen is not an option on this tool/);

    const widthOnly = await call("render_photo_mockup", { ...printArea, width: 400 });
    assert.equal(widthOnly.isError, true);
    assert.match(widthOnly.text, /width and height must be provided together/);
    assert.equal(widthOnly.wire, undefined);

    const twoAnswersOnSurface = await call("render_photo_mockup", {
      ...surface,
      coverage: 80,
      width: 400,
      height: 250,
    });
    assert.equal(twoAnswersOnSurface.isError, true);
    assert.match(twoAnswersOnSurface.text, /coverage and an explicit width and height/);

    const twoAnswersOnArea = await call("render_photo_mockup", {
      ...printArea,
      fit: "cover",
      width: 400,
      height: 250,
    });
    assert.equal(twoAnswersOnArea.isError, true);
    assert.match(twoAnswersOnArea.text, /fit and an explicit width and height/);
  });
});
