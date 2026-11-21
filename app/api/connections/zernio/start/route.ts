import { env } from "cloudflare:workers";
import { currentUser } from "../../../../auth";
import { database } from "../../../../../db/raw";
import { connectionFor, connections } from "../../../../../lib/zernio-keys";
import { connectUrl, defaultProfile, VIDEO_PLATFORMS, ZernioError } from "../../../../../lib/zernio";
export const dynamic="force-dynamic";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Starts connecting a social account: the browser goes to the platform's own sign-in (through Zernio) and comes
// back to /api/connections/zernio/callback. ?platform=tiktok|instagram|youtube|facebook|twitter|threads;
// ?key=<zernio key id> chooses which of the workspace's Zernio keys it goes under (default: the first);
// ?streamer=<id> links the new account to that streamer.
export async function GET(request:Request){
 const url=new URL(request.url),origin=url.origin;
 const back=(message:string)=>Response.redirect(origin+"/?connect_error="+encodeURIComponent(message),302);
 const user=await currentUser();
 if(!user)return back("Sign in before connecting an account.");
 const platform=url.searchParams.get("platform")??"";
 if(!VIDEO_PLATFORMS[platform])return back("That platform can't be connected.");
 const db=database(),wanted=url.searchParams.get("key");
 const config=await (wanted?connectionFor(env,db,user.userId,wanted):connections(env,db,user.userId).then(all=>all[0]??null)).catch(()=>null);
 if(!config)return back(wanted?"That Zernio key is no longer in your workspace.":"Add a Zernio API key under Connections first.");
 try{
  const authUrl=await connectUrl(config,platform,await defaultProfile(config),origin+"/api/connections/zernio/callback");
  // Which key and streamer travel in a short-lived cookie; the callback checks both belong to this user.
  const streamer=url.searchParams.get("streamer");
  const cookie=(streamer&&UUID.test(streamer)?streamer:"-")+"."+(config.keyId??"-");
  return new Response(null,{status:302,headers:{
   Location:authUrl,
   "Set-Cookie":"zn_connect="+cookie+"; Path=/api/connections/zernio; Max-Age=900; HttpOnly; Secure; SameSite=Lax",
   "Cache-Control":"no-store",
  }});
 }catch(error){
  console.error("Zernio connect failed",error);
  if(error instanceof ZernioError){
   if(error.keyInvalid)return back("Zernio refused the key "+config.label+". Remove it and add a new one under Connections.");
   // Say why, and the two ways out: pay on Zernio, or connect under another (free) Zernio key.
   if(error.accountLimit)return back("The Zernio account "+config.label+" is full: its free plan holds 2 social accounts. Add a payment method at zernio.com → Billing, or add another Zernio key under Connections and connect "+VIDEO_PLATFORMS[platform]+" under that key.");
   return back("Couldn't start connecting "+VIDEO_PLATFORMS[platform]+": "+error.message.replace(/^Zernio: /,"").slice(0,200));
  }
  return back("Couldn't start connecting "+VIDEO_PLATFORMS[platform]+". Please try again.");
 }
}
