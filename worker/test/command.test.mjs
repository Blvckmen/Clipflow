import { test } from "node:test";
import assert from "node:assert/strict";
import { clipCommand } from "../chat.mjs";
import { commandTrigger } from "../highlights.mjs";
import { validateControl } from "../core.mjs";

const line = (tags, nick, text) => (tags ? "@" + tags + " " : "") + ":" + nick + "!" + nick + "@" + nick + ".tmi.twitch.tv PRIVMSG #chan :" + text;

test("clipCommand reads !clip and whether the sender is the streamer, a moderator or a VIP", () => {
  assert.deepEqual(clipCommand(line("badge-info=;badges=moderator/1,subscriber/12;mod=1;display-name=ModGuy", "modguy", "!clip")), { by: "modguy", mod: true });
  assert.deepEqual(clipCommand(line("badges=broadcaster/1;mod=0", "chan", "!CLIP that was insane")), { by: "chan", mod: true });
  assert.deepEqual(clipCommand(line("badges=vip/1;mod=0", "vipper", "!clip")), { by: "vipper", mod: true });
  assert.deepEqual(clipCommand(line("badges=subscriber/3;mod=0", "Viewer1", "!clip")), { by: "viewer1", mod: false });
  assert.deepEqual(clipCommand(line("", "plain", "!clip")), { by: "plain", mod: false }, "works without tags");
  assert.equal(clipCommand(line("mod=1", "m", "!clipboard")), null);
  assert.equal(clipCommand(line("mod=1", "m", "nice !clip")), null, "only at the start of a message");
  assert.equal(clipCommand(":tmi.twitch.tv 001 justinfan1 :Welcome"), null);
});

test("commandTrigger: moderators clip at once, viewers need a crowd, old commands are ignored", () => {
  const v = (t, by) => ({ t, by, mod: false }), m = (t, by) => ({ t, by, mod: true });
  assert.deepEqual(commandTrigger([v(1000, "a"), m(2000, "mod")], { sinceMs: 0 }), { atMs: 2000, by: "mod" });
  assert.equal(commandTrigger([v(1000, "a"), v(2000, "b"), v(3000, "c")], { sinceMs: 0 }), null, "mods only by default");
  assert.deepEqual(commandTrigger([v(1000, "a"), v(2000, "b"), v(3000, "c")], { sinceMs: 0, who: "everyone" }), { atMs: 3000, by: "3 viewers" });
  assert.equal(commandTrigger([v(1000, "a"), v(2000, "a"), v(3000, "a")], { sinceMs: 0, who: "everyone" }), null, "one viewer spamming isn't a crowd");
  assert.equal(commandTrigger([v(1000, "a"), v(2000, "b"), v(40_000, "c")], { sinceMs: 0, who: "everyone" }), null, "too far apart");
  assert.equal(commandTrigger([m(1000, "mod")], { sinceMs: 1000 }), null, "already handled");
  assert.equal(commandTrigger([m(5000, "mod")], { sinceMs: 0, who: "off" }), null);
});

test("validateControl defaults and checks the chat command setting", () => {
  const base = { control: "running", duration: 45, dailyLimit: 5, captions: true, streamers: [] };
  assert.equal(validateControl({ ...base }).clipCommand, "mods");
  assert.equal(validateControl({ ...base, clipCommand: "everyone" }).clipCommand, "everyone");
  assert.throws(() => validateControl({ ...base, clipCommand: "all" }));
});
