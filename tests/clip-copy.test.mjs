import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
test("clip copy has owner-scoped reads and mutations",()=>{
 const api=read("app/api/clips/[id]/copy/route.ts");
 assert.match(api,/currentUser\(\)/);
 assert.match(api,/c.id=\? AND c.owner=\?/);
 assert.match(api,/WHERE owner=excluded.owner/);
 assert.match(api,/Request origin rejected/);
});
test("generated copy is a draft until approved",()=>{
 const api=read("app/api/clips/[id]/copy/route.ts");
 assert.match(api,/status='draft'/);
 assert.match(api,/z.enum\(\["draft","approved"\]\)/);
});
test("publishing uses only approved Instagram captions",()=>{
 const publisher=read("lib/publisher.ts");
 assert.match(publisher,/status='approved' AND platform='Instagram'/);
 assert.match(publisher,/clip.ai_caption \|\| renderCaption/);
});
test("worker uploads a transcript and avoids a second transcription pass",()=>{
 const media=read("worker/media.mjs");
 const worker=read("worker/main.mjs");
 assert.match(media,/transcript=segments.flatMap/);
 assert.match(worker,/transcript:row.transcript\|\|''/);
});

test("Cloudflare Workers AI is the default without an OpenAI key",()=>{
 const provider=read("lib/ai-copy.ts");
 const deploy=read("scripts/deploy-cloudflare.mjs");
 const vite=read("vite.config.ts");
 assert.match(provider,/AI_PROVIDER==="openai"\?"openai":"cloudflare"/);
 assert.match(provider,/env\.AI!\.run/);
 assert.match(deploy,/ai: \{ binding: "AI" \}/);
 assert.match(vite,/ai: \{ binding: "AI" \}/);
});
