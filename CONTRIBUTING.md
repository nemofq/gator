# Contributing

## Add a provider

### What qualifies

A provider can join the catalog if it runs a **remote MCP server** (Streamable HTTP, `https://`) that
accepts a **static API key in a request header**, or needs no key at all. Servers that need OAuth,
a key in the URL, or a local process do not qualify.

When a provider offers more than one endpoint, `mcp_url` must be the one meant for programmatic
API-key access, not the one for interactive OAuth sign-in.

### The file

One TOML file per provider, `catalog/providers/<id>.toml`. For example, `catalog/providers/tavily.toml`:

```toml
id = "tavily"
name = "Tavily"
description = "Web search, recent news and the text of any web page"
category = ["search", "news"]
mcp_url = "https://mcp.tavily.com/mcp"
signup_url = "https://app.tavily.com"
docs_url = "https://docs.tavily.com/documentation/mcp"
read_only = false
default_enabled_tools = ["tavily_search", "tavily_extract"]

[auth]
header = "Authorization"
format = "Bearer {key}"
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | `a-z`, `0-9` and `-`, at most 32 characters. Must match the file name. Prefixes every tool ID. |
| `name` | yes | Display name. |
| `description` | yes | The sites and kinds of data it covers, at most 120 characters. See below. |
| `category` | yes | One or two lowercase tags, such as `social`, `shopping`, `code`, `web`, `video`. Searched alongside tool names. |
| `mcp_url` | yes | The MCP endpoint, `https://` on a public host. |
| `signup_url` | yes | The page where a new person gets a key, linked as "Get API key" next to the key field: the developer console or API-keys page, or the home page only if signing up there is the way to a key. `https://`. |
| `docs_url` | no | The provider's MCP documentation. |
| `read_only` | yes | `true` only if no tool can write, post, delete or start a paid long-running job. |
| `key_required` | no | `false` if the server works without a key. Defaults to `true`. |
| `default_enabled_tools` | if `read_only = false` | Tools switched on in the provider's first listing, when it is enabled. Empty or absent means all. A tool the provider adds later always starts off. |
| `default_disabled_tools` | no | Tools left off when the provider is enabled. |
| `key_hint` | no | One short sentence next to the key field, only if it helps the owner get a working key: what works without a key, what access to grant. No plan, pricing, quota or credit details: they change and are not ours to maintain. Not the key's format. |
| `quota_signals` | no | Only for a provider that does not answer an exhausted key with HTTP 429 or 402: text it puts in a short result instead, taken from its documentation or a seen result. Gator then switches keys as for a 429. Each must be specific enough that an ordinary result cannot contain it. |
| `auth.header` | unless `key_required = false` | The request header that carries the key. |
| `auth.format` | with `auth.header` | The header value, with `{key}` where the key goes. |

`catalog/schema.json` is the precise definition.

### Choosing the description and the default tools

Agents read `description` to decide whether Gator has the data they need, and the summary built from
every description is sent in each conversation. Write it as the phrases a person asks with ("Reddit
posts and comments", "YouTube video transcripts"), name the sites and kinds of data rather than the
provider, and claim only what the tools that are on by default can return.

Every call goes through one Gator tool, so an agent's per-tool permission prompts no longer protect
the owner. Tools that are on by default must therefore be read-only and cheap. Leave off anything that
writes or deletes, starts crawls, agents or batch jobs, costs unusually many credits, needs a paid plan,
is deprecated, or is not about the data the description promises. Tools that appear upstream later
always start disabled, even when `default_enabled_tools` names them, until the owner switches them on.

### An icon (optional)

`catalog/icons/<id>.png`: the provider's own icon as an opaque square PNG of 64 × 64 pixels (RGB,
no transparency), at most 8 KB. The dashboard rounds its corners like an app icon. If the
provider's mark has a transparent background, place it centred on a white square at about
44 pixels across. Without an icon the dashboard shows the name's first letter on a tile.

### Open a pull request

The pull request is the TOML file, and the icon if you add one; you need no toolchain. CI validates it, and after the merge
it rebuilds `catalog/catalog.json` and commits it. Do not include that file.

To try the provider first, add it to your own deployment as a custom MCP in the dashboard
(Providers, then Add custom MCP), with the same URL and header.

## Change the code

| Path | What it is |
| --- | --- |
| `crates/core` | Rust core: catalog validation, tool index and search, argument validation, routing. No I/O. |
| `crates/core-wasm` | The core compiled to WebAssembly. The compiled output is committed. |
| `crates/catalog-tool` | Validates `catalog/providers/` and writes `catalog/catalog.json`. |
| `apps/worker` | Worker shell in TypeScript: OAuth, MCP transport, upstream calls, storage. |
| `apps/dashboard` | Dashboard in Preact. |

```bash
pnpm install
pnpm run check        # format, lint and type-check
pnpm run test
cargo test
```

The compiled core in `crates/core-wasm/pkg` and `catalog/catalog.json` are generated, and only CI
generates the committed copies: after every change to `main` it builds them on Linux and commits
them. Pull requests must not change them.

After changing `crates/` or `catalog/`, run `scripts/build-core.sh` to build them locally (it needs
[rustup](https://rustup.rs) and `cargo install wasm-bindgen-cli --version 0.2.130 --locked`). Your
build differs byte for byte from CI's, so the script tells git to ignore those files and `git status`
stays clean. Run `scripts/build-core.sh --restore` to bring back the committed files; `git pull`
refuses to run while upstream has changed them and yours are hidden.

Keep changes small and dependencies few. Add an option or a layer only when something real needs it
today.
