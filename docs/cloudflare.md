# Deploy your own private Cloudflare connector

[Back to README](../README.md)

This runs the server on Cloudflare Workers, so your computer can be off. You supply your own YNAB token and Cloudflare account. A separate connector password protects the single owner's OAuth login.

## 1. Prepare the project

Install Node.js 22+ and the project's pinned pnpm version (11.24.0), then:

```sh
git clone https://github.com/itsRoze/ynab-mcp.git
cd ynab-mcp
pnpm install --frozen-lockfile
pnpm run build
pnpm run setup
pnpm run doctor
```

If you've already done local setup, use that checkout and skip these commands. `setup` saves your YNAB personal access token in `.env`. You do not need to run the local client configuration command for a hosted installation.

## 2. Configure Cloudflare

Create a Cloudflare account if needed. This project uses Workers, a SQLite Durable Object, and Workers KV. Review [Cloudflare pricing](https://developers.cloudflare.com/workers/platform/pricing/) for your account and usage.

```sh
pnpm exec wrangler login
pnpm exec wrangler whoami
pnpm exec wrangler kv namespace create ynab-private-oauth
cp wrangler.jsonc wrangler.private.json
```

Edit **`wrangler.private.json`**, leaving the public template unchanged:

- Add a top-level `"account_id": "YOUR_ACCOUNT_ID"` using the account reported by `whoami`.
- Set `name` to a Worker name that is unused in your account. The default is `ynab-private`; do not reuse an unrelated Worker's name.
- Replace `REPLACE_WITH_YOUR_NAMESPACE_ID` in `kv_namespaces` with the ID returned by the namespace creation command.
- Leave `vars.PUBLIC_ORIGIN` as an empty string for the first deployment.
- Keep the remaining bindings, migrations, and compatibility settings intact.

The private file must be valid JSON (no comments or trailing commas). The template is already valid JSON despite its `.jsonc` extension. `wrangler.private.json` is Git-ignored.

## 3. Deploy and save your connector password

```sh
pnpm run deploy
pnpm run remote:password
```

Run the password command in your own terminal and save the result in your password manager. It is a generated password for this connector, **not your YNAB account password**.

The deployment script:

1. Creates the Worker with access disabled until credentials are configured.
2. Discovers its `workers.dev` address and saves `PUBLIC_ORIGIN` in your private configuration.
3. Uploads the YNAB token and connector password as Cloudflare secrets through stdin.
4. Deploys the configured server and prints the connector URL ending in `/mcp`.

The password is stored locally in the ignored `.env.remote` file with owner-only permissions and reused on later deployments. Keep it and `.env` private. The script targets `workers.dev`; custom domains require additional configuration.

## 4. Connect your client

Use the **full URL ending in `/mcp`**, for example:

```text
https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/mcp
```

### Codex

On the computer containing your deployment files:

```sh
pnpm run connect:codex
```

This backs up the Codex configuration, registers the hosted endpoint as `ynab`, and replaces a local `ynab` entry if present. First registration uses browser login. Later reconnections use the local connector password with Codex's no-browser login flow.

On another computer with the Codex CLI installed:

```sh
codex mcp add ynab --url https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/mcp
```

Complete the browser login with your connector password. If already registered, use `codex mcp login ynab` to authenticate again. Start a new session after connecting.

### Claude Code

With the Claude Code CLI installed:

```sh
claude mcp add --transport http ynab https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/mcp
```

Open Claude Code and use `/mcp` to authenticate the server. If `ynab` already names a local registration, remove that entry or choose a different name for the remote connector.

### Claude web and mobile

If your account supports custom connectors, add the URL in Claude's connector settings on the web and complete the password/consent flow. Enable the connector in your conversation. Availability in the mobile client depends on Claude's current account and client support; consult [Claude's remote MCP guide](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp).

The deployment can stay online independently of your laptop, but it does not automatically register itself with every client or cloud agent environment.

## Verify and update

Ask your client to list your YNAB plans, then read a month's budget. No budget changes are needed to verify connectivity.

```sh
pnpm run check:worker
pnpm run test:remote
pnpm run deploy
```

The remote test command uses fake secrets and isolated local storage, with no YNAB calls. An optional live check authenticates against your deployment and performs one read-only `list_plans` call:

```sh
node test/remote-flow.mjs --live
```

It prints the accessible plan count, not plan names or balances. To update from GitHub, pull the changes, run `pnpm install --frozen-lockfile`, run the tests above, and redeploy. Your ignored private files remain local.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Opening `/mcp` directly returns 401 | Expected without OAuth credentials. Add the URL in an MCP client; `/` is the human-readable landing page. |
| `127.0.0.1` refuses the OAuth callback | The local CLI's temporary callback listener may have exited. Restart login from the client and complete the new flow; don't reload an old callback URL. |
| `Forbidden origin` | Start a fresh login from the client. Confirm `PUBLIC_ORIGIN` exactly matches the Worker's HTTPS origin, with no `/mcp` suffix or trailing slash. |
| Service unavailable after initial deployment | Verify both Cloudflare secrets and `PUBLIC_ORIGIN` were installed; rerun `pnpm run deploy`. |
| Wrong Cloudflare account or namespace | Check `account_id` and the KV ID in the private configuration. |
| Lost connector password | Run `pnpm run remote:password` in the deployment checkout. It reads `.env.remote` and refuses non-interactive output. |

## Authentication and operating notes

OAuth uses PKCE S256, single-use consent challenges, an HttpOnly cookie, and a login attempt limit. Access tokens last one hour; refresh tokens last 30 days. The hosted server exposes read and write tools; `.env`'s local `YNAB_READ_ONLY` setting does not configure the Worker.

To rotate the password, replace `CONNECTOR_PASSWORD` in `.env.remote` with a newly generated random value of at least 32 characters and redeploy. **Password rotation does not revoke existing OAuth grants.** To revoke all clients, create a new OAuth KV namespace, update its ID in the private configuration, and redeploy. All clients must then reconnect. Revoke a compromised YNAB token separately in YNAB, update `.env`, and redeploy.

The Durable Object coordinates requests from remote clients and holds a short-lived cache. It cannot coordinate edits in the YNAB app or a separate local server. Financial responses remain in memory; OAuth grants and expiring consent state are persisted. Sampled Cloudflare operational logs and traces are enabled. Review [tool behavior](tools.md) before making budget changes.
