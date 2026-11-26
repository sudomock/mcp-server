// Fills the library's size from the live API into every file that states it:
// src/library-size.ts (the tool description) and the package, registry and
// README descriptions. publish.yml runs it before the build, so each release
// states the figure of its day. When the API cannot answer, the files keep
// the figures they have and the release goes on.
import { readFileSync, writeFileSync } from "node:fs";

const SOURCE = "https://api.sudomock.com/api/v1/library/size";
const FLOOR_FILES = ["README.md", "package.json", "server.json"];

let size;
try {
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(10_000), redirect: "error" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const answer = await res.json();
  // The answer lands in release files and a tool description, so only these
  // four values are taken, and only in the shape the API writes them.
  const counts = [answer.templates, answer.product_types];
  if (!counts.every((n) => Number.isInteger(n) && n >= 1) || !/^\d{1,3}(,\d{3})*\+?$/.test(answer.mockups_floor)) {
    throw new Error("the answer is not a library size");
  }
  size = {
    mockups_floor: answer.mockups_floor,
    templates: answer.templates,
    product_types: answer.product_types,
  };
} catch (err) {
  console.warn(`library size: kept the current figures (${err.message})`);
  process.exit(0);
}

writeFileSync(
  "src/library-size.ts",
  "// Written by scripts/sync-library-size.mjs from the live API; run `npm run sync:library-size`, do not edit by hand.\n" +
    `export const LIBRARY_SIZE = ${JSON.stringify(size)} as const;\n`,
);
for (const file of FLOOR_FILES) {
  const text = readFileSync(file, "utf8");
  const next = text.replace(/[\d,]+\+ ready-made mockups/g, `${size.mockups_floor} ready-made mockups`);
  if (next === text && !text.includes(`${size.mockups_floor} ready-made mockups`)) {
    console.warn(`library size: ${file} no longer says "<n>+ ready-made mockups"`);
  }
  writeFileSync(file, next);
}
console.log(`library size: ${size.mockups_floor} mockups, ${size.templates} templates, ${size.product_types} product types`);
