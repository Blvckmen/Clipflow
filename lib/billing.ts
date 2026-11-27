import { refusal, standing, TRIAL_DAYS } from "./plans.mjs";

export type Standing = ReturnType<typeof standing>;
type BillingRow = { plan: string | null; status: string; trial_ends_at: string | null; stripe_customer: string | null };
type Env = { STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string };

// Billing is on only with a Stripe key; without one nothing is limited (self-hosting, tests, before launch).
export const billingOn = (env: unknown) => !!(env as Env).STRIPE_SECRET_KEY;
export const stripeKey = (env: unknown) => (env as Env).STRIPE_SECRET_KEY ?? "";
// Stripe's API address; STRIPE_API_URL points it at a stand-in for tests.
export const stripeBase = (env: unknown) => (env as { STRIPE_API_URL?: string }).STRIPE_API_URL || "https://api.stripe.com/v1";

export async function billingRow(db: D1Database, owner: string) {
  return db.prepare("SELECT plan,status,trial_ends_at,stripe_customer FROM billing WHERE owner=?").bind(owner).first<BillingRow>();
}

/** A workspace's standing; the first look starts its trial (one row per workspace, kept even if it's never used). */
export async function workspaceStanding(db: D1Database, owner: string, now = Date.now()) {
  let row = await billingRow(db, owner);
  if (!row) {
    const ends = new Date(now + TRIAL_DAYS * 86_400_000).toISOString(), iso = new Date(now).toISOString();
    await db.prepare("INSERT OR IGNORE INTO billing (owner,plan,status,trial_ends_at,updated_at) VALUES (?,NULL,'trial',?,?)").bind(owner, ends, iso).run();
    row = await billingRow(db, owner);
  }
  return { standing: standing(row, now), customer: row?.stripe_customer ?? null };
}

/** Why the workspace can't add one more channel or publishing account, or null (always null with billing off). */
export async function limitReached(env: unknown, db: D1Database, owner: string, kind: "channels" | "accounts") {
  if (!billingOn(env)) return null;
  const { standing: s } = await workspaceStanding(db, owner);
  // Accounts: only working ones count, so reconnecting an expired one is never refused.
  const sql = kind === "channels" ? "SELECT count(*) AS n FROM streamers WHERE owner=?" : "SELECT count(*) AS n FROM accounts WHERE owner=? AND status='connected'";
  const have = (await db.prepare(sql).bind(owner).first<{ n: number }>())?.n ?? 0;
  return refusal(s, kind, have);
}

/** Whether automation should run for this workspace. Fails open: a billing problem must never stop recording. */
export async function automationAllowed(env: unknown, db: D1Database, owner: string) {
  if (!billingOn(env)) return true;
  try {
    const row = await billingRow(db, owner);
    return row ? standing(row).active : true;
  } catch (error) { console.error("Billing check failed; running as usual", error); return true; }
}
