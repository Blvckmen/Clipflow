// Highlight videos: the best approved clips of a period, joined into one landscape (16:9) video by the worker PC,
// for YouTube. Made on request (Clip library -> Highlights) or every Monday for the past week (Settings).
export const HIGHLIGHT_COUNT = { min: 3, max: 20, default: 8 };
const DAY = 86_400_000;

type Picked = { id: string; start: number; end: number; streamer: string | null };

// The clips for a highlight video: approved clips of the period that still have their unframed source (needed for a
// landscape cut), most viewed first (where the platforms report views), then newest; shown in the order they happened.
export async function pickHighlightClips(db: D1Database, owner: string, { since, until, streamerId, count }: { since: string; until: string; streamerId?: string | null; count: number }): Promise<Picked[]> {
  const { results } = await db.prepare(`SELECT c.id,c.created_at,json_extract(c.edit,'$.trim.start') AS start,json_extract(c.edit,'$.trim.end') AS end,s.name AS streamer,
      (SELECT max(p.views) FROM posts p WHERE p.clip_id=c.id) AS views
    FROM clips c INDEXED BY clips_owner_created LEFT JOIN streamers s ON s.id=c.streamer_id
    WHERE c.owner=? AND c.created_at>=? AND c.created_at<? AND c.review='approved' AND c.source_key IS NOT NULL AND c.edit IS NOT NULL AND (? IS NULL OR c.streamer_id=?)
    ORDER BY coalesce(views,-1) DESC, c.created_at DESC LIMIT ?`)
    .bind(owner, since, until, streamerId ?? null, streamerId ?? null, Math.max(HIGHLIGHT_COUNT.min, Math.min(HIGHLIGHT_COUNT.max, count)))
    .all<{ id: string; created_at: string; start: number | null; end: number | null; streamer: string | null; views: number | null }>();
  return results.filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && (r.end as number) > (r.start as number))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map(r => ({ id: r.id, start: r.start as number, end: r.end as number, streamer: r.streamer }));
}

// Queues a highlight video. Null when the period has too few clips to make one.
export async function createHighlight(db: D1Database, owner: string, { days, count, streamerId, auto = false, now = Date.now() }: { days: number; count: number; streamerId?: string | null; auto?: boolean; now?: number }) {
  const until = new Date(now).toISOString(), since = new Date(now - days * DAY).toISOString();
  const clips = await pickHighlightClips(db, owner, { since, until, streamerId, count });
  if (clips.length < HIGHLIGHT_COUNT.min) return null;
  const names = [...new Set(clips.map(c => c.streamer).filter(Boolean))];
  const title = (names.length === 1 ? names[0] + " " : "") + (days === 7 ? "weekly highlights" : "highlights, last " + days + " days") + " (" + new Date(now).toISOString().slice(0, 10) + ")";
  const id = crypto.randomUUID(), iso = new Date(now).toISOString();
  await db.prepare("INSERT INTO highlights (id,owner,streamer_id,title,since,until,clips,state,auto,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'queued',?,?,?)")
    .bind(id, owner, streamerId ?? null, title, since, until, JSON.stringify(clips.map(({ id, start, end }) => ({ id, start, end }))), auto ? 1 : 0, iso, iso).run();
  return { id, title, clips: clips.length };
}

// Monday's highlight videos for every workspace that wants them. Runs from the every-minute publisher, so the first
// thing it reads is one row: the week it last ran for. Nothing else is read until a new week is due.
export async function weeklyHighlights(db: D1Database, now = Date.now()) {
  const d = new Date(now);
  // Mondays from 06:00 UTC. The week is named by that Monday's date.
  if (d.getUTCDay() !== 1 || d.getUTCHours() < 6) return;
  const week = d.toISOString().slice(0, 10);
  const last = await db.prepare("SELECT note FROM sync_state WHERE key='highlights:weekly'").first<{ note: string | null }>();
  if (last?.note === week) return;
  await db.prepare("INSERT INTO sync_state (key,at,note) VALUES ('highlights:weekly',?,?) ON CONFLICT(key) DO UPDATE SET at=excluded.at,note=excluded.note").bind(d.toISOString(), week).run();
  const { results } = await db.prepare("SELECT owner FROM preferences WHERE weekly_highlights=1").all<{ owner: string }>();
  for (const { owner } of results) await createHighlight(db, owner, { days: 7, count: HIGHLIGHT_COUNT.default, auto: true, now }).catch(error => console.error("Weekly highlights failed", owner, error));
}
