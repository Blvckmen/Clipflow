// Alerts in the owner's Discord server: "clips are waiting for your review", sent through a Discord webhook the owner
// pasted in Settings. A webhook URL lets anyone post into that channel, so it is stored encrypted with TOKEN_KEY
// (preferences.discord_webhook_enc) and never sent back to the browser.
import { decrypt } from "./secure";

// At most one review alert per this long; each says how many clips are waiting in total.
export const ALERT_GAP_MS = 10 * 60_000;
const WEBHOOK = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/[\w-]{20,100}$/;

export const isDiscordWebhook = (url: string) => WEBHOOK.test(url.trim());

// Posts a message to the webhook. Returns null when Discord took it, else a short reason.
export async function sendDiscord(url: string, content: string): Promise<string | null> {
  if (!isDiscordWebhook(url)) return "That isn't a Discord webhook link.";
  try {
    const response = await fetch(url.trim(), {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(8_000),
      // No pings: the message never mentions @everyone, roles or people, whatever a streamer's name contains.
      body: JSON.stringify({ username: "Clipflow", content: content.slice(0, 1900), allowed_mentions: { parse: [] } }),
    });
    if (response.ok) return null;
    return response.status === 404 || response.status === 401 ? "Discord says this webhook no longer exists. Make a new one and paste it here." : "Discord answered HTTP " + response.status + ".";
  } catch (error) { return "Couldn't reach Discord: " + (error as Error).message; }
}

// Called when a clip that waits for review becomes watchable (its file is stored). Sends one alert with the number
// of clips waiting, unless one went out in the last ALERT_GAP_MS. Never throws: a failed alert must not fail an upload.
export async function reviewAlert(db: D1Database, env: { TOKEN_KEY?: string; PUBLIC_URL?: string }, owner: string, streamer: string | null, now = Date.now()) {
  try {
    const p = await db.prepare("SELECT discord_webhook_enc,alert_at FROM preferences WHERE owner=?").bind(owner).first<{ discord_webhook_enc: string | null; alert_at: string | null }>();
    if (!p?.discord_webhook_enc || !env.TOKEN_KEY) return;
    if (p.alert_at && now - Date.parse(p.alert_at) < ALERT_GAP_MS) return;
    // Claim this slot first, so two uploads finishing together send one alert.
    const iso = new Date(now).toISOString(), claimed = await db.prepare("UPDATE preferences SET alert_at=? WHERE owner=? AND (alert_at IS NULL OR alert_at=?)").bind(iso, owner, p.alert_at).run();
    if (!claimed.meta.changes) return;
    const waiting = (await db.prepare("SELECT count(*) AS n FROM clips WHERE owner=? AND review='pending' AND file_key IS NOT NULL").bind(owner).first<{ n: number }>())?.n ?? 0;
    if (!waiting) return;
    const link = (env.PUBLIC_URL ?? "").replace(/\/$/, "");
    const text = "\u{1F3AC} **" + waiting + " clip" + (waiting === 1 ? "" : "s") + "** waiting for your review in Clipflow" + (streamer ? " (latest from " + streamer.replace(/[*_~`|>]/g, "") + ")" : "") + "." + (link ? "\n" + link : "");
    const problem = await sendDiscord(await decrypt(p.discord_webhook_enc, env.TOKEN_KEY), text);
    await db.prepare("UPDATE preferences SET alert_error=? WHERE owner=?").bind(problem, owner).run();
  } catch (error) { console.error("Review alert failed", error); }
}
