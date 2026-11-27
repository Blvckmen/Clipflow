// Stripe over its REST API (no SDK, so it runs in the Worker as is). Checkout takes the card on Stripe's own page;
// the billing portal is Stripe's page for invoices, card changes and cancelling; the webhook tells Clipflow what
// changed, signed with the endpoint's secret (Stripe-Signature).
import { PLANS, isPlan } from "./plans.mjs";

export const STRIPE_API = "https://api.stripe.com/v1";

// Stripe's form encoding: nested objects and arrays as a[b][0][c]=v.
export function formEncode(value, prefix = "", out = new URLSearchParams()) {
  if (value === undefined || value === null) return out;
  if (typeof value === "object") {
    for (const [k, v] of Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value)) formEncode(v, prefix ? prefix + "[" + k + "]" : k, out);
  } else out.append(prefix, String(value));
  return out;
}

export async function stripe(key, path, params, { method = "POST", fetchImpl = fetch, base = STRIPE_API } = {}) {
  const response = await fetchImpl(base + path, {
    method, headers: { Authorization: "Bearer " + key, ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    ...(method === "POST" ? { body: formEncode(params ?? {}).toString() } : {}), signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => null);
  // Stripe's own message only (it never echoes the key).
  if (!response.ok) throw Object.assign(new Error(body?.error?.message ?? "Stripe answered HTTP " + response.status), { status: response.status });
  return body;
}

/**
 * A Checkout Session for a monthly subscription to `plan`, its price set here (no products to create in Stripe).
 * @param {{ plan: string, owner: string, origin: string, customer?: string | null, email?: string | null }} options
 */
export function checkoutParams({ plan, owner, origin, customer = null, email = null }) {
  if (!isPlan(plan)) throw new Error("Unknown plan");
  const p = PLANS[plan], meta = { owner, plan };
  return {
    mode: "subscription", client_reference_id: owner, metadata: meta, allow_promotion_codes: true,
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: p.price, recurring: { interval: "month" }, product_data: { name: "Clipflow " + p.name } } }],
    subscription_data: { metadata: meta },
    success_url: origin + "/?billing=done", cancel_url: origin + "/?billing=cancelled",
    ...(customer ? { customer } : email ? { customer_email: email } : {}),
  };
}

const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
/** Whether `payload` (the raw body) was signed by Stripe with `secret`, no more than `tolerance` seconds ago. */
export async function verifySignature(payload, header, secret, { now = Date.now(), tolerance = 300 } = {}) {
  const parts = Object.groupBy(String(header ?? "").split(",").map(p => p.split("=")), ([k]) => k.trim());
  const t = Number(parts.t?.[0]?.[1]), sigs = (parts.v1 ?? []).map(([, v]) => v);
  if (!secret || !Number.isFinite(t) || !sigs.length || Math.abs(now / 1000 - t) > tolerance) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(t + "." + payload)));
  // Compared in full whatever the first difference, so the time taken says nothing about the signature.
  return sigs.some(s => s.length === expected.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ expected.charCodeAt(i)), 0) === 0);
}

/**
 * What a webhook event changes for a workspace: { owner, plan, status, customer, subscription, periodEnd } (nulls
 * where the event doesn't say), or null for events that don't concern billing.
 */
export function billingChange(event) {
  const o = event?.data?.object;
  if (!o) return null;
  if (event.type === "checkout.session.completed" && o.mode === "subscription") {
    const owner = o.client_reference_id ?? o.metadata?.owner;
    return owner ? { owner, plan: isPlan(o.metadata?.plan) ? o.metadata.plan : null, status: "active", customer: o.customer ?? null, subscription: o.subscription ?? null, periodEnd: null } : null;
  }
  if (/^customer\.subscription\.(created|updated|deleted)$/.test(event.type)) {
    const owner = o.metadata?.owner;
    if (!owner) return null;
    const end = o.current_period_end ?? o.items?.data?.[0]?.current_period_end;
    return { owner, plan: isPlan(o.metadata?.plan) ? o.metadata.plan : null, status: event.type.endsWith("deleted") ? "canceled" : String(o.status ?? "active"), customer: o.customer ?? null, subscription: o.id ?? null, periodEnd: Number.isFinite(end) ? new Date(end * 1000).toISOString() : null };
  }
  return null;
}
