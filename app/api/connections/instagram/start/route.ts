import { env } from "cloudflare:workers";
import { currentUser } from "../../../../auth";
import { authorizeUrl } from "../../../../../lib/instagram";
import { instagramConfig } from "../../../../../lib/publisher";
export const dynamic="force-dynamic";
const STATE_COOKIE="ig_oauth_state";
// Starts "Instagram Login": a random state in a short-lived cookie ties the callback to this browser and request.
export async function GET(request:Request){
 const origin=new URL(request.url).origin;
 const back=(query:string)=>Response.redirect(origin+"/?"+query,302);
 if(!await currentUser())return back("connect_error="+encodeURIComponent("Sign in before connecting an account."));
 const config=instagramConfig(env);
 if(!config)return back("connect_error="+encodeURIComponent("Instagram publishing is not set up on this site yet."));
 const state=crypto.randomUUID();
 return new Response(null,{status:302,headers:{
  Location:authorizeUrl(config,origin+"/api/connections/instagram/callback",state),
  "Set-Cookie":STATE_COOKIE+"="+state+"; Path=/api/connections/instagram; Max-Age=600; HttpOnly; Secure; SameSite=Lax",
  "Cache-Control":"no-store",
 }});
}
