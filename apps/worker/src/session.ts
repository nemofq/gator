import { keys, passwordMatches, sign, verify } from "./crypto";
import { migrate } from "./schema";

const COOKIE = "__Host-gator";
/** Sign-in attempts per address and minute, wrong or right. */
const ATTEMPTS_PER_MINUTE = 5;
/** Seven days. Sessions are stateless: signing out clears the cookie, and nothing else ends one early. */
const MAX_AGE_S = 604_800;
const ATTRIBUTES = "HttpOnly; Secure; SameSite=Strict; Path=/";

/** A fresh `Set-Cookie` value: `<expiry ms>.<HMAC(expiry)>`. */
export async function issueSession(env: Env): Promise<string> {
  const expiry = String(Date.now() + MAX_AGE_S * 1000);
  const value = `${expiry}.${await sign((await keys(env)).session, expiry)}`;
  return `${COOKIE}=${value}; ${ATTRIBUTES}; Max-Age=${MAX_AGE_S}`;
}

export const CLEAR_SESSION = `${COOKIE}=; ${ATTRIBUTES}; Max-Age=0`;

/** The session cookie's value if it is signed with the current keys and not expired, else null. */
export async function session(request: Request, env: Env): Promise<string | null> {
  const value = request.headers
    .get("Cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  const [expiry, signature] = value?.split(".") ?? [];
  if (!value || !signature || !(Number(expiry) > Date.now())) return null;
  return (await verify((await keys(env)).session, expiry, signature)) ? value : null;
}

/** The CSRF token for a session: an HMAC of the cookie, so it dies with the cookie. */
export async function csrfToken(env: Env, cookie: string): Promise<string> {
  return sign((await keys(env)).csrf, cookie);
}

/** A state-changing request must come from this origin and carry the session's CSRF token. */
export async function trusted(request: Request, env: Env, cookie: string): Promise<boolean> {
  const token = request.headers.get("X-CSRF-Token");
  if (!sameOrigin(request) || token === null) return false;
  return verify((await keys(env)).csrf, cookie, token);
}

export function sameOrigin(request: Request): boolean {
  return request.headers.get("Origin") === new URL(request.url).origin;
}

/**
 * Counts the attempt before the password is compared, so a limited attempt never reaches the
 * comparison. The count is one statement on D1's single primary: concurrent attempts cannot both
 * read the old count, so the limit is exact.
 */
export async function checkPassword(
  request: Request,
  env: Env,
  given: unknown,
): Promise<"ok" | "wrong" | "limited"> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const minute = Math.floor(Date.now() / 60_000);
  // A sign-in can be the first request a new or updated deployment gets.
  await migrate(env.DB);
  const [, counted] = await env.DB.batch<{ count: number }>([
    env.DB.prepare("DELETE FROM login_attempts WHERE minute < ?").bind(minute - 1),
    env.DB.prepare(
      `INSERT INTO login_attempts (ip, minute, count) VALUES (?, ?, 1)
       ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`,
    ).bind(ip, minute),
  ]);
  if (counted.results[0].count > ATTEMPTS_PER_MINUTE) return "limited";
  return (await passwordMatches(String(given ?? ""), env.OWNER_PASSWORD)) ? "ok" : "wrong";
}
