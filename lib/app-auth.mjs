// Clipflow's own sign-in (Sign in with Twitch or Google), so anyone can sign up without a Cloudflare Access
// allow-list (free up to 50 people). A signed-in browser holds a random session token in an HttpOnly cookie; only its
// SHA-256 is stored (sessions table). Each sign-in account (auth_identities: provider + its user id) belongs to one
// workspace owner: an Access user who signs in with Twitch links it to their existing workspace, so their data stays
// theirs once Access is gone. Pure helpers here; the routes are app/api/auth/*.

export const SESSION_COOKIE = "cf_session", STATE_COOKIE = "cf_oauth";
export const SESSION_DAYS = 30;

const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export async function sha256(text) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

// One cookie's value from a Cookie header, or null.
export function readCookie(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim() || null;
  }
  return null;
}
// A session or state token is 64 hex characters; anything else is ignored without a database lookup.
export const isToken = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/** @param {string} name @param {string} value @param {{ path?: string, maxAge: number, secure?: boolean }} options */
export function cookie(name, value, { path = "/", maxAge, secure = true }) {
  return [name + "=" + value, "Path=" + path, "Max-Age=" + maxAge, "HttpOnly", ...(secure ? ["Secure"] : []), "SameSite=Lax"].join("; ");
}

// Where to go after signing in: a path on this site only (never another origin), else the dashboard.
export function safeReturn(value) {
  const v = String(value ?? "");
  return v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\") && v.length <= 300 ? v : "/";
}

// Sign-up setting (CLIPFLOW_SIGNUPS): "open" lets anyone with a Twitch account create a workspace; anything else
// (the default, "closed") lets only accounts already linked to a workspace sign in, plus linking a new one while signed
// in another way (Access). Closed until billing and the public launch are ready.
export const signupsOpen = setting => String(setting ?? "").toLowerCase() === "open";

/**
 * Which workspace a sign-in goes to: the one its account is already linked to; else the workspace of whoever is
 * signed in now (linking, e.g. an Access user adding Twitch); else a new one when sign-ups are open; else refused.
 * @returns {{ owner: string, link: boolean } | { refused: string }}
 */
export function ownerFor({ linked, current, provider, providerId, open }) {
  if (linked) return { owner: linked, link: false };
  if (current) return { owner: current, link: true };
  if (open) return { owner: provider + ":" + providerId, link: true };
  return { refused: "Clipflow isn't open for new sign-ups yet. Ask for an invite, or sign in the way you did before and link this account from Settings → Account & data." };
}

// Twitch's sign-in and API addresses; TWITCH_AUTH_URL / TWITCH_API_URL point them at a stand-in for tests.
export const twitchUrls = env => ({ auth: String(env?.TWITCH_AUTH_URL || "https://id.twitch.tv").replace(/\/$/, ""), api: String(env?.TWITCH_API_URL || "https://api.twitch.tv").replace(/\/$/, "") });
export function twitchAuthorizeUrl({ clientId, redirectUri, state, auth = "https://id.twitch.tv" }) {
  const url = new URL(auth + "/oauth2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "user:read:email");
  url.searchParams.set("state", state);
  return url.toString();
}

// Sign in with Google (OpenID Connect): only the account's id, name and email ("openid email profile"), and the
// account picker every time so a shared computer doesn't sign in as whoever used it last. GOOGLE_AUTH_URL /
// GOOGLE_TOKEN_URL / GOOGLE_API_URL point them at a stand-in for tests.
export const googleUrls = env => ({
  auth: String(env?.GOOGLE_AUTH_URL || "https://accounts.google.com").replace(/\/$/, ""),
  token: String(env?.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com").replace(/\/$/, ""),
  api: String(env?.GOOGLE_API_URL || "https://openidconnect.googleapis.com").replace(/\/$/, ""),
});
export function googleAuthorizeUrl({ clientId, redirectUri, state, auth = "https://accounts.google.com" }) {
  const url = new URL(auth + "/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}
/**
 * The Google account from its userinfo answer, or a reason it can't be used. Google ids ("sub") are digits; an
 * email Google hasn't verified is not shown or kept.
 * @returns {{ id: string, email: string | null, name: string } | { problem: string }}
 */
export function googleAccount(info) {
  if (!info || typeof info !== "object" || typeof info.sub !== "string" || !/^\d{1,30}$/.test(info.sub)) return { problem: "Couldn't read your Google account. Try again." };
  const email = info.email_verified === true && typeof info.email === "string" ? info.email.slice(0, 200) : null;
  const name = String(info.name || info.given_name || email || "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 100);
  return { id: info.sub, email, name };
}
// The sign-in ways this site offers, for the sign-in page and Settings → Account & data.
export const PROVIDERS = { twitch: { label: "Twitch", start: "/api/auth/twitch/start" }, google: { label: "Google", start: "/api/auth/google/start" } };
