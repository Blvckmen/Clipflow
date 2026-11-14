// Publishes approved clips to connected accounts. Runs from the Worker's once-a-minute cron trigger and does a
// bounded amount of work per account per run, so a slow platform never holds up the rest.
import { decrypt, encrypt, signedMediaPath } from "./secure";
import * as instagram from "./instagram";
import { defaultCaption } from "./clipflow";

type Env = Cloudflare.Env;
type AccountRow = { id: string; owner: string; external_id: string; username: string; token_enc: string; token_expires_at: string; token_refreshed_at: string; connected_at: string; control: string | null; destinations: string | null; daily_limit: number | null; caption_template: string | null };
type PostRow = { id: string; clip_id: string; state: string; container_id: string | null; attempts: number; updated_at: string };

const CHECK_EVERY_MS = 60_000;            // Instagram recommends checking a container about once a minute
const PROCESSING_TIMEOUT_MS = 15 * 60_000; // give up on a container that never finishes and retry from scratch
const MAX_ATTEMPTS = 3;
const LINK_TTL_MS = 3 * 3600_000;          // the signed video link must outlive Instagram's fetch
const REFRESH_WITHIN_MS = 10 * 24 * 3600_000;

export function instagramConfig(env: Env): instagram.InstagramConfig | null {
  if (!env.INSTAGRAM_APP_ID || !env.INSTAGRAM_APP_SECRET || !env.TOKEN_KEY) return null;
  return {
    appId: env.INSTAGRAM_APP_ID, appSecret: env.INSTAGRAM_APP_SECRET,
    authUrl: env.INSTAGRAM_AUTH_URL || "https://www.instagram.com",
    apiUrl: env.INSTAGRAM_API_URL || "https://api.instagram.com",
    graphUrl: env.INSTAGRAM_GRAPH_URL || "https://graph.instagram.com",
  };
}

export function renderCaption(template: string, values: { streamer: string; platform: string }) {
  return template.replace(/\{streamer\}/g, values.streamer).replace(/\{platform\}/g, values.platform).slice(0, 2200);
}

export async function runPublisher(env: Env, now = Date.now()) {
  const config = instagramConfig(env);
  if (!config || !env.DB || !env.MEDIA_KEY || !env.PUBLIC_URL) return;
  const { results } = await env.DB.prepare("SELECT a.*, p.control, p.destinations, p.daily_limit, p.caption_template FROM accounts a LEFT JOIN preferences p ON p.owner=a.owner WHERE a.platform='instagram' AND a.status='connected'").all<AccountRow>();
  for (const account of results) {
    try { await runAccount(env, config, account, now); }
    catch (error) {
      console.error("Publisher failed for account", account.id, error);
      await env.DB.prepare("UPDATE accounts SET last_error=? WHERE id=?").bind(String((error as Error).message).slice(0, 500), account.id).run();
    }
  }
}

async function runAccount(env: Env, config: instagram.InstagramConfig, account: AccountRow, now: number) {
  const db = env.DB!, iso = new Date(now).toISOString();
  let token = await decrypt(account.token_enc, env.TOKEN_KEY!);

  // Long-lived tokens last 60 days and can be refreshed once they are a day old.
  if (Date.parse(account.token_expires_at) - now < REFRESH_WITHIN_MS && now - Date.parse(account.token_refreshed_at) > 24 * 3600_000) {
    const renewed = await instagram.refresh(config, token);
    token = renewed.access_token;
    await db.prepare("UPDATE accounts SET token_enc=?,token_expires_at=?,token_refreshed_at=? WHERE id=?").bind(await encrypt(token, env.TOKEN_KEY!), new Date(now + renewed.expires_in * 1000).toISOString(), iso, account.id).run();
  }

  // Pausing or stopping automation also pauses publishing.
  if (account.control !== "running") return;

  const destinations: string[] = JSON.parse(account.destinations ?? "[]");
  if (destinations.includes("Instagram")) {
    // Queue approved, uploaded clips that became approved after the account was connected — never the old backlog.
    await db.prepare(`INSERT OR IGNORE INTO posts (id,owner,clip_id,platform,account_id,state,next_attempt_at,created_at,updated_at)
      SELECT lower(hex(randomblob(16))),c.owner,c.id,'instagram',?,'queued',?,?,? FROM clips c
      WHERE c.owner=? AND c.review='approved' AND c.file_key IS NOT NULL AND coalesce(c.reviewed_at,c.created_at)>=?
      AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.clip_id=c.id AND p.platform='instagram')`).bind(account.id, iso, iso, iso, account.owner, account.connected_at).run();
  }

  const fail = async (post: PostRow, message: string) => {
    const attempts = post.attempts + 1, final = attempts >= MAX_ATTEMPTS;
    await db.prepare("UPDATE posts SET state=?,container_id=NULL,attempts=?,error=?,next_attempt_at=?,updated_at=? WHERE id=?")
      .bind(final ? "failed" : "queued", attempts, message.slice(0, 500), new Date(now + 5 * 60_000 * attempts).toISOString(), iso, post.id).run();
  };
  const tokenProblem = async (error: unknown) => {
    if (error instanceof instagram.InstagramError && error.tokenInvalid) {
      await db.prepare("UPDATE accounts SET status='expired',last_error=? WHERE id=?").bind("Instagram sign-in expired or was revoked; reconnect the account.", account.id).run();
      return true;
    }
    return false;
  };

  // 1. Finish a post whose container is processing.
  const processing = await db.prepare("SELECT id,clip_id,state,container_id,attempts,updated_at FROM posts WHERE account_id=? AND state='processing' AND next_attempt_at<=? ORDER BY created_at LIMIT 1").bind(account.id, iso).first<PostRow>();
  if (processing) {
    try {
      const status = await instagram.containerStatus(config, token, processing.container_id!);
      if (status.code === "FINISHED" || status.code === "PUBLISHED") {
        // PUBLISHED means an earlier publish call succeeded but its response was lost; don't publish twice.
        const mediaId = status.code === "FINISHED" ? await instagram.publish(config, token, account.external_id, processing.container_id!) : null;
        const link = mediaId ? await instagram.permalink(config, token, mediaId).catch(() => null) : null;
        await db.prepare("UPDATE posts SET state='published',media_id=?,permalink=?,error=NULL,published_at=?,updated_at=? WHERE id=?").bind(mediaId, link, iso, iso, processing.id).run();
      } else if (status.code === "IN_PROGRESS") {
        if (now - Date.parse(processing.updated_at) > PROCESSING_TIMEOUT_MS) await fail(processing, "Instagram took too long to process the video.");
        else await db.prepare("UPDATE posts SET next_attempt_at=? WHERE id=?").bind(new Date(now + CHECK_EVERY_MS).toISOString(), processing.id).run();
      } else await fail(processing, "Instagram could not process the video (" + status.code + (status.detail ? ": " + status.detail : "") + ").");
    } catch (error) {
      if (!await tokenProblem(error)) await fail(processing, (error as Error).message);
    }
    return;
  }

  // 2. Otherwise start the oldest queued post, within the daily limit and Instagram's own allowance.
  const queued = await db.prepare("SELECT id,clip_id,state,container_id,attempts,updated_at FROM posts WHERE account_id=? AND state='queued' AND next_attempt_at<=? ORDER BY created_at LIMIT 1").bind(account.id, iso).first<PostRow>();
  if (!queued) return;
  const clip = await db.prepare("SELECT c.review,c.file_key,s.name,s.platform FROM clips c LEFT JOIN streamers s ON s.id=c.streamer_id AND s.owner=c.owner WHERE c.id=? AND c.owner=?").bind(queued.clip_id, account.owner).first<{ review: string; file_key: string | null; name: string | null; platform: string | null }>();
  if (!clip || clip.review !== "approved" || !clip.file_key) {
    // Rejected or deleted after it was queued: drop it rather than post it.
    await db.prepare("DELETE FROM posts WHERE id=?").bind(queued.id).run();
    return;
  }
  const since = new Date(now - 24 * 3600_000).toISOString();
  const today = await db.prepare("SELECT count(*) AS n FROM posts WHERE account_id=? AND state='published' AND published_at>=?").bind(account.id, since).first<{ n: number }>();
  if ((today?.n ?? 0) >= (account.daily_limit ?? 5)) return;
  try {
    const quota = await instagram.publishingQuota(config, token, account.external_id);
    if (quota.used >= quota.total) return;
    const link = env.PUBLIC_URL!.replace(/\/$/, "") + await signedMediaPath(queued.clip_id, now + LINK_TTL_MS, env.MEDIA_KEY!);
    const caption = renderCaption(account.caption_template || defaultCaption, { streamer: clip.name ?? "a streamer", platform: clip.platform ?? "stream" });
    const containerId = await instagram.createReel(config, token, account.external_id, link, caption);
    await db.prepare("UPDATE posts SET state='processing',container_id=?,next_attempt_at=?,updated_at=? WHERE id=?").bind(containerId, new Date(now + CHECK_EVERY_MS).toISOString(), iso, queued.id).run();
  } catch (error) {
    if (!await tokenProblem(error)) await fail(queued, (error as Error).message);
  }
}
