import { env } from "cloudflare:workers";
import { googleApp } from "../../../../auth";
import { STATE_COOKIE, cookie, googleAuthorizeUrl, googleUrls, randomToken, safeReturn } from "../../../../../lib/app-auth.mjs";
export const dynamic="force-dynamic";
// Sign in with Google, step 1: off to Google's own sign-in, with a one-time state (and where to come back to) in a
// short-lived cookie that the callback checks, so nobody else's sign-in can be slipped into this browser.
export async function GET(request:Request){
 const url=new URL(request.url),app=googleApp();
 if(!app)return Response.redirect(url.origin+"/?signin_error="+encodeURIComponent("Sign in with Google isn't set up on this site yet."),302);
 const state=randomToken(),back=safeReturn(url.searchParams.get("return_to"));
 const secure=url.protocol==="https:";
 return new Response(null,{status:302,headers:{
  Location:googleAuthorizeUrl({clientId:app.clientId,redirectUri:url.origin+"/api/auth/google/callback",state,auth:googleUrls(env).auth}),
  "Set-Cookie":cookie(STATE_COOKIE,state+"."+encodeURIComponent(back),{path:"/api/auth",maxAge:600,secure}),
  "Cache-Control":"no-store",
 }});
}
