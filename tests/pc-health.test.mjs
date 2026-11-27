import { test } from "node:test";
import assert from "node:assert/strict";
import { pcProblems } from "../lib/pc-health.mjs";

const now = Date.parse("2026-11-23T12:00:00Z");
const healthy = { checkedAt: "2026-11-23T11:55:00Z", diskFreeGb: 91, diskTotalGb: 475, ffmpeg: true, streamlink: true, whisper: true, whisperModel: "small", whisperReady: true, ollama: "ok", ollamaMissing: [], codeChanged: false };
const device = (health = {}, extra = {}) => ({ recording: [], making: 0, waiting: 0, held: 0, oldestWaitMin: 0, health: { ...healthy, ...health }, ...extra });
const ids = (d, o = {}) => pcProblems(d, { now, ...o }).map(p => p.id);

test("a healthy PC has no problems, and no report means nothing to say", () => {
  assert.deepEqual(ids(device()), []);
  assert.deepEqual(ids(null), []);
  assert.deepEqual(ids({ recording: [] }), []);
});

test("each broken part is named with a fix, worst first", () => {
  const p = pcProblems(device({ diskFreeGb: 3, ffmpeg: false, ollama: "down", whisperReady: false, whisperModel: "medium" }), { now });
  assert.deepEqual(p.map(x => [x.id, x.level]), [["disk", "bad"], ["ffmpeg", "bad"], ["ollama", "warn"], ["whisper-model", "info"]]);
  assert.match(p.find(x => x.id === "whisper-model").fix, /1\.5 GB/);
  assert.deepEqual(ids(device({ diskFreeGb: 12 })), ["disk"]);
  assert.equal(pcProblems(device({ diskFreeGb: 12 }), { now })[0].level, "warn");
  assert.deepEqual(ids(device({ whisper: false, whisperReady: false })), ["whisper"], "the model download doesn't matter while Whisper is missing");
  assert.match(pcProblems(device({ ollamaMissing: ["qwen2.5:3b"] }), { now })[0].fix, /ollama pull qwen2\.5:3b/);
  assert.deepEqual(ids(device({ ollama: "off" })), [], "the writer turned off isn't a problem");
});

test("an update waiting offers a restart, which then shows what it waits for", () => {
  const waiting = pcProblems(device({ codeChanged: true }), { now });
  assert.equal(waiting[0].action, "restart");
  const pending = pcProblems(device({ codeChanged: true }, { restartPending: true, recording: ["a", "b"] }), { now });
  assert.deepEqual(pending.map(p => p.id), ["restarting"]);
  assert.match(pending[0].fix, /2 recordings/);
});

test("falling behind, stale reports and an offline PC", () => {
  assert.match(pcProblems(device({}, { oldestWaitMin: 45 }), { now })[0].title, /45 minutes/);
  assert.match(pcProblems(device({}, { oldestWaitMin: 180 }), { now })[0].title, /3 hours/);
  assert.deepEqual(ids(device({}, { oldestWaitMin: 25 })), []);
  assert.deepEqual(ids(device({ checkedAt: "2026-11-23T10:00:00Z", ffmpeg: false })), [], "checks older than 30 minutes aren't shown");
  assert.deepEqual(ids(device({ ffmpeg: false }, { oldestWaitMin: 60 }), { connected: false }), [], "an offline PC's last facts aren't current");
});
