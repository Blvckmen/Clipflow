import { env } from "cloudflare:workers";
import { currentUser } from "../../../../auth";
import { authorizeUrl } from "../../../../../lib/instagram";
import { instagramConfig } from "../../../../../lib/publisher";
import { database } from "../../../../../db/raw";
import { limitReached } from "../../../../../lib/billing";
export const dynamic="force-dynamic";
const STATE_COOKIE="ig_oauth_state";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Starts "Instagram Login": a random state in a short-lived cookie ties the callback to this browser and request.
// ?streamer=<id> links the connected account to that streamer; ?another=1 asks Instagram which account to use.
export async function GET(request:Request){
 const url=new URL(request.url),origin=url.origin;
 const back=(query:string)=>Response.redirect(origin+"/?"+query,302);
 const user=await currentUser();
 if(!user)return back("connect_error="+encodeURIComponent("Sign in before connecting an account."));
 // The plan's account limit (lib/plans.mjs; only with billing on). Reconnecting an expired account is never refused.
 const limited=await limitReached(env,database(),user.userId,"accounts");
 if(limited)return back("connect_error="+encodeURIComponent(limited));
 const config=instagramConfig(env);
 if(!config)return back("connect_error="+encodeURIComponent("Instagram publishing is not set up on this site yet."));
 const state=crypto.randomUUID(),streamer=url.searchParams.get("streamer");
 // The streamer travels in the cookie, not the state Instagram sees; the callback checks it belongs to the user.
 const cookie=state+(streamer&&UUID.test(streamer)?"."+streamer:"");
 return new Response(null,{status:302,headers:{
  Location:authorizeUrl(config,origin+"/api/connections/instagram/callback",state,url.searchParams.has("another")),
  "Set-Cookie":STATE_COOKIE+"="+cookie+"; Path=/api/connections/instagram; Max-Age=600; HttpOnly; Secure; SameSite=Lax",
  "Cache-Control":"no-store",
 }});
}
