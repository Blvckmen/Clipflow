import { bucket, previewKey } from "../db/raw";
// A recording's stored preview (or its unfinished upload). The full-quality file is on the worker PC, which
// deletes it once the recording is gone from the dashboard.
export async function removeRecordingFiles(id: string, rec: { preview_key: string | null; upload_id: string | null }, store = bucket()) {
  if (!store) return;
  if (rec.upload_id) await store.resumeMultipartUpload(previewKey(id), rec.upload_id).abort().catch(() => {});
  await store.delete(rec.preview_key ?? previewKey(id));
}

// Deletes recordings past their workspace's retention period. Runs from the once-a-minute cron, a few at a time.
export async function expireRecordings(env: Cloudflare.Env, now = Date.now()) {
  if (!env.DB) return;
  const { results } = await env.DB.prepare("SELECT id,owner,preview_key,upload_id FROM recordings WHERE expires_at<? AND state!='recording' LIMIT 25").bind(new Date(now).toISOString()).all<{ id: string; owner: string; preview_key: string | null; upload_id: string | null }>();
  for (const rec of results) {
    await removeRecordingFiles(rec.id, rec, env.BUCKET ?? null);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM recording_requests WHERE recording_id=?").bind(rec.id),
      env.DB.prepare("DELETE FROM recordings WHERE id=?").bind(rec.id),
    ]);
  }
}
