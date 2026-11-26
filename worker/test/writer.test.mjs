import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { buildPrompt, chatSample, pickerOnCpu, rateMoments, spillsOver, tidy, writeClipText } from "../writer.mjs";

test("the rating model goes on the CPU only when the writer's model doesn't fit in graphics memory", () => {
  const ps = { models: [{ name: "qwen2.5:7b", size: 5_000, size_vram: 600 }, { name: "llama3:latest", size: 4_000, size_vram: 4_000 }] };
  assert.equal(spillsOver(ps, "qwen2.5:7b"), true);
  assert.equal(spillsOver(ps, "llama3"), false, "fits");
  assert.equal(spillsOver(ps, "qwen2.5:3b"), null, "not loaded: unknown");
  assert.equal(pickerOnCpu({ setting: undefined, spills: true, writer: "a", picker: "b" }), true);
  assert.equal(pickerOnCpu({ setting: undefined, spills: false, writer: "a", picker: "b" }), false, "a big GPU keeps both");
  assert.equal(pickerOnCpu({ setting: undefined, spills: true, writer: "a", picker: "a" }), false, "one model: nothing to swap");
  assert.equal(pickerOnCpu({ setting: "on", spills: false }), true);
  assert.equal(pickerOnCpu({ setting: "OFF", spills: true, writer: "a", picker: "b" }), false);
});

test("after a writing shows the writer's model spilling out of graphics memory, ratings ask for the CPU", async () => {
  const chats = [];
  const server = createServer((req, res) => {
    if (req.url === "/api/ps") return res.end(JSON.stringify({ models: [{ name: "qwen2.5:7b", size: 5e9, size_vram: 6e8 }] }));
    let body = ""; req.on("data", c => body += c); req.on("end", () => {
      const ask = JSON.parse(body); chats.push(ask);
      res.end(JSON.stringify({ message: { content: JSON.stringify(ask.format.properties.scores ? { scores: [7, 2] } : { hook: "Chat called it first", caption: "Nobody believed him.", hashtags: [] }) } }));
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  process.env.OLLAMA_URL = "http://127.0.0.1:" + server.address().port;
  try {
    assert.deepEqual(await rateMoments(["a joke lands", "reading donations"]), [7, 2]);
    assert.equal(chats.at(-1).options.num_gpu, undefined, "nothing known yet: as before");
    await writeClipText({ transcript: "watch this" });
    await new Promise(r => setTimeout(r, 100));  // the /api/ps check runs after the writing
    await rateMoments(["a joke lands", "reading donations"]);
    assert.equal(chats.at(-1).options.num_gpu, 0);
  } finally { server.close(); delete process.env.OLLAMA_URL; }
});

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
