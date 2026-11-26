import { test } from "node:test";
import assert from "node:assert/strict";
import { cookie, isToken, ownerFor, randomToken, readCookie, safeReturn, sha256, signupsOpen, twitchAuthorizeUrl } from "../lib/app-auth.mjs";

test("session tokens are random 64-hex strings, stored only as their SHA-256", async () => {
  const a = randomToken(), b = randomToken();
  assert.ok(isToken(a) && isToken(b) && a !== b);
  assert.equal(isToken("abc"), false);
  assert.equal(isToken(a.toUpperCase()), false);
  assert.equal(await sha256("x"), "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881");
});

test("cookies: read one by name, and set HttpOnly, Secure and SameSite=Lax", () => {
  assert.equal(readCookie("a=1; cf_session=abc ; b=2", "cf_session"), "abc");
  assert.equal(readCookie("cf_sessionx=1", "cf_session"), null);
  assert.equal(readCookie(null, "cf_session"), null);
  assert.equal(cookie("cf_session", "v", { maxAge: 60 }), "cf_session=v; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax");
  assert.equal(cookie("cf_oauth", "", { path: "/api/auth", maxAge: 0, secure: false }), "cf_oauth=; Path=/api/auth; Max-Age=0; HttpOnly; SameSite=Lax");
});

test("after signing in, only a path on this site is followed", () => {
  assert.equal(safeReturn("/?view=Settings"), "/?view=Settings");
  for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "", null, "x"]) assert.equal(safeReturn(bad), "/");
});

test("a sign-in goes to its linked workspace, links to the signed-in one, or opens a new one only when sign-ups are open", () => {
  const base = { provider: "twitch", providerId: "123" };
  assert.deepEqual(ownerFor({ ...base, linked: "access:me", current: "access:other", open: false }), { owner: "access:me", link: false }, "linked wins");
  assert.deepEqual(ownerFor({ ...base, linked: null, current: "access:me", open: false }), { owner: "access:me", link: true }, "an Access user links Twitch");
  assert.deepEqual(ownerFor({ ...base, linked: null, current: null, open: true }), { owner: "twitch:123", link: true });
  assert.match(ownerFor({ ...base, linked: null, current: null, open: false }).refused, /isn't open for new sign-ups/);
  assert.equal(signupsOpen("OPEN"), true);
  assert.equal(signupsOpen(undefined), false);
});

test("the Twitch sign-in link asks only for the account and its email, with the state to check on return", () => {
  const u = new URL(twitchAuthorizeUrl({ clientId: "cid", redirectUri: "https://x.dev/api/auth/twitch/callback", state: "s".repeat(64) }));
  assert.equal(u.origin + u.pathname, "https://id.twitch.tv/oauth2/authorize");
  assert.equal(u.searchParams.get("scope"), "user:read:email");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("redirect_uri"), "https://x.dev/api/auth/twitch/callback");
  assert.equal(u.searchParams.get("state"), "s".repeat(64));
});
