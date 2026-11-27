import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultEdit, defaultStyle, normalizeEdit } from "../edit.mjs";
import { applyTextStyle, readTemplateFile, readTextStyle, styleName, textStyleOf, toTemplateFile, MAX_TEXT_STYLE_BYTES } from "../text-style.mjs";

const clip = (extra = {}) => normalizeEdit({ ...defaultEdit(defaultStyle({ captions: true }), { trimStart: 0, trimEnd: 30 }), hook: { text: "He did NOT\nsee that", lines: [null, { color: "#ff0000" }] }, ...extra }, { duration: 40 });

test("a text style leaves out what belongs to one clip", () => {
  const s = textStyleOf(clip());
  assert.equal(s.captions.on, undefined);
  assert.equal(s.captions.y, undefined, "the height follows each clip's framing");
  assert.equal(s.hook.text, undefined);
  assert.equal(s.hook.lines, undefined);
  assert.equal(s.hook.on, undefined);
  assert.equal(typeof s.captions.font, "string");
  assert.equal(s.hook.anim, "pop");
  assert.equal(s.frame, undefined, "only text, not framing");
});

test("applying a style keeps each clip's switches, text, height and line colours", () => {
  const style = { ...textStyleOf(clip()), captions: { ...textStyleOf(clip()).captions, color: "#00ff00", italic: true, shadow: 4 }, hook: { ...textStyleOf(clip()).hook, color: "#ffffff", anim: "fade", own: true, font: "Arial" } };
  const target = clip({ captions: { ...clip().captions, on: false, y: 0.5 } });
  const out = applyTextStyle(target, style);
  assert.equal(out.captions.color, "#00ff00");
  assert.equal(out.captions.italic, true);
  assert.equal(out.captions.shadow, 4);
  assert.equal(out.captions.on, false, "subtitles stay off");
  assert.equal(out.captions.y, 0.5, "and at their height");
  assert.equal(out.hook.anim, "fade");
  assert.equal(out.hook.font, "Arial");
  assert.equal(out.hook.text, "He did NOT\nsee that");
  assert.deepEqual(out.hook.lines, [null, { color: "#ff0000" }]);
  assert.doesNotThrow(() => normalizeEdit(out, { duration: 40 }));
  // A partial style fills the rest from the defaults rather than failing.
  assert.equal(applyTextStyle(target, { captions: { color: "#123456" } }).captions.color, "#123456");
});

test("styles from outside are checked", () => {
  assert.throws(() => readTextStyle(null));
  assert.throws(() => readTextStyle({ captions: "big" }));
  assert.throws(() => readTextStyle({ captions: { color: "red" } }), /colour/);
  assert.throws(() => readTextStyle({ hook: { anim: "spin" } }));
  assert.throws(() => readTextStyle({ captions: { font: "Comic Sans Evil" } }));
  assert.equal(styleName("  Brand\n kit  "), "Brand kit");
  assert.throws(() => styleName("   "));
  assert.equal(styleName("x".repeat(60)).length, 40);
});

test("export and import round-trip; other files are refused", () => {
  const style = textStyleOf(clip({ captions: { ...clip().captions, color: "#abcdef" } }));
  const file = toTemplateFile(style, "My look");
  const back = readTemplateFile(file);
  assert.equal(back.name, "My look");
  assert.deepEqual(back.style, style);
  assert.throws(() => readTemplateFile("{nope"), /isn't a ClipFlow text style/);
  assert.throws(() => readTemplateFile(JSON.stringify({ kind: "something-else" })), /isn't a ClipFlow text style/);
  assert.throws(() => readTemplateFile(JSON.stringify({ kind: "clipflow-text-style", v: 99 })), /newer/);
  assert.throws(() => readTemplateFile(" ".repeat(MAX_TEXT_STYLE_BYTES + 1)), /too big/);
  assert.equal(readTemplateFile(JSON.stringify({ kind: "clipflow-text-style", v: 1, name: "" })).name, "Imported style");
});
