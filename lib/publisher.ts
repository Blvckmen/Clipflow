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
import { subtitleLanguages, translatable } from "./languages";
import { weeklyHighlights } from "./highlights";
import { pruneSources } from "./sources";
import { planNext, tiktokBusy, TIKTOK_DAILY, bestHours, hoursLabel, nextOpenAt, windowHours, spreadGap } from "./posting-plan.mjs";
import { applyRules, lengthProblem, readRules } from "./posting-rules.mjs";
import { keyConnection, siteConnection, zernioApiUrl, type Connection } from "./zernio-keys";

type Env = Cloudflare.Env;
type AccountRow = { id: string; owner: string; provider: string; platform: string; external_id: string; username: string; token_enc: string; token_expires_at: string; token_refreshed_at: string; connected_at: string; options: string | null; control: string | null; daily_limit: number | null; caption_template: string | null; zernio_key_id: string | null; key_label: string | null; key_enc: string | null };
type PostRow = { id: string; clip_id: string; state: string; container_id: string | null; attempts: number; updated_at: string; draft?: number; queued_by_hand?: number };
// Shown on a post held for review because its account had reached its daily limit (set to hold, not queue).
const heldNote = (why: string) => "Held for your review: " + why + ". Queue it to post when there's room, or skip it.";
type ClipInfo = { reviewed: boolean; streamer: string; platform: string; draft: boolean };
// What an adapter reports back: done, still going (check again later), or failed with a reason.
// cancelled: the clip was rejected or deleted before the platform's last step, so it was never posted.
type Outcome = { state: "published"; mediaId: string | null; permalink: string | null; externalId?: string } | { state: "processing"; containerId: string; until?: string; note?: string } | { state: "failed"; message: string } | { state: "wait"; until?: string; note?: string } | { state: "cancelled" };
// A post the platform is holding (its own daily posting limit): `until` is when it goes out, `note` says why.
type Adapter = {
  timeoutMs: number; linkTtlMs: number;
  start(post: PostRow, link: string, caption: string, clip: ClipInfo): Promise<Outcome>;
  // wanted: the clip is still approved and there. Where posting is a separate last step (Instagram publishes a finished
  // container), a clip that no longer is isn't posted.
  check(post: PostRow, wanted: boolean): Promise<Outcome>;
  // A problem with the account as a whole (expired sign-in, revoked key): stop this account rather than fail the post.
  accountProblem(error: unknown): { message: string; expire: boolean } | null;
};

const CHECK_EVERY_MS = 60_000;   // Instagram recommends checking a container about once a minute
// An account's posts sent since a time (bind: account, since, account, since): published ones by when they went out,
// ones still processing by when they were sent. Two ranges on posts_account_published, so it reads only that day's
// posts rather than the account's whole history (it runs every minute for every account).
const LAST_DAY = `(SELECT draft,state,published_at AS at FROM posts WHERE account_id=? AND state='published' AND published_at>=?
  UNION ALL SELECT draft,state,updated_at AS at FROM posts WHERE account_id=? AND state='processing' AND updated_at>=?)`;
const MAX_ATTEMPTS = 3;
// How long a run holds a post it's working on (see claim in runAccount), and how long a post whose outcome isn't
// known keeps being checked before it stops (see unsure).
const CLAIM_MS = 5 * 60_000, UNSURE_MS = 6 * 3600_000;
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

// "https://www.twitch.tv/kaicenat" -> "twitch.tv/kaicenat", for credit lines.
export function channelLabel(url: string | null) {
  if (!url) return "";
  try { const u = new URL(url); return u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, ""); } catch { return ""; }
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
  // Monday's highlight videos (one sync_state row read until a new week is due).
  await weeklyHighlights(env.DB, now).catch(error => console.error("Weekly highlights failed:", error));
  // Editable sources of clips past SOURCE_KEEP_DAYS (one sync_state row read once done for the day).
  await pruneSources(env, now).catch(error => console.error("Source cleanup failed:", error));
  if (!env.MEDIA_KEY || !env.PUBLIC_URL) return;
  const ig = instagramConfig(env);
  // Clips flagged before this point are looked at by every account below; flags set meanwhile (a trigger, real time)
  // stay for the next run.
  const runStarted = new Date().toISOString(), owners = new Set<string>(), unfinished = new Set<string>();
  const { results } = await env.DB.prepare("SELECT a.*, p.control, p.daily_limit, p.caption_template, k.label AS key_label, k.key_enc FROM accounts a LEFT JOIN preferences p ON p.owner=a.owner LEFT JOIN zernio_keys k ON k.id=a.zernio_key_id AND k.owner=a.owner WHERE a.status='connected'").all<AccountRow>();
  for (const account of results) {
    owners.add(account.owner);
    // Paused, or no way to post right now: this account didn't look at the flagged clips, so they stay flagged.
    const paused = account.control !== "running";
    if (paused) unfinished.add(account.owner);
    // A paused Zernio account has nothing to do, so its key isn't decrypted. A paused Instagram account still goes
    // through instagramAdapter, which keeps its 60-day sign-in refreshed so it still works when unpaused.
    if (paused && account.provider === "zernio") continue;
    try {
      // An account connected with a workspace key posts with that key; one from the site key, with the site key.
      const zn = account.provider !== "zernio" ? null : account.zernio_key_id ? (account.key_enc ? await keyConnection(env, { id: account.zernio_key_id, label: account.key_label ?? "", key_enc: account.key_enc }) : null) : siteConnection(env);
      const adapter = account.provider === "zernio" ? (zn && zernioAdapter(zn, account)) : (ig && await instagramAdapter(env, ig, account, now));
      if (adapter) await runAccount(env, adapter, account, now);
      else unfinished.add(account.owner);
    } catch (error) {
      unfinished.add(account.owner);
      console.error("Publisher failed for account", account.id, error);
      await env.DB.prepare("UPDATE accounts SET last_error=? WHERE id=?").bind(String((error as Error).message).slice(0, 500), account.id).run();
    }
  }
  // Every account of these workspaces has now looked at their flagged clips: clear the flags set before this run.
  const done = [...owners].filter(o => !unfinished.has(o));
  if (done.length) await env.DB.prepare("UPDATE clips SET queue_check=NULL WHERE queue_check IS NOT NULL AND queue_check<=? AND owner IN (SELECT value FROM json_each(?))").bind(runStarted, JSON.stringify(done)).run();
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
    async check(post, wanted) {
      const status = await instagram.containerStatus(config, token, post.container_id!);
      // Rejected or deleted while Instagram was processing it: the container is never published (it expires by itself).
      if (status.code === "FINISHED" && !wanted) return { state: "cancelled" };
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

// The hours of the day an account posts in (options.hours): a fixed window, or its best hours from the views of its
// posts over the last 90 days (posts_account_published, at most 300 rows). null: any time.
export async function postingHours(db: D1Database, accountId: string, options: ReturnType<typeof readOptions>, now: number): Promise<number[] | null> {
  if (options.hours === "any") return null;
  if (options.hours === "window") return windowHours(options.hoursFrom, options.hoursTo);
  const { results } = await db.prepare("SELECT published_at,views FROM posts WHERE account_id=? AND state='published' AND views IS NOT NULL AND published_at>=? ORDER BY published_at DESC LIMIT 300")
    .bind(accountId, new Date(now - 90 * 24 * 3600_000).toISOString()).all<{ published_at: string; views: number }>();
  return bestHours(results.map(p => ({ at: Date.parse(p.published_at), views: p.views })), options.timeZone).hours;
}

async function runAccount(env: Env, adapter: Adapter, account: AccountRow, now: number) {
  const db = env.DB!, iso = new Date(now).toISOString();

  // Pausing or stopping automation also pauses publishing.
  if (account.control !== "running") return;

  // An account that has reached its daily limit (its own, or TikTok's 15 a day, drafts included) and is set to hold
  // ("When the daily limit is reached") holds its new clips for the owner's review rather than queueing them; the
  // same clips still queue for the streamer's other accounts.
  const since = new Date(now - 24 * 3600_000).toISOString(), options = readOptions(account.options);
  const ownLimit = options.dailyLimit ?? account.daily_limit ?? 5, tiktokCap = account.platform === "tiktok" && TIKTOK_DAILY < ownLimit;
  const cap = tiktokCap ? TIKTOK_DAILY : ownLimit;
  const sentToday = options.whenFull === "review" ? (await db.prepare("SELECT count(*) AS n FROM " + LAST_DAY).bind(account.id, since, account.id, since).first<{ n: number }>())?.n ?? 0 : 0;
  const full = options.whenFull === "review" && sentToday >= cap;
  const fullNote = heldNote(tiktokCap ? "TikTok's " + TIKTOK_DAILY + " posts a day were used up" : "this account's daily limit of " + ownLimit + " was reached");

  // Queue approved, uploaded clips from the streamers this account is linked to, approved after both the account
  // was connected and the streamer was linked to it — never the old backlog. Clips waiting for a re-render wait.
  // Only clips flagged since the last run (queue_check, set by triggers when a clip arrives, is approved, uploaded or
  // re-rendered) are looked at, through a partial index, so this every-minute step reads a handful of rows.
  await db.prepare(`INSERT OR IGNORE INTO posts (id,owner,clip_id,platform,account_id,state,error,next_attempt_at,created_at,updated_at)
    SELECT lower(hex(randomblob(16))),c.owner,c.id,?,?,?,?,?,?,? FROM clips c INDEXED BY clips_queue_check
    JOIN streamer_accounts sa ON sa.streamer_id=c.streamer_id AND sa.account_id=?
    WHERE c.queue_check IS NOT NULL AND c.owner=? AND c.review='approved' AND c.file_key IS NOT NULL AND coalesce(c.render_state,'')!='queued'
    AND coalesce(c.reviewed_at,c.created_at)>=max(?,sa.created_at)
    AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.clip_id=c.id AND p.account_id=?)`).bind(account.platform, account.id, full ? "review" : "queued", full ? fullNote : null, iso, iso, iso, account.id, account.owner, account.connected_at, account.id).run();

  // A post that goes back to the queue (or fails) after it was sent as an overflow draft (the planner sending it to
  // TikTok drafts because the day's direct posts were used up) loses that draft mark, so the next try is planned
  // afresh and posts directly once there's room. A post queued by hand as a draft stays one. (The mark is set before
  // sending, not after, so a retry after a lost response repeats exactly the same request.)
  const UNDRAFT = "draft=CASE WHEN queued_by_hand=1 THEN draft ELSE 0 END";
  const fail = async (post: PostRow, message: string) => {
    // TikTok saying "not now" (drafts inbox full, too many posts today) isn't a failure: try again later, as a
    // fresh request (updated_at is part of the idempotency key), without using up an attempt.
    const busy = account.platform === "tiktok" ? tiktokBusy(message) : null;
    if (busy) {
      const later = now + (busy === "drafts" ? 2 : 3) * 3600_000;
      const note = busy === "drafts" ? "TikTok's drafts inbox is full. Post or delete drafts in the TikTok app; Clipflow tries again at " + new Date(later).toISOString().slice(11, 16) + " UTC."
        : "TikTok won't take more posts from apps today; Clipflow tries again at " + new Date(later).toISOString().slice(11, 16) + " UTC.";
      await db.prepare("UPDATE posts SET state='queued',container_id=NULL," + UNDRAFT + ",error=?,next_attempt_at=?,updated_at=? WHERE id=?").bind(note, new Date(later).toISOString(), iso, post.id).run();
      return;
    }
    const attempts = post.attempts + 1, final = attempts >= MAX_ATTEMPTS;
    await db.prepare("UPDATE posts SET state=?,container_id=NULL," + UNDRAFT + ",attempts=?,error=?,next_attempt_at=?,updated_at=? WHERE id=?")
      .bind(final ? "failed" : "queued", attempts, message.slice(0, 500), new Date(now + 5 * 60_000 * attempts).toISOString(), iso, post.id).run();
  };
  // A run claims a post before acting on it: one conditional UPDATE that only one run can win, holding it for
  // CLAIM_MS. Publisher runs can overlap (a slow one still going when the next minute's starts), and both used to
  // read the same post and send it.
  const claim = async (post: PostRow) => !!await db.prepare("UPDATE posts SET next_attempt_at=? WHERE id=? AND state=? AND next_attempt_at<=? RETURNING id")
    .bind(new Date(now + CLAIM_MS).toISOString(), post.id, post.state, iso).first();
  // Something went wrong while a post was already with the platform (a lost response, the network): whether it went
  // out isn't known, so the platform's id is kept and it's checked again, never sent afresh (which could post it
  // twice: Instagram says PUBLISHED for a container already published). Past UNSURE_MS it stops, still keeping the id.
  const unsure = async (post: PostRow, message: string) => {
    if (now - Date.parse(post.updated_at) > UNSURE_MS) await db.prepare("UPDATE posts SET state='failed',error=?,updated_at=? WHERE id=?").bind(("Couldn't confirm whether this posted (" + message + "). Check the account before retrying, or it may post twice.").slice(0, 500), iso, post.id).run();
    else await db.prepare("UPDATE posts SET next_attempt_at=?,error=? WHERE id=?").bind(new Date(now + 5 * CHECK_EVERY_MS).toISOString(), ("Checking whether it posted: " + message).slice(0, 500), post.id).run();
  };
  const apply = async (post: PostRow, result: Outcome) => {
    if (result.state === "cancelled") await db.prepare("DELETE FROM posts WHERE id=?").bind(post.id).run();
    else if (result.state === "published")
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
    if (!await claim(processing)) return;
    try {
      const clipNow = await db.prepare("SELECT review,file_key FROM clips WHERE id=? AND owner=?").bind(processing.clip_id, account.owner).first<{ review: string; file_key: string | null }>();
      const result = await adapter.check(processing, clipNow?.review === "approved" && !!clipNow.file_key);
      if (result.state !== "wait") await apply(processing, result);
      // Held by the platform until a known time: not stuck, so it is checked again then rather than timed out.
      else if (result.until) await db.prepare("UPDATE posts SET next_attempt_at=?,error=?,updated_at=? WHERE id=?").bind(new Date(Math.max(now + CHECK_EVERY_MS, Date.parse(result.until) + CHECK_EVERY_MS)).toISOString(), result.note ?? null, iso, processing.id).run();
      else if (now - Date.parse(processing.updated_at) > adapter.timeoutMs) await fail(processing, "The platform took too long to process the video.");
      else await db.prepare("UPDATE posts SET next_attempt_at=? WHERE id=?").bind(new Date(now + CHECK_EVERY_MS).toISOString(), processing.id).run();
    } catch (error) {
      const problem = adapter.accountProblem(error);
      if (problem) await db.prepare("UPDATE accounts SET status=?,last_error=? WHERE id=?").bind(problem.expire ? "expired" : "connected", problem.message, account.id).run();
      // Zernio's own "still in flight" answer: just look again next time.
      else if (!(error instanceof zernio.ZernioError && error.inFlight)) await unsure(processing, (error as Error).message);
    }
    return;
  }

  // One post in flight per account: one being processed or held, even if it isn't due for a check yet, comes first.
  // (While TikTok holds one for its daily limit, anything else, drafts included, would only be held too.)
  if (await db.prepare("SELECT 1 FROM posts WHERE account_id=? AND state='processing' LIMIT 1").bind(account.id).first()) return;

  // 2. Otherwise start the oldest queued post, within the daily limit.
  const queued = await db.prepare("SELECT id,clip_id,state,container_id,attempts,updated_at,draft,queued_by_hand FROM posts WHERE account_id=? AND state='queued' AND next_attempt_at<=? ORDER BY created_at LIMIT 1").bind(account.id, iso).first<PostRow>();
  if (!queued || !await claim(queued)) return;
  const clip = await db.prepare("SELECT c.review,c.reviewed_at,c.file_key,c.render_state,c.duration,c.edit_rev,c.edit IS NOT NULL AS editable,s.name,s.platform,s.url,s.posting_rules FROM clips c LEFT JOIN streamers s ON s.id=c.streamer_id AND s.owner=c.owner WHERE c.id=? AND c.owner=?").bind(queued.clip_id, account.owner).first<{ review: string; reviewed_at: string | null; file_key: string | null; render_state: string | null; duration: number | null; edit_rev: number; editable: number; name: string | null; platform: string | null; url: string | null; posting_rules: string | null }>();
  if (!clip || clip.review !== "approved" || !clip.file_key) {
    // Rejected or deleted after it was queued: drop it rather than post it.
    await db.prepare("DELETE FROM posts WHERE id=?").bind(queued.id).run();
    return;
  }
  // Edited after it was queued: post the new version once the worker has rendered it.
  // (The claim is let go, so it's looked at again next minute.)
  if (clip.render_state === "queued") { await db.prepare("UPDATE posts SET next_attempt_at=? WHERE id=?").bind(iso, queued.id).run(); return; }
  // A clip the streamer's campaign won't accept (too short or long) waits for the owner, unless they queued it by hand.
  const rules = readRules(clip.posting_rules), tooLong = queued.queued_by_hand ? null : lengthProblem(rules, clip.duration ?? NaN);
  if (tooLong) {
    await db.prepare("UPDATE posts SET state='review',error=?,updated_at=? WHERE id=?").bind(heldNote(tooLong), iso, queued.id).run();
    return;
  }
  // What the last day looks like for this account, for the planner (lib/posting-plan.mjs): direct posts and drafts
  // sent, when the last one went, and when the oldest of each leaves the 24-hour window.
  const day = await db.prepare("SELECT sum(draft=0 AND state='published') AS direct, sum(draft=1) AS drafts, max(at) AS last, min(at) AS oldest FROM " + LAST_DAY)
    .bind(account.id, since, account.id, since).first<{ direct: number | null; drafts: number | null; last: string | null; oldest: string | null }>();
  const at = (v: string | null | undefined) => v ? Date.parse(v) : null;
  // This account's posting hours (null: any time), to wait for them and to spread the day's posts across them. A post
  // queued or scheduled by hand goes when asked: it skips both (the set gap and the limits still apply).
  const hours = queued.queued_by_hand ? null : await postingHours(db, account.id, options, now);
  const limit = options.dailyLimit ?? account.daily_limit ?? 5;
  const plan = planNext({
    platform: account.platform, wantsDraft: account.platform === "tiktok" && (!!queued.draft || wantsDraft(options, !!clip.reviewed_at)), queuedByHand: !!queued.queued_by_hand, holdWhenFull: options.whenFull === "review",
    limit, gapMinutes: queued.queued_by_hand ? options.gapMinutes : spreadGap(hours, limit, options.gapMinutes, options.spread),
    directToday: day?.direct ?? 0, draftsToday: day?.drafts ?? 0, lastSentAt: at(day?.last), oldestSentAt: at(day?.oldest), now,
  });
  if (plan.action === "hold") {
    await db.prepare("UPDATE posts SET state='review',error=?,updated_at=? WHERE id=?").bind(heldNote(plan.reason ?? "the daily limit was reached"), iso, queued.id).run();
    return;
  }
  // Posting hours: outside this account's best hours (or its set window) the post waits for the next of them.
  if ((plan.action === "post" || plan.action === "draft") && !queued.queued_by_hand && hours) {
    const opens = nextOpenAt(now, hours, options.timeZone);
    if (opens !== null) {
      await db.prepare("UPDATE posts SET next_attempt_at=?,error=? WHERE id=?").bind(new Date(opens).toISOString(), "Waiting for " + (options.hours === "window" ? "this account's posting hours" : "this account's best hours") + " (" + hoursLabel(hours) + ", " + options.timeZone + ").", queued.id).run();
      return;
    }
  }
  if (plan.action === "wait") {
    // Not this post's fault: look again when there is room (or in 15 minutes), and say why in the queue.
    const next = Math.max(now + CHECK_EVERY_MS, plan.until ?? now + 15 * 60_000);
    await db.prepare("UPDATE posts SET next_attempt_at=?,error=? WHERE id=?").bind(new Date(next).toISOString(), "Waiting: " + plan.reason + "; next try " + new Date(next).toISOString().slice(11, 16) + " UTC.", queued.id).run();
    return;
  }
  const draft = plan.action === "draft";
  const info = { reviewed: !!clip.reviewed_at, streamer: clip.name ?? "a streamer", platform: clip.platform ?? "stream", draft };
  // The clip's own caption (written by Claude or typed by the owner), else the workspace template.
  const english = async () => await captionForPost(env, queued.clip_id).catch(() => null) ?? renderCaption(account.caption_template || defaultCaption, info);
  // An account that posts in another language posts that version of the clip: subtitles, hook and caption translated
  // and rendered on the worker PC (worker translate jobs). Asked for here, made from the clip's current edit.
  let media = queued.clip_id, translatedCaption: string | null = null;
  if (translatable(options.subtitleLanguage)) {
    const lang = options.subtitleLanguage, name = subtitleLanguages[lang];
    if (!clip.editable) {
      await db.prepare("UPDATE posts SET state='failed',error=?,updated_at=? WHERE id=?").bind("This clip was captured before the editor existed, so it can't be made in " + name + ". Post it from an English account, or change this account's language.", iso, queued.id).run();
      return;
    }
    const version = await db.prepare("SELECT rev,state,caption,error FROM clip_translations WHERE clip_id=? AND lang=?").bind(queued.clip_id, lang).first<{ rev: number; state: string; caption: string | null; error: string | null }>();
    // Couldn't be made from this edit: the post fails with the reason. Retrying the post clears it, so it's asked again.
    if (version?.state === "failed" && version.rev === clip.edit_rev) {
      await db.prepare("UPDATE posts SET state='failed',error=?,updated_at=? WHERE id=?").bind("Couldn't make the " + name + " version: " + (version.error ?? "unknown error") + ". Retry to try again.", iso, queued.id).run();
      return;
    }
    if (version?.state !== "ready" || version.rev !== clip.edit_rev) {
      if (!version || version.rev !== clip.edit_rev)
        await db.prepare(`INSERT INTO clip_translations (clip_id,owner,lang,rev,state,source_caption,created_at,updated_at) VALUES (?,?,?,?,'queued',?,?,?)
          ON CONFLICT(clip_id,lang) DO UPDATE SET rev=excluded.rev,state='queued',source_caption=excluded.source_caption,caption=NULL,error=NULL,updated_at=excluded.updated_at`)
          .bind(queued.clip_id, account.owner, lang, clip.edit_rev, await english(), iso, iso).run();
      const next = new Date(now + 2 * 60_000).toISOString();
      await db.prepare("UPDATE posts SET next_attempt_at=?,error=? WHERE id=?").bind(next, "Waiting for your worker PC to make the " + name + " version (subtitles, hook and caption).", queued.id).run();
      return;
    }
    media = queued.clip_id + "-" + lang;
    translatedCaption = version.caption;
  }
  if (draft) await db.prepare("UPDATE posts SET draft=1 WHERE id=?").bind(queued.id).run();
  try {
    const link = env.PUBLIC_URL!.replace(/\/$/, "") + await signedMediaPath(media, now + adapter.linkTtlMs, env.MEDIA_KEY!);
    // Then the streamer's posting rules: a campaign's label and tags, and the credit line, added after translating
    // so a brand's own label and tags are never translated.
    const written = translatedCaption ?? await english();
    const caption = applyRules(written, rules, { streamer: info.streamer, platform: info.platform, channel: channelLabel(clip.url) });
    await apply(queued, await adapter.start(queued, link, caption, info));
  } catch (error) { await handle(queued, error); }
}
