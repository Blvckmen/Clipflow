import { test } from "node:test";
import assert from "node:assert/strict";
import { pair, siteOrigin, updateEnv } from "../pair.mjs";
import { PAIR_ALPHABET, hashPairCode, newPairCode, normalizePairCode } from "../../lib/pairing.mjs";

test("pairing codes are 8 unambiguous characters, typed in any form", async () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const code = newPairCode();
    assert.match(code, /^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    assert.ok([...code.replace("-", "")].every(c => PAIR_ALPHABET.includes(c)), code);
    seen.add(code);
  }
  assert.ok(seen.size > 495, "codes don't repeat");
  assert.equal(normalizePairCode(" 4f7k-9q2m "), "4F7K9Q2M");
  assert.equal(normalizePairCode("4F7K 9Q2M"), "4F7K9Q2M");
  for (const bad of ["4F7K-9Q2", "0F7K-9Q2M", "4F7K-9Q2MX", "", null, 42]) assert.equal(normalizePairCode(bad), null, String(bad));
  assert.equal(await hashPairCode("4F7K9Q2M"), await hashPairCode(normalizePairCode("4f7k-9q2m")));
  assert.notEqual(await hashPairCode("4F7K9Q2M"), await hashPairCode("4F7K9Q2N"));
});

test("pair.mjs only talks to https sites, and keeps the rest of worker/.env", () => {
  assert.equal(siteOrigin("https://clipflow.example.com/some/page"), "https://clipflow.example.com");
  assert.equal(siteOrigin("http://127.0.0.1:8790"), "http://127.0.0.1:8790");
  assert.equal(siteOrigin("http://clipflow.example.com"), null);
  assert.equal(siteOrigin("not a url"), null);
  const before = "# my settings\r\nCLIPFLOW_URL=https://old.example\r\nMAX_CAPTURES=2\r\nCLIPFLOW_TOKEN=cfw_old\r\n";
  assert.equal(updateEnv(before, { CLIPFLOW_URL: "https://new.example", CLIPFLOW_TOKEN: "cfw_new" }), "# my settings\nCLIPFLOW_URL=https://new.example\nMAX_CAPTURES=2\nCLIPFLOW_TOKEN=cfw_new\n");
  assert.equal(updateEnv("", { CLIPFLOW_URL: "https://a", CLIPFLOW_TOKEN: "cfw_b" }), "CLIPFLOW_URL=https://a\nCLIPFLOW_TOKEN=cfw_b\n");
  assert.equal(updateEnv("# CLIPFLOW_TOKEN=commented\n", { CLIPFLOW_TOKEN: "cfw_b" }), "# CLIPFLOW_TOKEN=commented\nCLIPFLOW_TOKEN=cfw_b\n");
});

test("pair() returns the token, and passes on the site's reason when it says no", async () => {
  const token = "cfw_" + "a".repeat(64);
  const ok = async (url, init) => { assert.equal(url, "https://s.example/api/worker/pair"); assert.deepEqual(JSON.parse(init.body), { code: "4F7K-9Q2M" }); return new Response(JSON.stringify({ token, url: "https://s.example" }), { headers: { "content-type": "application/json" } }); };
  assert.equal((await pair("https://s.example", "4F7K-9Q2M", { fetch: ok })).token, token);
  const no = async () => new Response(JSON.stringify({ error: "That code is wrong or has expired." }), { status: 400 });
  await assert.rejects(pair("https://s.example", "XXXX-XXXX", { fetch: no }), /wrong or has expired/);
  const down = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(pair("https://s.example", "XXXX-XXXX", { fetch: down }), /Couldn't reach https:\/\/s\.example/);
  const odd = async () => new Response(JSON.stringify({ token: "nope" }));
  await assert.rejects(pair("https://s.example", "XXXX-XXXX", { fetch: odd }), /didn't accept/);
});
