export type Keys = {
  /** AES-256-GCM key for provider API keys. */
  providerKeys: CryptoKey;
  /** Stored beside each encrypted key, so a changed MASTER_KEY is noticed per key. */
  check: string;
  /** HMAC keys for the session cookie and for CSRF tokens. */
  session: CryptoKey;
  csrf: CryptoKey;
};

const NONCE_BYTES = 12;
const encoder = new TextEncoder();
let cached: { secrets: string; keys: Promise<Keys> } | undefined;

/** The shortest owner password; scripts/setup.mjs asks for the same. */
export const MIN_PASSWORD = 12;

/** A sentence saying which secret to set and how, or null when both are usable. */
export function secretsProblem(env: Env, host?: string): string | null {
  const masterKey = /^[0-9a-fA-F]{64}$/.test(env.MASTER_KEY ?? "");
  if (masterKey && (env.OWNER_PASSWORD ?? "").length >= MIN_PASSWORD) return null;
  const name = workerName(host);
  const put = (secret: string) =>
    `\`pnpm exec wrangler secret put ${secret} --name ${name ?? "<your Worker's name>"}\``;
  if (!masterKey) {
    return `Gator is not set up: the encryption key must be 64 hexadecimal characters. Run \`openssl rand -hex 32\` and set the output with ${put("MASTER_KEY")}.`;
  }
  return `Gator is not set up: the owner password must have at least ${MIN_PASSWORD} characters. Set one with ${put("OWNER_PASSWORD")}, or in the Cloudflare dashboard: Workers & Pages → ${name ?? "your Gator Worker"} → Settings → Variables and Secrets → Edit, then Deploy.`;
}

/** The Worker cannot ask Cloudflare for its name, but on workers.dev it is the host's first label. */
function workerName(host = ""): string | undefined {
  return /^([a-z0-9-]+)\.[a-z0-9-]+\.workers\.dev$/.exec(host)?.[1];
}

/** The keys derived from MASTER_KEY, imported once per isolate. Call `secretsProblem` first. */
export function keys(env: Env): Promise<Keys> {
  const secrets = `${env.MASTER_KEY}\n${env.OWNER_PASSWORD}`;
  if (cached?.secrets !== secrets) cached = { secrets, keys: derive(env) };
  return cached.keys;
}

async function derive(env: Env): Promise<Keys> {
  const bytes = Uint8Array.fromHex(env.MASTER_KEY);
  const master = await crypto.subtle.importKey("raw", bytes, "HKDF", false, [
    "deriveKey",
    "deriveBits",
  ]);
  const info = (label: string) => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(),
    info: encoder.encode(label),
  });
  const hmac = (label: string) =>
    crypto.subtle.deriveKey(info(label), master, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
  const [providerKeys, check, session, csrf] = await Promise.all([
    crypto.subtle.deriveKey(
      info("gator/provider-keys"),
      master,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ),
    crypto.subtle.deriveBits(info("gator/key-check"), master, 64),
    hmac(`gator/session/${env.OWNER_PASSWORD}`),
    hmac("gator/csrf"),
  ]);
  return { providerKeys, check: new Uint8Array(check).toHex(), session, csrf };
}

/** `base64(nonce || ciphertext)`, bound to the provider ID. */
export async function encryptKey(keys: Keys, providerId: string, key: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(providerId) },
    keys.providerKeys,
    encoder.encode(key),
  );
  const out = new Uint8Array(NONCE_BYTES + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), NONCE_BYTES);
  return out.toBase64();
}

/** The key in the clear, or null if it cannot be decrypted (another MASTER_KEY or provider ID). */
export async function decryptKey(
  keys: Keys,
  providerId: string,
  stored: string,
): Promise<string | null> {
  try {
    const bytes = Uint8Array.fromBase64(stored);
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.subarray(0, NONCE_BYTES),
        additionalData: encoder.encode(providerId),
      },
      keys.providerKeys,
      bytes.subarray(NONCE_BYTES),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** base64url HMAC-SHA-256 of `data`. */
export async function sign(key: CryptoKey, data: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return new Uint8Array(mac).toBase64({ alphabet: "base64url", omitPadding: true });
}

/** Checks a `sign` output in constant time. */
export async function verify(key: CryptoKey, data: string, signature: string): Promise<boolean> {
  try {
    const mac = Uint8Array.fromBase64(signature, { alphabet: "base64url" });
    return await crypto.subtle.verify("HMAC", key, mac, encoder.encode(data));
  } catch {
    return false;
  }
}

/** Compares SHA-256 digests so neither the length nor the content leaks through timing. */
export async function passwordMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all(
    [given, expected].map((text) => crypto.subtle.digest("SHA-256", encoder.encode(text))),
  );
  return crypto.subtle.timingSafeEqual(a, b);
}
