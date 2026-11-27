import { currentUser, signInPath } from "../../../auth";
import { database } from "../../../../db/raw";
import { exportWorkspace } from "../../../../lib/account-data";
export const dynamic="force-dynamic";
// Settings → Your data → Download my data: everything this workspace holds, as a JSON file (secrets left out).
export async function GET(request:Request){
 const user=await currentUser();
 if(!user)return Response.redirect(new URL(request.url).origin+signInPath(),302);
 const data=await exportWorkspace(database(),user.userId);
 return new Response(JSON.stringify(data,null,1),{headers:{"Content-Type":"application/json; charset=utf-8","Content-Disposition":"attachment; filename=\"clipflow-data-"+data.exportedAt.slice(0,10)+".json\"","Cache-Control":"private, no-store"}});
}
