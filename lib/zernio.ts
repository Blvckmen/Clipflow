// Zernio (https://zernio.com) posts to TikTok, Instagram, YouTube and more through one API key. The social accounts
// are connected on Zernio's own site; Clipflow lists them and sends each approved clip's signed video link.
export type ZernioConfig = { apiKey: string; apiUrl: string };
export type ZernioAccount = { _id: string; platform: string; username?: string; displayName?: string; isActive?: boolean };
export type ZernioPlatformResult = { platform: string; status?: string; platformPostUrl?: string; platformPostId?: string; errorMessage?: string; error?: string };
export type ZernioPost = { _id: string; status: string; platforms?: ZernioPlatformResult[] };

// Platforms that take a vertical video post, by Zernio's platform name.
export const VIDEO_PLATFORMS: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", facebook: "Facebook", twitter: "X", threads: "Threads" };

export class ZernioError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
  // The API key itself was refused: no account can post until it is replaced.
  get keyInvalid() { return this.status === 401; }
  // This one account was disconnected or lost posting rights on Zernio.
  get accountInvalid() { return this.code === "ACCOUNT_DISCONNECTED" || this.code === "ACCOUNT_NOT_ENABLED_FOR_POSTING"; }
  // The same Idempotency-Key is still being processed; ask again shortly.
  get inFlight() { return this.status === 409 && this.code === "idempotency_conflict"; }
}

async function call<T>(config: ZernioConfig, path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { authorization: "Bearer " + config.apiKey, accept: "application/json" };
  if (init.body) headers["content-type"] = "application/json";
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
  const response = await fetch(config.apiUrl.replace(/\/$/, "") + path, { ...init, headers });
  const body = await response.json().catch(() => ({})) as T & { error?: string | { message?: string }; code?: string };
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : body.error?.message ?? "Zernio request failed (" + response.status + ")";
    throw new ZernioError("Zernio: " + message, response.status, body.code);
  }
  return { status: response.status, body };
}

export async function listAccounts(config: ZernioConfig) {
  return (await call<{ accounts?: ZernioAccount[] }>(config, "/accounts")).body.accounts ?? [];
}

// Checks a key and says whose it is (for display next to "Connected to Zernio").
export async function verifyKey(config: ZernioConfig) {
  const body = (await call<{ valid?: boolean; name?: string; email?: string }>(config, "/auth/verify")).body;
  if (body.valid === false) throw new ZernioError("Zernio: this API key is not valid", 401);
  return { label: (body.name || body.email || "your Zernio account").slice(0, 120) };
}

// Accounts are connected into a Zernio profile; Clipflow uses the default one, creating it on a brand-new account.
export async function defaultProfile(config: ZernioConfig) {
  const profiles = (await call<{ profiles?: { _id: string; isDefault?: boolean }[] }>(config, "/profiles")).body.profiles ?? [];
  const found = profiles.find(p => p.isDefault) ?? profiles[0];
  if (found) return found._id;
  return (await call<{ profile: { _id: string } }>(config, "/profiles", { method: "POST", body: JSON.stringify({ name: "Clipflow" }), idempotencyKey: "clipflow-default-profile" })).body.profile._id;
}

// The platform's sign-in page for connecting a new account. After it, Zernio sends the browser to `redirectUrl`
// with connected=<platform>&accountId=..&username=.. (or error=..&platform=..).
export async function connectUrl(config: ZernioConfig, platform: string, profileId: string, redirectUrl: string) {
  const query = new URLSearchParams({ profileId, redirect_url: redirectUrl });
  return (await call<{ authUrl: string }>(config, "/connect/" + encodeURIComponent(platform) + "?" + query)).body.authUrl;
}

// Disconnects the account on Zernio itself. Already gone counts as done.
export async function deleteAccount(config: ZernioConfig, id: string) {
  try { await call(config, "/accounts/" + encodeURIComponent(id), { method: "DELETE" }); }
  catch (error) { if (!(error instanceof ZernioError && error.status === 404)) throw error; }
}

// Publishes immediately (Zernio posts synchronously inside the request). The key makes a retried request return
// the original post instead of posting twice.
export async function createPost(config: ZernioConfig, post: Record<string, unknown>, idempotencyKey: string) {
  return (await call<{ post: ZernioPost }>(config, "/posts", { method: "POST", body: JSON.stringify(post), idempotencyKey })).body.post;
}

export async function getPost(config: ZernioConfig, id: string) {
  return (await call<{ post: ZernioPost }>(config, "/posts/" + encodeURIComponent(id))).body.post;
}

// The one platform result for this post (Clipflow sends a single account per post).
export function platformResult(post: ZernioPost) { return post.platforms?.[0]; }
export function platformError(post: ZernioPost) {
  const p = platformResult(post);
  return p?.errorMessage || p?.error || "Zernio reported the post as " + post.status + ".";
}
