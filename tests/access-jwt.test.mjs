import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import { verifyAccessJwt } from "../lib/access-jwt.ts";

const team = "clipflow.cloudflareaccess.com", aud = "aud-tag-123";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keys = [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" }];
const enc = obj => Buffer.from(JSON.stringify(obj)).toString("base64url");
const now = Date.UTC(2026, 10, 13, 12) ;
const sign = (payload, { kid = "k1", alg = "RS256", key = privateKey } = {}) => {
  const head = enc({ alg, kid, typ: "JWT" }) + "." + enc(payload);
  return head + "." + createSign("RSA-SHA256").update(head).sign(key).toString("base64url");
};
const good = { iss: "https://" + team, aud: [aud], sub: "user-uuid-1", email: "owner@example.com", exp: now / 1000 + 600, nbf: now / 1000 - 10 };
const check = token => verifyAccessJwt(token, { teamDomain: team, audience: aud, keys, now });

test("accepts a valid token and returns the stable user id", async () => {
  assert.deepEqual(await check(sign(good)), { userId: "user-uuid-1", email: "owner@example.com" });
});

test("rejects tokens for another app, another team, or that have expired", async () => {
  assert.equal(await check(sign({ ...good, aud: ["someone-elses-app"] })), null);
  assert.equal(await check(sign({ ...good, iss: "https://evil.cloudflareaccess.com" })), null);
  assert.equal(await check(sign({ ...good, exp: now / 1000 - 1 })), null);
  assert.equal(await check(sign({ ...good, nbf: now / 1000 + 3600 })), null);
});

test("rejects forged, altered, or malformed tokens", async () => {
  assert.equal(await check(sign(good, { key: other.privateKey })), null, "signed with a different key");
  assert.equal(await check(sign(good, { kid: "unknown" })), null);
  assert.equal(await check(sign(good, { alg: "none" })), null);
  const [h, , s] = sign(good).split(".");
  assert.equal(await check([h, enc({ ...good, sub: "attacker" }), s].join(".")), null, "payload changed after signing");
  assert.equal(await check("not.a.jwt.at.all"), null);
  assert.equal(await check("garbage"), null);
  assert.equal(await check(sign({ ...good, email: "" })), null);
});
