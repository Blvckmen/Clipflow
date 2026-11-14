import { env } from "cloudflare:workers";
import { currentUser } from "../../../../auth";
import { database } from "../../../../../db/raw";
import { connect } from "../../../../../lib/instagram";
import { instagramConfig } from "../../../../../lib/publisher";
import { encrypt } from "../../../../../lib/secure";
export const dynamic="force-dynamic";
const STATE_COOKIE="ig_oauth_state";
export async function GET(request:Request){
 const url=new URL(request.url),origin=url.origin;
 const clearState=STATE_COOKIE+"=; Path=/api/connections/instagram; Max-Age=0; HttpOnly; Secure; SameSite=Lax";
 const back=(query:string)=>new Response(null,{status:302,headers:{Location:origin+"/?"+query,"Set-Cookie":clearState,"Cache-Control":"no-store"}});
 const problem=(message:string)=>back("connect_error="+encodeURIComponent(message));
 const user=await currentUser();
 if(!user)return problem("Sign in before connecting an account.");
 const config=instagramConfig(env);
 if(!config||!env.TOKEN_KEY)return problem("Instagram publishing is not set up on this site yet.");
 const [cookieState,streamerId]=(/(?:^|;\s*)ig_oauth_state=([^;]+)/.exec(request.headers.get("cookie")??"")?.[1]??"").split(".");
 if(!cookieState||cookieState!==url.searchParams.get("state"))return problem("The Instagram sign-in could not be verified. Please try again.");
 if(url.searchParams.get("error"))return problem("Instagram sign-in was cancelled.");
 const code=url.searchParams.get("code");
 if(!code)return problem("Instagram did not return a sign-in code.");
 try{
  const account=await connect(config,code,origin+"/api/connections/instagram/callback");
  const now=new Date(),iso=now.toISOString(),db=database(),owner=user.userId;
  // Each Instagram account is its own row, so several can be connected. Reconnecting the same account keeps its
  // id, links and original connection time, so clips approved while it was disconnected still post.
  await db.prepare(`INSERT INTO accounts (id,owner,platform,external_id,username,token_enc,token_expires_at,token_refreshed_at,status,connected_at,last_error)
    VALUES (?,?,'instagram',?,?,?,?,?,'connected',?,NULL)
    ON CONFLICT(owner,platform,external_id) DO UPDATE SET username=excluded.username,token_enc=excluded.token_enc,token_expires_at=excluded.token_expires_at,
    token_refreshed_at=excluded.token_refreshed_at,status='connected',last_error=NULL`)
   .bind(crypto.randomUUID(),owner,account.userId,account.username,await encrypt(account.token,env.TOKEN_KEY),new Date(now.getTime()+account.expiresIn*1000).toISOString(),iso,iso).run();
  const row=await db.prepare("SELECT id FROM accounts WHERE owner=? AND platform='instagram' AND external_id=?").bind(owner,account.userId).first<{id:string}>();
  const others=await db.prepare("SELECT count(*) AS n FROM accounts WHERE owner=? AND id!=?").bind(owner,row!.id).first<{n:number}>();
  // Started from a streamer: post that streamer's clips here. The first account of all posts every streamer's
  // clips, so a single-account workspace needs no extra step.
  const link=streamerId
   ?db.prepare("INSERT OR IGNORE INTO streamer_accounts (streamer_id,account_id,owner,created_at) SELECT id,?,owner,? FROM streamers WHERE id=? AND owner=?").bind(row!.id,iso,streamerId,owner)
   :(others?.n??0)===0?db.prepare("INSERT OR IGNORE INTO streamer_accounts (streamer_id,account_id,owner,created_at) SELECT id,?,owner,? FROM streamers WHERE owner=?").bind(row!.id,iso,owner):null;
  await db.batch([
   ...(link?[link]:[]),
   db.prepare("INSERT INTO events (id,owner,message,created_at) VALUES (?,?,?,?)").bind(crypto.randomUUID(),owner,"Connected Instagram account @"+account.username+".",iso),
  ]);
  return back("connected=instagram&account="+encodeURIComponent(account.username));
 }catch(error){
  console.error("Instagram connection failed",error);
  return problem((error as Error).message.slice(0,200));
 }
}
