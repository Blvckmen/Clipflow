import { test } from "node:test";
import assert from "node:assert/strict";
import { GENERIC_HOOKS, generateHook, suggestHooks } from "../hooks.mjs";

const said = [[0, .3, "Chat"], [.3, .6, "I"], [.6, .9, "just"], [.9, 1.2, "won"], [1.2, 1.5, "a"], [1.5, 1.8, "million!"],
  [3, 3.3, "Why"], [3.3, 3.6, "is"], [3.6, 3.9, "nobody"], [3.9, 4.2, "talking?"], [6, 6.3, "Bro"], [6.3, 6.6, "this"], [6.6, 6.9, "game"], [6.9, 7.2, "is"], [7.2, 7.5, "broken."]];
const trim = { start: 0, end: 30 };

test("three titles to pick from: what was said first, the best one first", () => {
  const list = suggestHooks(said, trim);
  assert.equal(list.length, 3);
  assert.ok(list.every(s => s.source === "said"));
  assert.equal(list[0].text, generateHook(said, trim), "the first is the one written automatically");
  assert.equal(new Set(list.map(s => s.text)).size, 3, "all different");
});

test("not enough said: generic openers fill in, with the streamer's name only when known", () => {
  const one = suggestHooks(said.slice(0, 6), trim, { name: "Kai" });
  assert.equal(one[0].source, "said");
  assert.deepEqual(one.slice(1).map(s => s.source), ["generic", "generic"]);
  const none = suggestHooks([], trim, { count: 4 });
  assert.ok(none.every(s => s.source === "generic") && none.length === 3, "the {name} opener is skipped without a name");
  assert.ok(!none.some(s => s.text.includes("{name}")));
  assert.ok(suggestHooks([], trim, { count: 4, name: "Kai" }).some(s => s.text === "Kai was NOT ready for this"));
  assert.equal(GENERIC_HOOKS.length, 4);
  assert.deepEqual(suggestHooks(said, trim, { count: 1 }).length, 1);
});

test("bleeped when the subtitles bleep", () => {
  const list = suggestHooks([[0, .3, "What"], [.3, .6, "the"], [.6, .9, "fuck"], [.9, 1.2, "happened?"]], trim, { mask: true });
  assert.ok(list[0].text.includes("f***"));
});
