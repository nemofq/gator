<img src=".github/logo.svg" width="72" height="72" alt="">

# Gator

**A data MCP gateway for all your agents, built in Rust for performance.**

Gator puts all the data MCP servers your agents need behind one endpoint. You stop configuring every MCP in every agent, and get one place to manage them, see their usage and stay in control. It runs on your own Cloudflare account with your own keys, and its core is written in Rust for excellent performance.

## Why

**Agents are missing data.** Ask yours to research a purchase, and Amazon blocks it. Ask it for what real users think, and Reddit has shut down its RSS feeds. Ask it about a project on GitHub, and the public API leaves things out and limits how often it can ask.

**Every agent needs its own setup.** You probably use several agents: a chat app, a coding agent, something on your phone, something you built. Each data MCP has to be set up in every one of them, and every change means doing it all again in each place.

Gator fixes both.

## Design

- **MCP in, MCP out.** MCP is the standard way agents reach tools, so Gator speaks only MCP.
- **Progressive discovery.** Agents see three tools, `search_tools`, `describe_tool` and `call_tool`, instead of hundreds, which saves context.
- **Fast and light.** A high-performance Rust core, and a design light enough to deploy to your Cloudflare account in one click.

## What you get

- **One endpoint, one sign-in.** An MCP URL protected by OAuth, for Claude, Codex or any agent.
- **A catalog of providers.** Enable one, paste its key, done. Or add any other MCP server that takes a key in a header.
- **A dashboard.** See what each agent calls, how often, and what failed. Switch individual tools on or off from the same place.
- **No surprise tool changes.** When a provider adds or changes a tool, you see it. New tools stay off until you turn them on, and you can choose to approve changes before your agents see them.

## Quick start

You need a Cloudflare account and a GitHub account. The Workers Free plan is enough.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nemofq/gator)

1. **Git account:** connect or choose your GitHub account. Cloudflare creates your copy of Gator there and deploys from it. Private or public is your choice; the copy holds no secrets.
2. **Project name:** keep `gator` or choose your own. It names your copy, your Worker and its address, `https://<name>.<you>.workers.dev`.
3. **Secrets:** enter the two secrets below.
4. Leave the KV namespace, D1 database and advanced settings as they are, and select **Deploy**.

**From the command line**, without a GitHub copy. You need Node.js 22.12+ and pnpm.

```bash
git clone https://github.com/nemofq/gator && cd gator
pnpm install && pnpm run setup
```

`setup` signs you in to Cloudflare, creates the database, generates the encryption key, asks for an owner password, and deploys.

Either way, you get:

```
Dashboard:    https://gator.<you>.workers.dev/
MCP endpoint: https://gator.<you>.workers.dev/mcp
```

Sign in to the dashboard, enable a provider and paste its key.

### The two secrets

| | What it is | If you lose it |
| --- | --- | --- |
| `MASTER_KEY` | The encryption key for your provider keys: 64 hex characters, from `openssl rand -hex 32`. `setup` generates it and prints it once. Keep a copy. | Set a new one, then enter every provider key again. |
| `OWNER_PASSWORD` | Your sign-in for the dashboard and for approving each agent that connects. At least 12 characters. | Set a new one in Cloudflare (your Worker, Settings, Variables and Secrets) or with `pnpm exec wrangler secret put OWNER_PASSWORD`. |

### Update

Providers, keys and connected agents are kept.

**One click:** in a clone of your copy, run the update script and push. Cloudflare redeploys. The script takes every file from this repository and keeps your Worker's name and IDs.

```bash
git clone https://github.com/<you>/<name> && cd <name>
node scripts/update.mjs && git push
```

**Command line:** `git pull && pnpm run deploy`

## Connect an agent

Send your agent this prompt, with your endpoint:

```
Add this MCP server: https://gator.<you>.workers.dev/mcp (Streamable HTTP, OAuth)
```

It opens a sign-in page; approve with your owner password. The dashboard's Agents page has the same prompt with your URL filled in.

## Providers

### Current providers

| Provider | Data |
| --- | --- |
| [Redlisten](https://redlisten.com/?ref=gator) | Reddit posts and comments: search, a subreddit's latest posts, threads, user history, mention counts |
| [X](https://developer.x.com/?ref=gator) | Posts on X (Twitter): search, single posts, replies, profiles, a user's posts. Billed per post. |
| [ZooData](https://zoodata.ai/?ref=gator) | Amazon products and reviews: search, details, live prices, price and sales history, best sellers |
| [TranscriptAPI](https://transcriptapi.com/?ref=gator) | YouTube transcripts and search: video details, a channel's videos and playlists |
| [Financial Modeling Prep](https://site.financialmodelingprep.com/?ref=gator) | Stock quotes, price history, financial statements, analyst targets, earnings dates, SEC filings, insider trades |
| [Tavily](https://tavily.com/?ref=gator) | Web search, recent news and the text of any web page |
| [Firecrawl](https://www.firecrawl.dev/?ref=gator) | Web search and the text of any web page or PDF |
| [GitHub](https://github.com/?ref=gator) | Repositories: files, commits, issues, pull requests, releases, code search |

You sign up with each provider yourself. Gator ships no keys and no data.

### Add a provider

Any remote MCP server that takes a static API key in a header, or no key, can be added.

**In your dashboard**, just for you: Providers, Add custom MCP. Enter the URL, the header and your key.

**As a pull request**, for everyone: add `catalog/providers/<id>.toml`. No code needed.

```toml
id = "tavily"
name = "Tavily"
description = "Web search, recent news and the text of any web page"
category = ["search", "news"]
mcp_url = "https://mcp.tavily.com/mcp"
signup_url = "https://app.tavily.com"
read_only = false
default_enabled_tools = ["tavily_search", "tavily_extract"]

[auth]
header = "Authorization"
format = "Bearer {key}"
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for every field.

## How it is built

- **Core (Rust, compiled to WebAssembly).** Catalog validation, tool search, argument checks, routing and tool diffs. No I/O. The dashboard runs it too.
- **Worker (TypeScript).** OAuth, MCP transport, provider calls and storage.
- **Storage.** Cloudflare D1, and KV for OAuth.
- **Dashboard.** Preact, served by the same Worker.

Written in Rust. Gators eat pythons.

## Security

- Provider keys are encrypted at rest with your `MASTER_KEY` and cannot be read back from the dashboard.
- Keys and request bodies are never logged. For a failed call, the first 300 characters of the provider's message are kept.
- Gator connects only to the providers you enabled and, when an agent signs in, to the address where its client publishes its details.
- Tools come from third parties, so you decide what reaches your agents. New tools stay off until you turn them on. Turn on review for a provider, and a changed tool waits for your approval.

## License

MIT
