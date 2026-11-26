import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { ZIP_PATH, crc32, shipped, zip } from "../scripts/pack-worker.mjs";

test("the worker download is packed outside public/, so it's never served without sign-in", () => {
  assert.ok(!/[\\/]public[\\/]/.test(ZIP_PATH), ZIP_PATH);
  assert.match(ZIP_PATH, /[\\/]outputs[\\/]clipflow-worker\.zip$/);
});

test("the worker download ships the worker's code, not its tests, tools, data or .env", () => {
  for (const p of ["worker/main.mjs", "worker/captions.py", "worker/Setup Clipflow.cmd", "worker/setup-windows.ps1", "worker/README.md"]) assert.ok(shipped(p), p);
  for (const p of ["worker/test/core.test.mjs", "worker/tools/compare-viewer-clips.mjs", "worker/data/worker.log", "worker/.env", "worker/__pycache__/x.pyc", "app/page.tsx"]) assert.ok(!shipped(p), p);
});

test("zip() writes a valid archive: each entry's name, CRC and deflated bytes read back", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  const files = [{ name: "clipflow-worker/a.txt", data: Buffer.from("hello ".repeat(100)) }, { name: "clipflow-worker/Setup Clipflow.cmd", data: Buffer.from("@echo off\r\n") }];
  const z = zip(files, new Date(2026, 10, 26, 12, 30, 10));
  // End of central directory: 2 entries.
  const end = z.length - 22;
  assert.equal(z.readUInt32LE(end), 0x06054b50);
  assert.equal(z.readUInt16LE(end + 10), 2);
  // Walk the local entries.
  let at = 0;
  for (const f of files) {
    assert.equal(z.readUInt32LE(at), 0x04034b50);
    const size = z.readUInt32LE(at + 18), nameLen = z.readUInt16LE(at + 26);
    assert.equal(z.subarray(at + 30, at + 30 + nameLen).toString("utf8"), f.name);
    assert.equal(z.readUInt32LE(at + 14), crc32(f.data));
    assert.deepEqual(inflateRawSync(z.subarray(at + 30 + nameLen, at + 30 + nameLen + size)), f.data);
    at += 30 + nameLen + size;
  }
  assert.equal(z.readUInt32LE(end + 16), at, "the central directory starts right after the entries");
});
