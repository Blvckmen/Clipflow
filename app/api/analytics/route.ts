import { currentUser } from "../../auth";
import { database } from "../../../db/raw";
import { analyticsSummary } from "../../../lib/analytics";
export const dynamic="force-dynamic";
// The Analytics page's numbers. Kept out of the dashboard load because they count the whole clip and post history:
// the dashboard reloads after every change, and D1 bills (and on the free plan caps) every row read.
export async function GET(){
 const user=await currentUser();if(!user)return Response.json({error:"Sign in to see analytics."},{status:401});
 try{return Response.json({analytics:await analyticsSummary(database(),user.userId)},{headers:{"Cache-Control":"private, max-age=120"}});}
 catch(error){console.error("Analytics load failed",error);return Response.json({error:"Analytics are unavailable right now."},{status:503});}
}
