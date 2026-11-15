import { env } from "cloudflare:workers";
import { currentUser } from "../../../../auth";
import { database } from "../../../../../db/raw";
import { workspaceZernio } from "../../../../../lib/publisher";
import { connectUrl, defaultProfile, VIDEO_PLATFORMS, ZernioError } from "../../../../../lib/zernio";
export const dynamic="force-dynamic";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Starts connecting a social account: the browser goes to the platform's own sign-in (through Zernio) and comes
// back to /api/connections/zernio/callback. ?platform=tiktok|instagram|youtube|facebook|twitter|threads;
// ?streamer=<id> links the new account to that streamer.
export async function GET(request:Request){
 const url=new URL(request.url),origin=url.origin;
 const back=(message:string)=>Response.redirect(origin+"/?connect_error="+encodeURIComponent(message),302);
 const user=await currentUser();
 if(!user)return back("Sign in before connecting an account.");
 const platform=url.searchParams.get("platform")??"";
 if(!VIDEO_PLATFORMS[platform])return back("That platform can't be connected.");
 const prefs=await database().prepare("SELECT zernio_key_enc FROM preferences WHERE owner=?").bind(user.userId).first<{zernio_key_enc:string|null}>();
 const config=await workspaceZernio(env,prefs?.zernio_key_enc).catch(()=>null);
 if(!config)return back("Add your Zernio API key under Connections first.");
 try{
  const authUrl=await connectUrl(config,platform,await defaultProfile(config),origin+"/api/connections/zernio/callback");
  // Which streamer to link travels in a short-lived cookie (the callback checks it belongs to this user).
  const streamer=url.searchParams.get("streamer");
  return new Response(null,{status:302,headers:{
   Location:authUrl,
   "Set-Cookie":"zn_connect="+(streamer&&UUID.test(streamer)?streamer:"-")+"; Path=/api/connections/zernio; Max-Age=900; HttpOnly; Secure; SameSite=Lax",
   "Cache-Control":"no-store",
  }});
 }catch(error){
  console.error("Zernio connect failed",error);
  return back(error instanceof ZernioError&&error.keyInvalid?"Zernio refused your API key. Enter a new one under Connections.":"Couldn't start connecting "+VIDEO_PLATFORMS[platform]+". Please try again.");
 }
}
