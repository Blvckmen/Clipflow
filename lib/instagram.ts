// Instagram API with Instagram Login: OAuth and Reels publishing for an account the owner manages.
// Hosts are configurable so the whole flow can be exercised against a local fake (tests/fake-instagram.mjs).

export type InstagramConfig = { appId: string; appSecret: string; authUrl: string; apiUrl: string; graphUrl: string };
export const GRAPH_VERSION = "v27.0";
export const SCOPES = "instagram_business_basic,instagram_business_content_publish";

export class InstagramError extends Error {
  constructor(message: string, public code?: number, public tokenInvalid = false) { super(message); }
}

async function call(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({})) as Record<string, unknown> & { error?: { message?: string; code?: number; type?: string }; error_message?: string };
  if (!response.ok || body.error || body.error_message) {
    const error = body.error;
    const message = error?.message ?? body.error_message ?? "HTTP " + response.status;
    // 190 is Meta's "invalid or expired access token"; the account must be reconnected.
    const tokenInvalid = error?.code === 190 || (error?.type === "OAuthException" && /token/i.test(message));
    throw new InstagramError("Instagram: " + message, error?.code, tokenInvalid);
  }
  return body;
}

export function authorizeUrl(c: InstagramConfig, redirectUri: string, state: string) {
  const query = new URLSearchParams({ client_id: c.appId, redirect_uri: redirectUri, response_type: "code", scope: SCOPES, state });
  return c.authUrl + "/oauth/authorize?" + query;
}

// Code -> short-lived token -> long-lived (60-day) token, plus the account's id and username.
export async function connect(c: InstagramConfig, code: string, redirectUri: string) {
  const form = new FormData();
  for (const [k, v] of Object.entries({ client_id: c.appId, client_secret: c.appSecret, grant_type: "authorization_code", redirect_uri: redirectUri, code: code.replace(/#_$/, "") })) form.set(k, v);
  const short = await call(c.apiUrl + "/oauth/access_token", { method: "POST", body: form });
  // The docs show the token object both bare and wrapped in a "data" array.
  const first = (Array.isArray(short.data) ? short.data[0] : short) as { access_token?: string };
  if (!first?.access_token) throw new InstagramError("Instagram did not return an access token");
  const long = await call(c.graphUrl + "/access_token?" + new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: c.appSecret, access_token: first.access_token })) as { access_token: string; expires_in: number };
  const me = await call(c.graphUrl + "/" + GRAPH_VERSION + "/me?" + new URLSearchParams({ fields: "user_id,username", access_token: long.access_token })) as { user_id?: string; id?: string; username: string };
  return { token: long.access_token, expiresIn: long.expires_in, userId: String(me.user_id ?? me.id), username: me.username };
}

// Valid only for long-lived tokens at least 24 hours old; returns a token valid for another 60 days.
export async function refresh(c: InstagramConfig, token: string) {
  return await call(c.graphUrl + "/refresh_access_token?" + new URLSearchParams({ grant_type: "ig_refresh_token", access_token: token })) as { access_token: string; expires_in: number };
}

const auth = (token: string) => ({ authorization: "Bearer " + token, "content-type": "application/json" });

export async function createReel(c: InstagramConfig, token: string, userId: string, videoUrl: string, caption: string) {
  const body = await call(c.graphUrl + "/" + GRAPH_VERSION + "/" + userId + "/media", { method: "POST", headers: auth(token), body: JSON.stringify({ media_type: "REELS", video_url: videoUrl, caption, share_to_feed: true }) });
  return String(body.id);
}

// EXPIRED | ERROR | FINISHED | IN_PROGRESS | PUBLISHED
export async function containerStatus(c: InstagramConfig, token: string, containerId: string) {
  const body = await call(c.graphUrl + "/" + GRAPH_VERSION + "/" + containerId + "?fields=status_code,status", { headers: auth(token) }) as { status_code: string; status?: string };
  return { code: body.status_code, detail: body.status ?? null };
}

export async function publish(c: InstagramConfig, token: string, userId: string, containerId: string) {
  const body = await call(c.graphUrl + "/" + GRAPH_VERSION + "/" + userId + "/media_publish", { method: "POST", headers: auth(token), body: JSON.stringify({ creation_id: containerId }) });
  return String(body.id);
}

export async function permalink(c: InstagramConfig, token: string, mediaId: string) {
  const body = await call(c.graphUrl + "/" + GRAPH_VERSION + "/" + mediaId + "?fields=permalink", { headers: auth(token) }) as { permalink?: string };
  return body.permalink ?? null;
}

// Instagram's own rolling 24-hour publishing allowance (currently 50) and how much is used.
export async function publishingQuota(c: InstagramConfig, token: string, userId: string) {
  const body = await call(c.graphUrl + "/" + GRAPH_VERSION + "/" + userId + "/content_publishing_limit?fields=quota_usage,config", { headers: auth(token) }) as { data?: { quota_usage: number; config?: { quota_total: number } }[] };
  const row = body.data?.[0];
  return { used: row?.quota_usage ?? 0, total: row?.config?.quota_total ?? 50 };
}
