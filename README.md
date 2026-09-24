# YNAB Conversation MCP

**Talk through your budget. Put the changes into YNAB.**

[![CI](https://github.com/itsRoze/ynab-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/itsRoze/ynab-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/package_manager-pnpm-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/installation)

Connect Claude or Codex to your YNAB plan with [Model Context Protocol](https://modelcontextprotocol.io/). Review spending, assign money, move funds between categories, and update transactions as you talk.

Run it on your computer, or deploy your own private Cloudflare endpoint that stays available when your laptop is off.

> “Help me budget this month. Start with what's available and which categories need attention.”
>
> “Move $40 from dining out to groceries.”
>
> “Find my uncategorized transactions and help me categorize them.”

Example prompts only—no personal budget data is included in this repository.

## Choose your setup

| | On your computer | On Cloudflare |
| --- | --- | --- |
| Connection | Local stdio | Remote HTTP with OAuth |
| Clients | Claude Code, Claude Desktop, Codex | Clients that support remote MCP and OAuth |
| Availability | While the local server can run | Independent of your laptop |
| Credentials | Local `.env` | Cloudflare secrets + separate connector password |
| Get started | [Local installation](#local-installation) | [Cloudflare deployment guide](docs/cloudflare.md) |

The Cloudflare deployment is for **one owner and one YNAB token**. Each person should deploy their own instance. This is an independent community project, not affiliated with YNAB, Anthropic, or OpenAI.

## Local installation

You'll need **Node.js 22 or newer**, **pnpm 11.24.0** (the version pinned in this project), and a YNAB personal access token. See [pnpm installation](https://pnpm.io/installation) if needed.

```sh
git clone https://github.com/itsRoze/ynab-mcp.git
cd ynab-mcp
pnpm install --frozen-lockfile
pnpm run build
pnpm run setup
pnpm run doctor
pnpm run config
```

1. Create a token in **YNAB → Account Settings → Developer Settings**. Enter it at the hidden `setup` prompt, not in an agent conversation.
2. `doctor` verifies authentication with a read-only call; it does not print your financial data.
3. `config` offers a menu for **Codex**, **Claude Code**, **both**, or **Claude Desktop**, and installs the configuration for you. Restart your client or start a new session afterward.

The setup command saves your token in a Git-ignored `.env` file with owner-only permissions and refuses to overwrite it. Client configuration references that file rather than copying the token. Desktop configuration is backed up before changes.

Prefer a direct command? Use `pnpm run config --client codex`, `--client claude`, `--client both`, or `--client desktop`. Use `pnpm run config --print codex` to inspect manual configuration. If you move the checkout or your Node installation, rerun configuration.

**Read-only local mode:** set `YNAB_READ_ONLY=true` in `.env` to omit write tools. Writes are otherwise enabled. The hosted deployment currently exposes both read and write tools.

## Use it from anywhere

[Deploy to Cloudflare →](docs/cloudflare.md)

The guide covers account setup, OAuth storage, secret installation, connecting clients, updates, and troubleshooting. Once deployed, your client connects to your own URL:

```text
https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/mcp
```

The YNAB token stays on the server. Sign in using a separate generated connector password. Remote client availability, including mobile, depends on the client's custom connector support and your account.

## What it can do

- **Understand your budget:** plans, accounts, categories, targets, monthly totals, and Ready to Assign.
- **Find spending:** transactions by date and filters, individual transaction details, and upcoming scheduled transactions.
- **Budget together:** set monthly assigned amounts and move available money between categories.
- **Keep things tidy:** create or update transactions; change category names, notes, and target amounts.

[Full tool reference and write behavior →](docs/tools.md)

Amounts use exact decimal strings in your plan's currency. Budget changes check fresh assignments before writing, and transaction creation supports retry deduplication. Client permissions still apply; the server itself does not add a confirmation dialog.

**Know the limits:** moving money requires two YNAB writes and can partially succeed. An uncertain write is never automatically retried. Avoid simultaneous edits across clients and the YNAB app. Transaction deletion, split editing, scheduled-transaction editing, and advanced target cadence editing are not supported.

## Privacy

Your token is sent only to the official YNAB API over HTTPS; redirects are rejected. Financial responses are not persisted by this server. Local mode has no telemetry. Cloudflare mode stores OAuth grants and consent state and enables sampled operational logs/traces, without application logging of tokens, passwords, request bodies, or financial results.

Your AI provider receives the tool results it requests. Keep `.env`, `.env.remote`, `wrangler.private.json`, and local runtime files private; they are excluded from Git. Never attach real budget exports or credentials to issues.

## Development

```sh
pnpm install --frozen-lockfile
pnpm test                 # Build, unit tests, and stdio MCP integration
pnpm run check:worker     # Worker type checking
pnpm run test:remote      # Local Workers runtime: OAuth + MCP integration
pnpm pack --dry-run       # Inspect package contents
```

Tests use synthetic data and run without YNAB credentials. CI checks Node.js 22 and 24. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

| Directory | Purpose |
| --- | --- |
| `src/` | YNAB API client, money conversion, MCP tools, stdio entry point |
| `worker/` | Cloudflare transport, owner login, request coordination |
| `scripts/` | Setup, client configuration, deployment, diagnostics |
| `test/` | Synthetic API, protocol, and authentication tests |

## License & references

[MIT](LICENSE). Source installation is supported; no published npm package is required.

[YNAB API](https://api.ynab.com/) · [MCP](https://modelcontextprotocol.io/) · [Claude Code MCP](https://code.claude.com/docs/en/mcp) · [Codex MCP](https://developers.openai.com/codex/mcp/)

“Plan” and “budget” refer to the same YNAB concept here.
