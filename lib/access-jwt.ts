// Verifies Cloudflare Access identity tokens (RS256 JWTs sent as `Cf-Access-Jwt-Assertion`).
// Self-contained so it can be unit tested outside the Worker runtime.

export type AccessIdentity = { userId: string; email: string };
export type Jwk = JsonWebKey & { kid?: string };

const b64url = (part: string) => {
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
};
const json = (part: string) => JSON.parse(new TextDecoder().decode(b64url(part)));

// Returns the identity, or null for anything that is not a currently valid token for this team and application.
export async function verifyAccessJwt(token: string, { teamDomain, audience, keys, now = Date.now() }: { teamDomain: string; audience: string; keys: Jwk[]; now?: number }): Promise<AccessIdentity | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try { header = json(parts[0]); payload = json(parts[1]); } catch { return null; }
  if (header?.alg !== "RS256") return null;
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) return null;
  let valid = false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  } catch { return null; }
  if (!valid) return null;
  const seconds = Math.floor(now / 1000);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== "https://" + teamDomain || !audiences.includes(audience)) return null;
  if (typeof payload.exp !== "number" || payload.exp <= seconds || (typeof payload.nbf === "number" && payload.nbf > seconds + 60)) return null;
  if (typeof payload.sub !== "string" || !payload.sub || typeof payload.email !== "string" || !payload.email) return null;
  return { userId: payload.sub, email: payload.email };
}
