/**
 * Guarantees for reading a local file off the user's disk.
 *
 * The model picks the path, so the path is untrusted input. Three things have to
 * hold: only the extensions a kind can actually process are read, SUDOMOCK_UPLOAD_DIR
 * confines reads to one tree when it is set, and a symlink cannot walk out of that
 * tree (which is why realpath runs before the containment check, not after).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readLocalUpload } from "../src/index.js";

const PSD_BYTES = Buffer.concat([Buffer.from("8BPS"), Buffer.alloc(60)]);

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sudomock-upload-"));
}

test("reads a file whose extension the kind accepts", async () => {
  const dir = await scratch();
  const file = join(dir, "template.psd");
  await writeFile(file, PSD_BYTES);

  const bytes = await readLocalUpload(file, "psd");

  assert.equal(bytes.length, PSD_BYTES.length);
  assert.equal(bytes.subarray(0, 4).toString(), "8BPS");
  await rm(dir, { recursive: true, force: true });
});

test("refuses an extension the kind cannot process", async () => {
  const dir = await scratch();
  const file = join(dir, "payload.exe");
  await writeFile(file, PSD_BYTES);

  await assert.rejects(() => readLocalUpload(file, "psd"), /psd uploads accept/);
  await rm(dir, { recursive: true, force: true });
});

test("an image is not a psd and a psd is not an image", async () => {
  const dir = await scratch();
  await writeFile(join(dir, "logo.png"), PSD_BYTES);
  await writeFile(join(dir, "template.psd"), PSD_BYTES);

  await assert.rejects(() => readLocalUpload(join(dir, "logo.png"), "psd"));
  await assert.rejects(() => readLocalUpload(join(dir, "template.psd"), "artwork"));
  await rm(dir, { recursive: true, force: true });
});

test("an empty file is refused rather than uploaded", async () => {
  const dir = await scratch();
  const file = join(dir, "empty.psd");
  await writeFile(file, Buffer.alloc(0));

  await assert.rejects(() => readLocalUpload(file, "psd"), /empty/);
  await rm(dir, { recursive: true, force: true });
});

test("a missing file reports the path rather than throwing raw ENOENT", async () => {
  const dir = await scratch();

  await assert.rejects(() => readLocalUpload(join(dir, "nope.psd"), "psd"), /No file at/);
  await rm(dir, { recursive: true, force: true });
});

test("SUDOMOCK_UPLOAD_DIR confines reads to its tree", async () => {
  const root = await scratch();
  const inside = join(root, "allowed");
  const outside = await scratch();
  await mkdir(inside, { recursive: true });
  await writeFile(join(inside, "ok.psd"), PSD_BYTES);
  await writeFile(join(outside, "secret.psd"), PSD_BYTES);

  const previous = process.env.SUDOMOCK_UPLOAD_DIR;
  process.env.SUDOMOCK_UPLOAD_DIR = inside;
  try {
    const bytes = await readLocalUpload(join(inside, "ok.psd"), "psd");
    assert.equal(bytes.length, PSD_BYTES.length);

    await assert.rejects(
      () => readLocalUpload(join(outside, "secret.psd"), "psd"),
      /only files under/
    );
  } finally {
    if (previous === undefined) delete process.env.SUDOMOCK_UPLOAD_DIR;
    else process.env.SUDOMOCK_UPLOAD_DIR = previous;
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("a symlink cannot walk out of SUDOMOCK_UPLOAD_DIR", async () => {
  const root = await scratch();
  const inside = join(root, "allowed");
  const outside = await scratch();
  await mkdir(inside, { recursive: true });
  await writeFile(join(outside, "secret.psd"), PSD_BYTES);
  await symlink(join(outside, "secret.psd"), join(inside, "innocent.psd"));

  const previous = process.env.SUDOMOCK_UPLOAD_DIR;
  process.env.SUDOMOCK_UPLOAD_DIR = inside;
  try {
    await assert.rejects(
      () => readLocalUpload(join(inside, "innocent.psd"), "psd"),
      /only files under/
    );
  } finally {
    if (previous === undefined) delete process.env.SUDOMOCK_UPLOAD_DIR;
    else process.env.SUDOMOCK_UPLOAD_DIR = previous;
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("with no confinement set, any accepted extension is readable", async () => {
  const dir = await scratch();
  const file = join(dir, "template.psd");
  await writeFile(file, PSD_BYTES);

  const previous = process.env.SUDOMOCK_UPLOAD_DIR;
  delete process.env.SUDOMOCK_UPLOAD_DIR;
  try {
    const bytes = await readLocalUpload(file, "psd");
    assert.equal(bytes.length, PSD_BYTES.length);
  } finally {
    if (previous !== undefined) process.env.SUDOMOCK_UPLOAD_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
