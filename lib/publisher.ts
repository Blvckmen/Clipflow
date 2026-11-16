// Publishes approved clips to connected accounts. Runs from the Worker's once-a-minute cron trigger and does a
// bounded amount of work per account per run, so a slow platform never holds up the rest.
// Accounts come from one of two providers: Instagram connected directly (Instagram Login, token stored here), or
// any platform connected through Zernio (each account posts with the workspace key it was connected with, or the
// site-wide key). Both share the queue, retries and daily limit below;
// a provider adapter only knows how to start a post and how to check on one.
import { decrypt, encrypt, signedMediaPath } from "./secure";
import * as instagram from "./instagram";
import * as zernio from "./zernio";
import { defaultCaption } from "./clipflow";
import { captionForPost, fillCaptions } from "./post-caption";
import { syncAnalytics } from "./analytics";
import { expireRecordings } from "./recordings";
import { readOptions, tiktokSettings, wantsDraft } from "./account-options";
import { planNext, tiktokBusy } from "./posting-plan.mjs";
import { keyConnection, siteConnection, zernioApiUrl, type Connection } from "./zernio-keys";

type Env = Cloudflare.Env;
type AccountRow = { id: string; owner: string; provider: string; platform: string; external_id: string; username: string; token_enc: string; token_expires_at: string; token_refreshed_at: string; connected_at: string; options: string | null; control: string | null; daily_limit: number | null; caption_template: string | null; zernio_key_id: string | null; key_label: string | null; key_enc: string | null };
type PostRow = { id: string; clip_id: string; state: string; container_id: string | null; attempts: number; updated_at: string; draft?: number };
type ClipInfo = { reviewed: boolean; streamer: string; platform: string; draft: boolean };
// What an adapter reports back: done, still going (check again later), or failed with a reason.
type Outcome = { state: "published"; mediaId: string | null; permalink: string | null; externalId?: string } | { state: "processing"; containerId: string; until?: string; note?: string } | { state: "failed"; message: string } | { state: "wait"; until?: string; note?: string };
// A post the platform is holding (its own daily posting limit): `until` is when it goes out, `note` says why.
type Adapter = {
  timeoutMs: number; linkTtlMs: number;
  start(post: PostRow, link: string, caption: string, clip: ClipInfo): Promise<Outcome>;
  check(post: PostRow): Promise<Outcome>;
  // A problem with the account as a whole (expired sign-in, revoked key): stop this account rather than fail the post.
  accountProblem(error: unknown): { message: string; expire: boolean } | null;
};

const CHECK_EVERY_MS = 60_000;   // Instagram recommends checking a container about once a minute
const MAX_ATTEMPTS = 3;
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

export { zernioApiUrl };
// The site-wide Zernio key (ZERNIO_API_KEY), used by workspaces that have not added keys of their own.
export function zernioConfig(env: Env): zernio.ZernioConfig | null {
  const site = siteConnection(env);
  return site && { apiKey: site.apiKey, apiUrl: site.apiUrl };
}

export function renderCaption(template: string, values: { streamer: string; platform: string }) {
  return template.replace(/\{streamer\}/g, values.streamer).replace(/\{platform\}/g, values.platform).slice(0, 2200);
}

export async function runPublisher(env: Env, now = Date.now()) {
  if (!env.DB) return;
  // Write captions for new clips first, so they can be read (and edited) before they post.
  await fillCaptions(env, now).catch(error => console.error("Caption writing failed:", error));
  // How published posts are doing, from Zernio (each connection about once an hour).
  await syncAnalytics(env, now).catch(error => console.error("Analytics sync failed:", error));
  // Whole-stream recordings past their retention period.
  await expireRecordings(env, now).catch(error => console.error("Recording expiry failed:", error));
  if (!env.MEDIA_KEY || !env.PUBLIC_URL) return;
  const ig = instagramConfig(env);
  const { results } = await env.DB.prepare("SELECT a.*, p.control, p.daily_limit, p.caption_template, k.label AS key_label, k.key_enc FROM accounts a LEFT JOIN preferences p ON p.owner=a.owner LEFT JOIN zernio_keys k ON k.id=a.zernio_key_id AND k.owner=a.owner WHERE a.status='connected'").all<AccountRow>();
  for (const account of results) {
    try {
      // An account connected with a workspace key posts with that key; one from the site key, with the site key.
      const zn = account.provider !== "zernio" ? null : account.zernio_key_id ? (account.key_enc ? await keyConnection(env, { id: account.zernio_key_id, label: account.key_label ?? "", key_enc: account.key_enc }) : null) : siteConnection(env);
      const adapter = account.provider === "zernio" ? (zn && zernioAdapter(zn, account)) : (ig && await instagramAdapter(env, ig, account, now));
      if (adapter) await runAccount(env, adapter, account, now);
    } catch (error) {
      console.error("Publisher failed for account", account.id, error);
      await env.DB.prepare("UPDATE accounts SET last_error=? WHERE id=?").bind(String((error as Error).message).slice(0, 500), account.id).run();
    }
  }
}

async function instagramAdapter(env: Env, config: instagram.InstagramConfig, account: AccountRow, now: number): Promise<Adapter> {
  let token = await decrypt(account.token_enc, env.TOKEN_KEY!);
  // Long-lived tokens last 60 days and can be refreshed once they are a day old.
  if (Date.parse(account.token_expires_at) - now < REFRESH_WITHIN_MS && now - Date.parse(account.token_refreshed_at) > 24 * 3600_000) {
    const renewed = await instagram.refresh(config, token);
    token = renewed.access_token;
    await env.DB!.prepare("UPDATE accounts SET token_enc=?,token_expires_at=?,token_refreshed_at=? WHERE id=?").bind(await encrypt(token, env.TOKEN_KEY!), new Date(now + renewed.expires_in * 1000).toISOString(), new Date(now).toISOString(), account.id).run();
  }
  return {
    timeoutMs: 15 * 60_000, linkTtlMs: 3 * 3600_000,  // the signed link must outlive Instagram's fetch
    async start(_post, link, caption) {
      const quota = await instagram.publishingQuota(config, token, account.external_id);
      if (quota.used >= quota.total) return { state: "wait" };
      return { state: "processing", containerId: await instagram.createReel(config, token, account.external_id, link, caption) };
    },
    async check(post) {
      const status = await instagram.containerStatus(config, token, post.container_id!);
      if (status.code === "FINISHED" || status.code === "PUBLISHED") {
        // PUBLISHED means an earlier publish call succeeded but its response was lost; don't publish twice.
        const mediaId = status.code === "FINISHED" ? await instagram.publish(config, token, account.external_id, post.container_id!) : null;
        return { state: "published", mediaId, permalink: mediaId ? await instagram.permalink(config, token, mediaId).catch(() => null) : null };
      }
      if (status.code === "IN_PROGRESS") return { state: "wait" };
      return { state: "failed", message: "Instagram could not process the video (" + status.code + (status.detail ? ": " + status.detail : "") + ")." };
    },
    accountProblem(error) {
      return error instanceof instagram.InstagramError && error.tokenInvalid ? { message: "Instagram sign-in expired or was revoked; reconnect the account.", expire: true } : null;
    },
  };
}

function zernioAdapter(config: Connection, account: AccountRow): Adapter {
  const options = readOptions(account.options);
  const outcome = (post: zernio.ZernioPost): Outcome => {
    const result = zernio.platformResult(post);
    if (post.status === "published" || result?.status === "published")
      return { state: "published", mediaId: result?.platformPostId ?? null, permalink: result?.platformPostUrl ?? null, externalId: post._id };
    if (post.status === "failed" || post.status === "partial" || post.status === "cancelled" || result?.status === "failed")
      return { state: "failed", message: zernio.platformError(post) };
    // scheduled / publishing / pending: Zernio is still working on it (it retries transient errors itself), or
    // holding it until the platform's daily limit resets.
    const until = zernio.heldUntil(post);
    return until ? { state: "processing", containerId: post._id, until, note: "Waiting for " + (zernio.VIDEO_PLATFORMS[account.platform] ?? account.platform) + "'s daily posting limit to reset; goes out after " + until.slice(0, 16).replace("T", " ") + " UTC." } : { state: "processing", containerId: post._id };
  };
  return {
    // Zernio may retry a transient failure itself later, so the video link stays valid for a day.
    timeoutMs: 60 * 60_000, linkTtlMs: 24 * 3600_000,
    async start(post, link, caption, clip) {
      const platform: Record<string, unknown> = { platform: account.platform, accountId: account.external_id };
      const body: Record<string, unknown> = { content: caption, publishNow: true, platforms: [platform], mediaItems: [{ type: "video", url: link, mimeType: "video/mp4" }] };
      if (account.platform === "youtube") {
        platform.platformSpecificData = { title: (caption.split("\n")[0].trim() || clip.streamer + " clip").slice(0, 100) };
        body.visibility = options.youtubeVisibility;
      }
      // Publish directly or send to TikTok drafts: the posting mode (see account-options.ts), or the planner sending
      // an overflow post to drafts once TikTok's direct posts for the day are used up.
      if (account.platform === "tiktok") body.tiktokSettings = clip.draft ? { draft: true } : tiktokSettings(options, clip.reviewed);
      // One key per attempt: a lost response is answered with the same post, while a retry after a definite
      // failure (automatic or by hand) is a fresh post. The attempt count separates automatic retries; updated_at,
      // set when a manual retry resets that count, separates those.
      return outcome(await zernio.createPost(config, body, post.id + "-" + post.attempts + "-" + Date.parse(post.updated_at)));
    },
    async check(post) {
      const result = outcome(await zernio.getPost(config, post.container_id!));
      return result.state === "processing" ? { state: "wait", until: result.until, note: result.note } : result;
    },
    accountProblem(error) {
      if (!(error instanceof zernio.ZernioError)) return null;
      if (error.keyInvalid) return { message: config.keyId ? "Zernio refused the key \"" + config.label + "\"; add it again under Connections." : "Zernio refused the site's shared key; add your own under Connections.", expire: false };
      if (error.accountInvalid) return { message: "This account was disconnected on Zernio; reconnect it under Connections.", expire: true };
      return null;
    },
  };
}

async function runAccount(env: Env, adapter: Adapter, account: AccountRow, now: number) {
  const db = env.DB!, iso = new Date(now).toISOString();

  // Pausing or stopping automation also pauses publishing.
  if (account.control !== "running") return;

  // Queue approved, uploaded clips from the streamers this account is linked to, approved after both the account
  // was connected and the streamer was linked to it — never the old backlog. Clips waiting for a re-render wait.
  await db.prepare(`INSERT OR IGNORE INTO posts (id,owner,clip_id,platform,account_id,state,next_attempt_at,created_at,updated_at)
    SELECT lower(hex(randomblob(16))),c.owner,c.id,?,?,'queued',?,?,? FROM clips c
    JOIN streamer_accounts sa ON sa.streamer_id=c.streamer_id AND sa.account_id=?
    WHERE c.owner=? AND c.review='approved' AND c.file_key IS NOT NULL AND coalesce(c.render_state,'')!='queued'
    AND coalesce(c.reviewed_at,c.created_at)>=max(?,sa.created_at)
    AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.clip_id=c.id AND p.account_id=?)`).bind(account.platform, account.id, iso, iso, iso, account.id, account.owner, account.connected_at, account.id).run();

  const fail = async (post: PostRow, message: string) => {
    // TikTok saying "not now" (drafts inbox full, too many posts today) isn't a failure: try again later, as a
    // fresh request (updated_at is part of the idempotency key), without using up an attempt.
    const busy = account.platform === "tiktok" ? tiktokBusy(message) : null;
    if (busy) {
      const later = now + (busy === "drafts" ? 2 : 3) * 3600_000;
      const note = busy === "drafts" ? "TikTok's drafts inbox is full. Post or delete drafts in the TikTok app; Clipflow tries again at " + new Date(later).toISOString().slice(11, 16) + " UTC."
        : "TikTok won't take more posts from apps today; Clipflow tries again at " + new Date(later).toISOString().slice(11, 16) + " UTC.";
      await db.prepare("UPDATE posts SET state='queued',container_id=NULL,error=?,next_attempt_at=?,updated_at=? WHERE id=?").bind(note, new Date(later).toISOString(), iso, post.id).run();
      return;
    }
    const attempts = post.attempts + 1, final = attempts >= MAX_ATTEMPTS;
    await db.prepare("UPDATE posts SET state=?,container_id=NULL,attempts=?,error=?,next_attempt_at=?,updated_at=? WHERE id=?")
      .bind(final ? "failed" : "queued", attempts, message.slice(0, 500), new Date(now + 5 * 60_000 * attempts).toISOString(), iso, post.id).run();
  };
  const apply = async (post: PostRow, result: Outcome) => {
    if (result.state === "published")
      // The Zernio post id (when there is one) is kept to match the post's analytics later.
      await db.prepare("UPDATE posts SET state='published',media_id=?,permalink=?,container_id=coalesce(?,container_id),error=NULL,published_at=?,updated_at=? WHERE id=?").bind(result.mediaId, result.permalink, result.externalId ?? null, iso, iso, post.id).run();
    else if (result.state === "processing")
      await db.prepare("UPDATE posts SET state='processing',container_id=?,next_attempt_at=?,error=?,updated_at=? WHERE id=?").bind(result.containerId, result.until ? new Date(Date.parse(result.until) + CHECK_EVERY_MS).toISOString() : new Date(now + CHECK_EVERY_MS).toISOString(), result.note ?? null, iso, post.id).run();
    else if (result.state === "failed") await fail(post, result.message);
  };
  const handle = async (post: PostRow, error: unknown) => {
    const problem = adapter.accountProblem(error);
    if (problem) await db.prepare("UPDATE accounts SET status=?,last_error=? WHERE id=?").bind(problem.expire ? "expired" : "connected", problem.message, account.id).run();
    else if (!(error instanceof zernio.ZernioError && error.inFlight)) await fail(post, (error as Error).message);
  };

  // 1. Finish a post the platform is still processing.
  const processing = await db.prepare("SELECT id,clip_id,state,container_id,attempts,updated_at FROM posts WHERE account_id=? AND state='processing' AND next_attempt_at<=? ORDER BY created_at LIMIT 1").bind(account.id, iso).first<PostRow>();
  if (processing) {
    try {
      const result = await adapter.check(processing);
      if (result.state !== "wait") await apply(processing, result);
      // Held by the platform until a known time: not stuck, so it is checked again then rather than timed out.
      else if (result.until) await db.prepare("UPDATE posts SET next_attempt_at=?,error=?,updated_at=? WHERE id=?").bind(new Date(Math.max(now + CHECK_EVERY_MS, Date.parse(result.until) + CHECK_EVERY_MS)).toISOString(), result.note ?? null, iso, processing.id).run();
      else if (now - Date.parse(processing.updated_at) > adapter.timeoutMs) await fail(processing, "The platform took too long to process the video.");
      else await db.prepare("UPDATE posts SET next_attempt_at=? WHERE id=?").bind(new Date(now + CHECK_EVERY_MS).toISOString(), processing.id).run();
    } catch (error) { await handle(processing, error); }
    return;
  }

  // One post in flight per account: one being processed or held, even if it isn't due for a check yet, comes first.
  if (await db.prepare("SELECT 1 FROM posts WHERE account_id=? AND state='processing' LIMIT 1").bind(account.id).first()) return;

  // 2. Otherwise start the oldest queued post, within the daily limit.
  const queued = await db.prepare("SELECT id,clip_id,state,container_id,attempts,updated_at,draft FROM posts WHERE account_id=? AND state='queued' AND next_attempt_at<=? ORDER BY created_at LIMIT 1").bind(account.id, iso).first<PostRow>();
  if (!queued) return;
  const clip = await db.prepare("SELECT c.review,c.reviewed_at,c.file_key,c.render_state,s.name,s.platform FROM clips c LEFT JOIN streamers s ON s.id=c.streamer_id AND s.owner=c.owner WHERE c.id=? AND c.owner=?").bind(queued.clip_id, account.owner).first<{ review: string; reviewed_at: string | null; file_key: string | null; render_state: string | null; name: string | null; platform: string | null }>();
  if (!clip || clip.review !== "approved" || !clip.file_key) {
    // Rejected or deleted after it was queued: drop it rather than post it.
    await db.prepare("DELETE FROM posts WHERE id=?").bind(queued.id).run();
    return;
  }
  // Edited after it was queued: post the new version once the worker has rendered it.
  if (clip.render_state === "queued") return;
  // What the last day looks like for this account, for the planner (lib/posting-plan.mjs): direct posts and drafts
  // sent, when the last one went, and when the oldest of each leaves the 24-hour window.
  const since = new Date(now - 24 * 3600_000).toISOString(), options = readOptions(account.options);
  const day = await db.prepare(`SELECT sum(draft=0 AND state='published') AS direct, sum(draft=1) AS drafts,
      max(coalesce(published_at,updated_at)) AS last, min(CASE WHEN draft=0 AND state='published' THEN published_at END) AS oldest_direct,
      min(CASE WHEN draft=1 THEN coalesce(published_at,updated_at) END) AS oldest_draft
    FROM posts WHERE account_id=? AND state IN ('published','processing') AND coalesce(published_at,updated_at)>=?`).bind(account.id, since)
    .first<{ direct: number | null; drafts: number | null; last: string | null; oldest_direct: string | null; oldest_draft: string | null }>();
  const at = (v: string | null | undefined) => v ? Date.parse(v) : null;
  const plan = planNext({
    platform: account.platform, wantsDraft: account.platform === "tiktok" && (!!queued.draft || wantsDraft(options, !!clip.reviewed_at)), overflow: options.overflowToDrafts,
    limit: options.dailyLimit ?? account.daily_limit ?? 5, gapMinutes: options.gapMinutes,
    directToday: day?.direct ?? 0, draftsToday: day?.drafts ?? 0, lastSentAt: at(day?.last), oldestDirectAt: at(day?.oldest_direct), oldestDraftAt: at(day?.oldest_draft), now,
  });
  if (plan.action === "wait") {
    // Not this post's fault: look again when there is room (or in 15 minutes), and say why in the queue.
    const next = Math.max(now + CHECK_EVERY_MS, plan.until ?? now + 15 * 60_000);
    await db.prepare("UPDATE posts SET next_attempt_at=?,error=? WHERE id=?").bind(new Date(next).toISOString(), "Waiting: " + plan.reason + "; next try " + new Date(next).toISOString().slice(11, 16) + " UTC.", queued.id).run();
    return;
  }
  const draft = plan.action === "draft";
  if (draft) await db.prepare("UPDATE posts SET draft=1 WHERE id=?").bind(queued.id).run();
  try {
    const link = env.PUBLIC_URL!.replace(/\/$/, "") + await signedMediaPath(queued.clip_id, now + adapter.linkTtlMs, env.MEDIA_KEY!);
    const info = { reviewed: !!clip.reviewed_at, streamer: clip.name ?? "a streamer", platform: clip.platform ?? "stream", draft };
    // The clip's own caption (written by Claude or typed by the owner), else the workspace template.
    const caption = await captionForPost(env, queued.clip_id).catch(() => null) ?? renderCaption(account.caption_template || defaultCaption, info);
    await apply(queued, await adapter.start(queued, link, caption, info));
  } catch (error) { await handle(queued, error); }
}
