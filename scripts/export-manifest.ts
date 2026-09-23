/**
 * Export the tool manifest the way a client sees it.
 *
 * The catalogue that the dashboard and the documentation render used to be a
 * hand-kept copy of this list, and it drifted: it promised eight tools that had
 * never existed here and omitted eight that did, including the ones the agent
 * setup instructions told clients to call. The test that should have caught it
 * compared the copy against another copy.
 *
 * So the manifest is read over the protocol rather than parsed out of the
 * source: what ships here is exactly what a connected client is offered.
 */
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { server } from "../src/index.js";

const OUT = process.argv[2] ?? "manifest.json";

async function main() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "manifest-export", version: "0.0.0" });
  await client.connect(clientTransport);

  const { tools } = await client.listTools();

  let prompts: unknown[] = [];
  let resources: unknown[] = [];
  try { prompts = (await client.listPrompts()).prompts ?? []; } catch { prompts = []; }
  try { resources = (await client.listResources()).resources ?? []; } catch { resources = []; }

  if (!tools.length) {
    console.error("The server offered no tools; refusing to publish an empty manifest.");
    process.exit(1);
  }

  const manifest = {
    generator: "scripts/export-manifest.ts",
    tools: tools
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    prompts: prompts.map((p: any) => ({ name: p.name, description: p.description ?? "" })),
    resources: resources.map((r: any) => ({ uri: r.uri, name: r.name ?? "" })),
  };

  writeFileSync(OUT, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Wrote ${manifest.tools.length} tools, ${manifest.prompts.length} prompts and ${manifest.resources.length} resources to ${OUT}`);
  process.exit(0);
}

main().catch((error) => {
  console.error("Manifest export failed:", error);
  process.exit(1);
});
