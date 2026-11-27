"use client";
import { useState } from "react";
import { CreditCard, Loader2 } from "lucide-react";

type Limits = { channels: number; accounts: number } | null;
type PlanInfo = { name: string; price: number; channels: number; accounts: number };
// Settings → Plan, from the dashboard's `plan` (app/api/dashboard; lib/plans.mjs): only shown with billing on.
export type Plan = { plan: string; status: string; active: boolean; limits: Limits; trialEndsAt: string | null; canManage: boolean; usage: { channels: number; accounts: number }; plans: Record<string, PlanInfo> };

const money = (cents: number) => "$" + (cents / 100).toFixed(cents % 100 ? 2 : 0);
const daysLeft = (iso: string) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));

// Checkout and the billing portal are Stripe's own pages; the server hands back where to go.
async function goTo(path: string, body: object, setBusy: (v: string) => void, setError: (v: string) => void, key: string) {
  setBusy(key); setError("");
  try {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({})) as { url?: string; error?: string };
    if (!response.ok || !result.url) throw new Error(result.error ?? "That didn't work. Try again.");
    window.top!.location.href = result.url;
  } catch (error) { setError((error as Error).message); setBusy(""); }
}

export function PlanPanel({ plan }: { plan: Plan }) {
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  const current = plan.plans[plan.plan], limits = plan.limits;
  const headline = plan.plan === "comped" ? "Free: this workspace isn't billed."
    : plan.plan === "trial" ? (plan.active ? "Free trial: " + daysLeft(plan.trialEndsAt!) + " day" + (daysLeft(plan.trialEndsAt!) === 1 ? "" : "s") + " left." : "Your free trial has ended. Recording and posting are paused until you choose a plan.")
    : (current?.name ?? plan.plan) + (plan.active ? (plan.status === "past_due" ? ": a payment failed. Stripe will try again; update your card to keep going." : ": active.") : ": not active. Recording and posting are paused until your payment is sorted.");
  return <section className="panel settings-group"><div className="group-head"><CreditCard size={18}/><div><h2>Plan</h2><p>{headline}</p></div></div><div className="group-body">
    {limits && <p>Using {plan.usage.channels} of {limits.channels} channel{limits.channels === 1 ? "" : "s"} and {plan.usage.accounts} of {limits.accounts} publishing accounts.</p>}
    {plan.plan !== "comped" && (plan.canManage
      ? <p><button className="secondary" type="button" disabled={!!busy} onClick={() => goTo("/api/billing/portal", {}, setBusy, setError, "portal")}>{busy === "portal" ? <Loader2 size={15} className="spin"/> : null}Manage billing</button><small> Invoices, card, switching plan or cancelling, on Stripe.</small></p>
      : <div className="plan-choices">{Object.entries(plan.plans).map(([id, p]) => <div key={id} className="plan-choice"><strong>{p.name}</strong><span>{money(p.price)} a month</span><small>{p.channels === 1 ? "1 channel" : p.channels + " channels"}, {p.accounts} publishing accounts</small>
        <button className="primary" type="button" disabled={!!busy} onClick={() => goTo("/api/billing/checkout", { plan: id }, setBusy, setError, id)}>{busy === id ? <Loader2 size={15} className="spin"/> : null}Choose {p.name}</button></div>)}</div>)}
    {error && <p className="field-error" role="alert">{error}</p>}
  </div></section>;
}
