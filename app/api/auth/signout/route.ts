import { database } from "../../../../db/raw";
import { SESSION_COOKIE, cookie, isToken, readCookie, sha256 } from "../../../../lib/app-auth.mjs";
export const dynamic="force-dynamic";
// Ends this browser's Clipflow session (its row and its cookie). POST only, so a link on another site can't sign
// anyone out.
export async function POST(request:Request){
 const url=new URL(request.url),token=readCookie(request.headers.get("cookie"),SESSION_COOKIE);
 if(isToken(token))await database().prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(token)).run().catch(()=>{});
 return new Response(null,{status:303,headers:{Location:url.origin+"/","Set-Cookie":cookie(SESSION_COOKIE,"",{maxAge:0,secure:url.protocol==="https:"}),"Cache-Control":"no-store"}});
}
