import { test } from "node:test";
import assert from "node:assert/strict";
import { hintText } from "../whisper.mjs";

test("hintText cuts at 200 characters without splitting an emoji", () => {
  const title = "a".repeat(199) + "🔴 more";
  const hint = hintText(title);
  assert.ok(hint.isWellFormed(), "no half emoji left for Whisper's tokenizer");
  assert.equal(hint, "a".repeat(199) + "🔴");
  // The old cut (UTF-16 halves) is what produced the half emoji.
  assert.equal(title.slice(0, 200).isWellFormed(), false);
});

test("hintText replaces a half emoji that is already on its own", () => {
  assert.equal(hintText("GTA 6 \ud83d"), "GTA 6 �");
  assert.equal(hintText(null), "");
  assert.equal(hintText("Speed. 🌴 GTA 6 🔴"), "Speed. 🌴 GTA 6 🔴");
});
