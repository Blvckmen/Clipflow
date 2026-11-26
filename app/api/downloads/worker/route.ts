import { currentUser, signInPath } from "../../../auth";
import { bucket } from "../../../../db/raw";
export const dynamic="force-dynamic";
// Connect worker → Download the worker: the zip scripts/pack-worker.mjs makes, uploaded to R2 by the deploy. Only for
// someone signed in. It used to be a static file in public/, which only Cloudflare Access kept private; without Access
// in front of the dashboard (open sign-ups), a static file would be anyone's.
// The same key as scripts/deploy-cloudflare.mjs uploads to.
const WORKER_ZIP_KEY="downloads/clipflow-worker.zip";
export async function GET(request:Request){
 const url=new URL(request.url);
 if(!await currentUser())return Response.redirect(url.origin+signInPath(),302);
 const store=bucket();
 if(!store)return new Response("The worker download isn't available on this site (it has no file storage).",{status:503,headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"}});
 const object=await store.get(WORKER_ZIP_KEY);
 if(!object)return new Response("The worker download isn't on this site yet. It's added with each deploy.",{status:404,headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"}});
 return new Response(object.body,{headers:{"Content-Type":"application/zip","Content-Disposition":"attachment; filename=\"clipflow-worker.zip\"","Content-Length":String(object.size),"Cache-Control":"private, no-store"}});
}
