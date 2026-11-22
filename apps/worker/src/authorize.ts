import {
  AuthorizationError,
  type AuthRequest,
  CimdFetchError,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import { checkPassword, session } from "./session";

/** The one user: every grant belongs to the owner. */
export const OWNER = "owner";

/** No `form-action`: browsers apply it to the redirect back to the client. */
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'";

/**
 * `/authorize`: the owner signs in (or already has a dashboard session) and approves or denies
 * the client. Consent is never skipped. The library binds each page to this browser and keeps the
 * request server-side, so the form carries only a single-use handle.
 */
export async function authorize(request: Request, env: Env): Promise<Response> {
  try {
    if (request.method === "POST") return await decide(request, env);
    if (request.method !== "GET")
      return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
    const signedIn = (await session(request, env)) !== null;
    return await consentPage(env, await env.OAUTH_PROVIDER.parseAuthRequest(request), signedIn);
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return new Response(null, { status: 302, headers: { Location: error.redirectTo } });
    }
    if (error instanceof AuthorizationError) return errorPage(error.description);
    if (error instanceof CimdFetchError) return errorPage("This app could not be verified.");
    throw error;
  }
}

async function decide(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData().catch(() => new FormData());
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  // The session cookie is SameSite=Strict, so it arrives on this same-site POST even when the
  // GET came from the client's site without it.
  if ((await session(request, env)) === null) {
    const password = await checkPassword(request, env, form.get("password"));
    if (password !== "ok") {
      // The form posts back to the URL that holds the request, so it can be shown again.
      const again = await oauth.parseAuthRequest(request);
      const message =
        password === "limited"
          ? "Too many attempts. Wait a minute and try again."
          : "Wrong password.";
      return consentPage(env, again, false, message, password === "limited" ? 429 : 401);
    }
  }
  const approved = await oauth.approveConsent(request, handle);
  const { clientName } = await oauth.describeConsent(approved.request);
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: OWNER,
    metadata: { clientName },
    scope: approved.request.scope,
    props: { clientName, connectedAt: Date.now() },
    // Two installs of one client are two agents; the owner revokes the ones no longer wanted.
    revokeExistingGrants: false,
  });
  approved.headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

async function consentPage(
  env: Env,
  authRequest: AuthRequest,
  signedIn: boolean,
  message = "",
  status = 200,
): Promise<Response> {
  // Described first: a failed client lookup then leaves nothing behind in KV.
  const details = await env.OAUTH_PROVIDER.describeConsent(authRequest);
  const consent = await env.OAUTH_PROVIDER.beginConsent(authRequest);
  const headers = pageHeaders(consent.headers);
  return new Response(page(consentBody(details, consent.handle, signedIn, message)), {
    status,
    headers,
  });
}

function consentBody(
  details: ConsentDescription,
  handle: string,
  signedIn: boolean,
  message: string,
): string {
  const lines = [
    `<p>Client: <strong class="client">${html(details.clientName)}</strong></p>`,
    details.clientDomain
      ? `<p class="note">Published by <code class="host">${html(details.clientDomain)}</code></p>`
      : "",
    `<p>Returns to <code class="host">${html(details.redirectHost)}</code></p>`,
    details.redirectIsLoopback ? `<p class="note">This is an app on this computer.</p>` : "",
    message ? `<p class="warning">${message}</p>` : "",
  ];
  const password = signedIn
    ? ""
    : `<label for="password">Owner password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>`;
  return `<h1>Connect an agent</h1>
${lines.filter(Boolean).join("\n")}
<form method="post">
<input type="hidden" name="handle" value="${html(handle)}">
${password}
<div class="actions"><button class="primary" name="decision" value="approve">Approve</button><button name="decision" value="deny" formnovalidate>Deny</button></div>
</form>
<p class="warning">Approve only if you started this.</p>`;
}

function errorPage(message: string): Response {
  const body = `<h1>Cannot connect</h1>\n<p>${html(message)}</p>\n<p class="note">Start connecting again from the app.</p>`;
  return new Response(page(body), { status: 400, headers: pageHeaders(new Headers()) });
}

function pageHeaders(headers: Headers): Headers {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", CSP);
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return headers;
}

function page(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect an agent · Gator</title>
<link rel="icon" href="/favicon.svg">
<link rel="stylesheet" href="/theme.css">
<link rel="stylesheet" href="/authorize.css">
<script src="/theme.js"></script>
</head>
<body>
<main class="consent">
<div class="brand"><span class="mark"></span><span class="word">GATOR</span></div>
${body}
</main>
</body>
</html>`;
}

/** Client names, hosts and messages are chosen by whoever registered the client. */
function html(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
