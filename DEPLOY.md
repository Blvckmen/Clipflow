# Deploying Clipflow to your Cloudflare account

`npm run deploy` builds Clipflow and deploys it to your own Cloudflare account as a
Worker, with sign-in handled by Cloudflare Access. It is safe to re-run: it reuses the
database, storage bucket and Access applications it created before, and applies only
new database migrations.

## One-time setup

1. **Cloudflare account** — sign up at dash.cloudflare.com (free).
2. **workers.dev subdomain** — open **Workers & Pages** once and accept the suggested
   subdomain. The site will live at `https://clipflow.<subdomain>.workers.dev`.
3. **Zero Trust team** — open **Zero Trust** once, choose a team name and the **Free**
   plan (up to 50 users). This is what provides the sign-in page.
4. **R2 (optional)** — open **R2** and enable it to store clip files in the dashboard so
   they can be played and downloaded there. Without it, clips stay on the worker machine.
5. **API token** — **My Profile → API Tokens → Create Token → Custom token** with:
   - Account · Workers Scripts · Edit
   - Account · D1 · Edit
   - Account · Workers R2 Storage · Edit
   - Account · Access: Apps and Policies · Edit
   - Account · Access: Organizations, Identity Providers, and Groups · Read
   - Account · Account Settings · Read
6. **`.env`** in the project root (already git-ignored — never commit it or paste the token anywhere):

   ```
   CLOUDFLARE_API_TOKEN=...
   CLIPFLOW_ACCESS_EMAILS=you@example.com
   # Optional:
   # CLOUDFLARE_ACCOUNT_ID=...          only needed if the token can see several accounts
   # CLIPFLOW_WORKER_NAME=clipflow
   # CLIPFLOW_HOSTNAME=clips.example.com  a custom domain on a zone in this account
   ```

## Deploy

```sh
npm run deploy:check   # read-only: confirms the token and every prerequisite
npm run deploy         # build, create what's missing, migrate, deploy, smoke-test
```

The final smoke test confirms that the dashboard redirects to the Access sign-in page and
that `/api/worker/*` answers the worker directly (it uses its own bearer token, so it is
exempt from Access). Then sign in, open **Connect worker**, create a token and point the
worker at the site (see `worker/README.md`).

## How sign-in works

The app reads `AUTH_MODE`:

- `sites` (default) — identity headers from Codex Sites hosting, and the local mock sign-in.
- `access` (set by the deploy script) — only a verified Cloudflare Access token
  (`Cf-Access-Jwt-Assertion`, checked against the team's signing keys and the application's
  audience tag). Sites headers are ignored in this mode because a client could send them itself.

Data is stored per Access user. A deployment on Cloudflare starts with an empty database;
it does not share data with a Codex Sites deployment.
