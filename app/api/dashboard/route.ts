import { currentUser, signInPath } from "../../auth";
import { bucket, database } from "../../../db/raw";
import { defaultCaption, defaults, parseStreamer, settingsSchema } from "../../../lib/clipflow";
import { instagramConfig } from "../../../lib/publisher";
import { env } from "cloudflare:workers";
import { hashToken, newToken } from "../../../lib/worker-auth";
import { z } from "zod";
const actionSchema=z.discriminatedUnion("action",[
 z.object({action:z.literal("add"),url:z.string().max(500),name:z.string().trim().max(80).optional()}),
 z.object({action:z.literal("status"),id:z.string().uuid(),status:z.enum(["armed","paused","stopped"])}),
 z.object({action:z.literal("remove"),id:z.string().uuid()}),
 z.object({action:z.literal("settings"),settings:settingsSchema}),
 z.object({action:z.literal("control"),control:z.enum(["running","paused","stopped"])}),
 z.object({action:z.literal("token")}),
 z.object({action:z.literal("deleteClip"),id:z.string().uuid()}),
 z.object({action:z.literal("reviewClip"),id:z.string().uuid(),review:z.enum(["approved","rejected","pending"])}),
 z.object({action:z.literal("disconnect"),platform:z.enum(["instagram"])}),
 z.object({action:z.literal("retryPost"),id:z.string().min(1).max(64)}),
]);
const ENGINE_FRESH_MS=5*60_000;
export async function GET(){
 const user=await currentUser();if(!user)return Response.json({error:"Sign in to open your dashboard.",signIn:signInPath()},{status:401});
 try{
  const db=database();
  const [a,po]=await Promise.all([
   // Tokens never leave the server: only display fields are selected.
   db.prepare("SELECT platform,username,status,connected_at,last_error FROM accounts WHERE owner=?").bind(user.userId).all(),
   db.prepare("SELECT p.id,p.clip_id,p.platform,p.state,p.permalink,p.error,p.attempts,p.created_at,p.published_at,s.name AS streamer FROM posts p LEFT JOIN clips c ON c.id=p.clip_id LEFT JOIN streamers s ON s.id=c.streamer_id AND s.owner=c.owner WHERE p.owner=? ORDER BY p.created_at DESC LIMIT 100").bind(user.userId).all(),
  ]);
  const [s,p,e,c,w]=await Promise.all([db.prepare("SELECT * FROM streamers WHERE owner=? ORDER BY created_at DESC").bind(user.userId).all(),db.prepare("SELECT * FROM preferences WHERE owner=?").bind(user.userId).first(),db.prepare("SELECT id,message,created_at FROM events WHERE owner=? ORDER BY created_at DESC LIMIT 30").bind(user.userId).all(),db.prepare("SELECT c.id,c.streamer_id,c.created_at,c.duration,c.captions,c.size,c.file_key IS NOT NULL AS stored,c.review,c.reason,s.name AS streamer FROM clips c LEFT JOIN streamers s ON s.id=c.streamer_id AND s.owner=c.owner WHERE c.owner=? ORDER BY c.created_at DESC LIMIT 100").bind(user.userId).all(),db.prepare("SELECT created_at,last_seen,last_error,last_error_at FROM worker_tokens WHERE owner=?").bind(user.userId).first<{created_at:string;last_seen:string|null;last_error:string|null;last_error_at:string|null}>()]);
  const lastSeen=w?.last_seen??null,connected=!!lastSeen&&Date.now()-Date.parse(lastSeen)<ENGINE_FRESH_MS;
  const engine={connected,lastSeen,tokenCreated:w?.created_at??null,lastError:w?.last_error??null,lastErrorAt:w?.last_error_at??null,status:connected?"Worker connected":w?(lastSeen?"Worker offline":"Waiting for worker"):"Setup required"};
  return Response.json({user:user.displayName,streamers:s.results,settings:p?{...p,dailyLimit:p.daily_limit,captions:!!p.captions,destinations:JSON.parse(String(p.destinations)),captionTemplate:p.caption_template}:defaults,events:e.results,engine,accounts:a.results,posts:po.results,publishing:{instagram:!!instagramConfig(env)},clips:c.results.map(x=>({...x,captions:!!x.captions,stored:!!x.stored})),analytics:null},{headers:{"Cache-Control":"private, no-store"}});
 }catch(error){console.error("Dashboard load failed",error);return Response.json({error:"We couldn't load your workspace. Please retry."},{status:503});}
}
export async function POST(request:Request){
 const user=await currentUser();if(!user)return Response.json({error:"Sign in before making changes.",signIn:signInPath()},{status:401});
 const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return Response.json({error:"Request origin rejected."},{status:403});
 let payload;try{payload=actionSchema.parse(await request.json());}catch{return Response.json({error:"Check your settings and try again."},{status:400});}
 try{
  const db=database(),owner=user.userId;let message="";const statements:D1PreparedStatement[]=[];
  if(payload.action==="add"){
   let channel;try{channel=parseStreamer(payload.url);}catch(error){return Response.json({error:(error as Error).message},{status:400});}
   const name=payload.name||channel.name;
   statements.push(db.prepare("INSERT INTO streamers (id,owner,name,url,platform,status,created_at) VALUES (?,?,?,?,?,'armed',?)").bind(crypto.randomUUID(),owner,name,channel.url,channel.platform,new Date().toISOString()));
   message="Added "+name+" from "+channel.platform+". Waiting for source connection.";
  }
  if(payload.action==="status"||payload.action==="remove"){
   const streamer=await db.prepare("SELECT name FROM streamers WHERE id=? AND owner=?").bind(payload.id,owner).first();
   if(!streamer)return Response.json({error:"Streamer not found."},{status:404});
   statements.push(payload.action==="remove"?db.prepare("DELETE FROM streamers WHERE id=? AND owner=?").bind(payload.id,owner):db.prepare("UPDATE streamers SET status=? WHERE id=? AND owner=?").bind(payload.status,payload.id,owner));
   message=payload.action==="remove"?"Removed "+streamer.name+".":streamer.name+": "+(payload.status==="armed"?"enabled; waiting for connection":payload.status)+".";
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
   const clip=await db.prepare("SELECT c.file_key,s.name FROM clips c LEFT JOIN streamers s ON s.id=c.streamer_id AND s.owner=c.owner WHERE c.id=? AND c.owner=?").bind(payload.id,owner).first<{file_key:string|null;name:string|null}>();
   if(!clip)return Response.json({error:"Clip not found."},{status:404});
   // Remove the stored file first: a leftover row is visible and retryable, an orphaned object is not.
   if(clip.file_key)await bucket()?.delete(clip.file_key);
   statements.push(db.prepare("DELETE FROM clips WHERE id=? AND owner=?").bind(payload.id,owner));
   message="Deleted a clip"+(clip.name?" from "+clip.name:"")+".";
  }
  if(payload.action==="reviewClip"){
   const clip=await db.prepare("SELECT s.name FROM clips c LEFT JOIN streamers s ON s.id=c.streamer_id AND s.owner=c.owner WHERE c.id=? AND c.owner=?").bind(payload.id,owner).first<{name:string|null}>();
   if(!clip)return Response.json({error:"Clip not found."},{status:404});
   // Reviews are frequent, so they update the clip without adding to the activity log.
   await db.prepare("UPDATE clips SET review=?,reviewed_at=? WHERE id=? AND owner=?").bind(payload.review,payload.review==="pending"?null:new Date().toISOString(),payload.id,owner).run();
   return Response.json({ok:true,message:{approved:"Clip approved.",rejected:"Clip rejected.",pending:"Clip moved back to review."}[payload.review]});
  }
  if(payload.action==="disconnect"){
   const account=await db.prepare("SELECT id,username FROM accounts WHERE owner=? AND platform=?").bind(owner,payload.platform).first<{id:string;username:string}>();
   if(!account)return Response.json({error:"That account is not connected."},{status:404});
   // Posts not yet sent are dropped with the account; published history is kept.
   statements.push(db.prepare("DELETE FROM posts WHERE account_id=? AND state IN ('queued','processing','failed')").bind(account.id),db.prepare("DELETE FROM accounts WHERE id=?").bind(account.id));
   message="Disconnected Instagram account @"+account.username+". Remove Clipflow under Instagram settings → Apps and websites to revoke its access fully.";
  }
  if(payload.action==="retryPost"){
   const post=await db.prepare("SELECT state FROM posts WHERE id=? AND owner=?").bind(payload.id,owner).first<{state:string}>();
   if(!post)return Response.json({error:"Post not found."},{status:404});
   if(post.state!=="failed")return Response.json({error:"Only failed posts can be retried."},{status:409});
   await db.prepare("UPDATE posts SET state='queued',attempts=0,error=NULL,container_id=NULL,next_attempt_at=?,updated_at=? WHERE id=? AND owner=?").bind(new Date().toISOString(),new Date().toISOString(),payload.id,owner).run();
   return Response.json({ok:true,message:"Post queued again."});
  }
  let token:string|undefined;
  if(payload.action==="token"){
   token=newToken();
   // Replacing the hash revokes any previous token for this owner.
   statements.push(db.prepare("INSERT INTO worker_tokens (owner,token_hash,created_at,last_seen) VALUES (?,?,?,NULL) ON CONFLICT(owner) DO UPDATE SET token_hash=excluded.token_hash,created_at=excluded.created_at,last_seen=NULL,last_error=NULL,last_error_at=NULL").bind(owner,await hashToken(token),new Date().toISOString()));
   message="Created a new worker token. Any previous token was revoked.";
  }
  statements.push(db.prepare("INSERT INTO events (id,owner,message,created_at) VALUES (?,?,?,?)").bind(crypto.randomUUID(),owner,message,new Date().toISOString()));
  await db.batch(statements);return Response.json({ok:true,message,token},{headers:{"Cache-Control":"private, no-store"}});
 }catch(error){
  if(String(error).includes("UNIQUE constraint"))return Response.json({error:"This streamer is already in your workspace."},{status:409});
  console.error("Dashboard save failed",error);return Response.json({error:"Changes weren't saved. Please try again."},{status:503});
 }
}
