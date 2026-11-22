declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    OAUTH_KV: KVNamespace;
    ASSETS: Fetcher;
    MASTER_KEY: string;
    OWNER_PASSWORD: string;
    /** Set by the OAuth provider before it calls `defaultHandler`. */
    OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
  }
}

type Env = Cloudflare.Env;
