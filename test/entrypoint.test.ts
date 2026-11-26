/**
 * npx runs the bin through a symlink in node_modules/.bin. The entrypoint
 * check must resolve it, or the process exits 0 without ever serving.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

test("entry run through a symlink answers initialize", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = join(here, "..", "..", "dist", "index.js");
  const link = join(mkdtempSync(join(realpathSync(tmpdir()), "sm-mcp-")), "sudomock-mcp");
  symlinkSync(entry, link);

  const child = spawn(process.execPath, [link], {
    env: { ...process.env, SUDOMOCK_API_KEY: "x" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const reply = new Promise<string>((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      if (buf.includes("\n")) resolve(buf);
    });
    child.on("exit", () => reject(new Error("server exited without answering")));
    setTimeout(() => reject(new Error("no answer in 15s")), 15000);
  });
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }) + "\n",
  );
  try {
    const msg = JSON.parse(await reply);
    assert.ok(msg.result?.serverInfo?.name);
  } finally {
    child.kill();
  }
});
