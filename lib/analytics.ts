// Reads how published posts are doing (views, likes, comments, shares, saves) from Zernio, which refreshes them
// about hourly, and stores them on Clipflow's posts. Runs from the once-a-minute cron trigger but only does the
// work for each Zernio connection once an hour.
import { listAnalytics, ZernioError, type ZernioMetrics } from "./zernio";
import { keyConnection, listKeys, siteConnection, type Connection } from "./zernio-keys";

type Env = Cloudflare.Env;
const EVERY_MS = 60 * 60_000, NO_ACCESS_RETRY_MS = 24 * 3600_000, MAX_PAGES = 5;
const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : null);

// Every key a workspace's published posts went out with: its own keys, plus the site's shared key while any of its
// accounts still posts with that one (an account keeps the key it was connected with).
async function readers(env: Env, db: D1Database, owner: string): Promise<Connection[]> {
  const own = await Promise.all((await listKeys(db, owner)).map(k => keyConnection(env, k)));
  const site = siteConnection(env);
  const usesSite = site && await db.prepare("SELECT 1 FROM accounts WHERE owner=? AND provider='zernio' AND zernio_key_id IS NULL LIMIT 1").bind(owner).first();
  return usesSite ? [...own, site] : own;
}

export async function syncAnalytics(env: Env, now = Date.now()) {
  const db = env.DB!;
  // Only workspaces that have something published through Zernio.
  const { results: owners } = await db.prepare("SELECT DISTINCT p.owner FROM posts p JOIN accounts a ON a.id=p.account_id WHERE a.provider='zernio' AND p.state='published'").all<{ owner: string }>();
  for (const { owner } of owners) {
    for (const connection of await readers(env, db, owner).catch(() => [] as Connection[])) {
      const key = "analytics:" + owner + ":" + (connection.keyId ?? "site");
      const last = await db.prepare("SELECT at,note FROM sync_state WHERE key=?").bind(key).first<{ at: string; note: string | null }>();
      const wait = last?.note === "no-access" ? NO_ACCESS_RETRY_MS : EVERY_MS;
      if (last && now - Date.parse(last.at) < wait) continue;
      let note: string | null = null;
      try {
        const updates: D1PreparedStatement[] = [], iso = new Date(now).toISOString();
        for (let page = 1; page <= MAX_PAGES; page++) {
          const { posts, pages, access } = await listAnalytics(connection, page);
          if (!access) { note = "no-access"; break; }
          for (const post of posts) {
            const entries = post.platforms?.length ? post.platforms : [{ platform: post.platform ?? "", platformPostId: undefined, analytics: post.analytics }];
            for (const entry of entries) {
              const m: ZernioMetrics = entry.analytics ?? {};
              // Match Clipflow's post by the platform's post id, or by the Zernio post it was sent as.
              updates.push(db.prepare(`UPDATE posts SET views=?,likes=?,comments=?,shares=?,saves=?,metrics_at=?
                WHERE owner=? AND state='published' AND platform=? AND ((media_id IS NOT NULL AND media_id=?) OR (container_id IS NOT NULL AND container_id=?))`)
                .bind(count(m.views), count(m.likes), count(m.comments), count(m.shares), count(m.saves), iso, owner, entry.platform, entry.platformPostId ?? "", post.latePostId ?? post._id));
            }
          }
          if (page >= pages) break;
        }
        for (let i = 0; i < updates.length; i += 50) await db.batch(updates.slice(i, i + 50));
      } catch (error) {
        // A plan without analytics (older Zernio plans need an add-on): try again tomorrow, not every hour.
        if (error instanceof ZernioError && (error.code === "analytics_addon_required" || error.status === 403)) note = "no-access";
        else { console.error("Analytics sync failed", key, error); note = "error"; }
      }
      await db.prepare("INSERT INTO sync_state (key,at,note) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET at=excluded.at,note=excluded.note").bind(key, new Date(now).toISOString(), note).run();
    }
  }
}

// Everything the Analytics page shows for one workspace: what Clipflow did (clips captured, reviewed, posted) and,
// where the platforms report it, how the posts did. Days are UTC dates, the last 14.
export async function analyticsSummary(db: D1Database, owner: string, now = Date.now()) {
  const since = new Date(now - 13 * 86400_000).toISOString().slice(0, 10);
  const [totals, clips, top, streamers, accounts, postsDaily, clipsDaily, synced] = await Promise.all([
    db.prepare(`SELECT count(*) AS published, sum(views) AS views, sum(likes) AS likes, sum(comments) AS comments, sum(shares) AS shares, sum(saves) AS saves,
      count(metrics_at) AS measured, max(metrics_at) AS metrics_at,
      (SELECT count(*) FROM posts WHERE owner=?1 AND state='failed') AS failed, (SELECT count(*) FROM posts WHERE owner=?1 AND state IN ('queued','processing')) AS waiting
      FROM posts WHERE owner=?1 AND state='published'`).bind(owner).first(),
    db.prepare(`SELECT count(*) AS total, sum(review='approved') AS approved, sum(review='rejected') AS rejected, sum(review='pending') AS pending,
      sum(reason='chat') AS chat, sum(reason='audio') AS audio FROM clips WHERE owner=?`).bind(owner).first(),
    db.prepare(`SELECT p.id,p.clip_id,p.platform,p.permalink,p.published_at,p.views,p.likes,p.comments,p.shares,p.saves,s.name AS streamer,a.username AS account
      FROM posts p LEFT JOIN clips c ON c.id=p.clip_id LEFT JOIN streamers s ON s.id=c.streamer_id LEFT JOIN accounts a ON a.id=p.account_id
      WHERE p.owner=? AND p.state='published' ORDER BY coalesce(p.views,-1) DESC, p.published_at DESC LIMIT 10`).bind(owner).all(),
    db.prepare(`SELECT s.id,s.name,s.platform,
      (SELECT count(*) FROM clips c WHERE c.streamer_id=s.id) AS clips,
      (SELECT count(*) FROM clips c WHERE c.streamer_id=s.id AND c.review='approved') AS approved,
      (SELECT count(*) FROM clips c WHERE c.streamer_id=s.id AND c.reason='chat') AS chat,
      (SELECT count(*) FROM posts p JOIN clips c ON c.id=p.clip_id WHERE c.streamer_id=s.id AND p.state='published') AS posts,
      (SELECT sum(p.views) FROM posts p JOIN clips c ON c.id=p.clip_id WHERE c.streamer_id=s.id AND p.state='published') AS views,
      (SELECT sum(p.likes) FROM posts p JOIN clips c ON c.id=p.clip_id WHERE c.streamer_id=s.id AND p.state='published') AS likes
      FROM streamers s WHERE s.owner=? ORDER BY coalesce(views,0) DESC, clips DESC`).bind(owner).all(),
    db.prepare(`SELECT a.id,a.platform,a.username,count(p.id) AS posts,sum(p.views) AS views,sum(p.likes) AS likes,sum(p.comments) AS comments,
      (SELECT count(*) FROM posts f WHERE f.account_id=a.id AND f.state='failed') AS failed
      FROM accounts a LEFT JOIN posts p ON p.account_id=a.id AND p.state='published' WHERE a.owner=? GROUP BY a.id ORDER BY coalesce(views,0) DESC, posts DESC`).bind(owner).all(),
    db.prepare("SELECT substr(published_at,1,10) AS day,count(*) AS n FROM posts WHERE owner=? AND state='published' AND published_at>=? GROUP BY day").bind(owner, since).all<{ day: string; n: number }>(),
    db.prepare("SELECT substr(created_at,1,10) AS day,count(*) AS n FROM clips WHERE owner=? AND created_at>=? GROUP BY day").bind(owner, since).all<{ day: string; n: number }>(),
    db.prepare("SELECT max(at) AS at, max(note='no-access') AS no_access FROM sync_state WHERE substr(key,1,?)=?").bind(("analytics:" + owner + ":").length, "analytics:" + owner + ":").first<{ at: string | null; no_access: number | null }>(),
  ]);
  const days = Array.from({ length: 14 }, (_, i) => new Date(now - (13 - i) * 86400_000).toISOString().slice(0, 10));
  const byDay = (rows: { day: string; n: number }[]) => days.map(day => ({ day, n: rows.find(r => r.day === day)?.n ?? 0 }));
  return {
    totals, clips, top: top.results, streamers: streamers.results, accounts: accounts.results,
    daily: { posts: byDay(postsDaily.results), clips: byDay(clipsDaily.results) },
    syncedAt: synced?.at ?? null, noAccess: !!synced?.no_access,
  };
}
