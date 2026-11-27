// Copies the accounts connected under one of a workspace's Zernio keys into Clipflow: new ones are added (and
// belong to that key), ones that went away or lost access are marked for reconnecting, and returning ones are
// restored. Used by "Refresh", after connecting an account from Clipflow, and after adding a key.
import { listAccounts, VIDEO_PLATFORMS } from "./zernio";
import type { Connection } from "./zernio-keys";

export type SyncResult = { added: { id: string; externalId: string; label: string }[]; total: number; message: string };

export async function syncZernioAccounts(db: D1Database, owner: string, connection: Connection, now = new Date()): Promise<SyncResult> {
  const iso = now.toISOString(), keyId = connection.keyId;
  const remote = (await listAccounts(connection)).filter(a => VIDEO_PLATFORMS[a.platform]);
  // All of the workspace's Zernio accounts: one that moved to this key (e.g. connected again under another Zernio
  // account) is taken over rather than duplicated.
  const { results: mine } = await db.prepare("SELECT id,external_id,status,zernio_key_id FROM accounts WHERE owner=? AND provider='zernio'").bind(owner).all<{ id: string; external_id: string; status: string; zernio_key_id: string | null }>();
  const any = await db.prepare("SELECT count(*) AS n FROM accounts WHERE owner=?").bind(owner).first<{ n: number }>();
  const statements: D1PreparedStatement[] = [], added: SyncResult["added"] = [], remoteIds = new Set(remote.map(a => a._id));
  for (const a of remote) {
    const username = (a.username || a.displayName || a._id).replace(/^@/, "").slice(0, 80), active = a.isActive !== false, existing = mine.find(m => m.external_id === a._id);
    if (existing) {
      statements.push(db.prepare("UPDATE accounts SET username=?,status=?,last_error=?,zernio_key_id=? WHERE id=?").bind(username, active ? "connected" : "expired", active ? null : "Disconnected on Zernio; reconnect it under Connections.", keyId, existing.id));
      continue;
    }
    const id = crypto.randomUUID();
    added.push({ id, externalId: a._id, label: VIDEO_PLATFORMS[a.platform] + " @" + username });
    statements.push(db.prepare("INSERT INTO accounts (id,owner,provider,platform,external_id,username,token_enc,token_expires_at,token_refreshed_at,status,connected_at,zernio_key_id) VALUES (?,?,'zernio',?,?,?,'','','',?,?,?)").bind(id, owner, a.platform, a._id, username, active ? "connected" : "expired", iso, keyId));
    // A workspace's very first accounts post every streamer's clips, so a simple setup needs no extra step.
    if (!any?.n) statements.push(db.prepare("INSERT OR IGNORE INTO streamer_accounts (streamer_id,account_id,owner,created_at) SELECT id,?,owner,? FROM streamers WHERE owner=?").bind(id, iso, owner));
  }
  // Only this key's accounts can have gone missing from this key's list.
  for (const m of mine) if (m.zernio_key_id === keyId && !remoteIds.has(m.external_id) && m.status === "connected")
    statements.push(db.prepare("UPDATE accounts SET status='expired',last_error=? WHERE id=?").bind("No longer connected on Zernio; reconnect it under Connections.", m.id));
  if (statements.length) await db.batch(statements);
  const message = added.length ? "Added " + added.map(a => a.label).join(", ") + "." : remote.length ? "Accounts under " + connection.label + " are up to date." : "No accounts connected under " + connection.label + " yet.";
  return { added, total: remote.length, message };
}
