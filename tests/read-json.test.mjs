import { test } from "node:test";
import assert from "node:assert/strict";
import { OFFLINE, SIGNED_OUT, apiFetch, errorPage, readJson } from "../lib/read-json.mjs";

const html = "<!DOCTYPE html><html><body>Sign in</body></html>";
const page = (status, url) => {
  const r = new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
  if (url) Object.defineProperty(r, "url", { value: url });
  return r;
};

test("JSON answers are read as before, error answers included", async () => {
  assert.deepEqual(await readJson(Response.json({ ok: true })), { ok: true });
  assert.deepEqual(await readJson(Response.json({ error: "Nope." }, { status: 409 })), { error: "Nope." });
  // The app's own "not signed in" answer is JSON and still reaches the caller.
  assert.deepEqual(await readJson(Response.json({ signIn: "/x" }, { status: 401 })), { signIn: "/x" });
});

test("the Access sign-in page says the sign-in expired", async () => {
  await assert.rejects(readJson(page(200, "https://team.cloudflareaccess.com/cdn-cgi/access/login/x")), { message: SIGNED_OUT });
  await assert.rejects(readJson(page(403)), { message: SIGNED_OUT });
  await assert.rejects(readJson(page(401)), { message: SIGNED_OUT });
});

test("any other web page says the server answered with an error page", async () => {
  await assert.rejects(readJson(page(500)), { message: errorPage(500) });
  await assert.rejects(readJson(page(502)), { message: /HTTP 502/ });
  // Labelled JSON but isn't.
  await assert.rejects(readJson(new Response(html, { status: 500, headers: { "content-type": "application/json" } })), { message: errorPage(500) });
});

test("apiFetch says plainly when Clipflow can't be reached, but lets an abort through", async () => {
  await assert.rejects(apiFetch("http://127.0.0.1:1/unreachable"), { message: OFFLINE });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(apiFetch("http://127.0.0.1:1/x", { signal: controller.signal }), { name: "AbortError" });
});
