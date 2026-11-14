declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    // Self-hosting on Cloudflare (see scripts/deploy-cloudflare.mjs): "access" trusts only Cloudflare Access.
    AUTH_MODE?: string;
    CF_ACCESS_TEAM_DOMAIN?: string;
    CF_ACCESS_AUD?: string;
    // Publishing. PUBLIC_URL is the site's origin, used for signed video links when there is no request.
    PUBLIC_URL?: string;
    TOKEN_KEY?: string;      // secret: base64 32-byte key encrypting stored platform tokens
    MEDIA_KEY?: string;      // secret: base64 32-byte key signing temporary video links
    INSTAGRAM_APP_ID?: string;
    INSTAGRAM_APP_SECRET?: string;  // secret
    // Overridable only so tests can point at a local fake Instagram.
    INSTAGRAM_AUTH_URL?: string;
    INSTAGRAM_API_URL?: string;
    INSTAGRAM_GRAPH_URL?: string;
    ZERNIO_API_KEY?: string;  // secret: posts to the accounts connected on zernio.com
    ZERNIO_API_URL?: string;  // overridable only so tests can point at a local fake Zernio
    ANTHROPIC_API_KEY?: string;  // secret: lets Claude write post captions
    ANTHROPIC_BASE_URL?: string;  // overridable only so tests can point at a local fake Claude API
    ENABLE_TEST_CRON?: string;  // local tests only; never set in a deployment
  }
}
