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

test("2D setup preserves paid-job handles and uses the public payload contract", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.SUDOMOCK_API_KEY;
  const quad = [[10, 20], [110, 20], [110, 120], [10, 120]];
  const idempotencyKeys = new Set<string>();
  const pollAttempts = new Map<string, number>();

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
      let outcome = "created";
      if (body.source_base64) {
        assert.deepEqual(Object.keys(body).sort(), ["name", "source_base64"]);
        assert.equal(body.source_base64, "data:image/png;base64,c291cmNl");
      } else {
        assert.deepEqual(Object.keys(body), ["source_url"]);
        outcome = body.source_url.includes("unsuitable")
          ? "rejected"
          : body.source_url.includes("timeout")
            ? "timeout"
            : body.source_url.includes("pending")
              ? "pending"
              : body.source_url.includes("recover")
                ? "recovered"
                : "created";
      }
      return new Response(
        JSON.stringify({
          job_id: `job-${outcome}`,
          kind: "2d_create",
          status: "queued",
          status_url: `/api/v1/jobs/job-${outcome}`,
        }),
        { status: 202, headers: { "Content-Type": "application/json" } }
      );
    }

    if (method === "GET" && url.endsWith("/api/v1/jobs/job-created")) {
      return Response.json({
        job_id: "job-created",
        status: "succeeded",
        mockup_uuid: "mockup-123",
        result_url: "/api/v1/sudoai/2d-mockup/mockup-123",
      });
    }

    if (method === "GET" && url.endsWith("/api/v1/jobs/job-rejected")) {
      return Response.json({
        job_id: "job-rejected",
        kind: "2d_create",
        status: "failed",
        result_url: null,
        mockup_uuid: null,
        error: {
          error_code: "NOT_MOCKUPABLE",
          message: "The image is not suitable for mockup generation.",
        },
      });
    }

    if (method === "GET" && url.endsWith("/api/v1/jobs/job-timeout")) {
      return Response.json({ job_id: "job-timeout", status: "running" });
    }

    if (method === "GET" && url.endsWith("/api/v1/jobs/job-pending")) {
      pollAttempts.set("pending", (pollAttempts.get("pending") ?? 0) + 1);
      return Response.json({ detail: "temporary failure" }, { status: 500 });
    }

    if (method === "GET" && url.endsWith("/api/v1/jobs/job-recovered")) {
      const attempts = (pollAttempts.get("recovered") ?? 0) + 1;
      pollAttempts.set("recovered", attempts);
      if (attempts === 1) {
        return Response.json({ detail: "temporary failure" }, { status: 500 });
      }
      return Response.json({
        job_id: "job-recovered",
        status: "succeeded",
        mockup_uuid: "mockup-recovered",
        result_url: "/api/v1/sudoai/2d-mockup/mockup-recovered",
      });
    }

    if (method === "GET" && url.endsWith("/api/v1/sudoai/2d-mockup/mockup-123")) {
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

    if (method === "GET" && url.endsWith("/api/v1/sudoai/2d-mockup/mockup-recovered")) {
      return Response.json({ detail: "temporary failure" }, { status: 500 });
    }

    if (method === "PUT" && url.endsWith("/api/v1/sudoai/2d-mockup/mockup-123/print-areas")) {
      assert.deepEqual(JSON.parse(String(init?.body)), { print_areas: [{ points: quad }] });
      return Response.json({ data: { print_areas: [{ print_area_id: "area-2", points: quad }] }, success: true });
    }

    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  process.env.SUDOMOCK_API_KEY = "sm_test";

  const client = await connectClient();
  try {
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
    assert.equal(created.source_width, 1200);
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

    const rejectedResult = await client.callTool({
      name: "create_2d_mockup",
      arguments: { source_url: "https://example.com/unsuitable.jpg" },
    });
    const rejected = JSON.parse(
      (rejectedResult.content as Array<{ type: "text"; text: string }>)[0].text
    );
    assert.equal(rejected.error_code, "NOT_MOCKUPABLE");
    assert.equal(rejected.reason, "The image is not suitable for mockup generation.");
    assert.equal(rejected.message, "credits refunded automatically");

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

    const originalDateNow = Date.now;
    const times = [0, 0, 50_000];
    Date.now = () => times.shift() ?? 50_000;
    try {
      const timeoutResult = await client.callTool({
        name: "create_2d_mockup",
        arguments: { source_url: "https://example.com/timeout.jpg" },
      });
      const timedOut = JSON.parse(
        (timeoutResult.content as Array<{ type: "text"; text: string }>)[0].text
      );
      assert.equal(timedOut.status, "timed_out");
      assert.equal(timedOut.job_id, "job-timeout");
      assert.equal(timedOut.status_url, "/api/v1/jobs/job-timeout");
      assert.match(timedOut.next_step, /get_job/);
    } finally {
      Date.now = originalDateNow;
    }

    const pendingResult = await client.callTool({
      name: "create_2d_mockup",
      arguments: { source_url: "https://example.com/pending.jpg" },
    });
    const pending = JSON.parse(
      (pendingResult.content as Array<{ type: "text"; text: string }>)[0].text
    );
    assert.equal(pollAttempts.get("pending"), 2);
    assert.equal(pending.status, "pending");
    assert.equal(pending.job_id, "job-pending");
    assert.equal(pending.status_url, "/api/v1/jobs/job-pending");

    const recoveredResult = await client.callTool({
      name: "create_2d_mockup",
      arguments: { source_url: "https://example.com/recover.jpg" },
    });
    const recovered = JSON.parse(
      (recoveredResult.content as Array<{ type: "text"; text: string }>)[0].text
    );
    assert.equal(pollAttempts.get("recovered"), 2);
    assert.deepEqual(recovered, {
      mockup_id: "mockup-recovered",
      result_url: "/api/v1/sudoai/2d-mockup/mockup-recovered",
      status_url: "/api/v1/jobs/job-recovered",
    });

    const updatedResult = await client.callTool({
      name: "update_2d_print_areas",
      arguments: { mockup_id: "mockup-123", print_areas: [{ points: quad }] },
    });
    const updated = JSON.parse(
      (updatedResult.content as Array<{ type: "text"; text: string }>)[0].text
    );
    assert.equal(updated.data.print_areas[0].print_area_id, "area-2");
    assert.equal(idempotencyKeys.size, 5);
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
