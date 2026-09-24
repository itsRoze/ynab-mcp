# Contributing

Use Node.js 22+ and pnpm 11.24.0 (pinned in `packageManager`). Fork the repository, create a branch, and install dependencies with `pnpm install --frozen-lockfile`.

Before opening a pull request, run:

```sh
pnpm test
pnpm run check:worker
pnpm run test:remote
pnpm pack --dry-run
```

Describe the behavior changed and how you verified it. Add behavior tests for new tools and failure cases. HTTP tests should inject a fetch implementation and use synthetic fixtures. CI must run without YNAB credentials. Never commit tokens, real budget exports, personal account IDs, or transaction histories.

Keep monetary arithmetic in integer milliunits, expose decimal strings to agents, and clearly describe whether a write sets an absolute value or applies a delta. Do not automatically retry writes with uncertain outcomes. Keep stdout reserved for the MCP protocol.

For new API behavior, verify the current [YNAB OpenAPI specification](https://api.ynab.com/papi/open_api_spec.yaml). Document partial-write behavior, concurrency limitations, and import-matching effects. Changes to authentication should include the corresponding remote integration coverage.

Use issues for reproducible bugs and focused feature requests, with synthetic examples. Follow [SECURITY.md](SECURITY.md) for vulnerabilities.
