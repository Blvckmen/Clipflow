// A workspace's Zernio connections. Each key added in the dashboard is a separate Zernio account with its own social
// accounts; a workspace with no keys of its own uses the site-wide ZERNIO_API_KEY.
import { decrypt } from "./secure";
import type { ZernioConfig } from "./zernio";

type Env = Cloudflare.Env;
export type KeyRow = { id: string; label: string; key_enc: string; created_at: string; last_error: string | null };
// keyId null is the site-wide key.
export type Connection = ZernioConfig & { keyId: string | null; label: string };

export const zernioApiUrl = (env: Env) => env.ZERNIO_API_URL || "https://zernio.com/api/v1";

export function siteConnection(env: Env): Connection | null {
  return env.ZERNIO_API_KEY ? { apiKey: env.ZERNIO_API_KEY, apiUrl: zernioApiUrl(env), keyId: null, label: "this site's shared key" } : null;
}

export async function keyConnection(env: Env, row: Pick<KeyRow, "id" | "label" | "key_enc">): Promise<Connection> {
  if (!env.TOKEN_KEY) throw new Error("TOKEN_KEY is missing, so stored Zernio keys can't be read.");
  return { apiKey: await decrypt(row.key_enc, env.TOKEN_KEY), apiUrl: zernioApiUrl(env), keyId: row.id, label: row.label };
}

export async function listKeys(db: D1Database, owner: string) {
  return (await db.prepare("SELECT id,label,key_enc,created_at,last_error FROM zernio_keys WHERE owner=? ORDER BY created_at").bind(owner).all<KeyRow>()).results;
}

// Every connection the workspace posts through: its own keys, else the site's.
export async function connections(env: Env, db: D1Database, owner: string): Promise<Connection[]> {
  const keys = await listKeys(db, owner);
  if (keys.length) return Promise.all(keys.map(k => keyConnection(env, k)));
  const site = siteConnection(env);
  return site ? [site] : [];
}

// The connection one account posts through (by its zernio_key_id; null is the site key).
export async function connectionFor(env: Env, db: D1Database, owner: string, keyId: string | null): Promise<Connection | null> {
  if (!keyId) return siteConnection(env);
  const row = await db.prepare("SELECT id,label,key_enc FROM zernio_keys WHERE id=? AND owner=?").bind(keyId, owner).first<KeyRow>();
  return row ? keyConnection(env, row) : null;
}

export async function hashKey(key: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))].map(b => b.toString(16).padStart(2, "0")).join("");
}
