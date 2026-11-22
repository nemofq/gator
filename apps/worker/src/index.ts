import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { initSync } from "@gator/core";
import wasm from "@gator/core/gator_core_bg.wasm";
import { secretsProblem } from "./crypto";
import { mcpHandler } from "./mcp";
import { defaultHandler } from "./routes";
import { cron } from "./snapshot";

initSync({ module: wasm });

/** `resource` is fixed when a provider is built, so there is one per origin the Worker is reached on. */
const providers = new Map<string, OAuthProvider<Env>>();

function oauth(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpHandler,
      defaultHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      scopesSupported: ["mcp", "offline_access"],
      requiredScopes: ["mcp"],
      resourceMetadata: { resource: `${origin}/mcp`, resource_name: "Gator" },
      clientIdMetadataDocumentEnabled: true,
      accessTokenTTL: 3600,
      // Written out on purpose: undefined means agents stay connected until the owner revokes them.
      refreshTokenTTL: undefined,
      clientRegistrationTTL: undefined,
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    const problem = secretsProblem(env, url.hostname);
    if (problem) return new Response(problem, { status: 500 });
    // A copy: the library caches its helpers on `env`, which every origin in the isolate shares.
    return oauth(url.origin).fetch(request, { ...env }, ctx);
  },
  async scheduled(_controller, env) {
    const problem = secretsProblem(env);
    if (problem) console.error(problem);
    else await cron(env);
  },
} satisfies ExportedHandler<Env>;
