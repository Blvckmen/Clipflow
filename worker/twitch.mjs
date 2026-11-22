// Viewers' Twitch clips: the clips viewers made on a channel, found through Twitch's official API (Helix) with the
// worker's own Twitch app (TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET from dev.twitch.tv; an app access token, so no
// one signs in) and downloaded with streamlink. Each becomes a Clipflow clip like any other: transcribed, framed in
// the streamer's look, and sent for review.

// The channel login from a streamer's Twitch URL ("https://www.twitch.tv/name" -> "name"), or null for other sites.
export function twitchLogin(url) {
  try {
    const u = new URL(url), host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
    if (host !== "twitch.tv") return null;
    const name = u.pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
    return /^[a-z0-9_]{2,25}$/.test(name) ? name : null;
  } catch { return null; }
}

// Where streamlink can fetch a clip; ids are letters, digits, - and _.
export const clipUrl = id => { if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid Twitch clip id"); return "https://clips.twitch.tv/" + id; };

// Whether two viewers' clips show the same moment: several viewers often clip the same thing, each clip with its own
// id. With both places in the broadcast known (video_id and vod_offset, seconds into it), they overlap (or come
// within GAP seconds); otherwise (Twitch fills vod_offset in later) they were made within a clip's length of each other.
const GAP = 5;
export function sameMoment(a, b) {
  const len = x => Math.max(0, Number(x.duration) || 0);
  // Other channels' clips are other moments (older remembered entries don't know their channel).
  if (a.broadcaster_id && b.broadcaster_id && a.broadcaster_id !== b.broadcaster_id) return false;
  if (a.video_id && b.video_id && Number.isFinite(a.vod_offset) && Number.isFinite(b.vod_offset))
    return a.video_id === b.video_id && a.vod_offset < b.vod_offset + len(b) + GAP && b.vod_offset < a.vod_offset + len(a) + GAP;
  const ta = Date.parse(a.created_at), tb = Date.parse(b.created_at);
  return Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) < Math.max(len(a), len(b), 30) * 1000;
}
// What to remember of an imported clip, to know its moment once Twitch stops listing it.
export const momentOf = c => ({ broadcaster_id: c.broadcaster_id || null, video_id: c.video_id || null, vod_offset: Number.isFinite(c.vod_offset) ? c.vod_offset : null, duration: Number(c.duration) || 0, created_at: c.created_at ?? null });

// The clips worth importing, best first: at least `minViews` views, at least `minSeconds` long (shorter ones are
// too short to post), not imported before, not the same moment as one imported before (`taken`: their moments) or
// as a better one picked now, at most `max`.
export function pickClips(list, { minViews, seen, max, minSeconds = 15, taken = [] }) {
  const have = [...taken], out = [];
  const ranked = (list ?? [])
    .filter(c => c && typeof c.id === "string" && Number(c.view_count) >= minViews && Number(c.duration) >= minSeconds && !seen.has(c.id))
    .sort((a, b) => b.view_count - a.view_count || String(a.created_at).localeCompare(String(b.created_at)));
  for (const c of ranked) {
    if (out.length >= max) break;
    if (have.some(t => sameMoment(c, t))) continue;
    out.push(c); have.push(c);
  }
  return out;
}

export class Twitch {
  constructor({ clientId, clientSecret, fetch = globalThis.fetch }) {
    this.clientId = clientId; this.clientSecret = clientSecret; this.fetch = fetch;
    this.access = null; this.users = new Map();
  }
  static fromEnv(env = process.env) {
    return env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET ? new Twitch({ clientId: env.TWITCH_CLIENT_ID, clientSecret: env.TWITCH_CLIENT_SECRET }) : null;
  }
  async token(renew = false) {
    if (!renew && this.access && this.access.until > Date.now()) return this.access.token;
    const body = new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: "client_credentials" });
    const response = await this.fetch("https://id.twitch.tv/oauth2/token", { method: "POST", body, signal: AbortSignal.timeout(20_000) });
    // Never include the response body: a bad request can echo the credentials back.
    if (!response.ok) throw new Error(response.status === 400 || response.status === 403 ? "Twitch refused the app's Client ID or secret (HTTP " + response.status + ")" : "Twitch sign-in failed (HTTP " + response.status + ")");
    const json = await response.json();
    if (typeof json.access_token !== "string") throw new Error("Twitch sign-in gave no token");
    this.access = { token: json.access_token, until: Date.now() + Math.max(60, Number(json.expires_in) || 3600) * 1000 - 60_000 };
    return this.access.token;
  }
  async get(path, params) {
    const url = new URL("https://api.twitch.tv/helix/" + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetch(url, { headers: { "Client-Id": this.clientId, Authorization: "Bearer " + await this.token(attempt > 0) }, signal: AbortSignal.timeout(20_000) });
      // An expired or revoked token: sign in again once.
      if (response.status === 401 && attempt === 0) continue;
      if (!response.ok) throw new Error("Twitch " + path + " failed (HTTP " + response.status + ")");
      return (await response.json()).data ?? [];
    }
  }
  async userId(login) {
    if (!this.users.has(login)) {
      const [user] = await this.get("users", { login });
      if (!user?.id) throw new Error("No Twitch channel called " + login);
      this.users.set(login, user.id);
    }
    return this.users.get(login);
  }
  // Clips made on the channel since `since` (a Date), up to 20, as Helix returns them (most viewed first).
  async clips(login, since) {
    return this.get("clips", { broadcaster_id: await this.userId(login), started_at: since.toISOString(), ended_at: new Date().toISOString(), first: 20 });
  }
}
