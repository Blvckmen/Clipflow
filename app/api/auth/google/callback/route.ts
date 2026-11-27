import { env } from "cloudflare:workers";
import { currentUser, googleApp } from "../../../../auth";
import { database } from "../../../../../db/raw";
import { SESSION_COOKIE, SESSION_DAYS, STATE_COOKIE, cookie, googleAccount, googleUrls, isToken, ownerFor, randomToken, readCookie, safeReturn, sha256, signupsOpen } from "../../../../../lib/app-auth.mjs";
export const dynamic="force-dynamic";
// Sign in with Google, step 2: checks the state against this browser's cookie, trades the code for a token (with the
// site's Google secret), asks Google who it is, finds or links its workspace (lib/app-auth.mjs ownerFor) and starts a
// session. Google's token is only used here, never kept. A Google account joins a workspace only by being linked
// from inside it (or by signing up when sign-ups are open), never because its email matches someone else's.
export async function GET(request:Request){
 const url=new URL(request.url),origin=url.origin,secure=url.protocol==="https:";
 const clearState=cookie(STATE_COOKIE,"",{path:"/api/auth",maxAge:0,secure});
 const fail=(message:string)=>new Response(null,{status:302,headers:{Location:origin+"/?signin_error="+encodeURIComponent(message),"Set-Cookie":clearState,"Cache-Control":"no-store"}});
 const app=googleApp();
 if(!app)return fail("Sign in with Google isn't set up on this site yet.");
 if(url.searchParams.get("error"))return fail("Google sign-in was cancelled.");
 const [state,backPart]=(readCookie(request.headers.get("cookie"),STATE_COOKIE)??"").split(".");
 const code=url.searchParams.get("code");
 if(!isToken(state)||url.searchParams.get("state")!==state||!code)return fail("That sign-in link has expired. Try signing in again.");
 const back=safeReturn(decodeURIComponent(backPart??""));
 let info:unknown;
 try{
  const urls=googleUrls(env);
  const token=await fetch(urls.token+"/token",{method:"POST",body:new URLSearchParams({client_id:app.clientId,client_secret:app.clientSecret,code,grant_type:"authorization_code",redirect_uri:origin+"/api/auth/google/callback"}),signal:AbortSignal.timeout(15_000)});
  // Never include the response body: a bad request can echo the secret back.
  if(!token.ok)return fail("Google didn't accept the sign-in (HTTP "+token.status+"). Try again.");
  const access=(await token.json() as {access_token?:string}).access_token;
  if(!access)return fail("Google didn't accept the sign-in. Try again.");
  const me=await fetch(urls.api+"/v1/userinfo",{headers:{Authorization:"Bearer "+access},signal:AbortSignal.timeout(15_000)});
  if(!me.ok)return fail("Couldn't read your Google account (HTTP "+me.status+"). Try again.");
  info=await me.json();
 }catch{return fail("Couldn't reach Google. Try again in a minute.");}
 const user=googleAccount(info);
 if("problem" in user)return fail(user.problem);
 const db=database(),now=new Date().toISOString();
 const linked=await db.prepare("SELECT owner FROM auth_identities WHERE provider='google' AND provider_id=?").bind(user.id).first<{owner:string}>();
 // Already signed in another way (Access, or Twitch): this links Google to that workspace.
 const current=linked?null:(await currentUser())?.userId??null;
 const pick=ownerFor({linked:linked?.owner??null,current,provider:"google",providerId:user.id,open:signupsOpen((env as {CLIPFLOW_SIGNUPS?:string}).CLIPFLOW_SIGNUPS)});
 if("refused" in pick)return fail(pick.refused);
 const session=randomToken(),expires=new Date(Date.now()+SESSION_DAYS*86_400_000).toISOString();
 const statements=[
  // login: the email (Google accounts have no handle), shown in Settings → Account & data.
  db.prepare("INSERT INTO auth_identities (provider,provider_id,owner,login,email,display_name,created_at,last_sign_in) VALUES ('google',?,?,?,?,?,?,?) ON CONFLICT(provider,provider_id) DO UPDATE SET login=excluded.login,email=excluded.email,display_name=excluded.display_name,last_sign_in=excluded.last_sign_in")
   .bind(user.id,pick.owner,user.email??"",user.email,user.name,now,now),
  db.prepare("INSERT INTO sessions (token_hash,owner,display_name,created_at,expires_at) VALUES (?,?,?,?,?)").bind(await sha256(session),pick.owner,user.name||null,now,expires),
  // Old sessions go when anyone signs in, so the table stays small.
  db.prepare("DELETE FROM sessions WHERE expires_at<=?").bind(now),
 ];
 if(pick.link)statements.push(db.prepare("INSERT INTO events (id,owner,message,created_at) VALUES (?,?,?,?)").bind(crypto.randomUUID(),pick.owner,(current?"Linked the Google account ":"Signed up with the Google account ")+(user.email??user.name)+" for signing in.",now));
 await db.batch(statements);
 const headers=new Headers({Location:origin+back,"Cache-Control":"no-store"});
 headers.append("Set-Cookie",clearState);
 headers.append("Set-Cookie",cookie(SESSION_COOKIE,session,{maxAge:SESSION_DAYS*86_400,secure}));
 return new Response(null,{status:302,headers});
}
