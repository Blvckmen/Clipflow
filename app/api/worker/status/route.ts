import { z } from "zod";
import { database } from "../../../../db/raw";
import { workerOwner } from "../../../../lib/worker-auth";
const clipProgress=z.object({id:z.string().uuid(),streamer:z.string().uuid(),reason:z.string().max(20).nullable(),stage:z.enum(["waiting","held","transcribing","choosing","rendering","uploading","failed"]),since:z.string().datetime(),why:z.string().max(200).optional()});
const statusSchema=z.object({
 streamers:z.array(z.object({id:z.string().uuid(),status:z.enum(["live","recording","limit","offline","error"]),checkedAt:z.string().datetime(),title:z.string().max(200).nullish()})).max(500),
 // The worker's latest problem, e.g. a failed render or a refused upload.
 error:z.object({message:z.string().min(1).max(500),at:z.string().datetime()}).optional(),
 // About the PC itself (Settings → This PC): the settings fingerprint it runs with (lib/clipflow.ts workerSettingsRev),
 // what it is doing, the values it actually uses (dashboard choice, else its .env, else the default) and its size.
 device:z.object({
  applied:z.string().max(20).nullable(),
  recording:z.array(z.string().uuid()).max(20),making:z.number().int().min(0).max(50),waiting:z.number().int().min(0).max(10_000),held:z.number().int().min(0).max(10_000),
  uses:z.object({maxCaptures:z.number().int().min(1).max(20),clipWorkers:z.number().int().min(1).max(20),whisperModel:z.string().max(40),aiWriter:z.boolean(),retentionHours:z.number().min(0).max(100_000)}),
  cores:z.number().int().min(1).max(1024),memoryGb:z.number().min(0).max(100_000),
  // How long the oldest clip ready to be made has waited (minutes), whether a restart asked for from the dashboard is
  // waiting for the PC to be idle, and the health checks (worker/health.mjs; lib/pc-health.mjs reads them).
  oldestWaitMin:z.number().min(0).max(1_000_000).optional(),restartPending:z.boolean().optional(),
  // Each clip being made or about to be, for Clips → Being made (worker/core.mjs clipsInProgress). Checked one by one
  // below, so one odd entry is dropped instead of refusing the whole report.
  clips:z.array(z.unknown()).max(20).optional(),
  health:z.object({
   checkedAt:z.string().datetime(),diskFreeGb:z.number().min(0).nullable(),diskTotalGb:z.number().min(0).nullable(),
   ffmpeg:z.boolean(),streamlink:z.boolean(),whisper:z.boolean(),whisperModel:z.string().max(40),whisperReady:z.boolean().nullable(),
   ollama:z.enum(["off","down","ok"]),ollamaMissing:z.array(z.string().max(80)).max(5),codeChanged:z.boolean(),
  }).nullable().optional(),
 }).optional(),
});
export async function POST(request:Request){
 try{
  const db=database(),owner=await workerOwner(request,db);
  if(!owner)return Response.json({error:"Invalid worker token."},{status:401});
  let body;try{body=statusSchema.parse(await request.json());}catch{return Response.json({error:"Invalid status report."},{status:400});}
  // The owner predicate means ids belonging to someone else are silently ignored.
  const statements=body.streamers.map(s=>db.prepare("UPDATE streamers SET live_status=?,live_checked_at=?,live_title=? WHERE id=? AND owner=?").bind(s.status,s.checkedAt,s.title??null,s.id,owner));
  if(body.device?.clips)body.device.clips=body.device.clips.flatMap(c=>{const r=clipProgress.safeParse(c);return r.success?[r.data]:[];});
  if(body.device)statements.push(db.prepare("UPDATE worker_tokens SET device=?,device_at=? WHERE owner=?").bind(JSON.stringify(body.device),new Date().toISOString(),owner));
  if(body.error)statements.push(db.prepare("UPDATE worker_tokens SET last_error=?,last_error_at=? WHERE owner=?").bind(body.error.message,body.error.at,owner));
  if(statements.length)await db.batch(statements);
  return Response.json({ok:true,updated:body.streamers.length});
 }catch(error){console.error("Status report failed",error);return Response.json({error:"Status not saved."},{status:503});}
}
