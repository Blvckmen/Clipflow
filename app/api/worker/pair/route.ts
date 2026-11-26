import { database } from "../../../../db/raw";
import { hashToken, newToken } from "../../../../lib/worker-auth";
import { hashPairCode, normalizePairCode } from "../../../../lib/pairing.mjs";
export const dynamic="force-dynamic";
// A PC trades a pairing code from Connect worker for a worker token (worker/pair.mjs). Like Create worker token, the
// new token replaces (revokes) any earlier one. The code works once: it's deleted in the same statement that finds it.
export async function POST(request:Request){
 const wrong=()=>Response.json({error:"That code is wrong or has expired. Make a new one under Connect worker in the dashboard."},{status:400});
 try{
  const body=await request.json().catch(()=>null) as {code?:unknown}|null;
  const code=normalizePairCode(body?.code);
  if(!code)return wrong();
  const db=database(),now=new Date().toISOString();
  const row=await db.prepare("DELETE FROM pairing_codes WHERE code_hash=? AND expires_at>? RETURNING owner").bind(await hashPairCode(code),now).first<{owner:string}>();
  if(!row)return wrong();
  const token=newToken();
  await db.batch([
   db.prepare("INSERT INTO worker_tokens (owner,token_hash,created_at,last_seen) VALUES (?,?,?,NULL) ON CONFLICT(owner) DO UPDATE SET token_hash=excluded.token_hash,created_at=excluded.created_at,last_seen=NULL,last_error=NULL,last_error_at=NULL").bind(row.owner,await hashToken(token),now),
   db.prepare("INSERT INTO events (id,owner,message,created_at) VALUES (?,?,?,?)").bind(crypto.randomUUID(),row.owner,"Paired a PC with a pairing code. Any previous worker token was revoked.",now),
  ]);
  return Response.json({token,url:new URL(request.url).origin},{headers:{"Cache-Control":"private, no-store"}});
 }catch(error){console.error("Pairing failed",error);return Response.json({error:"Pairing didn't work this time. Try again in a minute."},{status:503});}
}
