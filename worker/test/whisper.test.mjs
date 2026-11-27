import { test } from "node:test";
import assert from "node:assert/strict";
import { hintText, oneAtATime } from "../whisper.mjs";

test("oneAtATime: requests go one by one in order, and one cancelled while waiting doesn't hold up the rest", async () => {
  const take = oneAtATime(), log = [];
  const job = async (name, signal, ms = 10) => {
    const release = await take(signal);
    try { log.push(name + " start"); await new Promise(r => setTimeout(r, ms)); log.push(name + " end"); } finally { release(); }
  };
  const cancel = new AbortController();
  const a = job("a"), b = job("b", cancel.signal), c = job("c");
  cancel.abort();
  await assert.rejects(b, /Cancelled/);
  await Promise.all([a, c]);
  assert.deepEqual(log, ["a start", "a end", "c start", "c end"], "never two at once; b left the line");
  const gone = new AbortController(); gone.abort();
  await assert.rejects(job("d", gone.signal), /Cancelled/);
  await job("e");
  assert.equal(log.at(-1), "e end", "a request cancelled before it queued doesn't block the next");
});

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
