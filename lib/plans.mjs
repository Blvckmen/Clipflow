// Plans and what a workspace may do on its plan. Billing is on only when the site has a Stripe key
// (STRIPE_SECRET_KEY); without one nothing here is enforced. A new workspace gets a TRIAL_DAYS trial with the
// Agency limits; workspaces from before billing are "comped" (migration 0045) and never limited.

export const TRIAL_DAYS = 14;
// price: US cents a month. channels: streamers it clips; accounts: publishing accounts it posts to.
export const PLANS = {
  streamer: { name: "Streamer", price: 1200, channels: 1, accounts: 3 },
  agency: { name: "Clipper / Agency", price: 4900, channels: 10, accounts: 20 },
};
export const isPlan = id => Object.hasOwn(PLANS, id);

// Stripe subscription statuses that keep a workspace running. past_due: a payment failed and Stripe is retrying; the
// workspace keeps working meanwhile.
const RUNNING = new Set(["active", "trialing", "past_due"]);

/**
 * Where a workspace stands: { plan, status, active, limits: { channels, accounts } | null (no limit), trialEndsAt }.
 * `row` is its billing row (null: none yet, a trial that starts now).
 */
export function standing(row, now = Date.now()) {
  if (row?.status === "comped") return { plan: "comped", status: "comped", active: true, limits: null, trialEndsAt: null };
  const plan = isPlan(row?.plan) ? row.plan : null;
  if (!row || row.status === "trial") {
    const ends = row?.trial_ends_at ? Date.parse(row.trial_ends_at) : now + TRIAL_DAYS * 86_400_000;
    const active = ends > now;
    return { plan: "trial", status: active ? "trial" : "trial_ended", active, limits: limitsOf("agency"), trialEndsAt: new Date(ends).toISOString() };
  }
  return { plan: plan ?? "streamer", status: row.status, active: RUNNING.has(row.status), limits: limitsOf(plan ?? "streamer"), trialEndsAt: null };
}
const limitsOf = id => ({ channels: PLANS[id].channels, accounts: PLANS[id].accounts });

/** Why one more channel or account isn't allowed (`have`: how many there are now), or null when it is. */
export function refusal(s, kind, have) {
  if (!s.active) return s.status === "trial_ended" ? "Your free trial has ended. Choose a plan under Settings → Plan to keep clipping." : "Your plan isn't active. Update your payment under Settings → Plan to keep clipping.";
  const limit = s.limits?.[kind];
  if (limit == null || have < limit) return null;
  const what = kind === "channels" ? (limit === 1 ? "1 channel" : limit + " channels") : limit + " publishing accounts";
  return "Your plan covers " + what + ". " + (s.plan === "agency" || s.plan === "trial" ? "Remove one first, or contact us for more." : "Upgrade to Clipper / Agency under Settings → Plan for more.");
}
