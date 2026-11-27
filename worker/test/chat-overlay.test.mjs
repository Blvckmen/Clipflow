import { test } from "node:test";
import assert from "node:assert/strict";
import { chatMessage } from "../chat.mjs";
import { buildAss, chatColor, chatWindows, defaultEdit, defaultStyle, needsSubtitles, normalizeStyle, CHAT_HOLD, CHAT_LINES } from "../edit.mjs";
import { sourceMessages } from "../media.mjs";

test("chatMessage keeps the text, display name and name colour", () => {
  assert.deepEqual(chatMessage("@badges=;color=#1E90FF;display-name=Big\\sFan;mod=0 :bigfan!bigfan@bigfan.tmi.twitch.tv PRIVMSG #chan :LETS GOOO"), { text: "LETS GOOO", name: "Big Fan", color: "#1e90ff" });
  assert.deepEqual(chatMessage(":plain!plain@plain.tmi.twitch.tv PRIVMSG #chan :hi"), { text: "hi", name: "plain", color: null });
  assert.equal(chatMessage(":tmi.twitch.tv PONG"), null);
});

const edit = (over = {}) => ({ ...defaultEdit(defaultStyle(), { trimStart: 10, trimEnd: 40 }), chat: { on: true, y: 0.6 }, ...over });

test("chatWindows shows the newest few messages, each for a while, inside the trim", () => {
  // A message sent just before the trim is still on screen at its start, like on stream; one long before isn't.
  assert.deepEqual(chatWindows([[5, "early", "still up", null]], edit())[0], { start: 10, end: 13, lines: [{ name: "early", text: "still up", color: chatColor("early") }] });
  const msgs = [[1, "early", "too early", null], [11, "a", "one", "#ff0000"], [12, "b", "two", null], [12.5, "c", "three", null], [13, "d", "four", null], [14, "e", "five", null], [50, "late", "after", null]];
  const w = chatWindows(msgs, edit());
  assert.equal(w[0].start, 11);
  assert.deepEqual(w[0].lines.map(l => l.text), ["one"]);
  const at14 = w.find(x => x.start <= 14 && x.end > 14);
  assert.deepEqual(at14.lines.map(l => l.text), ["two", "three", "four", "five"], "at most " + CHAT_LINES + ", oldest pushed out");
  assert.ok(w.every(x => x.end <= 40 && x.start >= 10));
  assert.ok(!w.some(x => x.lines.some(l => l.text === "after" || l.text === "too early")));
  const last = w.at(-1);
  assert.equal(last.end, 14 + CHAT_HOLD, "messages go after " + CHAT_HOLD + "s");
  assert.equal(w[0].lines[0].color, "#ff0000");
  assert.deepEqual(chatWindows(msgs, edit({ chat: { on: false, y: 0.6 } })), []);
});

test("chatWindows shortens long messages and bleeps swear words when the captions do", () => {
  const e = edit({ captions: { ...edit().captions, mask: true } });
  const [w] = chatWindows([[11, "x", "shit " + "a".repeat(100), null]], e);
  assert.ok(w.lines[0].text.startsWith("s***"));
  assert.ok(w.lines[0].text.length <= 60 && w.lines[0].text.endsWith("..."));
});

test("buildAss draws chat bottom-left with coloured names; needsSubtitles counts it", () => {
  const ass = buildAss(edit({ hook: { ...edit().hook, text: "" }, captions: { ...edit().captions, on: false } }), [], undefined, [[11, "Fan", "hello {there}", "#00ff00"]]);
  assert.match(ass, /^Style: Chat,Arial,30,/m);
  // Times count from the trim's start (10s); the column's bottom is at chat.y of the height.
  assert.ok(ass.includes("\nDialogue: 0,0:00:01.00,0:00:09.00,Chat,,0,0,0,,{\\an1\\pos(40,768)\\q2}{\\c&H0000FF00}Fan{\\c&H00FFFFFF&}: hello there\n"));
  assert.equal(needsSubtitles(edit({ captions: { ...edit().captions, on: false } }), [], [[11, "a", "b", null]]), true);
  assert.equal(needsSubtitles(edit({ captions: { ...edit().captions, on: false }, chat: { on: false, y: 0.6 } }), [], [[11, "a", "b", null]]), false);
});

test("chat is part of a look, off unless turned on", () => {
  assert.deepEqual(normalizeStyle(defaultStyle()).chat, { on: false, y: 0.62 });
  assert.deepEqual(normalizeStyle({ ...defaultStyle(), chat: { on: true, y: 2 } }).chat, { on: true, y: 0.95 });
  assert.throws(() => normalizeStyle({ ...defaultStyle(), chat: { on: "yes" } }));
  assert.equal(chatColor("same"), chatColor("same"), "a name always gets the same colour");
});

test("sourceMessages keeps the source's messages, shifted, and thins a flood to 400", () => {
  assert.deepEqual(sourceMessages([[1, "a", "x", null], [5, "b", "y", "#ffffff"], [50, "c", "z", null]], 4, 20), [[1, "b", "y", "#ffffff"]]);
  assert.equal(sourceMessages(Array.from({ length: 1000 }, (_, i) => [i / 10, "n", "m", null]), 0, 100).length, 400);
});
