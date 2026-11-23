// `node scripts/update.mjs`: updates a copy made by the Deploy to Cloudflare button. See README, Update.
// Takes every file from nemofq/gator's main branch, keeps this Worker's name and the IDs that
// Cloudflare wrote into wrangler.jsonc, and commits. Push afterwards to deploy.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const UPSTREAM = "https://github.com/nemofq/gator";
const CONFIG = "wrangler.jsonc";
// The settings Cloudflare fills in, each matched whole, over one line or several.
const KEEP = [
  /^\s*"name":\s*"[^"]*",?$/m,
  /^\s*"d1_databases":\s*\[[^\]]*\],?$/m,
  /^\s*"kv_namespaces":\s*\[[^\]]*\],?$/m,
];

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const fail = (sentence) => {
  console.error(sentence);
  process.exit(1);
};

process.chdir(git("rev-parse", "--show-toplevel"));
if (git("status", "--porcelain")) fail("Commit or discard your changes first.");

const ours = readFileSync(CONFIG, "utf8");
const kept = KEEP.map((line) => ours.match(line)?.[0]);
git("fetch", "--quiet", UPSTREAM, "main");
const version = git("rev-parse", "--short", "FETCH_HEAD");

// Every file as it is upstream, deleted ones included; then this Worker's own lines.
git("read-tree", "-u", "--reset", "FETCH_HEAD");
let config = readFileSync(CONFIG, "utf8");
KEEP.forEach((line, i) => {
  if (kept[i]) config = config.replace(line, () => kept[i]);
});
if (kept.some((line) => line && !config.includes(line))) {
  git("read-tree", "-u", "--reset", "HEAD");
  fail(`Could not keep your Worker's name and IDs in ${CONFIG}. Nothing was changed.`);
}
writeFileSync(CONFIG, config);
git("add", "--all");

if (!git("status", "--porcelain")) {
  console.log("Already up to date.");
} else {
  git("commit", "--quiet", "--message", `Update to nemofq/gator ${version}`);
  console.log(`Updated to ${version}. Run \`git push\` to deploy.`);
}
