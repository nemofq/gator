#!/bin/sh
# Builds every generated file: the core compiled to WebAssembly in crates/core-wasm/pkg, the
# catalog bundle catalog/catalog.json, and the fingerprint of their sources. CI on Linux is their
# only source on main; a local build is for development and is hidden from git.
# Needs rustup and `cargo install wasm-bindgen-cli --version 0.2.130 --locked`.
#   --check    fails if the generated files are older than their sources (needs only Node)
#   --restore  brings back the committed generated files, e.g. before `git pull`
set -eu
cd "$(dirname "$0")/.."

WASM_BINDGEN_VERSION=0.2.130
GENERATED="crates/core-wasm/pkg/gator_core.js crates/core-wasm/pkg/gator_core.d.ts
  crates/core-wasm/pkg/gator_core_bg.wasm crates/core-wasm/pkg/gator_core_bg.wasm.d.ts
  crates/core-wasm/pkg/sources.sha256 catalog/catalog.json"

# What the build was made from. Read from the file system, not git: the build reads it too (an
# untracked manifest is bundled), and a deploy may run where there is no git history. Node does
# the hashing because it is present everywhere this runs; shasum and sha256sum are not.
fingerprint() {
  node -e '
    const { createHash } = require("node:crypto");
    const { readdirSync, readFileSync, statSync } = require("node:fs");
    const sha = (data) => createHash("sha256").update(data).digest("hex");
    const files = (path) =>
      statSync(path).isDirectory()
        ? readdirSync(path).filter((name) => !name.startsWith(".")).flatMap((name) => files(`${path}/${name}`))
        : [path];
    const lines = process.argv.slice(1).flatMap(files).sort().map((file) => `${sha(readFileSync(file))}  ${file}\n`);
    console.log(sha(lines.join("")));
  ' Cargo.toml Cargo.lock rust-toolchain.toml catalog/schema.json catalog/providers/*.toml \
    scripts/build-core.sh crates/core/Cargo.toml crates/core/src crates/core-wasm/Cargo.toml \
    crates/core-wasm/src crates/catalog-tool/Cargo.toml crates/catalog-tool/src
}

case "${1:-}" in
--check)
  [ "$(fingerprint)" = "$(cat crates/core-wasm/pkg/sources.sha256)" ] && exit 0
  echo "The generated files are older than the sources. If you pulled main, CI commits new ones a few minutes after each change: pull again shortly. If you changed crates/ or catalog/ yourself, run scripts/build-core.sh." >&2
  exit 1
  ;;
--restore)
  git update-index --no-skip-worktree $GENERATED
  git checkout HEAD -- $GENERATED
  exit 0
  ;;
esac

if [ "$(wasm-bindgen --version 2>/dev/null)" != "wasm-bindgen $WASM_BINDGEN_VERSION" ]; then
  echo "Run \`cargo install wasm-bindgen-cli --version $WASM_BINDGEN_VERSION --locked\` first." >&2
  exit 1
fi
cargo run -q --locked -p catalog-tool
# Keep this machine's paths out of the binary.
export RUSTFLAGS="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=cargo --remap-path-prefix=$PWD=gator"
cargo build --release --locked --target wasm32-unknown-unknown -p gator-core-wasm
wasm-bindgen --target web --remove-name-section --remove-producers-section \
  --out-dir crates/core-wasm/pkg --out-name gator_core \
  target/wasm32-unknown-unknown/release/gator_core_wasm.wasm
fingerprint > crates/core-wasm/pkg/sources.sha256

# CI must see the difference to commit it. Anywhere else the bytes differ from CI's Linux build,
# so git is told to ignore them and nobody commits them by accident.
if [ -z "${CI:-}" ]; then
  git update-index --skip-worktree $GENERATED
  echo "Built. git ignores the generated files now; run scripts/build-core.sh --restore before pulling changes to them."
fi
