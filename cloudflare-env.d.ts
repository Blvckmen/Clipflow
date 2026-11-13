declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    // Self-hosting on Cloudflare (see scripts/deploy-cloudflare.mjs): "access" trusts only Cloudflare Access.
    AUTH_MODE?: string;
    CF_ACCESS_TEAM_DOMAIN?: string;
    CF_ACCESS_AUD?: string;
  }
}
