import { currentUser, signInPath } from "../../auth";
import { bucket, database } from "../../../db/raw";
import { defaultCaption, defaults, parseStreamer, settingsSchema } from "../../../lib/clipflow";
import { instagramConfig, zernioConfig } from "../../../lib/publisher";
import { listAccounts, VIDEO_PLATFORMS, ZernioError } from "../../../lib/zernio";
import { normalizeStyle } from "../../../worker/edit.mjs";
import { env } from "cloudflare:workers";
import { hashToken, newToken } from "../../../lib/worker-auth";
import { z } from "zod";
const accountIds=z.array(z.string().uuid()).max(50).transform(x=>[...new Set(x)]);
const actionSchema=z.discriminatedUnion("action",[
 z.object({action:z.literal("add"),url:z.string().max(500),name:z.string().trim().max(80).optional(),accounts:accountIds.optional()}),
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
 // Copies the accounts connected on Zernio into this workspace (new ones added, removed ones marked).
 z.object({action:z.literal("syncZernio")}),
 z.object({action:z.literal("assign"),streamerId:z.string().uuid(),accounts:accountIds}),
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
   db.prepare("SELECT id,provider,platform,username,status,connected_at,last_error FROM accounts WHERE owner=? ORDER BY connected_at").bind(owner).all(),
   db.prepare("SELECT p.id,p.clip_id,p.platform,p.account_id,p.state,p.permalink,p.error,p.attempts,p.created_at,p.published_at,s.name AS streamer,a.username AS account FROM posts p LEFT JOIN clips c ON c.id=p.clip_id LEFT JOIN streamers s ON s.id=c.streamer_id AND s.owner=c.owner LEFT JOIN accounts a ON a.id=p.account_id WHERE p.owner=? ORDER BY p.created_at DESC LIMIT 100").bind(owner).all(),
   db.prepare("SELECT streamer_id,account_id FROM streamer_accounts WHERE owner=?").bind(owner).all<{streamer_id:string;account_id:string}>(),
  ]);
  const [s,p,e,c,w]=await Promise.all([db.prepare("SELECT * FROM streamers WHERE owner=? ORDER BY created_at DESC").bind(owner).all<Record<string,unknown>>(),db.prepare("SELECT * FROM preferences WHERE owner=?").bind(owner).first(),db.prepare("SELECT id,message,created_at FROM events WHERE owner=? ORDER BY created_at DESC LIMIT 30").bind(owner).all(),db.prepare("SELECT c.id,c.streamer_id,c.created_at,c.duration,c.captions,c.size,c.file_key IS NOT NULL AS stored,c.review,c.reason,c.edit IS NOT NULL AS editable,c.source_key IS NOT NULL AS source_stored,c.render_state,c.render_error,c.rendered_at,c.edit_rev,s.name AS streamer FROM clips c LEFT JOIN streamers s ON s.id=c.streamer_id AND s.owner=c.owner WHERE c.owner=? ORDER BY c.created_at DESC LIMIT 200").bind(owner).all<Record<string,unknown>>(),db.prepare("SELECT created_at,last_seen,last_error,last_error_at FROM worker_tokens WHERE owner=?").bind(owner).first<{created_at:string;last_seen:string|null;last_error:string|null;last_error_at:string|null}>()]);
  const lastSeen=w?.last_seen??null,connected=!!lastSeen&&Date.now()-Date.parse(lastSeen)<ENGINE_FRESH_MS;
  const engine={connected,lastSeen,tokenCreated:w?.created_at??null,lastError:w?.last_error??null,lastErrorAt:w?.last_error_at??null,status:connected?"Worker connected":w?(lastSeen?"Worker offline":"Waiting for worker"):"Setup required"};
  const streamers=s.results.map(x=>({...x,style:parse(x.style),accounts:l.results.filter(k=>k.streamer_id===x.id).map(k=>k.account_id)}));
  const settings=p?{...p,dailyLimit:p.daily_limit,captions:!!p.captions,destinations:JSON.parse(String(p.destinations)),captionTemplate:p.caption_template,style:parse(p.style)}:{...defaults,style:null};
  return Response.json({user:user.displayName,streamers,settings,events:e.results,engine,accounts:a.results,posts:po.results,publishing:{instagram:!!instagramConfig(env),zernio:!!zernioConfig(env)},clips:c.results.map(x=>({...x,captions:!!x.captions,stored:!!x.stored,editable:!!x.editable,source_stored:!!x.source_stored})),storage:!!bucket(),analytics:null},{headers:{"Cache-Control":"private, no-store"}});
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
   statements.push(db.prepare("INSERT INTO streamers (id,owner,name,url,platform,status,created_at) VALUES (?,?,?,?,?,'armed',?)").bind(streamerId,owner,name,channel.url,channel.platform,iso));
   for(const a of linked)statements.push(db.prepare("INSERT INTO streamer_accounts (streamer_id,account_id,owner,created_at) VALUES (?,?,?,?)").bind(streamerId,a.id,owner,iso));
   // Adding a streamer means "start clipping them": automation is switched on for the workspace.
   statements.push(db.prepare("INSERT INTO preferences (owner,control) VALUES (?,'running') ON CONFLICT(owner) DO UPDATE SET control='running'").bind(owner));
   message="Added "+name+" from "+channel.platform+". Clipping starts as soon as they go live"+(linked.length?" and clips post to "+linked.map(a=>"@"+a.username).join(", ")+".":".");
  }
  if(payload.action==="status"||payload.action==="remove"){
   const streamer=await db.prepare("SELECT name FROM streamers WHERE id=? AND owner=?").bind(payload.id,owner).first();
   if(!streamer)return Response.json({error:"Streamer not found."},{status:404});
   if(payload.action==="remove")statements.push(db.prepare("DELETE FROM streamer_accounts WHERE streamer_id=? AND owner=?").bind(payload.id,owner),db.prepare("DELETE FROM streamers WHERE id=? AND owner=?").bind(payload.id,owner));
   else statements.push(db.prepare("UPDATE streamers SET status=? WHERE id=? AND owner=?").bind(payload.status,payload.id,owner));
   message=payload.action==="remove"?"Removed "+streamer.name+".":streamer.name+": "+(payload.status==="armed"?"enabled; waiting for connection":payload.status)+".";
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
   // A client that omits captionTemplate keeps the saved one.
   statements.push(db.prepare("INSERT INTO preferences (owner,mode,duration,daily_limit,captions,framing,destinations,control,caption_template) VALUES (?,?,?,?,?,?,?,'paused',?) ON CONFLICT(owner) DO UPDATE SET mode=excluded.mode,duration=excluded.duration,daily_limit=excluded.daily_limit,captions=excluded.captions,framing=excluded.framing,destinations=excluded.destinations,caption_template=coalesce(?,preferences.caption_template)").bind(owner,s.mode,s.duration,s.dailyLimit,Number(s.captions),s.framing,JSON.stringify(s.destinations),s.captionTemplate??defaultCaption,s.captionTemplate??null));
   message="Saved clipping and publishing preferences.";
  }
  if(payload.action==="control"){
   statements.push(db.prepare("INSERT INTO preferences (owner,control) VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET control=excluded.control").bind(owner,payload.control));
   message=payload.control==="running"?"Global automation resumed.":payload.control==="paused"?"Global automation paused.":"Global automation stopped.";
  }
  if(payload.action==="deleteClip"){
   const clip=await db.prepare("SELECT c.file_key,c.source_key,s.name FROM clips c LEFT JOIN streamers s ON s.id=c.streamer_id AND s.owner=c.owner WHERE c.id=? AND c.owner=?").bind(payload.id,owner).first<{file_key:string|null;source_key:string|null;name:string|null}>();
   if(!clip)return Response.json({error:"Clip not found."},{status:404});
   // Remove the stored files first: a leftover row is visible and retryable, an orphaned object is not.
   const keys=[clip.file_key,clip.source_key].filter((k):k is string=>!!k);
   if(keys.length)await bucket()?.delete(keys);
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
   type Row={id:string;username:string;provider:string;platform:string};
   const account=payload.id
    ?await db.prepare("SELECT id,username,provider,platform FROM accounts WHERE owner=? AND id=?").bind(owner,payload.id).first<Row>()
    :payload.platform?await db.prepare("SELECT id,username,provider,platform FROM accounts WHERE owner=? AND platform=? ORDER BY connected_at LIMIT 1").bind(owner,payload.platform).first<Row>():null;
   if(!account)return Response.json({error:"That account is not connected."},{status:404});
   // Posts not yet sent are dropped with the account; published history is kept.
   statements.push(db.prepare("DELETE FROM posts WHERE account_id=? AND state IN ('queued','processing','failed')").bind(account.id),db.prepare("DELETE FROM streamer_accounts WHERE account_id=?").bind(account.id),db.prepare("DELETE FROM accounts WHERE id=?").bind(account.id));
   message=account.provider==="zernio"
    ?"Removed "+(VIDEO_PLATFORMS[account.platform]??account.platform)+" account @"+account.username+" from Clipflow. It stays connected on Zernio; disconnect it there too if you no longer use it, or it returns on the next sync."
    :"Disconnected Instagram account @"+account.username+". Remove Clipflow under Instagram settings → Apps and websites to revoke its access fully.";
  }
  if(payload.action==="retryPost"){
   const post=await db.prepare("SELECT state FROM posts WHERE id=? AND owner=?").bind(payload.id,owner).first<{state:string}>();
   if(!post)return Response.json({error:"Post not found."},{status:404});
   if(post.state!=="failed")return Response.json({error:"Only failed posts can be retried."},{status:409});
   await db.prepare("UPDATE posts SET state='queued',attempts=0,error=NULL,container_id=NULL,next_attempt_at=?,updated_at=? WHERE id=? AND owner=?").bind(iso,iso,payload.id,owner).run();
   return Response.json({ok:true,message:"Post queued again."});
  }
  if(payload.action==="syncZernio"){
   const config=zernioConfig(env);
   if(!config)return Response.json({error:"Zernio isn't set up on this site yet: add ZERNIO_API_KEY (see DEPLOY.md)."},{status:409});
   let remote;
   try{remote=(await listAccounts(config)).filter(a=>VIDEO_PLATFORMS[a.platform]);}
   catch(error){console.error("Zernio sync failed",error);return Response.json({error:error instanceof ZernioError&&error.keyInvalid?"Zernio refused the API key. Check ZERNIO_API_KEY.":"Couldn't reach Zernio. Please try again."},{status:502});}
   const {results:mine}=await db.prepare("SELECT id,external_id,status FROM accounts WHERE owner=? AND provider='zernio'").bind(owner).all<{id:string;external_id:string;status:string}>();
   const any=await db.prepare("SELECT count(*) AS n FROM accounts WHERE owner=?").bind(owner).first<{n:number}>();
   const added:string[]=[],remoteIds=new Set(remote.map(a=>a._id));
   for(const a of remote){
    const username=(a.username||a.displayName||a._id).replace(/^@/,"").slice(0,80),active=a.isActive!==false,existing=mine.find(m=>m.external_id===a._id);
    if(existing){statements.push(db.prepare("UPDATE accounts SET username=?,status=?,last_error=? WHERE id=?").bind(username,active?"connected":"expired",active?null:"Disconnected on Zernio; reconnect it there, then sync again.",existing.id));continue;}
    const id=crypto.randomUUID();added.push(VIDEO_PLATFORMS[a.platform]+" @"+username);
    statements.push(db.prepare("INSERT INTO accounts (id,owner,provider,platform,external_id,username,token_enc,token_expires_at,token_refreshed_at,status,connected_at) VALUES (?,?,'zernio',?,?,?,'','','',?,?)").bind(id,owner,a.platform,a._id,username,active?"connected":"expired",iso));
    // A workspace's very first accounts post every streamer's clips, so a simple setup needs no extra step.
    if(!any?.n)statements.push(db.prepare("INSERT OR IGNORE INTO streamer_accounts (streamer_id,account_id,owner,created_at) SELECT id,?,owner,? FROM streamers WHERE owner=?").bind(id,iso,owner));
   }
   for(const m of mine)if(!remoteIds.has(m.external_id)&&m.status==="connected")statements.push(db.prepare("UPDATE accounts SET status='expired',last_error=? WHERE id=?").bind("No longer connected on Zernio; reconnect it there, then sync again.",m.id));
   message=added.length?"Added from Zernio: "+added.join(", ")+".":remote.length?"Zernio accounts are up to date.":"No video accounts are connected on Zernio yet. Connect TikTok, Instagram or YouTube at zernio.com, then sync again.";
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
