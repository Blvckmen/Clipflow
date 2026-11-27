import { env } from "cloudflare:workers";
import { twitchApp } from "../../../../auth";
import { STATE_COOKIE, cookie, randomToken, safeReturn, twitchAuthorizeUrl, twitchUrls } from "../../../../../lib/app-auth.mjs";
export const dynamic="force-dynamic";
// Sign in with Twitch, step 1: off to Twitch's own sign-in, with a one-time state (and where to come back to) in a
// short-lived cookie that the callback checks, so nobody else's sign-in can be slipped into this browser.
export async function GET(request:Request){
 const url=new URL(request.url),app=twitchApp();
 if(!app)return Response.redirect(url.origin+"/?signin_error="+encodeURIComponent("Sign in with Twitch isn't set up on this site yet."),302);
 const state=randomToken(),back=safeReturn(url.searchParams.get("return_to"));
 const secure=url.protocol==="https:";
 return new Response(null,{status:302,headers:{
  Location:twitchAuthorizeUrl({clientId:app.clientId,redirectUri:url.origin+"/api/auth/twitch/callback",state,auth:twitchUrls(env).auth}),
  "Set-Cookie":cookie(STATE_COOKIE,state+"."+encodeURIComponent(back),{path:"/api/auth",maxAge:600,secure}),
  "Cache-Control":"no-store",
 }});
}
