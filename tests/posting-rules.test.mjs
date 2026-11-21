import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRules, emptyRules, lengthProblem, MAX_CAPTION, parseBrief, readRules } from "../lib/posting-rules.mjs";

const info = { streamer: "KaiCenat", platform: "Twitch", channel: "twitch.tv/kaicenat" };

test("a pasted campaign brief gives the label, tags, mentions, lengths and credit it asks for", () => {
  const brief = `🎮 KAI CENAT CLIPPING CAMPAIGN — $1.50 per 1K views
Requirements:
- Clips must be 15-60 seconds
- Include #ad and #kaicenat #mafiathon in every caption
- Tag @KaiCenat and credit the streamer
- No reuploads of full VODs. Email me at test@example.com`;
  assert.deepEqual(parseBrief(brief), { label: "#ad", hashtags: ["#kaicenat", "#mafiathon"], mentions: ["@KaiCenat"], minSeconds: 15, maxSeconds: 60, credit: true });
  assert.deepEqual(parseBrief("Keep it under 1 minute, at least 20 seconds. Disclose it as a paid partnership."), { label: "#ad", minSeconds: 20, maxSeconds: 60 });
  assert.deepEqual(parseBrief("Videos 30s to 90s, #sponsored"), { label: "#sponsored", minSeconds: 30, maxSeconds: 90 });
  assert.deepEqual(parseBrief("nothing here"), {});
});

test("rules from storage keep only known, well-formed fields", () => {
  assert.deepEqual(readRules(null), emptyRules());
  assert.deepEqual(readRules("not json"), emptyRules());
  assert.equal(emptyRules().credit, false, "posts stay as written until credit is switched on");
  const r = readRules({ credit: false, label: " #ad ", hashtags: ["#Clips", "clips", "bad tag", 3], mentions: ["KaiCenat", "@x"], minSeconds: 90, maxSeconds: 20, extra: 1 });
  assert.deepEqual([r.credit, r.label, r.hashtags, r.mentions, r.minSeconds, r.maxSeconds, "extra" in r], [false, "#ad", ["#clips"], ["@KaiCenat", "@x"], 20, 90, false]);
});

test("the label goes first; credit and missing tags are added once, after the caption", () => {
  const rules = { ...emptyRules(), credit: true, label: "#ad", hashtags: ["#kaicenat", "#mafiathon"], mentions: ["@KaiCenat"] };
  const out = applyRules("He did NOT see that coming 😭 #KaiCenat", rules, info);
  assert.equal(out, "#ad He did NOT see that coming 😭 #KaiCenat\n\n🎥 KaiCenat on Twitch: twitch.tv/kaicenat\n\n@KaiCenat #mafiathon");
  assert.equal(applyRules("#ad already labelled", { ...emptyRules(), label: "#ad", credit: false }, info), "#ad already labelled");
  assert.equal(applyRules("plain", { ...emptyRules(), credit: false }, info), "plain", "no rules, no change");
  assert.equal(applyRules("x", { ...emptyRules(), credit: true, creditText: "Credit: {streamer} ({channel})" }, { ...info, channel: "" }), "x\n\nCredit: KaiCenat ()");
});

test("a long caption is shortened so the label, credit and tags still fit", () => {
  const rules = { ...emptyRules(), credit: true, label: "#ad", hashtags: ["#kaicenat"] };
  const out = applyRules("word ".repeat(1000), rules, info);
  assert.ok(out.length <= MAX_CAPTION);
  assert.ok(out.startsWith("#ad ") && out.endsWith("🎥 KaiCenat on Twitch: twitch.tv/kaicenat\n\n#kaicenat"));
  assert.match(out, /…\n\n🎥/);
});

test("clip length outside the campaign's range is a reason to hold the post", () => {
  const rules = { ...emptyRules(), minSeconds: 15, maxSeconds: 60 };
  assert.equal(lengthProblem(rules, 45), null);
  assert.match(lengthProblem(rules, 75), /at most 60s \(this one is 75s\)/);
  assert.match(lengthProblem(rules, 10), /at least 15s/);
  assert.equal(lengthProblem(emptyRules(), 300), null);
});
