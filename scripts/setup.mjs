// `pnpm run setup`: creates or re-deploys a Gator instance and its secrets. See README, Quick start.
// Unattended: set OWNER_PASSWORD and GATOR_NAME; GATOR_SECRETS_OUT receives a generated MASTER_KEY.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fail = (sentence, result) => {
  if (result) process.stderr.write(`${result.stdout ?? ""}${result.stderr ?? ""}\n`);
  console.error(sentence);
  process.exit(1);
};

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) fail("Gator needs Node.js 22.12 or newer.");

const root = join(import.meta.dirname, "..");
const WRANGLER = join(root, "node_modules/wrangler/bin/wrangler.js");
const CONFIG = join(root, "wrangler.jsonc");
const MIN_PASSWORD = 12;
// Waits for a new Worker and a new workers.dev subdomain to start answering.
const READY_TIMEOUT_MS = 30_000;

const name = process.env.GATOR_NAME ?? "gator";
const secretsOut = process.env.GATOR_SECRETS_OUT;
// Secrets never reach a child process's environment, only the 0600 secrets file.
const { OWNER_PASSWORD: givenPassword, ...childEnv } = process.env;
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
// With a listener, Ctrl-C during a child process lets the `finally` below delete the secrets file.
process.on("SIGINT", () => process.exit(130));

// Wrangler is interactive only with a TTY; without one it never prompts and never writes the IDs
// of the resources it creates into the shared wrangler.jsonc.
const wrangler = (args, env = {}) =>
  spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...childEnv, CI: "1", ...env },
  });

function ask(question) {
  process.stdout.write(question);
  process.stdin.setRawMode(true).setEncoding("utf8").resume();
  return new Promise((resolve) => {
    let input = "";
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\u0003") process.exit(130);
        if (char === "\r" || char === "\n") {
          process.stdin.off("data", onData).setRawMode(false).pause();
          process.stdout.write("\n");
          return resolve(input);
        }
        input = char === "\u007f" || char === "\b" ? input.slice(0, -1) : input + char;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function promptPassword() {
  if (!interactive) fail("Set OWNER_PASSWORD in the environment to run setup unattended.");
  for (;;) {
    const password = await ask("Owner password: ");
    if (password.length < MIN_PASSWORD) {
      console.log(`Use at least ${MIN_PASSWORD} characters.`);
    } else if ((await ask("Owner password again: ")) === password) {
      return password;
    } else {
      console.log("The passwords do not match.");
    }
  }
}

if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
  fail("GATOR_NAME must be lowercase letters, digits and inner hyphens, at most 63 characters.");
}
if (!existsSync(WRANGLER)) fail("Dependencies are missing: run `pnpm install` first.");
const current = spawnSync("scripts/build-core.sh", ["--check"], {
  cwd: root,
  encoding: "utf8",
  env: childEnv,
});
if (current.status !== 0) fail(current.stderr.trim());

console.log("Checking the Cloudflare sign-in…");
if (wrangler(["whoami", "--json"]).status !== 0) {
  if (!interactive) fail("Wrangler is not signed in: run `pnpm exec wrangler login` first.");
  const login = spawnSync(process.execPath, [WRANGLER, "login"], {
    cwd: root,
    stdio: "inherit",
    env: childEnv,
  });
  if (login.status !== 0) fail("Signing in to Cloudflare did not complete.");
}

console.log(`Checking the secrets of ${name}…`);
const list = wrangler(["secret", "list", "--name", name, "--format", "json"]);
// A Worker that does not exist yet is a first setup.
if (list.status !== 0 && !list.stderr.includes("not found")) {
  fail(`Could not read the secrets of ${name}.`, list);
}
const existing = list.status === 0 ? JSON.parse(list.stdout).map((secret) => secret.name) : [];

// MASTER_KEY encrypts the stored provider keys, so a re-run never replaces it.
const secrets = {};
if (!existing.includes("MASTER_KEY")) secrets.MASTER_KEY = randomBytes(32).toString("hex");
if (givenPassword !== undefined && givenPassword.length < MIN_PASSWORD) {
  fail(`OWNER_PASSWORD must have at least ${MIN_PASSWORD} characters.`);
}
if (givenPassword !== undefined || !existing.includes("OWNER_PASSWORD")) {
  secrets.OWNER_PASSWORD = givenPassword ?? (await promptPassword());
}
if (secrets.MASTER_KEY && secretsOut) {
  // Written before the deploy, so the key is kept even if anything later fails.
  try {
    writeFileSync(secretsOut, `MASTER_KEY=${secrets.MASTER_KEY}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    fail(`Could not write GATOR_SECRETS_OUT (${error.code}); it must not exist yet.`);
  }
}

console.log("Building the dashboard…");
const build = spawnSync("pnpm", ["run", "build"], { cwd: root, encoding: "utf8", env: childEnv });
if (build.status !== 0) fail("Building the dashboard failed.", build);

console.log(`Deploying ${name}…`);
const config = readFileSync(CONFIG, "utf8");
const tmp = mkdtempSync(join(tmpdir(), "gator-setup-"));
let deploy;
let report = "";
try {
  const args = ["deploy", "--name", name];
  const secretsFile = join(tmp, "secrets.json");
  const outputFile = join(tmp, "output.ndjson");
  if (Object.keys(secrets).length > 0) {
    writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
    args.push("--secrets-file", secretsFile);
  }
  deploy = wrangler(args, { WRANGLER_OUTPUT_FILE_PATH: outputFile });
  if (existsSync(outputFile)) report = readFileSync(outputFile, "utf8");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (readFileSync(CONFIG, "utf8") !== config) {
  writeFileSync(CONFIG, config);
  console.log("Wrangler changed wrangler.jsonc; it has been restored.");
}
// Shown even if the deploy failed: a deploy can fail after its secrets were stored.
if (secrets.MASTER_KEY && !secretsOut) {
  console.log(`\nMASTER_KEY=${secrets.MASTER_KEY}`);
  console.log(
    "Store this key somewhere safe: Cloudflare cannot show it again, and if it is lost every provider key must be entered again.\n",
  );
}
if (deploy.status !== 0) fail(`Deploying ${name} failed.`, deploy);

const targets = report
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .find((entry) => entry.type === "deploy")?.targets;
const url = targets?.find((target) => target.endsWith(".workers.dev"));
if (!url) {
  fail(
    "Cloudflare reported no workers.dev URL: open Workers & Pages in the Cloudflare dashboard to choose a workers.dev subdomain, then run `pnpm run setup` again.",
  );
}

console.log(`Waiting for ${name} to answer…`);
let up = false;
for (const deadline = Date.now() + READY_TIMEOUT_MS; Date.now() < deadline; ) {
  const response = await fetch(`${url}/api/session`).catch(() => undefined);
  if (response?.status === 500) fail(await response.text());
  if (response?.status === 401 && response.headers.get("content-type")?.includes("json")) {
    up = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

console.log(`\nDashboard:    ${url}/`);
console.log(`MCP endpoint: ${url}/mcp`);
if (!up) {
  fail(
    `${name} did not answer within ${READY_TIMEOUT_MS / 1000} seconds; a new workers.dev subdomain can take a few minutes, so try the dashboard shortly.`,
  );
}
console.log("\nOpen the dashboard, sign in with your owner password, enable a provider.");
