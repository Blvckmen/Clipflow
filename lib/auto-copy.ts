import { configured, generateCopy } from "./ai-copy";

type AutoCopyEnv = Parameters<typeof generateCopy>[0] & { DB?: D1Database };

/**
 * Generates background copy for clips with a usable transcript.
 * The cron runs once a minute; claims are persisted so overlapping cron invocations
 * cannot generate the same clip concurrently. Three attempts are allowed.
 */
export async function runAutoCopy(env: AutoCopyEnv, now = Date.now()): Promise<void> {
  const db = env.DB;
  if (!db || !configured(env)) return;

  const staleBefore = new Date(now - 10 * 60_000).toISOString();
  const rows = await db.prepare(
    `SELECT cc.clip_id,cc.owner,cc.transcript,cc.auto_attempts,
            s.name AS streamer,s.platform AS source,c.reason
       FROM clip_copy cc
       JOIN clips c ON c.id=cc.clip_id AND c.owner=cc.owner
       LEFT JOIN streamers s ON s.id=c.streamer_id AND s.owner=c.owner
      WHERE length(trim(cc.transcript)) >= 12
        AND cc.auto_attempts < 3
        AND ((cc.status='draft' AND cc.hooks_json='[]')
          OR (cc.status='generating' AND cc.updated_at < ?))
      ORDER BY c.created_at ASC
      LIMIT 3`
  ).bind(staleBefore).all<{
    clip_id:string;owner:string;transcript:string;auto_attempts:number;
    streamer:string|null;source:string|null;reason:string|null;
  }>();

  for (const row of rows.results ?? []) {
    const claimedAt = new Date(now).toISOString();
    const claim = await db.prepare(
      `UPDATE clip_copy SET status='generating',auto_attempts=auto_attempts+1,updated_at=?
        WHERE clip_id=? AND owner=? AND auto_attempts < 3
          AND ((status='draft' AND hooks_json='[]')
            OR (status='generating' AND updated_at < ?))`
    ).bind(claimedAt,row.clip_id,row.owner,staleBefore).run();
    if (!claim.meta.changes) continue;

    try {
      const result = await generateCopy(env,{
        platform:"TikTok",tone:"curiosity",streamer:row.streamer,
        source:row.source,reason:row.reason,transcript:row.transcript,
      });
      await db.prepare(
        `UPDATE clip_copy
            SET hooks_json=?,captions_json=?,selected_hook=?,selected_caption=?,
                status='draft',updated_at=?
          WHERE clip_id=? AND owner=? AND status='generating'`
      ).bind(JSON.stringify(result.hooks),JSON.stringify(result.captions),
        result.hooks[0],result.captions[0],new Date().toISOString(),row.clip_id,row.owner).run();
    } catch (error) {
      const attempts = row.auto_attempts + 1;
      const status = attempts >= 3 ? "failed" : "draft";
      await db.prepare(
        `UPDATE clip_copy SET status=?,updated_at=?
          WHERE clip_id=? AND owner=? AND status='generating'`
      ).bind(status,new Date().toISOString(),row.clip_id,row.owner).run();
      console.error("Automatic AI copy generation failed for clip",row.clip_id,
        error instanceof Error ? error.message : "Unknown error");
    }
  }
}
