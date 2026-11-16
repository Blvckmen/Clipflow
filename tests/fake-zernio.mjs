// A local stand-in for the Zernio endpoints Clipflow uses (accounts, posts, key check, profiles, connect,
// disconnect), for end-to-end tests. Like Zernio, it downloads each post's video URL itself and honours
// Idempotency-Key. Several API keys are accepted (`keys`: key -> owner name); the log records which one each call used.
// Control: GET /__log returns calls and posts; POST /__accounts sets the account list (JSON array);
// POST /__mode?platform=..&mode=published|pending|fail|held chooses how posts to that platform turn out (held: the
// platform's daily limit is reached, so the post waits until `until`; POST /__release lets held posts go out);
// GET /__authorize stands in for a platform's sign-in page: it adds the account and redirects back like Zernio.
// Keys listed in `isolated` are separate Zernio accounts: they see only the accounts connected with them, while the
// other keys share the /__accounts list (and the accounts they connect).
import { createServer } from "node:http";

export function startFakeZernio({ port = 0, apiKey = "sk_test", keys = { [apiKey]: "Test Owner" }, isolated = [], limits = {} } = {}) {
  const log = [], posts = new Map(), byKey = new Map(), modes = new Map(), holds = new Map();
  let accounts = [];
  // Which accounts a key can see and use.
  const visible = (a, auth) => isolated.includes(auth) ? a.key === auth : !isolated.includes(a.key);
  const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const readBody = req => new Promise(r => { let b = ""; req.on("data", c => b += c); req.on("end", () => r(b)); });
  const view = p => ({ _id: p._id, status: p.status, platforms: [{ platform: p.platform, accountId: { _id: p.accountId }, status: p.platformStatus, ...(p.url && { platformPostUrl: p.url, platformPostId: "pp-" + p._id }), ...(p.errorMessage && { errorMessage: p.errorMessage }) }] });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake"), path = url.pathname, body = req.method === "POST" ? await readBody(req) : "";
    const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    log.push({ method: req.method, path, auth, idempotencyKey: req.headers["idempotency-key"] ?? null, at: Date.now() });
    if (path === "/__log") return send(res, 200, { log, posts: [...posts.values()] });
    if (path === "/__accounts") { accounts = JSON.parse(body); return send(res, 200, { ok: true }); }
    if (path === "/__mode") { modes.set(url.searchParams.get("platform"), url.searchParams.get("mode")); holds.set(url.searchParams.get("platform"), url.searchParams.get("until")); return send(res, 200, { ok: true }); }
    if (path === "/__release") { for (const p of posts.values()) if (p.held) p.held = false; return send(res, 200, { ok: true }); }
    if (path === "/__authorize") {
      const platform = url.searchParams.get("platform"), back = new URL(url.searchParams.get("redirect"));
      if (url.searchParams.get("deny")) { back.searchParams.set("error", "access_denied"); back.searchParams.set("platform", platform); back.searchParams.set("error_message", "The user cancelled"); }
      else {
        const account = { _id: "acc-new-" + (accounts.length + 1), platform, username: "new_" + platform + (url.searchParams.get("k") && isolated.includes(url.searchParams.get("k")) ? "_2" : ""), isActive: true, key: url.searchParams.get("k") };
        accounts = [...accounts, account];
        for (const [k, v] of Object.entries({ connected: platform, profileId: "prof-1", accountId: account._id, username: account.username })) back.searchParams.set(k, v);
      }
      res.writeHead(302, { location: back.href }); return res.end();
    }
    if (!keys[auth]) return send(res, 401, { error: "Invalid API key", code: "unauthorized" });

    if (path === "/api/v1/auth/verify") return send(res, 200, { valid: true, name: keys[auth], authType: "api_key" });
    if (path === "/api/v1/profiles" && req.method === "GET") return send(res, 200, { profiles: [{ _id: "prof-1", name: "Default", isDefault: true }] });
    const connect = /^\/api\/v1\/connect\/([a-z]+)$/.exec(path);
    if (connect && req.method === "GET") {
      // Like Zernio's free plan: a key with a limit can't connect more accounts than that.
      if (limits[auth] !== undefined && accounts.filter(a => visible(a, auth)).length >= limits[auth]) return send(res, 402, { error: "Add a payment method to connect more than " + limits[auth] + " accounts.", code: "PAYMENT_REQUIRED", reason: "free_tier_exceeded" });
      if (url.searchParams.get("profileId") !== "prof-1" || !/^https?:\/\//.test(url.searchParams.get("redirect_url") ?? "")) return send(res, 400, { error: "profileId and an absolute redirect_url are required", code: "INVALID_REDIRECT_URL" });
      return send(res, 200, { authUrl: "http://127.0.0.1:" + server.address().port + "/__authorize?platform=" + connect[1] + "&k=" + encodeURIComponent(auth) + "&redirect=" + encodeURIComponent(url.searchParams.get("redirect_url")), state: "st" });
    }
    const account = /^\/api\/v1\/accounts\/([^/]+)$/.exec(path);
    if (account && req.method === "DELETE") {
      const id = decodeURIComponent(account[1]);
      if (!accounts.some(a => a._id === id && visible(a, auth))) return send(res, 404, { error: "Account not found", code: "not_found" });
      accounts = accounts.filter(a => a._id !== id); return send(res, 200, { message: "Account disconnected" });
    }

    if (path === "/api/v1/accounts" && req.method === "GET") return send(res, 200, { accounts: accounts.filter(a => visible(a, auth)).map(({ key, ...a }) => a) });
    if (path === "/api/v1/posts" && req.method === "POST") {
      const key = req.headers["idempotency-key"];
      if (key && byKey.has(key)) return send(res, 200, { post: view(posts.get(byKey.get(key))), message: "Duplicate request" });
      const params = JSON.parse(body), target = params.platforms?.[0];
      const account = accounts.find(a => a._id === target?.accountId && visible(a, auth));
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
      else if (mode === "held") Object.assign(post, { status: "publishing", platformStatus: "pending", held: true, errorMessage: "TikTok allows 15 video posts per account per day through the Business API. This post is queued and will publish automatically after " + holds.get(target.platform) + "." });
      else Object.assign(post, { status: "published", platformStatus: "published", url: "https://example.test/" + target.platform + "/" + id });
      posts.set(id, post); if (key) byKey.set(key, id);
      return send(res, post.status === "published" ? 201 : 207, { post: view(post), message: "ok" });
    }
    // Stored analytics, like Zernio's: every published post with lifetime metrics (views 1000, likes 50, ...).
    if (path === "/api/v1/analytics" && req.method === "GET") {
      const published = [...posts.values()].filter(p => p.status === "published" && accounts.some(a => a._id === p.accountId && visible(a, auth)));
      const limit = Number(url.searchParams.get("limit") ?? 50), page = Number(url.searchParams.get("page") ?? 1);
      const items = published.slice((page - 1) * limit, page * limit).map(p => ({ _id: "an-" + p._id, latePostId: p._id, platform: p.platform, status: "published", platformPostUrl: p.url,
        platforms: [{ platform: p.platform, status: "published", platformPostId: "pp-" + p._id, analytics: { views: 1000, likes: 50, comments: 5, shares: 2, saves: 3 } }] }));
      return send(res, 200, { hasAnalyticsAccess: true, overview: { publishedPosts: published.length }, posts: items, pagination: { page, limit, total: published.length, pages: Math.max(1, Math.ceil(published.length / limit)) } });
    }
    const one = /^\/api\/v1\/posts\/([^/]+)$/.exec(path);
    if (one && req.method === "GET") {
      const post = posts.get(decodeURIComponent(one[1]));
      if (!post) return send(res, 404, { error: "Post not found", code: "not_found" });
      // A pending post finishes on its second check, like a platform that takes a little while.
      if (post.status === "publishing" && !post.held) Object.assign(post, { status: "published", platformStatus: "published", errorMessage: undefined, url: "https://example.test/" + post.platform + "/" + post._id });
      if (post.status === "scheduled" && ++post.checks >= 2) Object.assign(post, { status: "published", platformStatus: "published", url: "https://example.test/" + post.platform + "/" + post._id });
      return send(res, 200, { post: view(post) });
    }
    send(res, 404, { error: "unknown path " + path, code: "not_found" });
  });
  return new Promise(resolve => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, log })));
}
