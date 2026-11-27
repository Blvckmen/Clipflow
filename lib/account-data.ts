// A workspace's own data: export it (Settings → Your data → Download) and delete all of it (Delete workspace), as
// privacy law expects before customers pay (GDPR: access and erasure). Posts already published on TikTok, Instagram
// or YouTube are the platforms' to delete; this can't reach them, and the dashboard says so.
import { clipKey, highlightKey, sourceKey } from "../db/raw";
import { removeRecordingFiles } from "./recordings";
import { stripe } from "./stripe.mjs";

// Every table holding a workspace's rows (each has an owner column), children before parents for deleting.
export const OWNER_TABLES = [
  "clip_versions", "clip_translations", "clip_retries", "posts", "streamer_accounts", "viewer_clip_candidates", "recording_requests", "recording_uploads",
  "recordings", "highlights", "backgrounds", "text_styles", "clips", "accounts", "zernio_keys", "streamers", "events", "billing",
  "pairing_codes", "worker_tokens", "auth_identities", "sessions", "preferences",
] as const;
// Never in an export: secrets (sign-in tokens, encrypted keys, hashes that would let someone act as the workspace).
const LEFT_OUT: Record<string, "all" | string[]> = {
  sessions: "all", pairing_codes: "all", worker_tokens: ["token_hash"], accounts: ["token_enc"], zernio_keys: ["key_enc", "key_hash"],
  preferences: ["discord_webhook_enc", "zernio_key_enc"],
};

/** Everything the workspace holds, as { exportedAt, tables: { name: rows } }, secrets left out. */
export async function exportWorkspace(db: D1Database, owner: string, now = Date.now()) {
  const tables: Record<string, unknown[]> = {};
  for (const name of OWNER_TABLES) {
    const left = LEFT_OUT[name];
    if (left === "all") continue;
    // A table the site doesn't have yet (a migration still to come) is just left out.
    const rows = await db.prepare("SELECT * FROM " + name + " WHERE owner=?").bind(owner).all<Record<string, unknown>>().then(r => r.results, () => null);
    if (rows) tables[name] = rows.map(row => left ? Object.fromEntries(Object.entries(row).filter(([k]) => !left.includes(k))) : row);
  }
  return { exportedAt: new Date(now).toISOString(), note: "Your Clipflow workspace. Clip and recording videos aren't included; download them from the dashboard first. Sign-in tokens and keys are left out.", tables };
}

type BillingRow = { status: string; stripe_subscription: string | null };
type Env = { STRIPE_SECRET_KEY?: string; STRIPE_API_URL?: string };

/**
 * Deletes the workspace: its Stripe subscription first (cancelled now, so it's never charged again; if that fails,
 * nothing is deleted), then its stored files, then every row. Returns how many files and rows went.
 */
export async function deleteWorkspace(env: Env, db: D1Database, store: R2Bucket | null, owner: string) {
  const bill = await db.prepare("SELECT status,stripe_subscription FROM billing WHERE owner=?").bind(owner).first<BillingRow>().catch(() => null);
  if (bill?.stripe_subscription && env.STRIPE_SECRET_KEY && !["canceled", "incomplete_expired"].includes(bill.status))
    await stripe(env.STRIPE_SECRET_KEY, "/subscriptions/" + bill.stripe_subscription, null, { method: "DELETE", base: env.STRIPE_API_URL || undefined })
      .catch((error: Error & { status?: number }) => { if (error.status !== 404) throw new Error("Couldn't cancel your subscription with Stripe (" + error.message + "). Nothing was deleted; try again."); });

  let files = 0;
  if (store) {
    const keys: string[] = [];
    const all = <T>(sql: string) => db.prepare(sql).bind(owner).all<T>().then(r => r.results, () => [] as T[]);
    for (const c of await all<{ id: string; file_key: string | null; source_key: string | null }>("SELECT id,file_key,source_key FROM clips WHERE owner=?")) keys.push(c.file_key ?? clipKey(c.id), c.source_key ?? sourceKey(c.id));
    for (const t of await all<{ file_key: string | null }>("SELECT file_key FROM clip_translations WHERE owner=?")) if (t.file_key) keys.push(t.file_key);
    for (const h of await all<{ id: string; file_key: string | null }>("SELECT id,file_key FROM highlights WHERE owner=?")) keys.push(h.file_key ?? highlightKey(h.id));
    for (const b of await all<{ key: string | null }>("SELECT key FROM backgrounds WHERE owner=?")) if (b.key) keys.push(b.key);
    // Thumbnails are kept under the owner's own prefix.
    for (let cursor: string | undefined; ;) {
      const listed = await store.list({ prefix: "thumbs/" + owner + "/", cursor });
      keys.push(...listed.objects.map(o => o.key));
      if (!listed.truncated) break;
      cursor = listed.cursor;
    }
    for (let i = 0; i < keys.length; i += 1000) await store.delete(keys.slice(i, i + 1000));
    files += keys.length;
    for (const r of await all<{ id: string; preview_key: string | null; upload_id: string | null }>("SELECT id,preview_key,upload_id FROM recordings WHERE owner=?")) {
      await removeRecordingFiles(r.id, r, store).catch(() => {});
      files += 2;  // its preview and transcript (an unfinished upload is discarded too)
    }
  }

  let rows = 0;
  for (const name of OWNER_TABLES) {
    const r = await db.prepare("DELETE FROM " + name + " WHERE owner=?").bind(owner).run().catch(() => null);
    rows += r?.meta.changes ?? 0;
  }
  // Alert state kept per workspace (lib/alerts.ts pcAlerts).
  await db.prepare("DELETE FROM sync_state WHERE key=?").bind("pc_alert:" + owner).run().catch(() => {});
  return { files, rows };
}
