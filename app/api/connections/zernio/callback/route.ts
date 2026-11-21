import { env } from "cloudflare:workers";
import { currentUser } from "../../../../auth";
import { database } from "../../../../../db/raw";
import { connectionFor, connections } from "../../../../../lib/zernio-keys";
import { VIDEO_PLATFORMS } from "../../../../../lib/zernio";
import { syncZernioAccounts } from "../../../../../lib/zernio-sync";
export const dynamic="force-dynamic";
// Where Zernio sends the browser after a platform sign-in: ?connected=<platform>&accountId=..&username=.. or
// ?error=..&platform=... Nothing in the query is trusted: accounts are read back from Zernio with the workspace's
// own key, so a forged link can only re-sync the user's own accounts.
export async function GET(request:Request){
 const url=new URL(request.url),origin=url.origin,q=url.searchParams;
 const [streamer,keyId]=(/(?:^|;\s*)zn_connect=([^;]+)/.exec(request.headers.get("cookie")??"")?.[1]??"").split(".");
 const clear="zn_connect=; Path=/api/connections/zernio; Max-Age=0; HttpOnly; Secure; SameSite=Lax";
 const back=(query:string)=>new Response(null,{status:302,headers:{Location:origin+"/?"+query,"Set-Cookie":clear,"Cache-Control":"no-store"}});
 const user=await currentUser();
 if(!user)return back("connect_error="+encodeURIComponent("Sign in before connecting an account."));
 const name=VIDEO_PLATFORMS[q.get("platform")??q.get("connected")??""]??"the account";
 if(q.get("error"))return back("connect_error="+encodeURIComponent((q.get("error_message")||"Connecting "+name+" was cancelled or refused.").slice(0,200)));
 const db=database(),owner=user.userId;
 // The key the sign-in was started with; without the cookie (another browser), the first key.
 const config=await (keyId&&keyId!=="-"?connectionFor(env,db,owner,keyId):connections(env,db,owner).then(all=>all[0]??null)).catch(()=>null);
 if(!config)return back("connect_error="+encodeURIComponent("Add a Zernio API key under Connections first."));
 try{
  const result=await syncZernioAccounts(db,owner,config);
  const accountId=q.get("accountId");
  const row=accountId?await db.prepare("SELECT id,username,platform FROM accounts WHERE owner=? AND provider='zernio' AND external_id=?").bind(owner,accountId).first<{id:string;username:string;platform:string}>():null;
  const iso=new Date().toISOString(),statements:D1PreparedStatement[]=[];
  // Started from a streamer: post that streamer's clips here too.
  if(row&&streamer&&streamer!=="-")statements.push(db.prepare("INSERT OR IGNORE INTO streamer_accounts (streamer_id,account_id,owner,created_at) SELECT id,?,owner,? FROM streamers WHERE id=? AND owner=?").bind(row.id,iso,streamer,owner));
  statements.push(db.prepare("INSERT INTO events (id,owner,message,created_at) VALUES (?,?,?,?)").bind(crypto.randomUUID(),owner,row?"Connected "+(VIDEO_PLATFORMS[row.platform]??row.platform)+" account @"+row.username+".":result.message,iso));
  await db.batch(statements);
  return back("connected="+encodeURIComponent(row?.platform??q.get("connected")??"account")+(row?"&account="+encodeURIComponent(row.username):""));
 }catch(error){
  console.error("Zernio connect callback failed",error);
  return back("connect_error="+encodeURIComponent("Connected, but Clipflow couldn't read the account from Zernio. Press Refresh under Connections."));
 }
}
