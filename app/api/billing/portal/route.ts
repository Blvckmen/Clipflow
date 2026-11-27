import { env } from "cloudflare:workers";
import { currentUser, signInPath } from "../../../auth";
import { database } from "../../../../db/raw";
import { billingOn, stripeBase, stripeKey, workspaceStanding } from "../../../../lib/billing";
import { stripe } from "../../../../lib/stripe.mjs";
export const dynamic="force-dynamic";
// Settings → Plan → Manage: Stripe's billing portal (invoices, card, change plan, cancel) for this workspace's customer.
export async function POST(request:Request){
 const user=await currentUser();if(!user)return Response.json({error:"Sign in first.",signIn:signInPath()},{status:401});
 const origin=new URL(request.url).origin,from=request.headers.get("origin");
 if(from&&from!==origin)return Response.json({error:"Request origin rejected."},{status:403});
 if(!billingOn(env))return Response.json({error:"Plans aren't set up on this site."},{status:404});
 try{
  const {customer}=await workspaceStanding(database(),user.userId);
  if(!customer)return Response.json({error:"There's no subscription to manage yet. Choose a plan first."},{status:409});
  const session=await stripe(stripeKey(env),"/billing_portal/sessions",{customer,return_url:origin+"/"},{base:stripeBase(env)});
  return Response.json({url:session.url},{headers:{"Cache-Control":"no-store"}});
 }catch(error){console.error("Billing portal failed",error);return Response.json({error:"Couldn't open billing: "+(error as Error).message},{status:502});}
}
