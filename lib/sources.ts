// Editable sources (sources/<id>.mp4 in R2, the unframed video a clip is re-rendered from) are the biggest thing in
// clip storage: since the worker copies the stream's own video they are 10-20 MB each, several hundred MB a day. Once
// a clip is SOURCE_KEEP_DAYS old (10 by default) its editable copy is deleted; the finished clip stays, it just can't
// be re-edited (the editor says so). Kept longer: clips still waiting for review, clips with a render queued, and
// clips a highlight video still being made needs.
//
// Runs from the every-minute publisher. Once done for the day it reads one sync_state row per run. Otherwise it reads
// the clips made in the 60 days before the cutoff (by created_at), so a day's reads stay bounded however big the
// library gets; a clip that waited longer than that keeps its source.
const DAY = 86_400_000, BATCH = 50, LOOK_BACK_DAYS = 60;
const GATE = "sources:prune";

export function sourceKeepDays(env: { SOURCE_KEEP_DAYS?: string }) {
  const days = Number(env.SOURCE_KEEP_DAYS ?? 10);
  return Number.isFinite(days) && days >= 1 ? Math.floor(days) : 10;
}

export async function pruneSources(env: Cloudflare.Env, now = Date.now()) {
  const db = env.DB, store = env.BUCKET;
  if (!db || !store) return;
  const today = new Date(now).toISOString().slice(0, 10);
  const gate = await db.prepare("SELECT at FROM sync_state WHERE key=?").bind(GATE).first<{ at: string }>();
  if (gate?.at.slice(0, 10) === today) return;
  const days = sourceKeepDays(env as { SOURCE_KEEP_DAYS?: string }), cutoff = new Date(now - days * DAY).toISOString();
  const from = new Date(now - (days + LOOK_BACK_DAYS) * DAY).toISOString();
  const { results: rows } = await db.prepare(`SELECT id,source_key FROM clips INDEXED BY clips_created
    WHERE created_at>=? AND created_at<? AND source_key IS NOT NULL AND review!='pending' AND coalesce(render_state,'')!='queued' ORDER BY created_at LIMIT ?`)
    .bind(from, cutoff, BATCH).all<{ id: string; source_key: string }>();
  // Clips a highlight video still being made will cut from (few rows: highlights in progress).
  const { results: active } = rows.length ? await db.prepare("SELECT clips FROM highlights WHERE state NOT IN ('ready','failed')").all<{ clips: string }>() : { results: [] };
  const needed = new Set(active.flatMap(h => { try { return (JSON.parse(h.clips) as { id: string }[]).map(c => c.id); } catch { return []; } }));
  const prune = rows.filter(r => !needed.has(r.id));
  if (prune.length) {
    await store.delete(prune.map(r => r.source_key));
    // source_sha goes too, so a worker can't upload the source again; source_meta says when it went.
    await db.batch(prune.map(r => db.prepare("UPDATE clips SET source_key=NULL,source_sha=NULL,source_meta=json_set(coalesce(source_meta,'{}'),'$.pruned',?) WHERE id=? AND source_key=?").bind(today, r.id, r.source_key)));
    console.log("Removed " + prune.length + " editable source" + (prune.length === 1 ? "" : "s") + " older than " + days + " days.");
  }
  // A full batch with something removed: carry on next minute. Otherwise done for today.
  if (rows.length === BATCH && prune.length) return;
  await db.prepare("INSERT INTO sync_state (key,at,note) VALUES (?,?,NULL) ON CONFLICT(key) DO UPDATE SET at=excluded.at").bind(GATE, new Date(now).toISOString()).run();
}
