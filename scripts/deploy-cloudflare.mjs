// Deploys Clipflow to your own Cloudflare account, protected by Cloudflare Access.
//   node scripts/deploy-cloudflare.mjs --check   read-only: verify the token and account prerequisites
//   node scripts/deploy-cloudflare.mjs           build, provision (idempotent), migrate, deploy, smoke-test
// Settings come from the environment or a git-ignored .env file in the project root (see DEPLOY.md).
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ZIP_KEY, packWorker } from "./pack-worker.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const checkOnly = process.argv.includes("--check");

function loadDotEnv() {
  const file = join(root, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
loadDotEnv();
const env = process.env;
const token = env.CLOUDFLARE_API_TOKEN;
const workerName = env.CLIPFLOW_WORKER_NAME || "clipflow";
const dbName = env.CLIPFLOW_D1_NAME || "clipflow";
const bucketName = env.CLIPFLOW_R2_BUCKET || "clipflow-clips";
const allowed = (env.CLIPFLOW_ACCESS_EMAILS || "").split(",").map(s => s.trim()).filter(Boolean);
// CLIPFLOW_PUBLIC=1: no Cloudflare Access in front of the dashboard; people sign in with Clipflow's own sign-in (Sign in
// with Twitch, AUTH_MODE=app). Who may create a workspace is CLIPFLOW_SIGNUPS (open, or closed by default).
const publicMode = env.CLIPFLOW_PUBLIC === "1";

const ok = msg => console.log("  ok   " + msg), warn = msg => console.log("  warn " + msg);
// Thrown rather than calling process.exit(): exiting with fetch sockets still closing crashes Node on Windows.
class DeployError extends Error {}
function fail(msg) { throw new DeployError(msg); }

async function cf(path, init = {}) {
  const response = await fetch("https://api.cloudflare.com/client/v4" + path, { ...init, headers: { authorization: "Bearer " + token, "content-type": "application/json", ...init.headers } });
  let body = null;
  try { body = await response.json(); } catch { /* not json */ }
  return { status: response.status, ok: response.ok && body?.success !== false, result: body?.result, errors: (body?.errors ?? []).map(e => e.code + ": " + e.message).join("; ") || "HTTP " + response.status };
}

function wrangler(args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), ...args], { cwd: root, stdio: "inherit", env: { ...env, CI: "true", WRANGLER_SEND_METRICS: "false", ...extraEnv } });
  if (result.status !== 0) fail("wrangler " + args.slice(0, 3).join(" ") + " failed (exit " + result.status + ")");
}

async function main() {
console.log(checkOnly ? "Checking Cloudflare prerequisites (no changes)\n" : "Deploying Clipflow to Cloudflare\n");

// 1. Token and account
if (!token) fail("CLOUDFLARE_API_TOKEN is not set. Put it in .env (see DEPLOY.md); never commit it.");
let verify = await cf("/user/tokens/verify");
let accountId = env.CLOUDFLARE_ACCOUNT_ID;
if (!verify.ok && accountId) verify = await cf("/accounts/" + accountId + "/tokens/verify");
if (!verify.ok || verify.result?.status !== "active") fail("API token was not accepted (" + verify.errors + ").");
ok("API token is active");
if (!accountId) {
  const accounts = await cf("/accounts");
  if (!accounts.ok || !accounts.result?.length) fail("Could not list accounts (" + accounts.errors + "). Set CLOUDFLARE_ACCOUNT_ID in .env.");
  if (accounts.result.length > 1) fail("The token can see several accounts; set CLOUDFLARE_ACCOUNT_ID in .env to choose one.");
  accountId = accounts.result[0].id;
}
ok("account " + accountId.slice(0, 6) + "…");
const acct = "/accounts/" + accountId;

// 2. workers.dev subdomain decides the site address
const sub = await cf(acct + "/workers/subdomain");
if (!sub.ok || !sub.result?.subdomain) fail("No workers.dev subdomain yet (" + sub.errors + "). Open Cloudflare dashboard → Workers & Pages once to choose one.");
const host = env.CLIPFLOW_HOSTNAME || workerName + "." + sub.result.subdomain + ".workers.dev";
ok("site address will be https://" + host);

// 3. Access organization (Zero Trust team)
const org = await cf(acct + "/access/organizations");
if (!org.ok || !org.result?.auth_domain) fail("Cloudflare Zero Trust is not set up (" + org.errors + "). Open dashboard → Zero Trust once, pick a team name and the Free plan.");
const teamDomain = org.result.auth_domain;
ok("Zero Trust team " + teamDomain);
if (!publicMode) {
  if (!allowed.length) fail("CLIPFLOW_ACCESS_EMAILS is empty. List the email addresses allowed to sign in (comma-separated) in .env.");
  ok(allowed.length + " allowed sign-in address(es)");
}

// 4. Database and storage
const dbList = await cf(acct + "/d1/database?name=" + encodeURIComponent(dbName));
if (!dbList.ok) fail("Cannot read D1 databases (" + dbList.errors + "). The token needs D1 Edit.");
let db = dbList.result.find(d => d.name === dbName);
ok(db ? "D1 database '" + dbName + "' exists" : "D1 database '" + dbName + "' will be created");
const bucketCheck = await cf(acct + "/r2/buckets/" + bucketName);
let bucketReady = bucketCheck.ok;
const r2Usable = bucketCheck.ok || bucketCheck.status === 404;
if (bucketReady) ok("R2 bucket '" + bucketName + "' exists");
else if (r2Usable) ok("R2 bucket '" + bucketName + "' will be created");
else warn("R2 is unavailable (" + bucketCheck.errors + "). Deploying without clip storage: clips stay on the worker machine. Enable R2 in the dashboard to add it later.");
const apps = await cf(acct + "/access/apps");
if (!apps.ok) fail("Cannot read Access applications (" + apps.errors + "). The token needs Access: Apps and Policies Edit.");
ok("Access applications readable");
const instagramReady = !!(env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET);
if (instagramReady) ok("Instagram app keys present; publishing will be enabled");
else ok("No Instagram app keys; direct Instagram Login stays off (Zernio covers Instagram)");
const zernioReady = !!env.ZERNIO_API_KEY;
if (zernioReady) ok("Zernio API key present; posting to TikTok, Instagram and YouTube will be enabled");
else warn("ZERNIO_API_KEY not set; deploying with publishing through Zernio switched off (see DEPLOY.md).");
ok("Post captions are generated locally from transcripts; no AI API key needed.");
// ClipFlow's own Twitch app, lent to workers for viewers' Twitch clips (app/api/worker/twitch), so customers need none.
const twitchReady = !!(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET);
if (twitchReady) ok("Twitch app keys present; workers without their own can import viewers' Twitch clips, and people can sign in with Twitch");
else warn("TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET not set; only workers with their own Twitch app can import viewers' clips (see DEPLOY.md).");
if (publicMode) {
  if (!twitchReady) fail("CLIPFLOW_PUBLIC=1 needs Sign in with Twitch (TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET): without Access nobody could sign in.");
  // Every workspace made through Access must have a Twitch account linked first, or its owner is locked out once
  // Access is gone (Settings → Sign-in → Link Twitch, on a deploy without CLIPFLOW_PUBLIC).
  const unlinked = db ? await cf(acct + "/d1/database/" + db.uuid + "/query", { method: "POST", body: JSON.stringify({ sql: "SELECT count(*) AS n FROM (SELECT owner FROM preferences WHERE owner LIKE 'access:%' UNION SELECT owner FROM streamers WHERE owner LIKE 'access:%') WHERE owner NOT IN (SELECT owner FROM auth_identities)" }) }) : null;
  const n = unlinked?.ok ? unlinked.result?.[0]?.results?.[0]?.n : db ? null : 0;
  if (n == null) fail("Couldn't check that every workspace has Twitch linked (" + (unlinked?.errors ?? "") + "). Deploy once without CLIPFLOW_PUBLIC (migration 0043), link Twitch under Settings → Sign-in, then try again.");
  if (n > 0) fail(n + " workspace(s) made through Cloudflare Access have no Twitch account linked; their owners couldn't sign in without Access. Link Twitch under Settings → Sign-in first.");
  ok("public: no Access in front of the dashboard; sign-in with Twitch" + (env.CLIPFLOW_SIGNUPS === "open" ? ", sign-ups open" : ", sign-ups closed (CLIPFLOW_SIGNUPS=open opens them)"));
}

if (checkOnly) { console.log("\nAll prerequisites look good. Run without --check to deploy.\n"); return; }

// 5. Build, with the worker download (Connect worker → Download the worker) packed first; it's uploaded to R2 after the
// deploy (app/api/downloads/worker serves it to signed-in people).
const pack = packWorker("https://" + host);
ok("Worker download packed: " + pack.files + " files at " + pack.commit);
console.log("\nBuilding…");
const build = spawnSync(process.execPath, [join(root, "scripts/run-framework.mjs"), "build"], { cwd: root, stdio: "inherit", env });
if (build.status !== 0) fail("build failed");

// 6. Provision (idempotent)
if (!db) {
  const created = await cf(acct + "/d1/database", { method: "POST", body: JSON.stringify({ name: dbName }) });
  if (!created.ok) fail("Could not create D1 database (" + created.errors + ").");
  db = created.result;
  ok("created D1 database '" + dbName + "'");
}
if (!bucketReady && r2Usable) {
  const created = await cf(acct + "/r2/buckets", { method: "POST", body: JSON.stringify({ name: bucketName }) });
  if (created.ok) { bucketReady = true; ok("created R2 bucket '" + bucketName + "'"); }
  else warn("Could not create R2 bucket (" + created.errors + "); deploying without clip storage.");
}

// Access: the dashboard requires sign-in; the worker API bypasses Access and uses its own bearer token.
async function ensureApp(name, domain, policy) {
  let app = apps.result.find(a => a.domain === domain);
  if (!app) {
    const created = await cf(acct + "/access/apps", { method: "POST", body: JSON.stringify({ name, domain, type: "self_hosted", session_duration: "24h", app_launcher_visible: false }) });
    if (!created.ok) fail("Could not create Access application for " + domain + " (" + created.errors + ").");
    app = created.result;
    ok("created Access application '" + name + "'");
  }
  const policies = await cf(acct + "/access/apps/" + app.id + "/policies");
  const existing = policies.ok ? policies.result.find(p => p.name === policy.name) : null;
  const saved = existing
    ? await cf(acct + "/access/apps/" + app.id + "/policies/" + existing.id, { method: "PUT", body: JSON.stringify({ ...policy, precedence: existing.precedence ?? 1 }) })
    : await cf(acct + "/access/apps/" + app.id + "/policies", { method: "POST", body: JSON.stringify({ ...policy, precedence: 1 }) });
  if (!saved.ok) fail("Could not save Access policy '" + policy.name + "' (" + saved.errors + ").");
  ok("Access policy '" + policy.name + "' on " + domain);
  return app;
}
let dashboardApp = null;
if (publicMode) {
  // The dashboard's own Access application goes; the bypasses for the worker API and media below stay (harmless).
  const old = apps.result.find(a => a.domain === host);
  if (old) {
    const removed = await cf(acct + "/access/apps/" + old.id, { method: "DELETE" });
    if (!removed.ok) fail("Could not remove the dashboard's Access application (" + removed.errors + ").");
    ok("removed the dashboard's Access application: Clipflow's own sign-in now");
  }
} else dashboardApp = await ensureApp("Clipflow", host, { name: "Allowed people", decision: "allow", include: allowed.map(email => ({ email: { email } })) });
await ensureApp("Clipflow worker API", host + "/api/worker", { name: "Worker token auth", decision: "bypass", include: [{ everyone: {} }] });
// Platforms such as Instagram fetch videos from signed, expiring /media links; the signature is the authorisation.
await ensureApp("Clipflow signed media", host + "/media", { name: "Signed links", decision: "bypass", include: [{ everyone: {} }] });

// Encryption and signing keys are generated once and kept in .env: rotating TOKEN_KEY would make stored
// platform tokens unreadable (accounts would need reconnecting).
for (const name of ["TOKEN_KEY", "MEDIA_KEY"]) {
  if (env[name]) continue;
  env[name] = randomBytes(32).toString("base64");
  appendFileSync(join(root, ".env"), "\n# Generated by deploy-cloudflare.mjs; keep, and never commit.\n" + name + "=" + env[name] + "\n");
  ok("generated " + name + " and saved it to .env");
}

// 7. Deploy config derived from the build output
const built = JSON.parse(readFileSync(join(root, "dist/server/wrangler.json"), "utf8"));
const deployConfig = {
  ...built,
  name: workerName,
  workers_dev: !env.CLIPFLOW_HOSTNAME,
  ...(env.CLIPFLOW_HOSTNAME && { routes: [{ pattern: env.CLIPFLOW_HOSTNAME, custom_domain: true }] }),
  d1_databases: [{ binding: "DB", database_name: dbName, database_id: db.uuid, migrations_dir: "../../drizzle" }],
  r2_buckets: bucketReady ? [{ binding: "BUCKET", bucket_name: bucketName }] : [],
  vars: { ...built.vars, ...(publicMode ? { AUTH_MODE: "app" } : { AUTH_MODE: "access", CF_ACCESS_TEAM_DOMAIN: teamDomain, CF_ACCESS_AUD: dashboardApp.aud }), ...(env.CLIPFLOW_SIGNUPS && { CLIPFLOW_SIGNUPS: env.CLIPFLOW_SIGNUPS }), PUBLIC_URL: "https://" + host, ...(instagramReady && { INSTAGRAM_APP_ID: env.INSTAGRAM_APP_ID }), ...(twitchReady && { TWITCH_CLIENT_ID: env.TWITCH_CLIENT_ID }) },
  // The publisher runs once a minute.
  triggers: { crons: ["* * * * *"] },
};
const deployConfigPath = join(root, "dist/server/wrangler.deploy.json");
writeFileSync(deployConfigPath, JSON.stringify(deployConfig, null, 2));
const auth = { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId };

console.log("\nApplying database migrations…");
wrangler(["d1", "migrations", "apply", "DB", "--remote", "--config", deployConfigPath], auth);
console.log("\nDeploying Worker…");
wrangler(["deploy", "--config", deployConfigPath], auth);

console.log("\nUploading secrets…");
const secretsFile = join(root, "dist/server/secrets.json");
try {
  writeFileSync(secretsFile, JSON.stringify({ TOKEN_KEY: env.TOKEN_KEY, MEDIA_KEY: env.MEDIA_KEY, ...(instagramReady && { INSTAGRAM_APP_SECRET: env.INSTAGRAM_APP_SECRET }), ...(zernioReady && { ZERNIO_API_KEY: env.ZERNIO_API_KEY }), ...(twitchReady && { TWITCH_CLIENT_SECRET: env.TWITCH_CLIENT_SECRET }) }));
  wrangler(["secret", "bulk", secretsFile, "--config", deployConfigPath], auth);
} finally { rmSync(secretsFile, { force: true }); }

// The worker download, for app/api/downloads/worker. Without R2 there's nowhere to keep it; the route says so.
if (bucketReady) {
  console.log("\nUploading the worker download…");
  wrangler(["r2", "object", "put", bucketName + "/" + ZIP_KEY, "--file", pack.path, "--content-type", "application/zip", "--remote"], auth);
} else warn("no R2 bucket: the worker download isn't available from the dashboard");

// 8. Smoke test: worker API must answer with the app's own 401; the dashboard must be behind Access.
console.log("\nChecking the live site…");
const sleep = ms => new Promise(r => setTimeout(r, ms));
let workerOk = false, dashboardOk = false, mediaOk = false, lastWorker = "", lastDashboard = "", lastMedia = "";
for (let attempt = 0; attempt < 12 && !(workerOk && dashboardOk && mediaOk); attempt++) {
  if (attempt) await sleep(5000);
  try {
    const w = await fetch("https://" + host + "/api/worker/config", { redirect: "manual" });
    lastWorker = w.status + " " + (w.headers.get("location") ?? (await w.text()).slice(0, 80));
    workerOk = w.status === 401 && lastWorker.includes("Invalid worker token");
    // Access answers an unauthenticated visit with a redirect to its login page. An app-level 401 here
    // would still be safe (no data), but means Access is not in front of the site yet.
    const d = await fetch("https://" + host + "/api/dashboard", { redirect: "manual" });
    lastDashboard = d.status + " " + (d.headers.get("location") ?? "");
    // Public: the app itself answers a signed-out visit (401, with where to sign in).
    dashboardOk = publicMode ? d.status === 401 : d.status === 302 && lastDashboard.includes(".cloudflareaccess.com");
    // An unsigned media link must reach the app (and be refused by it), not the Access login page.
    const m = await fetch("https://" + host + "/media/00000000-0000-4000-8000-000000000000.mp4", { redirect: "manual" });
    lastMedia = m.status + " " + (m.headers.get("location") ?? "");
    mediaOk = m.status === 404;
  } catch (error) { lastWorker = lastDashboard = error.message; }
}
if (workerOk) ok("worker API reachable without sign-in (bearer token required)");
else warn("worker API check: " + lastWorker);
if (dashboardOk) ok(publicMode ? "dashboard asks signed-out visitors to sign in" : "dashboard is behind the Access login page");
else warn(publicMode ? "dashboard check (expected the app's own 401): " + lastDashboard : "dashboard check (expected a redirect to " + teamDomain + "): " + lastDashboard);
if (mediaOk) ok("signed media links bypass sign-in (unsigned ones are refused)");
else warn("media link check (expected 404 from the app): " + lastMedia);
console.log("\nDone: https://" + host + "\n" + (workerOk && dashboardOk && mediaOk ? "" : "Some checks did not pass yet; Access changes can take a minute. Re-run with --check or open the site.\n"));
}

main().catch(error => {
  console.error("\n  FAIL " + (error instanceof DeployError ? error.message : error.stack) + "\n");
  process.exitCode = 1;
});
