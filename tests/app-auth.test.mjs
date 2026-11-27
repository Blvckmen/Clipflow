import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS, cookie, googleAccount, googleAuthorizeUrl, googleUrls, isToken, ownerFor, randomToken, readCookie, safeReturn, sha256, signupsOpen, twitchAuthorizeUrl } from "../lib/app-auth.mjs";

test("Sign in with Google asks only for the account's id, name and email, with the account picker", () => {
  const url = new URL(googleAuthorizeUrl({ clientId: "abc.apps.googleusercontent.com", redirectUri: "https://x.example/api/auth/google/callback", state: "s".repeat(64) }));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("prompt"), "select_account");
  assert.equal(url.searchParams.get("redirect_uri"), "https://x.example/api/auth/google/callback");
  assert.equal(url.searchParams.get("access_type"), null, "no offline access: nothing is kept");
  assert.deepEqual(googleUrls({ GOOGLE_AUTH_URL: "http://127.0.0.1:9/", GOOGLE_TOKEN_URL: "http://127.0.0.1:9", GOOGLE_API_URL: "http://127.0.0.1:9" }), { auth: "http://127.0.0.1:9", token: "http://127.0.0.1:9", api: "http://127.0.0.1:9" });
  assert.equal(googleUrls({}).token, "https://oauth2.googleapis.com");
  assert.deepEqual(Object.keys(PROVIDERS), ["twitch", "google"]);
});

test("a Google account is read safely: digits for its id, an unverified email left out", () => {
  assert.deepEqual(googleAccount({ sub: "1234567890", email: "a@b.co", email_verified: true, name: "Kai" }), { id: "1234567890", email: "a@b.co", name: "Kai" });
  assert.deepEqual(googleAccount({ sub: "42", email: "a@b.co", email_verified: false }), { id: "42", email: null, name: "" }, "an unverified email isn't kept, or shown as the name");
  assert.ok("problem" in googleAccount({ sub: "../admin" }));
  assert.ok("problem" in googleAccount(null));
  assert.equal(googleAccount({ sub: "1", name: "x\u0000y".padEnd(300, "z") }).name.length, 100);
  // A new Google account never joins someone's workspace by email: only an existing link or the signed-in owner.
  assert.deepEqual(ownerFor({ linked: null, current: null, provider: "google", providerId: "42", open: true }), { owner: "google:42", link: true });
  assert.deepEqual(ownerFor({ linked: null, current: "access:me", provider: "google", providerId: "42", open: false }), { owner: "access:me", link: true });
  assert.ok("refused" in ownerFor({ linked: null, current: null, provider: "google", providerId: "42", open: false }));
});

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
