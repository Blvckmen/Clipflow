import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMOJI, emojiIn, hideEmoji, probe, boxesIn, layerFrames, concatList } from '../emoji.mjs';
import { defaultEdit, defaultStyle, normalizeEdit, buildAss, filterGraph } from '../edit.mjs';

const words = text => text.split(' ').map((w, i) => [2 + i * 0.6, 2.5 + i * 0.6, w]);
const edit = (change = e => e) => normalizeEdit(change(defaultEdit(defaultStyle(), { trimStart: 1, trimEnd: 11 })), { duration: 12 });

test('finds whole emoji, joined ones and skin tones included, and leaves text symbols alone', () => {
  const found = s => s.match(EMOJI) ?? [];
  assert.deepEqual(found('go 😂🔥 now'), ['😂', '🔥']);
  assert.deepEqual(found('❤️‍🔥 👍🏽 😵‍💫 #️⃣ 🇬🇭'), ['❤️‍🔥', '👍🏽', '😵‍💫', '#️⃣', '🇬🇭']);
  assert.deepEqual(found('© 2026 ™ 1 # ↔ plain text'), []);
  assert.deepEqual(found('❤️ ❤'), ['❤️'], 'a heart with VS16 is an emoji, without it text');
});

test('hides only colourable emoji, keeping the hook box but not an outline', () => {
  const boxed = edit(e => { e.hook.text = 'Wow 😂 ok 🇬🇭'; return e; });
  const ass = buildAss(boxed, words('no way 💀'));
  assert.deepEqual(emojiIn(ass), ['💀', '😂', '🇬🇭']);
  const hidden = hideEmoji(ass, new Set(['😂', '💀']));
  assert.ok(hidden.includes('Wow {\\1a&HFF&}😂{\\1a&H00&} ok 🇬🇭'), 'box style: fill only; uncoloured flag stays');
  assert.ok(hidden.includes('{\\1a&HFF&\\3a&HFF&}💀{\\1a&H00&\\3a&H00&}'), 'captions with an outline: outline too');
  assert.equal(hideEmoji(ass, new Set()), ass);
});

test('the probe gives each layout one slot, karaoke colour changes included, and each emoji its own colour', () => {
  const karaoke = edit(e => { e.captions.animation = 'karaoke'; return e; });
  const ass = buildAss(karaoke, words('no 💀 🔥'));
  const p = probe(ass, new Set(['💀', '🔥']));
  assert.equal(p.layouts.length, 1, 'one cue, three karaoke lines, one layout');
  assert.deepEqual(p.layouts[0], ['💀', '🔥']);
  assert.equal(p.events.length, 3);
  assert.ok(p.ass.includes('YCbCr Matrix: None'));
  assert.ok(p.ass.includes('{\\1a&H00&\\1c&H0001FF&}💀{\\1a&HFF&}') && p.ass.includes('\\1c&H0002FF&}🔥'));
  assert.match(p.ass, /Dialogue: 0,0:00:00\.50,0:00:01\.50,Cap/);
  assert.equal(p.ass.match(/^Dialogue/gm).length, 1);
});

test('reads each emoji box from a probe frame, a pixel wider for the soft edge', () => {
  const w = 10, h = 6, frame = Buffer.alloc(w * h * 3);
  const paint = (x, y, j) => frame.set([255, j, 0], (y * w + x) * 3);
  paint(2, 1, 1); paint(3, 2, 1); paint(7, 4, 2);
  frame.set([200, 1, 0], (5 * w + 0) * 3); // an anti-aliased edge pixel doesn't count
  assert.deepEqual(boxesIn(frame, w, h, 3), [{ x: 1, y: 0, w: 4, h: 4 }, { x: 6, y: 3, w: 3, h: 3 }, null]);
});

test('layer frames follow the lines, merge repeats, and switch half a frame early', () => {
  const boxes = [[{ i: 0, x: 1, y: 1, w: 5, h: 5 }], [{ i: 1, x: 9, y: 9, w: 5, h: 5 }]];
  const frames = layerFrames([{ start: 0, end: 2, layout: 0 }, { start: 2, end: 3, layout: 0 }, { start: 4, end: 5, layout: 1 }], boxes);
  assert.deepEqual(frames.map(f => [f.duration, f.items.length]), [[3, 1], [1, 0], [1, 1], [1, 0]]);
  assert.equal(concatList(frames), "ffconcat version 1.0\nfile 'f0.png'\nduration 2.983\nfile 'f1.png'\nduration 1.000\nfile 'f2.png'\nduration 1.000\nfile 'f3.png'\nduration 1.000\nfile 'f3.png'\n");
});

test('the colour emoji layer goes over the subtitles', () => {
  const e = edit();
  assert.match(filterGraph(e, { width: 1280, height: 720 }, 'clip.ass', { emoji: 1 }), /\[v0\]subtitles=clip\.ass\[v1\];\[v1\]\[1:v\]overlay=0:0:eof_action=pass\[ve\];\[ve\]format=yuv420p/);
  assert.doesNotMatch(filterGraph(e, { width: 1280, height: 720 }, 'clip.ass'), /overlay=0:0:eof_action/);
});
