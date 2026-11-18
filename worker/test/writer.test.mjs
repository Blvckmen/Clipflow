import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { buildPrompt, chatSample, tidy, writeClipText } from "../writer.mjs";

test("tidy keeps a short hook, strips hashtags and quotes, and adds credit and tags to the caption", () => {
  const out = tidy({ hook: "\"He did NOT see that coming #fail\"", caption: "Chat lost it when the boss came back. #gaming", hashtags: ["#EldenRing", "boss fight", "clips"] }, { streamer: "Kaicenat", platform: "Twitch" });
  assert.equal(out.hook, "He did NOT see that coming");
  assert.equal(out.caption, "Chat lost it when the boss came back.\n\n\u{1F3A5} Kaicenat on Twitch\n\n#kaicenat #eldenring #bossfight #clips");
});

test("tidy refuses answers it can't use and shortens long hooks", () => {
  assert.equal(tidy(null), null);
  assert.equal(tidy({ hook: "Wow", caption: "Something happened here." }), null, "a one-word hook");
  assert.equal(tidy({ hook: "A real hook here", caption: "" }), null, "no caption");
  const long = tidy({ hook: "one two three four five six seven eight nine ten eleven twelve", caption: "Fine caption.", hashtags: [] }, {});
  assert.equal(long.hook.split(" ").length, 10);
  assert.ok(long.caption.endsWith("#clips"));
});

test("chatSample keeps the moment's messages, most repeated first", () => {
  const lines = [{ t: 1000, text: "LMAO" }, { t: 1500, text: "LMAO" }, { t: 1800, text: "no way" }, { t: 9000, text: "later" }, { t: 500, text: "earlier" }, { t: 1200, text: "LMAO" }];
  assert.deepEqual(chatSample(lines, 900, 2000), ["LMAO (x3)", "no way"]);
  assert.deepEqual(chatSample([], 0, 1), []);
});

test("buildPrompt includes the clip's words, title and chat, and says when there is no speech", () => {
  const prompt = buildPrompt({ transcript: "bro what was that", streamer: "jynxzi", platform: "Twitch", title: "ranked grind", chat: ["W (x5)"] });
  for (const part of ["jynxzi on Twitch", "Stream title: ranked grind", "bro what was that", "W (x5)"]) assert.ok(prompt.includes(part), part);
  assert.ok(buildPrompt({ transcript: "" }).includes("(no speech)"));
});

test("writeClipText asks Ollama for JSON and falls back to null when it's missing or slow", async () => {
  let asked = null;
  const server = createServer((req, res) => {
    let body = ""; req.on("data", c => body += c); req.on("end", () => {
      asked = JSON.parse(body);
      res.end(JSON.stringify({ message: { content: JSON.stringify({ hook: "Chat called it first", caption: "Nobody believed him until this.", hashtags: ["valorant"] }) } }));
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  process.env.OLLAMA_URL = "http://127.0.0.1:" + server.address().port;
  try {
    const out = await writeClipText({ transcript: "watch this", streamer: "tarik", platform: "Twitch" });
    assert.equal(out.hook, "Chat called it first");
    assert.match(out.caption, /#valorant/);
    assert.equal(asked.model, "qwen2.5:7b");
    assert.equal(asked.stream, false);
    assert.equal(asked.format.type, "object");
    process.env.AI_WRITER = "off";
    assert.equal(await writeClipText({ transcript: "x" }), null, "turned off");
    delete process.env.AI_WRITER;
  } finally { server.close(); }
  process.env.OLLAMA_URL = "http://127.0.0.1:9";  // nothing listening
  assert.equal(await writeClipText({ transcript: "x" }, { timeoutMs: 2000 }), null);
  delete process.env.OLLAMA_URL;
});
