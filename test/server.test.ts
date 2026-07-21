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
  "render_2d_mockup",
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
  "create_studio_session",
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

    for (const tool of tools) {
      assert.equal(typeof tool.description, "string", `${tool.name} has no description`);
      assert.ok((tool.description ?? "").length > 0, `${tool.name} description is empty`);
      assert.equal(tool.inputSchema.type, "object", `${tool.name} input schema is not an object`);
    }
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

test("2D create is sync-default (201) and every 2D path is plural + black-box", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.SUDOMOCK_API_KEY;
  const quad = [[10, 20], [110, 20], [110, 120], [10, 120]];
  const idempotencyKeys = new Set<string>();

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (method === "POST" && url.endsWith("/api/v1/sudoai/2d-mockups")) {
      const headers = new Headers(init?.headers);
      const idempotencyKey = headers.get("Idempotency-Key") ?? "";
      assert.match(idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert.ok(!idempotencyKeys.has(idempotencyKey), "create calls must use unique idempotency keys");
      idempotencyKeys.add(idempotencyKey);

      const body = JSON.parse(String(init?.body));

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

      if (body.source_base64) {
        assert.deepEqual(Object.keys(body).sort(), ["name", "source_base64"]);
        assert.equal(body.source_base64, "data:image/png;base64,c291cmNl");
      } else {
        // Unsuitable image -> BE rejects with an error body (credits refunded),
        // no async job in the sync-default flow.
        if (body.source_url.includes("unsuitable")) {
          return Response.json(
            { detail: "The image is not suitable for mockup generation." },
            { status: 422 }
          );
        }
        // Optional customer-seeded print areas (with names) pass through verbatim.
        if (body.source_url.includes("seed")) {
          assert.deepEqual(body.print_areas, [{ points: quad, name: "Front" }]);
        }
      }

      return Response.json(
        {
          data: {
            mockup_id: "mockup-123",
            name: body.name ?? null,
            status: "ready",
            source_width: 1200,
            source_height: 900,
            quads: [{ print_area_id: "area-1", points: quad }],
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
          source_width: 1200,
          source_height: 900,
          quads: [{ print_area_id: "area-1", points: quad }],
        },
        success: true,
      });
    }

    if (method === "POST" && url.endsWith("/api/v1/sudoai/2d-mockups/mockup-123/render")) {
      const body = JSON.parse(String(init?.body));
      // render carries the mockup id in the PATH, never in the body.
      assert.ok(!("mockup_uuid" in body), "render body must not carry mockup_uuid");
      assert.equal(body.print_areas[0].uuid, "area-1");
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
      assert.deepEqual(JSON.parse(String(init?.body)), {
        print_areas: [{ points: quad, name: "Front" }],
      });
      return Response.json({
        data: { print_areas: [{ print_area_id: "area-2", points: quad, name: "Front" }] },
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
        source_base64: "c291cmNl",
        source_content_type: "image/png",
        name: "Product",
      },
    });
    const created = JSON.parse(
      (createdResult.content as Array<{ type: "text"; text: string }>)[0].text
    );
    assert.equal(created.mockup_id, "mockup-123");
    assert.equal(created.name, "Product");
    assert.equal(created.status, "ready");
    assert.equal(created.source_width, 1200);
    // Black-box: quads surfaced as print_areas, no mask/segment primitives.
    assert.deepEqual(created.print_areas, [{ print_area_id: "area-1", points: quad }]);

    const detailsResult = await client.callTool({
      name: "get_2d_mockup",
      arguments: { mockup_id: "mockup-123" },
    });
    const details = JSON.parse(
      (detailsResult.content as Array<{ type: "text"; text: string }>)[0].text
    );
    assert.deepEqual(details.data.print_areas, [{ print_area_id: "area-1", points: quad }]);
    assert.ok(!("quads" in details.data));

    // Unsuitable image -> error body -> tool surfaces an error result.
    const rejectedResult = await client.callTool({
      name: "create_2d_mockup",
      arguments: { source_url: "https://example.com/unsuitable.jpg" },
    });
    assert.equal(rejectedResult.isError, true);

    const neitherSource = await client.callTool({
      name: "create_2d_mockup",
      arguments: {},
    });
    assert.equal(neitherSource.isError, true);
    const bothSources = await client.callTool({
      name: "create_2d_mockup",
      arguments: { source_url: "https://example.com/product.jpg", source_base64: "c291cmNl" },
    });
    assert.equal(bothSources.isError, true);

    // Customer-seeded print areas (with names) pass through to the create body.
    const seededResult = await client.callTool({
      name: "create_2d_mockup",
      arguments: {
        source_url: "https://example.com/seed.jpg",
        print_areas: [{ points: quad, name: "Front" }],
      },
    });
    const seeded = JSON.parse(
      (seededResult.content as Array<{ type: "text"; text: string }>)[0].text
    );
    assert.equal(seeded.mockup_id, "mockup-123");

    // is_async=true still returns the job-accepted contract.
    const asyncResult = await client.callTool({
      name: "create_2d_mockup",
      arguments: { source_url: "https://example.com/async.jpg", is_async: true },
    });
    const asyncJob = JSON.parse(
      (asyncResult.content as Array<{ type: "text"; text: string }>)[0].text
    );
    assert.equal(asyncJob.accepted, true);
    assert.equal(asyncJob.job_id, "job-async");
    assert.equal(asyncJob.status_url, "/api/v1/jobs/job-async");

    // render posts to the plural path with the id in the path + print_files/render_uuid back.
    const renderResult = await client.callTool({
      name: "render_2d_mockup",
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

    // render is_async=true returns the job-accepted contract (mirrors create).
    const asyncRenderResult = await client.callTool({
      name: "render_2d_mockup",
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

    // Four creates reached the POST (base64, unsuitable, seed, async); neither/both
    // fail validation before any request.
    assert.equal(idempotencyKeys.size, 4);
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
    formatJobAccepted({ job_id: "job-123", kind: "render", status: "queued" })
  );
  assert.equal(out.accepted, true);
  assert.equal(out.job_id, "job-123");
  assert.equal(out.kind, "render");
  assert.equal(out.status, "queued");
  assert.equal(out.status_url, "/api/v1/jobs/job-123");
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
