import { env } from "cloudflare:workers";
import { currentUser, signInPath } from "../../../auth";
import { database } from "../../../../db/raw";
import { billingOn, stripeBase, stripeKey, workspaceStanding } from "../../../../lib/billing";
import { isPlan } from "../../../../lib/plans.mjs";
import { checkoutParams, stripe } from "../../../../lib/stripe.mjs";
export const dynamic="force-dynamic";
// Settings → Plan → Choose: a Stripe Checkout page for that plan. The card is entered on Stripe's page, never here; the
// webhook (app/api/stripe/webhook) records the result.
export async function POST(request:Request){
 const user=await currentUser();if(!user)return Response.json({error:"Sign in first.",signIn:signInPath()},{status:401});
 const origin=new URL(request.url).origin,from=request.headers.get("origin");
 if(from&&from!==origin)return Response.json({error:"Request origin rejected."},{status:403});
 if(!billingOn(env))return Response.json({error:"Plans aren't set up on this site."},{status:404});
 const body=await request.json().catch(()=>null) as {plan?:unknown}|null;
 const plan=typeof body?.plan==="string"&&isPlan(body.plan)?body.plan:null;
 if(!plan)return Response.json({error:"Choose Streamer or Clipper / Agency."},{status:400});
 try{
  const db=database(),{customer}=await workspaceStanding(db,user.userId);
  // The sign-in email (Twitch) prefills Stripe's form for a first purchase.
  const email=customer?null:(await db.prepare("SELECT email FROM auth_identities WHERE owner=? AND email IS NOT NULL LIMIT 1").bind(user.userId).first<{email:string}>())?.email??(user.displayName.includes("@")?user.displayName:null);
  const session=await stripe(stripeKey(env),"/checkout/sessions",checkoutParams({plan,owner:user.userId,origin,customer,email}),{base:stripeBase(env)});
  return Response.json({url:session.url},{headers:{"Cache-Control":"no-store"}});
 }catch(error){console.error("Checkout failed",error);return Response.json({error:"Couldn't open checkout: "+(error as Error).message},{status:502});}
}
