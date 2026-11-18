import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backgroundStart, chooseBackground, localBackground, validBackgrounds } from "../backgrounds.mjs";

const lib = [{ id: "11111111-1111-4111-8111-111111111111", size: 10 }, { id: "22222222-2222-4222-8222-222222222222", size: 20 }, { id: "33333333-3333-4333-8333-333333333333", size: 30 }];
const split = background => ({ frame: { mode: "split", background } });

test("a clip keeps the same background each render, unless one was chosen", () => {
  const a = chooseBackground(split(null), "clip-a", lib);
  assert.deepEqual(chooseBackground(split(null), "clip-a", lib), a, "same clip, same pick");
  const picks = new Set(Array.from({ length: 40 }, (_, i) => chooseBackground(split(null), "clip-" + i, lib).id));
  assert.ok(picks.size > 1, "different clips spread over the library");
  assert.equal(chooseBackground(split(lib[2].id), "clip-a", lib).id, lib[2].id, "the chosen one wins");
  assert.ok(lib.includes(chooseBackground(split("44444444-4444-4444-8444-444444444444"), "clip-a", lib)), "a deleted choice falls back to the library");
  assert.equal(chooseBackground({ frame: { mode: "blur" } }, "clip-a", lib), null);
  assert.equal(chooseBackground(split(null), "clip-a", []), null, "empty library: no background");
});

test("only backgrounds at least as long as the clip are picked; gallery clips can be chosen", () => {
  const timed = [{ ...lib[0], duration: 20 }, { ...lib[1], duration: 60 }, { ...lib[2] }];
  for (let i = 0; i < 30; i++) assert.notEqual(chooseBackground(split(null), "c" + i, timed, 45)?.id, lib[0].id, "the 20s video is too short for a 45s clip");
  assert.equal(chooseBackground(split(lib[0].id), "c", timed, 45).id === lib[0].id, false, "even when chosen, a too-short video isn't used");
  assert.equal(chooseBackground(split(null), "c", [{ ...lib[0], duration: 10 }], 45), null, "nothing long enough: blurred fill");
  const fromGallery = chooseBackground(split("clip:" + lib[1].id), "c", [], 45);
  assert.deepEqual(fromGallery, { id: "clip:" + lib[1].id, kind: "clip", clip: lib[1].id, size: null });
});

test("with usage history, new clips rotate through the library and prefer backgrounds named after the stream", () => {
  const named = [{ ...lib[0], name: "Subway run" }, { ...lib[1], name: "Fortnite gameplay" }, { ...lib[2], name: "Satisfying sand" }];
  const used = new Map();
  const picks = [];
  for (let i = 0; i < 6; i++) { const b = chooseBackground(split(null), "clip-" + i, named, 30, { lastUsed: used }); picks.push(b.id); used.set(b.id, i + 1); }
  assert.deepEqual(new Set(picks.slice(0, 3)).size, 3, "each one before any repeats");
  assert.deepEqual(picks.slice(3), picks.slice(0, 3), "then round again, oldest first");
  assert.equal(chooseBackground(split(null), "c", named, 30, { lastUsed: new Map([[lib[1].id, 99]]), title: "FORTNITE ranked w/ chat" }).id, lib[1].id, "a name matching the title wins, even if recently used");
  assert.notEqual(chooseBackground(split(null), "c", named, 30, { lastUsed: new Map([[lib[0].id, 5]]), title: "just chatting" }).id, lib[0].id, "no match: the least recently used");
  assert.equal(chooseBackground(split(lib[0].id), "c", named, 30, { lastUsed: new Map([[lib[0].id, 99]]) }).id, lib[0].id, "a pinned choice is kept");
});

test("the worker's store remembers when each background was last used", async () => {
  const { Store } = await import("../core.mjs");
  const dir = await mkdtemp(join(tmpdir(), "bguse-")), store = new Store(dir);
  assert.equal(store.backgroundUse().size, 0);
  store.usedBackground("a", 10); store.usedBackground("b", 20); store.usedBackground("a", 30);
  assert.deepEqual([...store.backgroundUse()].sort(), [["a", 30], ["b", 20]]);
  store.close();
});

test("the start point leaves room for the whole clip", () => {
  for (let i = 0; i < 50; i++) { const s = backgroundStart("c" + i, 60, 45); assert.ok(s >= 0 && s <= 15, String(s)); }
  assert.equal(backgroundStart("c", 20, 45), 0, "shorter than the clip: start at the beginning and loop");
  assert.equal(backgroundStart("c", 60, 45), backgroundStart("c", 60, 45));
});

test("backgrounds are downloaded once and fetched again only if the library's copy changed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bg-")), entry = { id: lib[0].id, size: 4 };
  let fetches = 0;
  const fetchFile = async () => { fetches++; return Buffer.from("abcd"); };
  const file = await localBackground(dir, entry, fetchFile);
  assert.equal(await readFile(file, "utf8"), "abcd");
  await localBackground(dir, entry, fetchFile);
  assert.equal(fetches, 1, "cached");
  await assert.rejects(localBackground(dir, { ...entry, size: 9 }, fetchFile), /incompletely/, "a size mismatch is refused, not cached");
  const clipEntry = { id: "clip:" + lib[1].id, kind: "clip", clip: lib[1].id, size: null };
  const clipFile = await localBackground(dir, clipEntry, fetchFile);
  assert.match(clipFile, /clip-22222222/);
  await localBackground(dir, clipEntry, fetchFile);
  assert.equal(fetches, 3, "a gallery clip's source is fetched once too");
});

test("the library list from the dashboard is checked", () => {
  assert.deepEqual(validBackgrounds(undefined), []);
  // Images (any clip length) and videos; older dashboards send videos only.
  assert.deepEqual(validBackgrounds([{ id: "11111111-1111-4111-8111-111111111111", size: 9, duration: null, kind: "image", type: "image/png" }])[0].kind, "image");
  assert.equal(validBackgrounds([{ id: "11111111-1111-4111-8111-111111111111", size: 9 }])[0].kind, "video");
  assert.throws(() => validBackgrounds([{ id: "11111111-1111-4111-8111-111111111111", size: 9, kind: "gif" }]), /kind/);
  assert.throws(() => validBackgrounds([{ id: "../x", size: 1 }]));
  assert.throws(() => validBackgrounds([{ id: lib[0].id, size: 0 }]));
});
