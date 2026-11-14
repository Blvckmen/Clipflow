// A local stand-in for the Instagram Login + Graph API endpoints Clipflow uses, for end-to-end tests.
// Like Instagram, it downloads each Reel's video_url itself. GET /__log returns every call; POST /__revoke
// invalidates issued tokens so token-expiry handling can be exercised. POST /__signin?id=..&username=.. chooses
// which account the next sign-in connects (the default is 17890000 / clipflow_test).
import { createServer } from "node:http";

export function startFakeInstagram({ port = 0, appId = "test-app", appSecret = "test-secret" } = {}) {
  const log = [], containers = new Map(), valid = new Map(), users = new Map([["17890000", "clipflow_test"]]), published = new Map();
  let tokenSeq = 0, signingIn = "17890000";
  const issue = (prefix, user) => { const t = prefix + "-" + ++tokenSeq; valid.set(t, user); return t; };
  const send = (res, status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
  const oauthError = res => send(res, 400, { error: { message: "Error validating access token: Session has expired", type: "OAuthException", code: 190 } });
  const readBody = req => new Promise(r => { let b = ""; req.on("data", c => b += c); req.on("end", () => r(b)); });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake"), path = url.pathname, q = url.searchParams;
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "") || q.get("access_token");
    const body = req.method === "POST" ? await readBody(req) : "";
    const entry = { method: req.method, path, query: Object.fromEntries(q), at: Date.now() };
    log.push(entry);

    if (path === "/__log") return send(res, 200, { log, containers: [...containers.entries()] });
    if (path === "/__revoke") { valid.clear(); return send(res, 200, { ok: true }); }
    if (path === "/__signin") { signingIn = q.get("id"); users.set(signingIn, q.get("username")); return send(res, 200, { ok: true }); }

    // 1. Authorization: approve immediately and bounce back with a code (Instagram appends "#_").
    if (path === "/oauth/authorize") {
      if (q.get("client_id") !== appId || !q.get("scope")?.includes("instagram_business_content_publish")) return send(res, 400, { error_message: "bad authorize request" });
      const back = new URL(q.get("redirect_uri"));
      back.searchParams.set("code", "fake-code-" + signingIn); back.searchParams.set("state", q.get("state"));
      res.writeHead(302, { location: back.href + "#_" }); return res.end();
    }
    // 2. Code exchange (multipart form, like the docs' curl -F example).
    if (path === "/oauth/access_token" && req.method === "POST") {
      const field = name => new RegExp('name="' + name + '"\\r\\n\\r\\n([^\\r]*)').exec(body)?.[1];
      const user = /^fake-code-(\d+)$/.exec(field("code") ?? "")?.[1];
      if (field("client_secret") !== appSecret || !users.has(user) || field("grant_type") !== "authorization_code") return send(res, 400, { error_message: "Invalid code exchange" });
      return send(res, 200, { data: [{ access_token: issue("short", user), user_id: user, permissions: "instagram_business_basic,instagram_business_content_publish" }] });
    }
    if (path === "/access_token") {
      if (q.get("grant_type") !== "ig_exchange_token" || q.get("client_secret") !== appSecret || !valid.has(bearer)) return oauthError(res);
      return send(res, 200, { access_token: issue("long", valid.get(bearer)), token_type: "bearer", expires_in: 5184000 });
    }
    if (path === "/refresh_access_token") {
      if (!valid.has(bearer)) return oauthError(res);
      return send(res, 200, { access_token: issue("long", valid.get(bearer)), token_type: "bearer", expires_in: 5184000 });
    }
    if (!path.startsWith("/v27.0/")) return send(res, 404, { error: { message: "unknown path " + path } });
    if (!valid.has(bearer)) return oauthError(res);
    const rest = path.slice("/v27.0/".length), me = valid.get(bearer);
    // A token only works for its own account.
    const [owner, edge] = rest.split("/");
    if (edge && owner !== me) return send(res, 400, { error: { message: "Token does not belong to " + owner, code: 10 } });

    if (rest === "me") return send(res, 200, { user_id: me, username: users.get(me) });
    if (edge === "content_publishing_limit") return send(res, 200, { data: [{ quota_usage: published.get(me) ?? 0, config: { quota_total: 50, quota_duration: 86400 } }] });
    if (edge === "media" && req.method === "POST") {
      const params = JSON.parse(body);
      if (params.media_type !== "REELS" || !params.video_url) return send(res, 400, { error: { message: "media_type REELS and video_url are required" } });
      // Fetch the video the way Instagram does: anonymously, from the public URL.
      const video = await fetch(params.video_url).catch(e => ({ ok: false, status: e.message }));
      const bytes = video.ok ? (await video.arrayBuffer()).byteLength : 0;
      const id = "c-" + (containers.size + 1);
      containers.set(id, { user: me, caption: params.caption, videoUrl: params.video_url, fetchStatus: video.status, contentType: video.headers?.get?.("content-type") ?? null, bytes, checks: 0, status: video.ok && bytes > 1024 ? "IN_PROGRESS" : "ERROR" });
      return send(res, 200, { id });
    }
    if (edge === "media_publish" && req.method === "POST") {
      const c = containers.get(JSON.parse(body).creation_id);
      if (!c || c.status !== "FINISHED" || c.user !== me) return send(res, 400, { error: { message: "Media not ready for publishing" } });
      c.status = "PUBLISHED"; published.set(me, (published.get(me) ?? 0) + 1);
      const total = [...published.values()].reduce((a, b) => a + b, 0);
      return send(res, 200, { id: "m-" + total });
    }
    if (containers.has(rest)) {
      const c = containers.get(rest);
      // First check reports IN_PROGRESS, later checks FINISHED, like a real upload that takes a minute.
      if (c.status === "IN_PROGRESS" && c.checks++ >= 1) c.status = "FINISHED";
      return send(res, 200, { status_code: c.status, ...(c.status === "ERROR" && { status: "2207026: video could not be fetched" }) });
    }
    if (/^m-\d+$/.test(rest)) return send(res, 200, { permalink: "https://www.instagram.com/reel/" + rest + "/" });
    send(res, 404, { error: { message: "unknown object " + rest } });
  });
  return new Promise(resolve => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, log })));
}

// Standalone: node tests/fake-instagram.mjs [port]
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const { port } = await startFakeInstagram({ port: Number(process.argv[2] ?? 8899) });
  console.log("fake Instagram listening on http://127.0.0.1:" + port);
}
