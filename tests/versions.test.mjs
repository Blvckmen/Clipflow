import { test } from "node:test";
import assert from "node:assert/strict";
import { versionLabel, KEEP_VERSIONS } from "../lib/versions.mjs";

test("versionLabel: length, template, and the text that shows", () => {
  const edit = { trim: { start: 0, end: 32.4 }, frame: { mode: "cam", facecam: { place: "top" } }, captions: { on: true }, hook: { text: "x", on: true } };
  assert.equal(versionLabel(edit), "32.4s · Top split · subtitles · title");
  assert.equal(versionLabel({ ...edit, captions: { on: false }, hook: { text: "" } }), "32.4s · Top split");
  assert.equal(versionLabel({ ...edit, hook: { text: "x", on: false } }), "32.4s · Top split · subtitles", "a hidden title isn't listed");
  assert.equal(versionLabel({ trim: { start: 10, end: 25 }, frame: { mode: "pip", facecam: { shape: "circle" } }, captions: { on: false }, hook: { text: "" } }), "15s · Circle facecam");
  assert.equal(versionLabel(null), "Saved edit", "something unreadable still gets a label");
});

test("KEEP_VERSIONS is 20", () => { assert.equal(KEEP_VERSIONS, 20); });
