import { env } from "cloudflare:workers";
import { currentUser, signInPath } from "../../../auth";
import { bucket, database } from "../../../../db/raw";
import { deleteWorkspace } from "../../../../lib/account-data";
import { SESSION_COOKIE, cookie } from "../../../../lib/app-auth.mjs";
export const dynamic="force-dynamic";
// Settings → Your data → Delete workspace: everything, after typing DELETE. Its Stripe subscription is cancelled
// first; its sign-in sessions go too, so this browser is signed out.
export async function POST(request:Request){
 const user=await currentUser();if(!user)return Response.json({error:"Sign in first.",signIn:signInPath()},{status:401});
 const url=new URL(request.url),from=request.headers.get("origin");
 if(from&&from!==url.origin)return Response.json({error:"Request origin rejected."},{status:403});
 const body=await request.json().catch(()=>null) as {confirm?:unknown}|null;
 if(body?.confirm!=="DELETE")return Response.json({error:"Type DELETE to confirm."},{status:400});
 try{
  const done=await deleteWorkspace(env as {STRIPE_SECRET_KEY?:string;STRIPE_API_URL?:string},database(),bucket(),user.userId);
  console.log("Deleted a workspace:",done.rows,"rows,",done.files,"files");
  return Response.json({ok:true,...done},{headers:{"Set-Cookie":cookie(SESSION_COOKIE,"",{maxAge:0,secure:url.protocol==="https:"}),"Cache-Control":"no-store"}});
 }catch(error){console.error("Workspace deletion failed",error);return Response.json({error:(error as Error).message},{status:502});}
}
