import { database, bucket } from "../../../../db/raw";
import { workerOwner } from "../../../../lib/worker-auth";
export const dynamic="force-dynamic";
// The worker download for a worker updating itself (worker/update.mjs): the same zip as Connect worker → Download the
// worker (app/api/downloads/worker), uploaded to R2 by each deploy, for a worker's own bearer token.
const KEY="downloads/clipflow-worker.zip";
export async function GET(request:Request){
 const db=database();
 if(!await workerOwner(request,db))return Response.json({error:"Invalid worker token."},{status:401});
 const object=await bucket()?.get(KEY);
 if(!object)return Response.json({error:"No worker download on this site yet."},{status:404});
 return new Response(object.body,{headers:{"Content-Type":"application/zip","Content-Length":String(object.size),"Cache-Control":"private, no-store"}});
}
