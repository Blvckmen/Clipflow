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

test('errors keep their reason, not a stream link\'s access token', async () => {
  const { lastLines: last, hideQueries } = await import('../process.mjs');
  const token = 'eyJ0eXAiOiJKV1Qi.' + 'x'.repeat(900) + '.sig';
  const err = `error: Unable to open URL: https://abc.playback.live-video.net/api/video/v1/x.m3u8?token=${token} (403 Client Error: Forbidden for url: https://abc.playback.live-video.net/api/x.m3u8?token=${token})`;
  const said = last(err, 1);
  assert.ok(!said.includes('xxxx') && said.includes('403 Client Error: Forbidden'), said);
  assert.equal(hideQueries('see https://a.b/c?d=1&e=2, and http://x.y/z'), 'see https://a.b/c?…, and http://x.y/z');
});

test("stderr redacts huge signed URLs before truncation, across arbitrary chunks", async () => {
  const { PassThrough } = await import("node:stream");
  const { tail } = await import("../process.mjs");
  const token="SECRET".repeat(3000);
  const url="https://cdn.example/live.m3u8?token="+token;
  const message="error: Unable to open URL: "+url+" (403 Client Error: Forbidden for url: "+url+")";
  for (const size of [1,7,4096,message.length]) {
    const stream=new PassThrough();
    const output=tail(stream);
    for (let i=0;i<message.length;i+=size) {
      stream.write(message.slice(i,i+size));
      assert.ok(!output.text.includes("SECRET"));
      assert.ok(output.text.length<=4000);
    }
    assert.match(lastLines(output.text,1),/403 Client Error: Forbidden/);
    stream.end();
  }
});

test("stderr retains recent diagnostics and an unfinished final line", async () => {
  const { PassThrough } = await import("node:stream");
  const { tail } = await import("../process.mjs");
  const stream=new PassThrough();
  const output=tail(stream);
  stream.write("old noise\n".repeat(1000));
  stream.write("error: Read timeout, exiting");
  assert.equal(lastLines(output.text,1),"error: Read timeout, exiting");
  assert.ok(output.text.length<=4000);
  stream.end();
});
