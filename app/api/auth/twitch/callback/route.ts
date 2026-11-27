import { env } from "cloudflare:workers";
import { currentUser, twitchApp } from "../../../../auth";
import { database } from "../../../../../db/raw";
import { SESSION_COOKIE, SESSION_DAYS, STATE_COOKIE, cookie, isToken, ownerFor, randomToken, readCookie, safeReturn, sha256, signupsOpen, twitchUrls } from "../../../../../lib/app-auth.mjs";
export const dynamic="force-dynamic";
type TwitchUser={id:string;login:string;display_name?:string;email?:string};
// Sign in with Twitch, step 2: checks the state against this browser's cookie, trades the code for a token (with the
// site's Twitch secret), asks Twitch who it is, finds or links its workspace (lib/app-auth.mjs ownerFor) and starts a
// session. Twitch's token is only used here, never kept.
export async function GET(request:Request){
 const url=new URL(request.url),origin=url.origin,secure=url.protocol==="https:";
 const clearState=cookie(STATE_COOKIE,"",{path:"/api/auth",maxAge:0,secure});
 const fail=(message:string)=>new Response(null,{status:302,headers:{Location:origin+"/?signin_error="+encodeURIComponent(message),"Set-Cookie":clearState,"Cache-Control":"no-store"}});
 const app=twitchApp();
 if(!app)return fail("Sign in with Twitch isn't set up on this site yet.");
 if(url.searchParams.get("error"))return fail("Twitch sign-in was cancelled.");
 const [state,backPart]=(readCookie(request.headers.get("cookie"),STATE_COOKIE)??"").split(".");
 const code=url.searchParams.get("code");
 if(!isToken(state)||url.searchParams.get("state")!==state||!code)return fail("That sign-in link has expired. Try signing in again.");
 const back=safeReturn(decodeURIComponent(backPart??""));
 let user:TwitchUser|undefined;
 try{
  const urls=twitchUrls(env);
  const token=await fetch(urls.auth+"/oauth2/token",{method:"POST",body:new URLSearchParams({client_id:app.clientId,client_secret:app.clientSecret,code,grant_type:"authorization_code",redirect_uri:origin+"/api/auth/twitch/callback"}),signal:AbortSignal.timeout(15_000)});
  // Never include the response body: a bad request can echo the secret back.
  if(!token.ok)return fail("Twitch didn't accept the sign-in (HTTP "+token.status+"). Try again.");
  const access=(await token.json() as {access_token?:string}).access_token;
  if(!access)return fail("Twitch didn't accept the sign-in. Try again.");
  const me=await fetch(urls.api+"/helix/users",{headers:{"Client-Id":app.clientId,Authorization:"Bearer "+access},signal:AbortSignal.timeout(15_000)});
  if(!me.ok)return fail("Couldn't read your Twitch account (HTTP "+me.status+"). Try again.");
  user=(await me.json() as {data?:TwitchUser[]}).data?.[0];
 }catch{return fail("Couldn't reach Twitch. Try again in a minute.");}
 if(!user?.id||!/^\d{1,20}$/.test(user.id))return fail("Couldn't read your Twitch account. Try again.");
 const db=database(),now=new Date().toISOString(),name=String(user.display_name||user.login||"").slice(0,100);
 const linked=await db.prepare("SELECT owner FROM auth_identities WHERE provider='twitch' AND provider_id=?").bind(user.id).first<{owner:string}>();
 // Already signed in another way (Cloudflare Access): this links Twitch to that workspace.
 const current=linked?null:(await currentUser())?.userId??null;
 const pick=ownerFor({linked:linked?.owner??null,current,provider:"twitch",providerId:user.id,open:signupsOpen((env as {CLIPFLOW_SIGNUPS?:string}).CLIPFLOW_SIGNUPS)});
 if("refused" in pick)return fail(pick.refused);
 const session=randomToken(),expires=new Date(Date.now()+SESSION_DAYS*86_400_000).toISOString();
 const statements=[
  db.prepare("INSERT INTO auth_identities (provider,provider_id,owner,login,email,display_name,created_at,last_sign_in) VALUES ('twitch',?,?,?,?,?,?,?) ON CONFLICT(provider,provider_id) DO UPDATE SET login=excluded.login,email=excluded.email,display_name=excluded.display_name,last_sign_in=excluded.last_sign_in")
   .bind(user.id,pick.owner,String(user.login??"").slice(0,60),user.email?String(user.email).slice(0,200):null,name,now,now),
  db.prepare("INSERT INTO sessions (token_hash,owner,display_name,created_at,expires_at) VALUES (?,?,?,?,?)").bind(await sha256(session),pick.owner,name||null,now,expires),
  // Old sessions go when anyone signs in, so the table stays small.
  db.prepare("DELETE FROM sessions WHERE expires_at<=?").bind(now),
 ];
 if(pick.link)statements.push(db.prepare("INSERT INTO events (id,owner,message,created_at) VALUES (?,?,?,?)").bind(crypto.randomUUID(),pick.owner,(current?"Linked the Twitch account @":"Signed up with the Twitch account @")+String(user.login??"").slice(0,60)+" for signing in.",now));
 await db.batch(statements);
 const headers=new Headers({Location:origin+back,"Cache-Control":"no-store"});
 headers.append("Set-Cookie",clearState);
 headers.append("Set-Cookie",cookie(SESSION_COOKIE,session,{maxAge:SESSION_DAYS*86_400,secure}));
 return new Response(null,{status:302,headers});
}
