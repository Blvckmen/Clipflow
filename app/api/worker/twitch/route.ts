import { env } from "cloudflare:workers";
import { database } from "../../../../db/raw";
import { workerOwner } from "../../../../lib/worker-auth";
import { helixQuery } from "../../../../lib/twitch-app.mjs";
export const dynamic="force-dynamic";
// The dashboard's own Twitch app (TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET, site secrets), lent to workers for the few
// Helix lookups viewers' clips need (worker/twitch.mjs Twitch.viaSite), so no customer creates a Twitch app. Only a
// worker with a valid token may ask, and only for users, clips and videos with the parameters those use.
// Answers this site makes itself carry x-clipflow, so the worker shows their reason; Twitch's own are passed on as they are.
const own=(error:string,status:number)=>Response.json({error},{status,headers:{"x-clipflow":"1","Cache-Control":"no-store"}});
// An app access token is good for about two months; kept per isolate and renewed when Twitch says it's expired.
let access:{token:string;until:number}|null=null;
async function appToken(id:string,secret:string,renew=false){
 if(!renew&&access&&access.until>Date.now())return access.token;
 const response=await fetch("https://id.twitch.tv/oauth2/token",{method:"POST",body:new URLSearchParams({client_id:id,client_secret:secret,grant_type:"client_credentials"})});
 // Never pass the body on: a bad request can echo the credentials back.
 if(!response.ok)throw new Error("Twitch app sign-in failed (HTTP "+response.status+")");
 const json=await response.json() as {access_token?:unknown;expires_in?:unknown};
 if(typeof json.access_token!=="string")throw new Error("Twitch app sign-in gave no token");
 access={token:json.access_token,until:Date.now()+Math.max(60,Number(json.expires_in)||3600)*1000-60_000};
 return access.token;
}
export async function GET(request:Request){
 const db=database();
 if(!await workerOwner(request,db))return own("Invalid worker token.",401);
 const id=(env as {TWITCH_CLIENT_ID?:string}).TWITCH_CLIENT_ID,secret=(env as {TWITCH_CLIENT_SECRET?:string}).TWITCH_CLIENT_SECRET;
 if(!id||!secret)return own("This site has no Twitch app set up yet, so viewers' Twitch clips can't be looked up.",501);
 const query=helixQuery(new URL(request.url).searchParams);
 if(!query)return own("Unsupported Twitch lookup.",400);
 try{
  for(let attempt=0;;attempt++){
   const response=await fetch("https://api.twitch.tv/helix/"+query.resource+"?"+query.params,{headers:{"Client-Id":id,Authorization:"Bearer "+await appToken(id,secret,attempt>0)}});
   if(response.status===401&&attempt===0)continue;
   if(!response.ok)return new Response(null,{status:response.status===404?404:502});
   return new Response(await response.text(),{headers:{"content-type":"application/json","Cache-Control":"no-store"}});
  }
 }catch(error){console.error("Twitch lookup failed",error);return own("Twitch couldn't be reached from this site. It will be tried again.",502);}
}
