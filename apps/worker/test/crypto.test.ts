import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import pkg from "../../../package.json";
import readme from "../../../README.md?raw";
import setup from "../../../scripts/setup.mjs?raw";
import settingsPage from "../../dashboard/src/pages/settings.tsx?raw";
import {
  decryptKey,
  encryptKey,
  keys,
  MIN_PASSWORD,
  passwordMatches,
  secretsProblem,
  sign,
  verify,
} from "../src/crypto";

describe("crypto", () => {
  it("round-trips a provider key, bound to the provider ID", async () => {
    const k = await keys(env);
    const sealed = await encryptKey(k, "tavily", "tvly-secret");
    expect(sealed).not.toContain("tvly");
    expect(await decryptKey(k, "tavily", sealed)).toBe("tvly-secret");
    expect(await decryptKey(k, "github", sealed)).toBeNull();
    expect(await decryptKey(k, "tavily", "not base64!")).toBeNull();
    expect(await encryptKey(k, "tavily", "tvly-secret")).not.toBe(sealed);
  });

  it("does not decrypt under another MASTER_KEY, and its check value differs", async () => {
    const k = await keys(env);
    const other = await keys({ ...env, MASTER_KEY: "f".repeat(64) });
    const sealed = await encryptKey(k, "tavily", "tvly-secret");
    expect(other.check).not.toBe(k.check);
    expect(other.check).toMatch(/^[0-9a-f]{16}$/);
    expect(await decryptKey(other, "tavily", sealed)).toBeNull();
  });

  it("names the missing or malformed secret", () => {
    expect(secretsProblem(env)).toBeNull();
    expect(secretsProblem({ ...env, MASTER_KEY: "" })).toContain("MASTER_KEY");
    expect(secretsProblem({ ...env, MASTER_KEY: "z".repeat(64) })).toContain("MASTER_KEY");
    expect(secretsProblem({ ...env, MASTER_KEY: "a".repeat(62) })).toContain("MASTER_KEY");
    expect(secretsProblem({ ...env, OWNER_PASSWORD: "" })).toContain("OWNER_PASSWORD");
    const short = "a".repeat(11);
    const problem = secretsProblem({ ...env, OWNER_PASSWORD: short });
    expect(problem).toContain("OWNER_PASSWORD");
    expect(problem).toContain("at least 12 characters");
    expect(problem).not.toContain(short);
    expect(problem).not.toContain("11");
    expect(problem).toBe(secretsProblem({ ...env, OWNER_PASSWORD: "" }));
    expect(secretsProblem({ ...env, OWNER_PASSWORD: "a".repeat(12) })).toBeNull();
  });

  it("names the Worker in the fix when the host is on workers.dev", () => {
    const host = "gator-dev.nemofq.workers.dev";
    for (const broken of [{ MASTER_KEY: "" }, { OWNER_PASSWORD: "a".repeat(11) }]) {
      const named = secretsProblem({ ...env, ...broken }, host);
      expect(named).toContain("`pnpm exec wrangler secret put");
      expect(named).toContain(" --name gator-dev`");
      for (const other of ["gator.example.com", "localhost", undefined]) {
        const unnamed = secretsProblem({ ...env, ...broken }, other);
        expect(unnamed).toContain(" --name <your Worker's name>`");
        expect(unnamed).not.toMatch(/--name (gator|localhost)/);
      }
    }
    expect(secretsProblem({ ...env, OWNER_PASSWORD: "" }, host)).toContain("→ gator-dev →");
    expect(secretsProblem({ ...env, OWNER_PASSWORD: "" })).toContain("→ your Gator Worker →");
  });

  it("states the same minimum password length in setup, the Deploy button, the README and Settings", () => {
    expect(setup).toContain(`MIN_PASSWORD = ${MIN_PASSWORD};`);
    const atLeast = `at least ${MIN_PASSWORD} characters`;
    expect(pkg.cloudflare.bindings.OWNER_PASSWORD.description).toContain(atLeast);
    expect(readme.toLowerCase()).toContain(atLeast);
    expect(settingsPage).toContain(`At least ${MIN_PASSWORD} characters.`);
  });

  it("signs and verifies, and the session key depends on the owner password", async () => {
    const k = await keys(env);
    const mac = await sign(k.session, "1700000000000");
    expect(mac).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await verify(k.session, "1700000000000", mac)).toBe(true);
    expect(await verify(k.session, "1700000000001", mac)).toBe(false);
    expect(await verify(k.csrf, "1700000000000", mac)).toBe(false);
    expect(await verify(k.session, "1700000000000", "%%%")).toBe(false);
    const changed = await keys({ ...env, OWNER_PASSWORD: "another password" });
    expect(await verify(changed.session, "1700000000000", mac)).toBe(false);
  });

  it("compares passwords", async () => {
    expect(await passwordMatches("correct horse battery staple", env.OWNER_PASSWORD)).toBe(true);
    expect(await passwordMatches("correct horse", env.OWNER_PASSWORD)).toBe(false);
    expect(await passwordMatches("", env.OWNER_PASSWORD)).toBe(false);
  });
});
