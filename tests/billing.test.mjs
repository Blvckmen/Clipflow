import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { PLANS, TRIAL_DAYS, refusal, standing } from "../lib/plans.mjs";
import { billingChange, checkoutParams, formEncode, verifySignature } from "../lib/stripe.mjs";

const now = Date.parse("2026-11-26T12:00:00Z"), day = 86_400_000;

test("a new workspace is on a 14-day trial with the Agency limits, then must choose a plan", () => {
  const fresh = standing(null, now);
  assert.deepEqual(fresh, { plan: "trial", status: "trial", active: true, limits: { channels: 10, accounts: 20 }, trialEndsAt: new Date(now + TRIAL_DAYS * day).toISOString() });
  const ended = standing({ status: "trial", trial_ends_at: new Date(now - 1).toISOString() }, now);
  assert.equal(ended.active, false);
  assert.match(refusal(ended, "channels", 0), /trial has ended/);
});

test("workspaces from before billing are comped: never limited", () => {
  const s = standing({ status: "comped" }, now);
  assert.equal(s.active, true);
  assert.equal(refusal(s, "channels", 500), null);
});

test("a paid plan's limits; a failed payment keeps it running while Stripe retries; cancelled stops it", () => {
  const streamer = standing({ plan: "streamer", status: "active" }, now);
  assert.equal(refusal(streamer, "channels", 0), null);
  assert.match(refusal(streamer, "channels", 1), /covers 1 channel\. Upgrade/);
  assert.match(refusal(streamer, "accounts", 3), /3 publishing accounts/);
  assert.equal(standing({ plan: "agency", status: "past_due" }, now).active, true);
  const gone = standing({ plan: "agency", status: "canceled" }, now);
  assert.equal(gone.active, false);
  assert.match(refusal(gone, "channels", 0), /plan isn't active/);
  assert.match(refusal(standing({ plan: "agency", status: "active" }, now), "channels", 10), /Remove one first/);
});

test("Stripe's form encoding nests objects and arrays with brackets", () => {
  assert.equal(decodeURIComponent(formEncode({ a: 1, b: { c: [{ d: "x" }] }, skip: null }).toString()), "a=1&b[c][0][d]=x");
});

test("checkout: a monthly subscription priced here, tied to the workspace both ways", () => {
  const p = checkoutParams({ plan: "agency", owner: "twitch:1", origin: "https://x.dev", email: "a@b.c" });
  assert.equal(p.mode, "subscription");
  assert.equal(p.client_reference_id, "twitch:1");
  assert.deepEqual(p.subscription_data.metadata, { owner: "twitch:1", plan: "agency" });
  assert.equal(p.line_items[0].price_data.unit_amount, PLANS.agency.price);
  assert.equal(p.line_items[0].price_data.recurring.interval, "month");
  assert.equal(p.customer_email, "a@b.c");
  assert.equal(checkoutParams({ plan: "streamer", owner: "o", origin: "https://x.dev", customer: "cus_1", email: "a@b.c" }).customer, "cus_1");
  assert.throws(() => checkoutParams({ plan: "gold", owner: "o", origin: "x" }));
});

test("webhook signatures: Stripe's scheme, recent only, and a wrong secret or body fails", async () => {
  const body = JSON.stringify({ id: "evt_1" }), t = Math.floor(now / 1000);
  const sig = createHmac("sha256", "whsec_test").update(t + "." + body).digest("hex");
  assert.equal(await verifySignature(body, "t=" + t + ",v1=" + sig, "whsec_test", { now }), true);
  assert.equal(await verifySignature(body, "t=" + t + ",v1=" + sig, "whsec_other", { now }), false);
  assert.equal(await verifySignature(body + " ", "t=" + t + ",v1=" + sig, "whsec_test", { now }), false);
  assert.equal(await verifySignature(body, "t=" + t + ",v1=" + sig, "whsec_test", { now: now + 600_000 }), false, "too old");
  assert.equal(await verifySignature(body, "", "whsec_test", { now }), false);
});

test("which webhook events change a workspace's plan", () => {
  assert.deepEqual(billingChange({ type: "checkout.session.completed", data: { object: { mode: "subscription", client_reference_id: "o1", customer: "cus_1", subscription: "sub_1", metadata: { plan: "streamer" } } } }),
    { owner: "o1", plan: "streamer", status: "active", customer: "cus_1", subscription: "sub_1", periodEnd: null });
  const updated = billingChange({ type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_1", status: "past_due", current_period_end: 1767225600, metadata: { owner: "o1", plan: "agency" } } } });
  assert.deepEqual(updated, { owner: "o1", plan: "agency", status: "past_due", customer: "cus_1", subscription: "sub_1", periodEnd: "2026-01-01T00:00:00.000Z" });
  assert.equal(billingChange({ type: "customer.subscription.deleted", data: { object: { id: "sub_1", status: "canceled", metadata: { owner: "o1" } } } }).status, "canceled");
  assert.equal(billingChange({ type: "invoice.paid", data: { object: {} } }), null);
  assert.equal(billingChange({ type: "customer.subscription.updated", data: { object: { id: "sub_x", metadata: {} } } }), null, "not one of ours");
});
