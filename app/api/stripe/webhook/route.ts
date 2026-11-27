import { env } from "cloudflare:workers";
import { database } from "../../../../db/raw";
import { billingChange, verifySignature } from "../../../../lib/stripe.mjs";
export const dynamic="force-dynamic";
// Stripe tells Clipflow about subscriptions here (checkout finished, renewed, payment failing, cancelled). Only events
// signed with this endpoint's secret (STRIPE_WEBHOOK_SECRET) count; the workspace is the one named in the metadata set
// at checkout. Answers 200 to events it doesn't need, so Stripe doesn't retry them.
export async function POST(request:Request){
 const secret=(env as {STRIPE_WEBHOOK_SECRET?:string}).STRIPE_WEBHOOK_SECRET;
 if(!secret)return Response.json({error:"Billing isn't set up."},{status:404});
 const payload=await request.text();
 if(!await verifySignature(payload,request.headers.get("stripe-signature"),secret))return Response.json({error:"Bad signature."},{status:400});
 let event;try{event=JSON.parse(payload);}catch{return Response.json({error:"Bad body."},{status:400});}
 const change=billingChange(event);
 if(!change)return Response.json({ok:true});
 const now=new Date().toISOString();
 // A later event for a different, older subscription (say, one replaced by a new checkout) doesn't undo the current
 // one: it only applies when it's about the subscription on file, or there's none yet, or it makes the plan active.
 await database().prepare("INSERT INTO billing (owner,plan,status,trial_ends_at,stripe_customer,stripe_subscription,period_end,updated_at) VALUES (?,?,?,NULL,?,?,?,?) ON CONFLICT(owner) DO UPDATE SET plan=coalesce(excluded.plan,billing.plan),status=excluded.status,stripe_customer=coalesce(excluded.stripe_customer,billing.stripe_customer),stripe_subscription=coalesce(excluded.stripe_subscription,billing.stripe_subscription),period_end=coalesce(excluded.period_end,billing.period_end),updated_at=excluded.updated_at WHERE billing.stripe_subscription IS NULL OR excluded.stripe_subscription IS NULL OR billing.stripe_subscription=excluded.stripe_subscription OR excluded.status IN ('active','trialing')")
  .bind(change.owner,change.plan,change.status,change.customer,change.subscription,change.periodEnd,now).run();
 return Response.json({ok:true});
}
