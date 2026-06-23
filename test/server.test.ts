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
  "render_mockup",
  "render_2d_mockup",
  "list_2d_mockups",
  "get_2d_mockup",
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
