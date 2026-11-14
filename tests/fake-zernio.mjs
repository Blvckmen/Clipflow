// A local stand-in for the Zernio endpoints Clipflow uses (GET /accounts, POST /posts, GET /posts/:id), for
// end-to-end tests. Like Zernio, it downloads each post's video URL itself and honours Idempotency-Key.
// Control: GET /__log returns calls and posts; POST /__accounts sets the account list (JSON array);
// POST /__mode?platform=..&mode=published|pending|fail chooses how posts to that platform turn out.
import { createServer } from "node:http";

export function startFakeZernio({ port = 0, apiKey = "sk_test" } = {}) {
  const log = [], posts = new Map(), byKey = new Map(), modes = new Map();
  let accounts = [];
  const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const readBody = req => new Promise(r => { let b = ""; req.on("data", c => b += c); req.on("end", () => r(b)); });
  const view = p => ({ _id: p._id, status: p.status, platforms: [{ platform: p.platform, accountId: { _id: p.accountId }, status: p.platformStatus, ...(p.url && { platformPostUrl: p.url, platformPostId: "pp-" + p._id }), ...(p.errorMessage && { errorMessage: p.errorMessage }) }] });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake"), path = url.pathname, body = req.method === "POST" ? await readBody(req) : "";
    log.push({ method: req.method, path, idempotencyKey: req.headers["idempotency-key"] ?? null, at: Date.now() });
    if (path === "/__log") return send(res, 200, { log, posts: [...posts.values()] });
    if (path === "/__accounts") { accounts = JSON.parse(body); return send(res, 200, { ok: true }); }
    if (path === "/__mode") { modes.set(url.searchParams.get("platform"), url.searchParams.get("mode")); return send(res, 200, { ok: true }); }
    if (req.headers.authorization !== "Bearer " + apiKey) return send(res, 401, { error: "Invalid API key", code: "unauthorized" });

    if (path === "/api/v1/accounts" && req.method === "GET") return send(res, 200, { accounts });
    if (path === "/api/v1/posts" && req.method === "POST") {
      const key = req.headers["idempotency-key"];
      if (key && byKey.has(key)) return send(res, 200, { post: view(posts.get(byKey.get(key))), message: "Duplicate request" });
      const params = JSON.parse(body), target = params.platforms?.[0];
      const account = accounts.find(a => a._id === target?.accountId);
      if (!account || account.platform !== target.platform) return send(res, 400, { error: "Unknown account", code: "validation_error" });
      if (account.isActive === false) return send(res, 403, { error: "Account disconnected", code: "ACCOUNT_DISCONNECTED" });
      const media = params.mediaItems?.[0];
      // Fetch the video the way Zernio does: anonymously, from the public URL.
      const video = media?.url ? await fetch(media.url).catch(e => ({ ok: false, status: e.message })) : { ok: false, status: "no url" };
      const bytes = video.ok ? (await video.arrayBuffer()).byteLength : 0;
      const id = "zp-" + (posts.size + 1), mode = modes.get(target.platform) ?? "published";
      const post = { _id: id, platform: target.platform, accountId: target.accountId, params, fetchStatus: video.status, bytes, checks: 0 };
      if (!video.ok || bytes < 1024 || mode === "fail") Object.assign(post, { status: "failed", platformStatus: "failed", errorMessage: video.ok ? "Video rejected by platform" : "Media could not be fetched" });
      else if (mode === "pending") Object.assign(post, { status: "scheduled", platformStatus: "pending" });
      else Object.assign(post, { status: "published", platformStatus: "published", url: "https://example.test/" + target.platform + "/" + id });
      posts.set(id, post); if (key) byKey.set(key, id);
      return send(res, post.status === "published" ? 201 : 207, { post: view(post), message: "ok" });
    }
    const one = /^\/api\/v1\/posts\/([^/]+)$/.exec(path);
    if (one && req.method === "GET") {
      const post = posts.get(decodeURIComponent(one[1]));
      if (!post) return send(res, 404, { error: "Post not found", code: "not_found" });
      // A pending post finishes on its second check, like a platform that takes a little while.
      if (post.status === "scheduled" && ++post.checks >= 2) Object.assign(post, { status: "published", platformStatus: "published", url: "https://example.test/" + post.platform + "/" + post._id });
      return send(res, 200, { post: view(post) });
    }
    send(res, 404, { error: "unknown path " + path, code: "not_found" });
  });
  return new Promise(resolve => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, log })));
}
