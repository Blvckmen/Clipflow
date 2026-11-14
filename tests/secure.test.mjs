import { test } from "node:test";
import assert from "node:assert/strict";
import { decrypt, encrypt, newKey, signedMediaPath, verifyMediaSignature } from "../lib/secure.ts";

const key = newKey(), other = newKey();

test("encrypt round-trips and never repeats ciphertext", async () => {
  const a = await encrypt("IGAAT-secret-token", key), b = await encrypt("IGAAT-secret-token", key);
  assert.notEqual(a, b, "random IV per encryption");
  assert.ok(!a.includes("secret"));
  assert.equal(await decrypt(a, key), "IGAAT-secret-token");
});

test("decrypt refuses the wrong key and tampered data", async () => {
  const box = await encrypt("token", key);
  await assert.rejects(decrypt(box, other));
  const [v, iv, sealed] = box.split(".");
  const flipped = sealed.slice(0, 4) + (sealed[4] === "A" ? "B" : "A") + sealed.slice(5);
  await assert.rejects(decrypt([v, iv, flipped].join("."), key));
  await assert.rejects(decrypt("plain-text", key));
});

test("rejects keys that are not 32 bytes", async () => {
  await assert.rejects(encrypt("x", btoa("short")), /32 bytes/);
});

test("signed media links verify until they expire", async () => {
  const now = Date.UTC(2026, 10, 14, 12);
  const path = await signedMediaPath("clip-1", now + 3600_000, key);
  const url = new URL(path, "https://x.test");
  assert.match(url.pathname, /^\/media\/clip-1\.mp4$/);
  const e = url.searchParams.get("e"), s = url.searchParams.get("s");
  assert.equal(await verifyMediaSignature("clip-1", e, s, key, now), true);
  assert.equal(await verifyMediaSignature("clip-1", e, s, key, now + 3601_000), false, "expired");
  assert.equal(await verifyMediaSignature("clip-2", e, s, key, now), false, "other clip");
  assert.equal(await verifyMediaSignature("clip-1", String(Number(e) + 999), s, key, now), false, "extended expiry");
  assert.equal(await verifyMediaSignature("clip-1", e, s, other, now), false, "other key");
  assert.equal(await verifyMediaSignature("clip-1", null, s, key, now), false);
  assert.equal(await verifyMediaSignature("clip-1", "abc", s, key, now), false);
});
