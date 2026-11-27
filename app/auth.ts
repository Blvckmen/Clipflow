import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { getChatGPTUser } from "./chatgpt-auth";
import { verifyAccessJwt, type Jwk } from "../lib/access-jwt";
import { SESSION_COOKIE, isToken, readCookie, sha256 } from "../lib/app-auth.mjs";

export type User = { userId: string; displayName: string };

// AUTH_MODE picks exactly one identity source:
//   "sites"  (default) — headers injected by Codex Sites hosting (and the local mock sign-in).
//   "access" — a Cloudflare Access token, for self-hosting on Cloudflare. Sites headers are ignored there,
//              because off Sites nothing stops a client from sending them itself.
//   "app"    — only Clipflow's own sign-in (Sign in with Twitch), once Access no longer guards the dashboard
//              (CLIPFLOW_PUBLIC in the deploy). Sites headers and Access tokens are both ignored.
// Clipflow's own session cookie is checked first in every mode.
const config = env;
export const authMode = () => (config.AUTH_MODE === "access" ? "access" : config.AUTH_MODE === "app" ? "app" : "sites");

let certs: { keys: Jwk[]; fetchedAt: number } | null = null;
async function accessKeys(teamDomain: string, refresh = false) {
  const age = certs ? Date.now() - certs.fetchedAt : Infinity;
  // Forced refreshes are capped at one a minute so invalid tokens can't make every request fetch keys.
  if (certs && (refresh ? age < 60_000 : age < 3600_000)) return certs.keys;
  const response = await fetch("https://" + teamDomain + "/cdn-cgi/access/certs");
  if (!response.ok) throw new Error("Access certificates unavailable: HTTP " + response.status);
  certs = { keys: (await response.json() as { keys: Jwk[] }).keys, fetchedAt: Date.now() };
  return certs.keys;
}

// Clipflow's own sign-in (Sign in with Twitch, app/api/auth/*): a session cookie whose token's hash is in sessions.
// Checked first in every mode; the database decides, so a made-up cookie is just signed out.
async function sessionUser(): Promise<User | null> {
  const token = readCookie((await headers()).get("cookie"), SESSION_COOKIE);
  if (!isToken(token) || !config.DB) return null;
  try {
    const row = await config.DB.prepare("SELECT owner,display_name FROM sessions WHERE token_hash=? AND expires_at>?").bind(await sha256(token), new Date().toISOString()).first<{ owner: string; display_name: string | null }>();
    return row && { userId: row.owner, displayName: row.display_name || "you" };
  } catch (error) { console.error("Session lookup failed", error); return null; }
}

// Signed in with Clipflow's own sign-in (not Access or Sites): the dashboard then offers Sign out.
export async function signedInWithApp() { return !!(await sessionUser()); }

export async function currentUser(): Promise<User | null> {
  const own = await sessionUser();
  if (own || authMode() === "app") return own;
  if (authMode() === "sites") {
    const user = await getChatGPTUser();
    return user && { userId: user.userId, displayName: user.displayName };
  }
  const teamDomain = config.CF_ACCESS_TEAM_DOMAIN, audience = config.CF_ACCESS_AUD;
  if (!teamDomain || !audience) { console.error("AUTH_MODE=access needs CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD"); return null; }
  const requestHeaders = await headers();
  const token = requestHeaders.get("cf-access-jwt-assertion");
  if (!token) return null;
  try {
    let identity = await verifyAccessJwt(token, { teamDomain, audience, keys: await accessKeys(teamDomain) });
    // Access rotates signing keys; one refresh covers a token signed with a key newer than the cache.
    if (!identity) identity = await verifyAccessJwt(token, { teamDomain, audience, keys: await accessKeys(teamDomain, true) });
    return identity && { userId: "access:" + identity.userId, displayName: identity.email };
  } catch (error) {
    // Without the signing keys nobody can be verified; treat the request as signed out rather than failing it.
    console.error("Access verification unavailable", error);
    return null;
  }
}

// Where the dashboard should send a signed-out visitor.
// With the site's Twitch app or Google client set up, Clipflow's own sign-in; else as before.
export const twitchApp = () => { const e = config as { TWITCH_CLIENT_ID?: string; TWITCH_CLIENT_SECRET?: string }; return e.TWITCH_CLIENT_ID && e.TWITCH_CLIENT_SECRET ? { clientId: e.TWITCH_CLIENT_ID, clientSecret: e.TWITCH_CLIENT_SECRET } : null; };
export const twitchSignIn = () => !!twitchApp();
// Sign in with Google: the site's Google OAuth client (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET).
export const googleApp = () => { const e = config as { GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string }; return e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET ? { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET } : null; };
export const googleSignIn = () => !!googleApp();
// With both, a page to choose (app/api/auth/signin); with one, straight to it.
export const signInPath = () => (twitchSignIn() && googleSignIn() ? "/api/auth/signin" : twitchSignIn() ? "/api/auth/twitch/start" : googleSignIn() ? "/api/auth/google/start" : authMode() === "access" ? "/" : "/signin-with-chatgpt?return_to=/");
