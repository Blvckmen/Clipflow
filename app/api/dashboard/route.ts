import { currentUser, signInPath } from "../../auth";
import { bucket, database } from "../../../db/raw";
import { defaultCaption, defaults, parseStreamer, settingsSchema } from "../../../lib/clipflow";
import { instagramConfig } from "../../../lib/publisher";
import { connectionFor, connections, hashKey, listKeys, siteConnection, zernioApiUrl } from "../../../lib/zernio-keys";
import { deleteAccount, deletePost, verifyKey, VIDEO_PLATFORMS, ZernioError } from "../../../lib/zernio";
import { syncZernioAccounts } from "../../../lib/zernio-sync";
import { optionsSchema, readOptions } from "../../../lib/account-options";
import { encrypt } from "../../../lib/secure";
import { normalizeStyle } from "../../../worker/edit.mjs";
import { socialCaptionsAvailable } from "../../../lib/social-caption";
import { aiCaptionsAvailable } from "../../../lib/post-caption";
import { removeRecordingFiles } from "../../../lib/recordings";
import { thumbOf } from "../../../lib/thumbs";
import { env } from "cloudflare:workers";
import { hashToken, newToken } from "../../../lib/worker-auth";
import { z } from "zod";
const accountIds=z.array(z.string().uuid()).max(50).transform(x=>[...new Set(x)]);
const clipIds=z.array(z.string().uuid()).min(1).max(200).transform(x=>[...new Set(x)]);
const captureMode=z.enum(["clip","record","both"]);
// A streamer's publishing mode: review first, post directly, or the workspace's ("workspace" is stored as null).
const publishMode=z.enum(["workspace","review","automatic"]);
// A streamer's own transcription, subtitles and automatic hook: true or false, or left out to follow the workspace.
const clipTextInput=z.object({transcribe:z.boolean().optional(),subtitles:z.boolean().optional(),hook:z.boolean().optional()}).strict();
const storedMode=(m:z.infer<typeof publishMode>|undefined)=>m===undefined||m==="workspace"?null:m;
const actionSchema=z.discriminatedUnion("action",[
 z.object({action:z.literal("add"),url:z.string().max(500),name:z.string().trim().max(80).optional(),accounts:accountIds.optional(),captureMode:captureMode.optional(),publishMode:publishMode.optional()}),
 z.object({action:z.literal("status"),id:z.string().uuid(),status:z.enum(["armed","paused","stopped"])}),
 z.object({action:z.literal("remove"),id:z.string().uuid()}),
 z.object({action:z.literal("settings"),settings:settingsSchema}),
 z.object({action:z.literal("control"),control:z.enum(["running","paused","stopped"])}),
 z.object({action:z.literal("token")}),
 z.object({action:z.literal("deleteClip"),id:z.string().uuid()}),
 z.object({action:z.literal("reviewClip"),id:z.string().uuid(),review:z.enum(["approved","rejected","pending"])}),
 // `platform` is the pre-multi-account form: it disconnects that platform's only account.
 z.object({action:z.literal("disconnect"),id:z.string().uuid().optional(),platform:z.enum(["instagram"]).optional()}),
 z.object({action:z.literal("retryPost"),id:z.string().min(1).max(64)}),
 // Posts held for review (their account had reached its daily limit): queue them to post when there's room, or skip them.
 z.object({action:z.literal("reviewPosts"),ids:z.array(z.string().min(1).max(64)).min(1).max(200).transform(x=>[...new Set(x)]),op:z.enum(["queue","skip"])}),
 // The owner posted a clip themselves (e.g. in the TikTok app): record it, so it isn't also posted there automatically.
 z.object({action:z.literal("markPosted"),id:z.string().uuid(),accountId:z.string().uuid()}),
 // Posts a clip's current version to the chosen accounts now: its first post, or again after an edit.
 // draft: send to the accounts' TikTok drafts (to finish in the app) instead of publishing; TikTok accounts only.
 z.object({action:z.literal("postClip"),id:z.string().uuid(),accounts:z.array(z.string().uuid()).min(1).max(50).transform(x=>[...new Set(x)]),draft:z.boolean().optional()}),
 // Bulk actions on clips picked in the library: post them all to the chosen accounts, or review, edit or delete them.
 z.object({action:z.literal("postClips"),ids:clipIds,accounts:z.array(z.string().uuid()).min(1).max(50).transform(x=>[...new Set(x)]),draft:z.boolean().optional()}),
 z.object({action:z.literal("bulkClips"),ids:clipIds,op:z.enum(["approve","reject","pending","delete","captionsOn","captionsOff","frame"]),frame:z.enum(["blur","crop","fit","split","phone"]).optional()}),
 // Removes a split-screen background video from the library (clips using it switch to another one).
 z.object({action:z.literal("deleteBackground"),id:z.string().uuid()}),
 // A library video's length, measured in the browser for videos uploaded before lengths were recorded.
 z.object({action:z.literal("backgroundLength"),id:z.string().uuid(),duration:z.number().positive().max(36000)}),
 // Re-reads the accounts under every Zernio key of the workspace (new ones added, removed ones marked).
 z.object({action:z.literal("syncZernio")}),
 // Turns subtitles off (or on) in every editable clip's edit and queues a re-render. "unposted" leaves clips that
 // are already published somewhere alone, since the posted videos can't change.
 z.object({action:z.literal("captionsAll"),on:z.boolean(),scope:z.enum(["unposted","all"]).default("unposted")}),
 // Adds one more Zernio API key (a separate Zernio account). It is checked with Zernio before it is saved.
 z.object({action:z.literal("addZernioKey"),key:z.string().trim().min(10).max(300)}),
 // Removes a key and the accounts connected under it from Clipflow (they stay connected on Zernio).
 z.object({action:z.literal("removeZernioKey"),id:z.string().min(1).max(80)}),
 // Posting options for one account (TikTok mode and privacy, YouTube visibility).
 z.object({action:z.literal("accountOptions"),id:z.string().uuid(),options:optionsSchema}),
 // Recording priority: every streamer's id, first recorded first.
 z.object({action:z.literal("priority"),ids:z.array(z.string().uuid()).min(1).max(500)}),
 z.object({action:z.literal("assign"),streamerId:z.string().uuid(),accounts:accountIds}),
 z.object({action:z.literal("assignAccount"),accountId:z.string().uuid(),streamers:z.array(z.string().uuid()).max(500).transform(x=>[...new Set(x)])}),
 // Edits a streamer: display name, channel URL, whether it is clipped, and (optionally) which accounts post its clips.
 z.object({action:z.literal("editStreamer"),id:z.string().uuid(),name:z.string().trim().min(1).max(80),url:z.string().max(500),status:z.enum(["armed","paused","stopped"]).optional(),accounts:accountIds.optional(),captureMode:captureMode.optional(),publishMode:publishMode.optional(),clipText:clipTextInput.optional()}),
 // Clips from a whole-stream recording: one moment picked in the player (seconds into it), or the best few.
 z.object({action:z.literal("makeClip"),recordingId:z.string().uuid(),start:z.number().int().min(0),end:z.number().int().min(1)}),
 z.object({action:z.literal("findMoments"),recordingId:z.string().uuid(),count:z.number().int().min(1).max(20)}),
 z.object({action:z.literal("deleteRecording"),id:z.string().uuid()}),
 // A streamer's own clip look, or the workspace's (no streamerId). A null style goes back to the default.
 z.object({action:z.literal("style"),streamerId:z.string().uuid().optional(),style:z.unknown().nullable()}),
]);
const ENGINE_FRESH_MS=5*60_000;
const parse=(json:unknown)=>{try{return typeof json==="string"?JSON.parse(json):null;}catch{return null;}};
export async function GET(){
 const user=await currentUser();if(!user)return Response.json({error:"Sign in to open your dashboard.",signIn:signInPath()},{status:401});
 try{
  const db=database(),owner=user.userId;
  const [a,po,l]=await Promise.all([
   // Tokens never leave the server: only display fields are selected.
   db.prepare("SELECT id,provider,platform,username,status,connected_at,last_error,options,zernio_key_id FROM accounts WHERE owner=? ORDER BY connected_at").bind(owner).all<Record<string,unknown>&{options:string|null}>(),
   db.prepare("SELECT p.id,p.clip_id,p.platform,p.account_id,p.state,p.permalink,p.error,p.attempts,p.created_at,p.published_at,p.round,p.views,p.likes,p.draft,s.name AS streamer,a.username AS account FROM posts p LEFT JOIN clips c ON c.id=p.clip_id LEFT JOIN streamers s ON s.id=c.streamer_id AND s.owner=c.owner LEFT JOIN accounts a ON a.id=p.account_id WHERE p.owner=? ORDER BY p.created_at DESC LIMIT 100").bind(owner).all(),
   db.prepare("SELECT streamer_id,account_id FROM streamer_accounts WHERE owner=?").bind(owner).all<{streamer_id:string;account_id:string}>(),
  ]);
  const [s,p,e,c,w]=await Promise.all([db.prepare("SELECT * FROM streamers WHERE owner=? ORDER BY created_at DESC").bind(owner).all<Record<string,unknown>>(),db.prepare("SELECT * FROM preferences WHERE owner=?").bind(owner).first(),db.prepare("SELECT id,message,created_at FROM events WHERE owner=? ORDER BY created_at DESC LIMIT 30").bind(owner).all(),db.prepare("SELECT c.id,c.streamer_id,c.created_at,c.duration,c.captions,c.size,c.file_key IS NOT NULL AS stored,c.review,c.reason,(c.edit IS NOT NULL OR c.file_key IS NOT NULL) AS editable,c.edit IS NULL AS legacy,c.post_caption,c.caption_source,c.source_key IS NOT NULL AS source_stored,c.render_state,c.render_error,c.rendered_at,c.edit_rev,c.thumb_rev,s.name AS streamer,(SELECT json_group_object(p.account_id,p.state) FROM posts p WHERE p.clip_id=c.id AND p.round=(SELECT MAX(q.round) FROM posts q WHERE q.clip_id=p.clip_id AND q.account_id=p.account_id)) AS targets FROM clips c LEFT JOIN streamers s ON s.id=c.streamer_id AND s.owner=c.owner WHERE c.owner=? ORDER BY c.created_at DESC LIMIT 200").bind(owner).all<Record<string,unknown>>(),db.prepare("SELECT created_at,last_seen,last_error,last_error_at FROM worker_tokens WHERE owner=?").bind(owner).first<{created_at:string;last_seen:string|null;last_error:string|null;last_error_at:string|null}>()]);
  const lastSeen=w?.last_seen??null,connected=!!lastSeen&&Date.now()-Date.parse(lastSeen)<ENGINE_FRESH_MS;
  const engine={connected,lastSeen,tokenCreated:w?.created_at??null,lastError:w?.last_error??null,lastErrorAt:w?.last_error_at??null,status:connected?"Worker connected":w?(lastSeen?"Worker offline":"Waiting for worker"):"Setup required"};
  const streamers=s.results.map(x=>({...x,style:parse(x.style),accounts:l.results.filter(k=>k.streamer_id===x.id).map(k=>k.account_id)}));
  // Stored Zernio keys never leave the server: only their labels and how many accounts each holds.
  const prefs=Object.fromEntries(Object.entries((p??{}) as Record<string,unknown>).filter(([k])=>k!=="zernio_key_enc"&&k!=="zernio_label"));
  const keys=(await listKeys(db,owner)).map(k=>({id:k.id,label:k.label,created_at:k.created_at,last_error:k.last_error,accounts:a.results.filter(x=>x.zernio_key_id===k.id).length}));
  const site=!keys.length&&!!siteConnection(env);
  const settings=p?{...prefs,dailyLimit:p.daily_limit,captions:!!p.captions,destinations:JSON.parse(String(p.destinations)),captionTemplate:p.caption_template,aiCaptions:!!p.ai_captions,captionNotes:p.caption_notes,transcribe:p.transcribe===undefined?true:!!p.transcribe,importClips:Number(p.import_clips??0),style:parse(p.style)}:{...defaults,style:null};
  return Response.json({user:user.displayName,streamers,settings,events:e.results,engine,accounts:a.results.map(({options,...x})=>({...x,options:readOptions(options)})),posts:po.results,publishing:{instagram:!!instagramConfig(env),zernio:keys.length>0||site,zernioSource:keys.length?"workspace":site?"site":null,zernioKeys:keys,canSaveKey:!!env.TOKEN_KEY,ai:aiCaptionsAvailable(env),socialCaptions:socialCaptionsAvailable(env)},clips:c.results.map(x=>({...x,targets:parse(x.targets)??{},captions:!!x.captions,stored:!!x.stored,editable:!!x.editable,legacy:!!x.legacy,source_stored:!!x.source_stored})),storage:!!bucket(),backgrounds:(await db.prepare("SELECT id,name,size,duration,content_type,created_at FROM backgrounds WHERE owner=? ORDER BY created_at").bind(owner).all()).results,
   // Whole-stream recordings (their heat strips load with GET /api/recordings/<id>) and clips asked for from them.
   recordings:(await db.prepare("SELECT r.id,r.streamer_id,s.name AS streamer,r.title,r.started_at,r.ended_at,r.duration,r.size,r.state,r.error,r.preview_key IS NOT NULL AS preview,r.upload_id IS NOT NULL AS uploading,r.expires_at FROM recordings r LEFT JOIN streamers s ON s.id=r.streamer_id AND s.owner=r.owner WHERE r.owner=? ORDER BY r.started_at DESC LIMIT 100").bind(owner).all<Record<string,unknown>>()).results.map(x=>({...x,preview:!!x.preview,uploading:!!x.uploading})),
   recordingRequests:(await db.prepare("SELECT id,recording_id,kind,start,end,count,state,error,clips,created_at,updated_at FROM recording_requests WHERE owner=? ORDER BY created_at DESC LIMIT 200").bind(owner).all()).results,
  },{headers:{"Cache-Control":"private, no-store"}});
 }catch(error){console.error("Dashboard load failed",error);return Response.json({error:"We couldn't load your workspace. Please retry."},{status:503});}
}
export async function POST(request:Request){
 const user=await currentUser();if(!user)return Response.json({error:"Sign in before making changes.",signIn:signInPath()},{status:401});
 const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return Response.json({error:"Request origin rejected."},{status:403});
 let payload;try{payload=actionSchema.parse(await request.json());}catch{return Response.json({error:"Check your settings and try again."},{status:400});}
 try{
  const db=database(),owner=user.userId,iso=new Date().toISOString();let message="";const statements:D1PreparedStatement[]=[];
  // Only the owner's own accounts can be linked; unknown ids are refused rather than ignored.
  const ownAccounts=async(ids:string[])=>{
   if(!ids.length)return [] as {id:string;username:string}[];
   const {results}=await db.prepare("SELECT id,username FROM accounts WHERE owner=? AND id IN ("+ids.map(()=>"?").join(",")+")").bind(owner,...ids).all<{id:string;username:string}>();
   return results.length===ids.length?results:null;
  };
  let streamerId:string|undefined;
  if(payload.action==="add"){
   let channel;try{channel=parseStreamer(payload.url);}catch(error){return Response.json({error:(error as Error).message},{status:400});}
   const linked=await ownAccounts(payload.accounts??[]);
   if(!linked)return Response.json({error:"One of those publishing accounts is no longer connected."},{status:404});
   const name=payload.name||channel.name;streamerId=crypto.randomUUID();
   statements.push(db.prepare("INSERT INTO streamers (id,owner,name,url,platform,status,created_at,capture_mode,publish_mode) VALUES (?,?,?,?,?,'armed',?,?,?)").bind(streamerId,owner,name,channel.url,channel.platform,iso,payload.captureMode??"clip",storedMode(payload.publishMode)));
   for(const a of linked)statements.push(db.prepare("INSERT INTO streamer_accounts (streamer_id,account_id,owner,created_at) VALUES (?,?,?,?)").bind(streamerId,a.id,owner,iso));
   // Adding a streamer means "start clipping them": automation is switched on for the workspace.
   statements.push(db.prepare("INSERT INTO preferences (owner,control) VALUES (?,'running') ON CONFLICT(owner) DO UPDATE SET control='running'").bind(owner));
   message="Added "+name+" from "+channel.platform+". "+(payload.captureMode==="record"?"Their whole stream is recorded as soon as they go live, and clipped when it ends":payload.captureMode==="both"?"Clipping and recording start as soon as they go live":"Clipping starts as soon as they go live")+(linked.length?" and clips post to "+linked.map(a=>"@"+a.username).join(", ")+".":".");
  }
  if(payload.action==="status"||payload.action==="remove"){
   const streamer=await db.prepare("SELECT name FROM streamers WHERE id=? AND owner=?").bind(payload.id,owner).first();
   if(!streamer)return Response.json({error:"Streamer not found."},{status:404});
   if(payload.action==="remove")statements.push(db.prepare("DELETE FROM streamer_accounts WHERE streamer_id=? AND owner=?").bind(payload.id,owner),db.prepare("DELETE FROM streamers WHERE id=? AND owner=?").bind(payload.id,owner));
   else statements.push(db.prepare("UPDATE streamers SET status=? WHERE id=? AND owner=?").bind(payload.status,payload.id,owner));
   message=payload.action==="remove"?"Removed "+streamer.name+".":streamer.name+": "+(payload.status==="armed"?"enabled; waiting for connection":payload.status)+".";
  }
  if(payload.action==="priority"){
   const {results:all}=await db.prepare("SELECT id,name FROM streamers WHERE owner=?").bind(owner).all<{id:string;name:string}>();
   const ids=payload.ids,known=new Set(all.map(s=>s.id));
   // The whole list, each streamer once: a list from before a streamer was added or removed is refused.
   if(new Set(ids).size!==ids.length||ids.length!==all.length||ids.some(id=>!known.has(id)))return Response.json({error:"Your streamer list changed. Refresh and set the order again."},{status:409});
   ids.forEach((id,i)=>statements.push(db.prepare("UPDATE streamers SET priority=? WHERE id=? AND owner=?").bind(i+1,id,owner)));
   message="Recording priority saved: "+ids.slice(0,3).map(id=>all.find(s=>s.id===id)!.name).join(", ")+(ids.length>3?" and "+(ids.length-3)+" more":"")+" first.";
  }
  if(payload.action==="assign"){
   const streamer=await db.prepare("SELECT name FROM streamers WHERE id=? AND owner=?").bind(payload.streamerId,owner).first<{name:string}>();
   if(!streamer)return Response.json({error:"Streamer not found."},{status:404});
   const linked=await ownAccounts(payload.accounts);
   if(!linked)return Response.json({error:"One of those publishing accounts is no longer connected."},{status:404});
   const keep=payload.accounts;
   // Existing links keep their creation time, so already-eligible clips stay eligible.
   statements.push(keep.length?db.prepare("DELETE FROM streamer_accounts WHERE streamer_id=? AND owner=? AND account_id NOT IN ("+keep.map(()=>"?").join(",")+")").bind(payload.streamerId,owner,...keep):db.prepare("DELETE FROM streamer_accounts WHERE streamer_id=? AND owner=?").bind(payload.streamerId,owner));
   for(const a of linked)statements.push(db.prepare("INSERT OR IGNORE INTO streamer_accounts (streamer_id,account_id,owner,created_at) VALUES (?,?,?,?)").bind(payload.streamerId,a.id,owner,iso));
   message=streamer.name+(linked.length?"'s clips now post to "+linked.map(a=>"@"+a.username).join(", ")+".":"'s clips are kept in the library and not posted.");
  }
  // The same links seen from the account: which streamers' clips post to this one account.
  if(payload.action==="assignAccount"){
   const account=(await ownAccounts([payload.accountId]))?.[0];
   if(!account)return Response.json({error:"That publishing account is no longer connected."},{status:404});
   const keep=payload.streamers;
   const {results:found}=keep.length?await db.prepare("SELECT id,name FROM streamers WHERE owner=? AND id IN ("+keep.map(()=>"?").join(",")+")").bind(owner,...keep).all<{id:string;name:string}>():{results:[] as {id:string;name:string}[]};
   if(found.length!==keep.length)return Response.json({error:"One of those streamers was removed. Refresh and try again."},{status:404});
   // Existing links keep their creation time, so already-eligible clips stay eligible.
   statements.push(keep.length?db.prepare("DELETE FROM streamer_accounts WHERE account_id=? AND owner=? AND streamer_id NOT IN ("+keep.map(()=>"?").join(",")+")").bind(account.id,owner,...keep):db.prepare("DELETE FROM streamer_accounts WHERE account_id=? AND owner=?").bind(account.id,owner));
   for(const s of found)statements.push(db.prepare("INSERT OR IGNORE INTO streamer_accounts (streamer_id,account_id,owner,created_at) VALUES (?,?,?,?)").bind(s.id,account.id,owner,iso));
   message="@"+account.username+(found.length?" now posts clips from "+found.map(s=>s.name).join(", ")+".":" no longer posts any streamer's clips.");
  }
  if(payload.action==="editStreamer"){
   const current=await db.prepare("SELECT name,url,status,capture_mode,publish_mode,clip_text FROM streamers WHERE id=? AND owner=?").bind(payload.id,owner).first<{name:string;url:string;status:string;capture_mode:string;publish_mode:string|null;clip_text:string|null}>();
   if(!current)return Response.json({error:"Streamer not found."},{status:404});
   let channel;try{channel=parseStreamer(payload.url);}catch(error){return Response.json({error:(error as Error).message},{status:400});}
   const moved=channel.url!==current.url;
   // A new channel starts with a fresh live status; the worker checks it on its next cycle.
   // A new capture mode applies from the streamer's next stream (one being recorded now carries on as it began).
   // A new publishing mode applies to clips that arrive from now on; clips already waiting keep their state.
   const mode=payload.publishMode===undefined?current.publish_mode:storedMode(payload.publishMode);
   // Transcription, subtitles and hook choices apply to clips captured from now on; nothing chosen stores null.
   const text=payload.clipText===undefined?current.clip_text:Object.keys(payload.clipText).length?JSON.stringify(payload.clipText):null;
   statements.push(db.prepare("UPDATE streamers SET name=?,url=?,platform=?,status=?,capture_mode=?,publish_mode=?,clip_text=?"+(moved?",live_status=NULL,live_checked_at=NULL,live_title=NULL":"")+" WHERE id=? AND owner=?").bind(payload.name,channel.url,channel.platform,payload.status??current.status,payload.captureMode??current.capture_mode,mode,text,payload.id,owner));
   if(payload.accounts){
    const linked=await ownAccounts(payload.accounts);
    if(!linked)return Response.json({error:"One of those publishing accounts is no longer connected."},{status:404});
    const keep=payload.accounts;
    // Existing links keep their creation time, so already-eligible clips stay eligible.
    statements.push(keep.length?db.prepare("DELETE FROM streamer_accounts WHERE streamer_id=? AND owner=? AND account_id NOT IN ("+keep.map(()=>"?").join(",")+")").bind(payload.id,owner,...keep):db.prepare("DELETE FROM streamer_accounts WHERE streamer_id=? AND owner=?").bind(payload.id,owner));
    for(const a of linked)statements.push(db.prepare("INSERT OR IGNORE INTO streamer_accounts (streamer_id,account_id,owner,created_at) VALUES (?,?,?,?)").bind(payload.id,a.id,owner,iso));
   }
   const changes=[payload.name!==current.name&&"renamed to "+payload.name,moved&&"now follows "+channel.url,payload.captureMode&&payload.captureMode!==current.capture_mode&&{clip:"clipped live",record:"recorded whole and clipped afterwards",both:"clipped live and recorded whole"}[payload.captureMode]+" from the next stream",payload.status&&payload.status!==current.status&&(payload.status==="armed"?"enabled":payload.status)].filter(Boolean);
   message="Saved "+current.name+(changes.length?": "+changes.join(", "):"")+".";
  }
  if(payload.action==="style"){
   let style=null;
   if(payload.style!==null){try{style=normalizeStyle(payload.style);}catch(error){return Response.json({error:(error as Error).message+"."},{status:400});}}
   const json=style?JSON.stringify(style):null;
   if(payload.streamerId){
    const streamer=await db.prepare("SELECT name FROM streamers WHERE id=? AND owner=?").bind(payload.streamerId,owner).first<{name:string}>();
    if(!streamer)return Response.json({error:"Streamer not found."},{status:404});
    statements.push(db.prepare("UPDATE streamers SET style=? WHERE id=? AND owner=?").bind(json,payload.streamerId,owner));
    message=style?"Saved this look for "+streamer.name+"'s new clips.":streamer.name+"'s new clips use the workspace look again.";
   }else{
    statements.push(db.prepare("INSERT INTO preferences (owner,style) VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET style=excluded.style").bind(owner,json));
    message=style?"Saved this look as the workspace default.":"The workspace look is back to the built-in default.";
   }
  }
  if(payload.action==="settings"){
   const s=payload.settings;
   // A client that omits captionTemplate, aiCaptions or captionNotes keeps the saved values.
   const ai=s.aiCaptions===undefined?null:Number(s.aiCaptions),notes=s.captionNotes??null,transcribe=s.transcribe===undefined?null:Number(s.transcribe);
   statements.push(db.prepare("INSERT INTO preferences (owner,mode,duration,daily_limit,captions,framing,destinations,control,caption_template,ai_captions,caption_notes,transcribe) VALUES (?,?,?,?,?,?,?,'paused',?,?,?,?) ON CONFLICT(owner) DO UPDATE SET mode=excluded.mode,duration=excluded.duration,daily_limit=excluded.daily_limit,captions=excluded.captions,framing=excluded.framing,destinations=excluded.destinations,caption_template=coalesce(?,preferences.caption_template),ai_captions=coalesce(?,preferences.ai_captions),caption_notes=coalesce(?,preferences.caption_notes),transcribe=coalesce(?,preferences.transcribe)").bind(owner,s.mode,s.duration,s.dailyLimit,Number(s.captions),s.framing,JSON.stringify(s.destinations),s.captionTemplate??defaultCaption,ai??1,notes??"",transcribe??1,s.captionTemplate??null,ai,notes,transcribe));
   if(s.recordingDays!==undefined)statements.push(db.prepare("UPDATE preferences SET recording_days=? WHERE owner=?").bind(s.recordingDays,owner));
   if(s.importClips!==undefined)statements.push(db.prepare("UPDATE preferences SET import_clips=? WHERE owner=?").bind(s.importClips,owner));
   message="Saved clipping and publishing preferences.";
  }
  if(payload.action==="control"){
   statements.push(db.prepare("INSERT INTO preferences (owner,control) VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET control=excluded.control").bind(owner,payload.control));
   message=payload.control==="running"?"Global automation resumed.":payload.control==="paused"?"Global automation paused.":"Global automation stopped.";
  }
  // Deleting clips also drops their posts that haven't gone out, and cancels any Zernio is still holding (e.g. for
  // TikTok's daily limit), so a deleted clip never posts. Published posts stay as history.
  const dropUnsent=async(ids:string[])=>{
   const {results:held}=await db.prepare("SELECT p.container_id,a.provider,a.zernio_key_id FROM posts p JOIN accounts a ON a.id=p.account_id WHERE p.owner=? AND p.state='processing' AND p.container_id IS NOT NULL AND p.clip_id IN (SELECT value FROM json_each(?))").bind(owner,JSON.stringify(ids)).all<{container_id:string;provider:string;zernio_key_id:string|null}>();
   for(const h of held.filter(h=>h.provider==="zernio")){
    try{const config=await connectionFor(env,db,owner,h.zernio_key_id);if(config)await deletePost(config,h.container_id);}
    catch(error){console.error("Zernio post cancel failed",error);}
   }
   statements.push(db.prepare("DELETE FROM posts WHERE owner=? AND state!='published' AND clip_id IN (SELECT value FROM json_each(?))").bind(owner,JSON.stringify(ids)));
  };
  if(payload.action==="deleteClip"){
   const clip=await db.prepare("SELECT c.id,c.file_key,c.source_key,c.thumb_rev,s.name FROM clips c LEFT JOIN streamers s ON s.id=c.streamer_id AND s.owner=c.owner WHERE c.id=? AND c.owner=?").bind(payload.id,owner).first<{id:string;file_key:string|null;source_key:string|null;thumb_rev:number|null;name:string|null}>();
   if(!clip)return Response.json({error:"Clip not found."},{status:404});
   // Remove the stored files first: a leftover row is visible and retryable, an orphaned object is not.
   const keys=[clip.file_key,clip.source_key,thumbOf(owner,clip)].filter((k):k is string=>!!k);
   if(keys.length)await bucket()?.delete(keys);
   await dropUnsent([payload.id]);
   statements.push(db.prepare("DELETE FROM clips WHERE id=? AND owner=?").bind(payload.id,owner));
   message="Deleted a clip"+(clip.name?" from "+clip.name:"")+".";
  }
  if(payload.action==="reviewClip"){
   const clip=await db.prepare("SELECT s.name FROM clips c LEFT JOIN streamers s ON s.id=c.streamer_id AND s.owner=c.owner WHERE c.id=? AND c.owner=?").bind(payload.id,owner).first<{name:string|null}>();
   if(!clip)return Response.json({error:"Clip not found."},{status:404});
   // Reviews are frequent, so they update the clip without adding to the activity log.
   await db.prepare("UPDATE clips SET review=?,reviewed_at=? WHERE id=? AND owner=?").bind(payload.review,payload.review==="pending"?null:iso,payload.id,owner).run();
   return Response.json({ok:true,message:{approved:"Clip approved.",rejected:"Clip rejected.",pending:"Clip moved back to review."}[payload.review]});
  }
  if(payload.action==="disconnect"){
   type Row={id:string;username:string;provider:string;platform:string;external_id:string;zernio_key_id:string|null};
   const account=payload.id
    ?await db.prepare("SELECT id,username,provider,platform,external_id,zernio_key_id FROM accounts WHERE owner=? AND id=?").bind(owner,payload.id).first<Row>()
    :payload.platform?await db.prepare("SELECT id,username,provider,platform,external_id,zernio_key_id FROM accounts WHERE owner=? AND platform=? ORDER BY connected_at LIMIT 1").bind(owner,payload.platform).first<Row>():null;
   if(!account)return Response.json({error:"That account is not connected."},{status:404});
   // A Zernio account is disconnected on Zernio too, so it doesn't come back on the next sync.
   if(account.provider==="zernio"){
    const config=await connectionFor(env,db,owner,account.zernio_key_id).catch(()=>null),external=account.external_id;
    // A refused key can't disconnect anything; the account is still removed here.
    if(config){try{await deleteAccount(config,external);}catch(error){if(!(error instanceof ZernioError&&error.keyInvalid)){console.error("Zernio disconnect failed",error);return Response.json({error:"Couldn't disconnect it on Zernio. Please try again."},{status:502});}}}
   }
   // Posts not yet sent are dropped with the account; published history is kept.
   statements.push(db.prepare("DELETE FROM posts WHERE account_id=? AND state IN ('queued','processing','failed','review','skipped')").bind(account.id),db.prepare("DELETE FROM streamer_accounts WHERE account_id=?").bind(account.id),db.prepare("DELETE FROM accounts WHERE id=?").bind(account.id));
   message=account.provider==="zernio"
    ?"Disconnected "+(VIDEO_PLATFORMS[account.platform]??account.platform)+" account @"+account.username+"."
    :"Disconnected Instagram account @"+account.username+". Remove Clipflow under Instagram settings → Apps and websites to revoke its access fully.";
  }
  if(payload.action==="postClip"){
   const clip=await db.prepare("SELECT c.id,c.review,c.file_key,c.render_state,s.name FROM clips c LEFT JOIN streamers s ON s.id=c.streamer_id AND s.owner=c.owner WHERE c.id=? AND c.owner=?").bind(payload.id,owner).first<{id:string;review:string;file_key:string|null;render_state:string|null;name:string|null}>();
   if(!clip)return Response.json({error:"Clip not found."},{status:404});
   if(!clip.file_key)return Response.json({error:"This clip's video isn't uploaded yet, so it can't be posted."},{status:409});
   const {results:chosen}=await db.prepare("SELECT id,username,platform,status FROM accounts WHERE owner=? AND id IN ("+payload.accounts.map(()=>"?").join(",")+")").bind(owner,...payload.accounts).all<{id:string;username:string;platform:string;status:string}>();
   if(chosen.length!==payload.accounts.length)return Response.json({error:"One of those accounts is no longer connected."},{status:404});
   // Only TikTok has an app drafts inbox; drafts skip the other accounts.
   const asDraft=!!payload.draft,skippedNoDrafts=asDraft?chosen.filter(a=>a.platform!=="tiktok").map(a=>(VIDEO_PLATFORMS[a.platform]??a.platform)+" @"+a.username):[];
   if(asDraft){chosen.splice(0,chosen.length,...chosen.filter(a=>a.platform==="tiktok"));if(!chosen.length)return Response.json({error:"Drafts are a TikTok feature: tick a TikTok account."},{status:400});}
   const {results:existing}=await db.prepare("SELECT id,account_id,state,round FROM posts WHERE clip_id=? AND owner=?").bind(clip.id,owner).all<{id:string;account_id:string;state:string;round:number}>();
   const label=(a:{username:string;platform:string})=>(VIDEO_PLATFORMS[a.platform]??a.platform)+" @"+a.username;
   const queued:string[]=[],busyNow:string[]=[],offline:string[]=[];
   for(const a of chosen){
    if(a.status!=="connected"){offline.push(label(a));continue;}
    const mine=existing.filter(p=>p.account_id===a.id);
    // One unfinished post per clip and account at a time.
    if(mine.some(p=>p.state==="queued"||p.state==="processing")){busyNow.push(label(a));continue;}
    // Held for review: posting it by hand queues that same post.
    const held=mine.find(p=>p.state==="review");
    if(held){statements.push(db.prepare("UPDATE posts SET state='queued',queued_by_hand=1,draft=?,error=NULL,next_attempt_at=?,updated_at=? WHERE id=?").bind(Number(asDraft),iso,iso,held.id));queued.push(label(a));continue;}
    const round=mine.length?Math.max(...mine.map(p=>p.round))+1:0;
    statements.push(db.prepare("INSERT INTO posts (id,owner,clip_id,platform,account_id,state,next_attempt_at,created_at,updated_at,round,draft,queued_by_hand) VALUES (lower(hex(randomblob(16))),?,?,?,?,'queued',?,?,?,?,?,1)").bind(owner,clip.id,a.platform,a.id,iso,iso,iso,round,Number(asDraft)));
    queued.push(label(a)+(round?" (again)":""));
   }
   if(!queued.length)return Response.json({error:[busyNow.length?"Already on its way to "+busyNow.join(", ")+".":"",offline.length?"Reconnect "+offline.join(", ")+" first.":""].filter(Boolean).join(" ")},{status:409});
   // Posting a clip by hand approves it.
   if(clip.review!=="approved")statements.push(db.prepare("UPDATE clips SET review='approved',reviewed_at=? WHERE id=? AND owner=?").bind(iso,clip.id,owner));
   message=(asDraft?"Saving "+(clip.name?clip.name+"'s clip":"the clip")+" to the TikTok drafts of ":"Posting "+(clip.name?clip.name+"'s clip":"the clip")+" to ")+queued.join(", ")+(clip.render_state==="queued"?" once the edit has finished rendering":"")+"."
    +(asDraft?" Finish it in the TikTok app.":"")+(busyNow.length?" Already on its way to "+busyNow.join(", ")+".":"")+(offline.length?" Skipped "+offline.join(", ")+" (reconnect needed).":"")+(skippedNoDrafts.length?" "+skippedNoDrafts.join(", ")+" skipped: drafts are TikTok only.":"");
  }
  // Clip id lists go in as one JSON value (json_each): D1 allows at most 100 bound values per query.
  if(payload.action==="postClips"){
   const marks="SELECT value FROM json_each(?)",idList=JSON.stringify(payload.ids);
   const {results:clips}=await db.prepare("SELECT id,review,file_key FROM clips WHERE owner=? AND id IN ("+marks+")").bind(owner,idList).all<{id:string;review:string;file_key:string|null}>();
   const {results:chosen}=await db.prepare("SELECT id,username,platform,status FROM accounts WHERE owner=? AND id IN ("+payload.accounts.map(()=>"?").join(",")+")").bind(owner,...payload.accounts).all<{id:string;username:string;platform:string;status:string}>();
   if(chosen.length!==payload.accounts.length)return Response.json({error:"One of those accounts is no longer connected."},{status:404});
   const asDraft=!!payload.draft,live=chosen.filter(a=>a.status==="connected"&&(!asDraft||a.platform==="tiktok"));
   if(!live.length)return Response.json({error:asDraft?"Drafts are a TikTok feature: tick a connected TikTok account.":"Reconnect those accounts first."},{status:asDraft?400:409});
   const {results:existing}=await db.prepare("SELECT id,clip_id,account_id,state,round FROM posts WHERE owner=? AND clip_id IN ("+marks+")").bind(owner,idList).all<{id:string;clip_id:string;account_id:string;state:string;round:number}>();
   let posts=0,clipsPosted=0,busyNow=0;const notUploaded=payload.ids.length-clips.filter(c=>c.file_key).length;
   for(const clip of clips){
    if(!clip.file_key)continue;
    let any=false;
    for(const a of live){
     const mine=existing.filter(p=>p.clip_id===clip.id&&p.account_id===a.id);
     if(mine.some(p=>p.state==="queued"||p.state==="processing")){busyNow++;continue;}
     const held=mine.find(p=>p.state==="review");
     if(held){statements.push(db.prepare("UPDATE posts SET state='queued',queued_by_hand=1,error=NULL,next_attempt_at=?,updated_at=? WHERE id=?").bind(iso,iso,held.id));posts++;any=true;continue;}
     const round=mine.length?Math.max(...mine.map(p=>p.round))+1:0;
     statements.push(db.prepare("INSERT INTO posts (id,owner,clip_id,platform,account_id,state,next_attempt_at,created_at,updated_at,round,draft,queued_by_hand) VALUES (lower(hex(randomblob(16))),?,?,?,?,'queued',?,?,?,?,?,1)").bind(owner,clip.id,a.platform,a.id,iso,iso,iso,round,Number(asDraft)));
     posts++;any=true;
    }
    if(any){clipsPosted++;if(clip.review!=="approved")statements.push(db.prepare("UPDATE clips SET review='approved',reviewed_at=? WHERE id=? AND owner=?").bind(iso,clip.id,owner));}
   }
   if(!posts)return Response.json({error:busyNow?"Those clips are already on their way to those accounts.":"None of those clips can be posted yet (their videos aren't uploaded)."},{status:409});
   const limit=(await db.prepare("SELECT daily_limit FROM preferences WHERE owner=?").bind(owner).first<{daily_limit:number}>())?.daily_limit??defaults.dailyLimit;
   message=(asDraft?"Saving "+clipsPosted+" clip"+(clipsPosted===1?"":"s")+" to the TikTok drafts of ":"Posting "+clipsPosted+" clip"+(clipsPosted===1?"":"s")+" to ")+live.map(a=>(VIDEO_PLATFORMS[a.platform]??a.platform)+" @"+a.username).join(", ")+" ("+posts+" post"+(posts===1?"":"s")+"). "+(asDraft?"TikTok takes about 5 drafts per account a day; the rest wait their turn. Finish them in the TikTok app.":"Each account posts about one a minute, up to "+limit+" a day; the rest wait their turn.")
    +(busyNow?" "+busyNow+" already on their way were skipped.":"")+(notUploaded?" "+notUploaded+" not uploaded yet were skipped.":"")+(live.length<chosen.length?" Accounts needing reconnection were skipped.":"");
  }
  if(payload.action==="bulkClips"){
   const marks="SELECT value FROM json_each(?)",idList=JSON.stringify(payload.ids),n=(r:D1Result)=>r.results.length,clips=(k:number)=>k+" clip"+(k===1?"":"s");
   if(payload.op==="approve"||payload.op==="reject"||payload.op==="pending"){
    const review={approve:"approved",reject:"rejected",pending:"pending"}[payload.op];
    const r=await db.prepare("UPDATE clips SET review=?,reviewed_at=? WHERE owner=? AND id IN ("+marks+") AND review!=? RETURNING id").bind(review,review==="pending"?null:iso,owner,idList,review).all();
    return Response.json({ok:true,message:{approved:"Approved ",rejected:"Rejected ",pending:"Moved back to review: "}[review]+clips(n(r))+"."});
   }
   if(payload.op==="delete"){
    const {results:rows}=await db.prepare("SELECT id,file_key,source_key,thumb_rev FROM clips WHERE owner=? AND id IN ("+marks+")").bind(owner,idList).all<{id:string;file_key:string|null;source_key:string|null;thumb_rev:number|null}>();
    // Stored files first: a leftover row is visible and retryable, an orphaned object is not.
    const keys=rows.flatMap(r=>[r.file_key,r.source_key,thumbOf(owner,r)]).filter((k):k is string=>!!k);
    for(let i=0;i<keys.length;i+=500)await bucket()?.delete(keys.slice(i,i+500));
    await dropUnsent(rows.map(r=>r.id));
    statements.push(db.prepare("DELETE FROM clips WHERE owner=? AND id IN ("+marks+")").bind(owner,idList));
    message="Deleted "+clips(rows.length)+".";
   }else{
    // Edits change each clip's saved edit and queue a re-render from its original video, like saving in the editor.
    const set=payload.op==="frame"
     ?{path:"$.frame.mode",value:JSON.stringify(payload.frame??"blur")}
     :{path:"$.captions.on",value:payload.op==="captionsOn"?"true":"false"};
    if(payload.op==="frame"&&!payload.frame)return Response.json({error:"Choose a framing."},{status:400});
    const needsWords=payload.op==="captionsOn"?1:0;
    // Split screen puts captions on the seam; phone mode uses the phone picture the worker found (if the edit has none).
    const extra=payload.op!=="frame"?"":payload.frame==="split"?",'$.captions.y',0.5":payload.frame==="phone"?",'$.frame.content',json(coalesce(json_extract(edit,'$.frame.content'),json_extract(source_meta,'$.content'),'null'))":"";
    const r=await db.prepare(`UPDATE clips SET edit=json_set(edit,'${set.path}',json(?)${extra}),edit_rev=edit_rev+1,render_state='queued',render_error=NULL
     WHERE owner=? AND id IN (${marks}) AND edit IS NOT NULL AND source_key IS NOT NULL AND coalesce(json_extract(edit,'${set.path}'),'')!=json_extract(json(?),'$')
     AND (?=0 OR coalesce(json_array_length(transcript),0)>0) RETURNING id`).bind(set.value,owner,idList,set.value,needsWords).all();
    const k=n(r),skipped=payload.ids.length-k;
    const what=payload.op==="frame"?"Reframing ("+payload.frame+") ":payload.op==="captionsOn"?"Adding subtitles to ":"Removing subtitles from ";
    message=(k?what+clips(k)+". The worker re-renders them over the next few minutes; queued posts wait for the new version.":"No clips changed.")
     +(skipped?" "+clips(skipped)+" left as they were (already like that"+(needsWords?", no transcript":"")+", or can't be edited).":"");
   }
  }
  if(payload.action==="backgroundLength"){
   // Quiet bookkeeping: no activity entry, and only fills in a length that isn't known yet.
   await db.prepare("UPDATE backgrounds SET duration=? WHERE id=? AND owner=? AND duration IS NULL").bind(Math.round(payload.duration*100)/100,payload.id,owner).run();
   return Response.json({ok:true,message:""});
  }
  if(payload.action==="deleteBackground"){
   const row=await db.prepare("SELECT key,name FROM backgrounds WHERE id=? AND owner=?").bind(payload.id,owner).first<{key:string;name:string}>();
   if(!row)return Response.json({error:"That background video is not in your library."},{status:404});
   await bucket()?.delete(row.key);
   statements.push(db.prepare("DELETE FROM backgrounds WHERE id=? AND owner=?").bind(payload.id,owner));
   message="Removed "+row.name+" from the background library. Split-screen clips that used it get another one when they are next rendered.";
  }
  if(payload.action==="markPosted"){
   const clip=await db.prepare("SELECT c.review,s.name FROM clips c LEFT JOIN streamers s ON s.id=c.streamer_id AND s.owner=c.owner WHERE c.id=? AND c.owner=?").bind(payload.id,owner).first<{review:string;name:string|null}>();
   if(!clip)return Response.json({error:"Clip not found."},{status:404});
   const account=await db.prepare("SELECT username,platform FROM accounts WHERE id=? AND owner=?").bind(payload.accountId,owner).first<{username:string;platform:string}>();
   if(!account)return Response.json({error:"That account is not connected."},{status:404});
   const {results:existing}=await db.prepare("SELECT id,state,round FROM posts WHERE clip_id=? AND account_id=?").bind(payload.id,payload.accountId).all<{id:string;state:string;round:number}>();
   if(existing.some(p=>p.state==="processing"))return Response.json({error:"Clipflow is already sending this clip to @"+account.username+" (the platform may be holding it). It will finish on its own."},{status:409});
   const waiting=existing.find(p=>p.state==="queued"||p.state==="failed"||p.state==="review"||p.state==="skipped");
   // A post waiting in the queue becomes the posted one; otherwise the hand-made post is recorded as a new round.
   if(waiting)statements.push(db.prepare("UPDATE posts SET state='published',published_at=?,updated_at=?,error=NULL,container_id=NULL,media_id=NULL,permalink=NULL WHERE id=?").bind(iso,iso,waiting.id));
   else statements.push(db.prepare("INSERT INTO posts (id,owner,clip_id,platform,account_id,state,next_attempt_at,created_at,updated_at,published_at,round) VALUES (lower(hex(randomblob(16))),?,?,?,?,'published',?,?,?,?,?)").bind(owner,payload.id,account.platform,payload.accountId,iso,iso,iso,iso,existing.length?Math.max(...existing.map(p=>p.round))+1:0));
   if(clip.review!=="approved")statements.push(db.prepare("UPDATE clips SET review='approved',reviewed_at=? WHERE id=? AND owner=?").bind(iso,payload.id,owner));
   message="Marked "+(clip.name?clip.name+"'s clip":"the clip")+" as posted to "+(VIDEO_PLATFORMS[account.platform]??account.platform)+" @"+account.username+(waiting?"; it's out of the queue.":".");
  }
  if(payload.action==="reviewPosts"){
   const r=await db.prepare(payload.op==="queue"
    ?"UPDATE posts SET state='queued',queued_by_hand=1,error=NULL,next_attempt_at=?,updated_at=? WHERE owner=? AND state='review' AND id IN (SELECT value FROM json_each(?))"
    :"UPDATE posts SET state='skipped',error=NULL,next_attempt_at=?,updated_at=? WHERE owner=? AND state='review' AND id IN (SELECT value FROM json_each(?))").bind(iso,iso,owner,JSON.stringify(payload.ids)).run();
   const n=r.meta.changes??0,posts=n+" post"+(n===1?"":"s");
   if(!n)return Response.json({error:"Those posts are no longer waiting for review."},{status:409});
   return Response.json({ok:true,message:payload.op==="queue"?"Queued "+posts+". They go out as their accounts have room again, within each daily limit.":"Skipped "+posts+"; those clips won't post to those accounts."});
  }
  if(payload.action==="retryPost"){
   const post=await db.prepare("SELECT state FROM posts WHERE id=? AND owner=?").bind(payload.id,owner).first<{state:string}>();
   if(!post)return Response.json({error:"Post not found."},{status:404});
   if(post.state!=="failed")return Response.json({error:"Only failed posts can be retried."},{status:409});
   await db.prepare("UPDATE posts SET state='queued',attempts=0,error=NULL,container_id=NULL,next_attempt_at=?,updated_at=? WHERE id=? AND owner=?").bind(iso,iso,payload.id,owner).run();
   return Response.json({ok:true,message:"Post queued again."});
  }
  if(payload.action==="addZernioKey"){
   if(!env.TOKEN_KEY)return Response.json({error:"This site can't store keys yet (TOKEN_KEY is missing; see DEPLOY.md)."},{status:409});
   const hash=await hashKey(payload.key);
   if(await db.prepare("SELECT 1 FROM zernio_keys WHERE owner=? AND key_hash=?").bind(owner,hash).first())return Response.json({error:"That key is already added."},{status:409});
   let label;
   try{({label}=await verifyKey({apiKey:payload.key,apiUrl:zernioApiUrl(env)}));}
   catch(error){return Response.json({error:error instanceof ZernioError&&error.keyInvalid?"Zernio didn't accept that key. Copy it again from zernio.com → Settings → API keys.":"Couldn't reach Zernio to check the key. Please try again."},{status:400});}
   // Two keys of the same person read alike; number them so they can be told apart.
   const same=await db.prepare("SELECT count(*) AS n FROM zernio_keys WHERE owner=? AND (label=? OR label LIKE ?)").bind(owner,label,label+" (%").first<{n:number}>();
   if(same?.n)label=label+" ("+(same.n+1)+")";
   const id=crypto.randomUUID(),keyEnc=await encrypt(payload.key,env.TOKEN_KEY);
   await db.prepare("INSERT INTO zernio_keys (id,owner,label,key_enc,key_hash,created_at) VALUES (?,?,?,?,?,?)").bind(id,owner,label,keyEnc,hash,iso).run();
   message="Added Zernio key "+label+".";
   try{message+=" "+(await syncZernioAccounts(db,owner,{apiKey:payload.key,apiUrl:zernioApiUrl(env),keyId:id,label})).message;}
   catch(error){console.error("Zernio sync failed",error);message+=" Its accounts couldn't be read yet; press Refresh.";}
  }
  if(payload.action==="removeZernioKey"){
   const key=await db.prepare("SELECT id,label FROM zernio_keys WHERE id=? AND owner=?").bind(payload.id,owner).first<{id:string;label:string}>();
   if(!key)return Response.json({error:"That key is not in your workspace."},{status:404});
   // Its accounts go with it (they stay connected on Zernio, and come back if the key is added again).
   const sub="SELECT id FROM accounts WHERE owner=? AND zernio_key_id=?";
   statements.push(
    db.prepare("DELETE FROM posts WHERE state IN ('queued','processing','failed','review','skipped') AND account_id IN ("+sub+")").bind(owner,key.id),
    db.prepare("DELETE FROM streamer_accounts WHERE account_id IN ("+sub+")").bind(owner,key.id),
    db.prepare("DELETE FROM accounts WHERE owner=? AND zernio_key_id=?").bind(owner,key.id),
    db.prepare("DELETE FROM zernio_keys WHERE id=? AND owner=?").bind(key.id,owner));
   message="Removed Zernio key "+key.label+" and the accounts connected under it.";
  }
  if(payload.action==="syncZernio"){
   const all=await connections(env,db,owner).catch(()=>[]);
   if(!all.length)return Response.json({error:"Add a Zernio API key under Connections first."},{status:409});
   const notes:string[]=[],failed:string[]=[];
   for(const c of all){
    try{notes.push((await syncZernioAccounts(db,owner,c)).message);if(c.keyId)await db.prepare("UPDATE zernio_keys SET last_error=NULL WHERE id=?").bind(c.keyId).run();}
    catch(error){
     console.error("Zernio sync failed",error);
     const why=error instanceof ZernioError&&error.keyInvalid?"Zernio refused this key; remove it and add a new one.":"Couldn't reach Zernio.";
     failed.push(c.label+": "+why);if(c.keyId)await db.prepare("UPDATE zernio_keys SET last_error=? WHERE id=?").bind(why,c.keyId).run();
    }
   }
   if(!notes.length)return Response.json({error:failed.join(" ")},{status:502});
   message=[...notes,...failed].join(" ");
  }
  if(payload.action==="captionsAll"){
   // Only clips with an edit and their unframed source can be re-rendered; turning subtitles on also needs words.
   const result=await db.prepare(`UPDATE clips SET edit=json_set(edit,'$.captions.on',json(?)),edit_rev=edit_rev+1,render_state='queued',render_error=NULL
    WHERE owner=? AND edit IS NOT NULL AND source_key IS NOT NULL AND coalesce(json_extract(edit,'$.captions.on'),0)!=?
    AND (?=0 OR coalesce(json_array_length(transcript),0)>0)
    AND (?='all' OR NOT EXISTS (SELECT 1 FROM posts p WHERE p.clip_id=clips.id AND p.state='published')) RETURNING id`)
    .bind(payload.on?"true":"false",owner,Number(payload.on),Number(payload.on),payload.scope).all();
   // Counted from the rows returned: the queue-check trigger's own updates are counted in meta.changes.
   const n=result.results.length;
   message=n?(payload.on?"Adding subtitles to ":"Removing subtitles from ")+n+" clip"+(n===1?"":"s")+". The worker re-renders them over the next few minutes; queued posts wait for the new version."
    :payload.on?"No clips to change: they already have subtitles, or have no transcript.":"No clips to change: none of them "+(payload.scope==="all"?"":"that are still unposted ")+"have subtitles.";
  }
  if(payload.action==="accountOptions"){
   const account=await db.prepare("SELECT username,platform,options FROM accounts WHERE id=? AND owner=?").bind(payload.id,owner).first<{username:string;platform:string;options:string|null}>();
   if(!account)return Response.json({error:"That account is not connected."},{status:404});
   statements.push(db.prepare("UPDATE accounts SET options=? WHERE id=? AND owner=?").bind(JSON.stringify({...readOptions(account.options),...payload.options}),payload.id,owner));
   message="Saved posting options for "+(VIDEO_PLATFORMS[account.platform]??account.platform)+" @"+account.username+".";
  }
  if(payload.action==="makeClip"||payload.action==="findMoments"){
   const rec=await db.prepare("SELECT r.state,r.duration,s.name FROM recordings r LEFT JOIN streamers s ON s.id=r.streamer_id AND s.owner=r.owner WHERE r.id=? AND r.owner=?").bind(payload.recordingId,owner).first<{state:string;duration:number|null;name:string|null}>();
   if(!rec)return Response.json({error:"That recording is no longer in your workspace."},{status:404});
   if(rec.state==="failed")return Response.json({error:"This recording failed, so it can't be clipped."},{status:409});
   const open=await db.prepare("SELECT count(*) AS n FROM recording_requests WHERE owner=? AND state IN ('queued','working')").bind(owner).first<{n:number}>();
   if((open?.n??0)>=40)return Response.json({error:"Lots of clips are already waiting to be made. Try again once some are done."},{status:429});
   const later=rec.state==="ready"?"":" once the recording has finished saving";
   if(payload.action==="makeClip"){
    const length=payload.end-payload.start;
    if(length<15||length>90)return Response.json({error:"Pick between 15 and 90 seconds (this is "+length+")."},{status:400});
    if(rec.duration&&payload.start>=rec.duration)return Response.json({error:"That start is past the end of the recording."},{status:400});
    statements.push(db.prepare("INSERT INTO recording_requests (id,owner,recording_id,kind,start,end,state,created_at,updated_at) VALUES (?,?,?,'moment',?,?,'queued',?,?)").bind(crypto.randomUUID(),owner,payload.recordingId,payload.start,payload.end,iso,iso));
    message="Making a "+length+"s clip from "+(rec.name?rec.name+"'s":"the")+" recording"+later+". It appears in the clip library in a few minutes, while the worker PC is on.";
   }else{
    statements.push(db.prepare("INSERT INTO recording_requests (id,owner,recording_id,kind,count,state,created_at,updated_at) VALUES (?,?,?,'best',?,'queued',?,?)").bind(crypto.randomUUID(),owner,payload.recordingId,payload.count,iso,iso));
    message="Finding the "+payload.count+" best moment"+(payload.count===1?"":"s")+" in "+(rec.name?rec.name+"'s":"the")+" recording"+later+". The clips appear in the clip library as the worker PC makes them.";
   }
  }
  if(payload.action==="deleteRecording"){
   const rec=await db.prepare("SELECT r.state,r.preview_key,r.upload_id,s.name FROM recordings r LEFT JOIN streamers s ON s.id=r.streamer_id AND s.owner=r.owner WHERE r.id=? AND r.owner=?").bind(payload.id,owner).first<{state:string;preview_key:string|null;upload_id:string|null;name:string|null}>();
   if(!rec)return Response.json({error:"That recording is no longer in your workspace."},{status:404});
   if(rec.state==="recording")return Response.json({error:"This stream is still being recorded. Delete it once it has ended."},{status:409});
   await removeRecordingFiles(payload.id,rec);
   statements.push(db.prepare("DELETE FROM recording_requests WHERE recording_id=? AND owner=?").bind(payload.id,owner),db.prepare("DELETE FROM recordings WHERE id=? AND owner=?").bind(payload.id,owner));
   message="Deleted "+(rec.name?rec.name+"'s":"a")+" recording. The worker PC removes its copy on its next check; clips already made from it stay in the library.";
  }
  let token:string|undefined;
  if(payload.action==="token"){
   token=newToken();
   // Replacing the hash revokes any previous token for this owner.
   statements.push(db.prepare("INSERT INTO worker_tokens (owner,token_hash,created_at,last_seen) VALUES (?,?,?,NULL) ON CONFLICT(owner) DO UPDATE SET token_hash=excluded.token_hash,created_at=excluded.created_at,last_seen=NULL,last_error=NULL,last_error_at=NULL").bind(owner,await hashToken(token),iso));
   message="Created a new worker token. Any previous token was revoked.";
  }
  statements.push(db.prepare("INSERT INTO events (id,owner,message,created_at) VALUES (?,?,?,?)").bind(crypto.randomUUID(),owner,message,iso));
  await db.batch(statements);return Response.json({ok:true,message,token,streamerId},{headers:{"Cache-Control":"private, no-store"}});
 }catch(error){
  if(String(error).includes("UNIQUE constraint"))return Response.json({error:"This streamer is already in your workspace."},{status:409});
  console.error("Dashboard save failed",error);return Response.json({error:"Changes weren't saved. Please try again."},{status:503});
 }
}
