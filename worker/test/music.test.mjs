import { test } from "node:test";
import assert from "node:assert/strict";
import { musicArgs, sourceForMusic } from "../music.mjs";
import { MUSIC_LEVEL, normalizeStyle, defaultStyle } from "../edit.mjs";

test("musicArgs keeps the picture and either the voice alone or the voice over the quieter rest", () => {
  const voice = musicArgs("in.mp4", "v.wav", "r.wav", "out.mp4", "voice").join(" ");
  assert.match(voice, /-i in\.mp4 -i v\.wav -map 0:v -map 1:a -c:v copy/);
  assert.doesNotMatch(voice, /r\.wav/);
  const lower = musicArgs("in.mp4", "v.wav", "r.wav", "out.mp4", "lower").join(" ");
  assert.match(lower, /-i r\.wav/);
  assert.match(lower, new RegExp("\\[2:a\\]volume=" + MUSIC_LEVEL + "\\[r\\];\\[1:a\\]\\[r\\]amix=inputs=2:duration=first:normalize=0\\[a\\]"));
  assert.match(lower, /-c:v copy/);
});

test("sourceForMusic leaves the source alone when the music is kept", async () => {
  assert.equal(await sourceForMusic("whatever.mp4", "keep"), "whatever.mp4");
  assert.equal(await sourceForMusic("whatever.mp4", undefined), "whatever.mp4");
});

test("a look's background music is checked and kept", () => {
  assert.deepEqual(normalizeStyle(defaultStyle()).audio, { music: "keep" });
  assert.equal(normalizeStyle({ ...defaultStyle(), audio: { music: "voice" } }).audio.music, "voice");
  assert.throws(() => normalizeStyle({ ...defaultStyle(), audio: { music: "loud" } }));
});
