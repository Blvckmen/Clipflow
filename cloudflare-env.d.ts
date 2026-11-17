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
    AI?: { run: (model: string, inputs: { messages: { role: string; content: string }[]; max_tokens: number }) => Promise<unknown> }; // Workers AI binding
    DB?: D1Database;
    AI_PROVIDER?: string; // default: cloudflare; opt-in: openai
    OPENAI_API_KEY?: string; // optional secret for OpenAI
    OPENAI_MODEL?: string; // optional OpenAI chat model override
    ENABLE_TEST_CRON?: string;  // local tests only; never set in a deployment
  }
}
