import { test } from "node:test";
import assert from "node:assert/strict";
import { command, lastLines } from "../process.mjs";

const node = process.execPath;

test("lastLines keeps the final non-empty lines", () => {
  assert.equal(lastLines("Traceback (most recent call last):\n  File x\nModuleNotFoundError: No module named 'faster_whisper'\n\n", 1), "ModuleNotFoundError: No module named 'faster_whisper'");
  assert.equal(lastLines("a\nb\nc"), "b | c");
  assert.equal(lastLines(""), "");
  assert.equal(lastLines("    model = WhisperModel(\n    )\n    ^^^^^\nValueError: Invalid model size"), "model = WhisperModel( | ValueError: Invalid model size");
});

test("a failing command reports its exit code and stderr", async () => {
  await assert.rejects(command(node, ["-e", "console.error('first'); console.error('boom: bad input'); process.exit(3)"]).done, /^Error: node(\.exe)? failed \(exit 3\): first \| boom: bad input$/);
});

test("a successful command resolves", async () => {
  await command(node, ["-e", "console.error('noise is fine')"]).done;
});

test("timeouts and cancellations are named as such", async () => {
  await assert.rejects(command(node, ["-e", "setTimeout(() => {}, 10000)"], { timeout: 200 }).done, /timed out after 0s/);
  const controller = new AbortController();
  const run = command(node, ["-e", "setTimeout(() => {}, 10000)"], { signal: controller.signal });
  controller.abort();
  await assert.rejects(run.done, /was cancelled/);
});

test("a missing program says it could not start", async () => {
  await assert.rejects(command("definitely-not-a-real-program-xyz", []).done, /could not start \(ENOENT\)/);
});

test("encodes get time in proportion to the video's length, at least five minutes", async () => {
  const { encodeTimeout } = await import("../render.mjs");
  assert.equal(encodeTimeout(5), 300_000);
  assert.equal(encodeTimeout(44), 880_000);
  assert.equal(encodeTimeout(56.2), 1_140_000);
});
