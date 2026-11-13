import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { getChatGPTUser } from "./chatgpt-auth";
import { verifyAccessJwt, type Jwk } from "../lib/access-jwt";

export type User = { userId: string; displayName: string };

// AUTH_MODE picks exactly one identity source:
//   "sites"  (default) — headers injected by Codex Sites hosting (and the local mock sign-in).
//   "access" — a Cloudflare Access token, for self-hosting on Cloudflare. Sites headers are ignored there,
//              because off Sites nothing stops a client from sending them itself.
const config = env;
export const authMode = () => (config.AUTH_MODE === "access" ? "access" : "sites");

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

export async function currentUser(): Promise<User | null> {
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
export const signInPath = () => (authMode() === "access" ? "/" : "/signin-with-chatgpt?return_to=/");
