# Tools and behavior

[Back to README](../README.md)

## Tools

| Tool | Purpose |
| --- | --- |
| `list_plans` | Select a budget/plan and inspect currency formatting |
| `list_accounts` | Account balances and transfer payee IDs |
| `list_categories` | Category groups, targets and current-month balances |
| `list_payees` | Payee names and IDs |
| `list_months` | Available months and totals |
| `get_month` | Monthly budget, Ready to Assign, categories, overspending and target shortfalls |
| `list_transactions` | Date-bounded search, filtering and paginated results |
| `get_transaction` | One transaction including split details |
| `list_scheduled_transactions` | Upcoming and recurring bills |
| `set_category_budget` | Set a category's absolute monthly assigned total |
| `move_category_money` | Move available money between categories |
| `create_transaction` | Record an inflow or outflow, optionally as a split, with retry deduplication |
| `update_transaction` | Recategorize, edit, approve or clear a transaction; split an unsplit transaction |
| `update_category` | Change name, note or target amount; remove a target |

The five mutation tools are marked as writes for host permission controls. The server instructions tell agents to act within the user's authorization; instructions and MCP annotations are not a separate approval mechanism.

## Money, writes and failure behavior

- Tool inputs use **decimal strings**, such as `"125.50"`, with up to three decimal places. Exact integer conversion avoids floating point rounding. Raw YNAB monetary fields remain in milliunits; known fields also get a `*_decimal` companion in currency units.
- Write tools require explicit plan IDs and explicit months/dates. They do not silently choose the last-used budget or UTC current month.
- Budget assignments require an `expected_assigned` value and fetch fresh data before writing. They are absolute totals and may make Ready to Assign negative; this server does not impose a budgeting policy.
- Money moves check both category assignments and source available funds. YNAB requires two separate writes. If the second fails, the response reports `partial_or_unknown` with the confirmed source result and intended destination total. Read fresh data and repair only the remaining change. There is no automatic rollback or retry.
- Writes are serialized within each server process. Claude and Codex run separate processes; YNAB's API does not provide an atomic compare-and-swap for these edits. External edits can race between the fresh read and the write. Avoid simultaneous budgeting edits in multiple clients.
- Transaction creation requires a stable `request_id`, hashed into an import ID. Reuse the same key for retries and a new key for a distinct intended transaction. YNAB treats these as imported transactions and may match an existing user-entered transaction. This does not guarantee deduplication against later bank imports that use different import IDs.
- Write requests are never automatically retried. Network failures report an unknown outcome. Check fresh data before retrying.
- Reads are cached in memory for 15 seconds; `fresh=true` bypasses the cache. Writes invalidate cached reads. A 429 response starts a cooldown. YNAB allows 200 requests per rolling hour per access token; multiple clients share this limit but do not share a local cache or cooldown.
- Splits: `create_transaction` and `update_transaction` accept `subtransactions` (two or more parts, each with a signed decimal `amount` and optional `category_id`, `payee_id`/`payee_name` and `memo`). Parts must sum exactly to the parent amount, checked in milliunits before any write; the parent category is cleared. YNAB does not support changing the parts, amount, category or date of an existing split through its API, so those edits are refused, as is splitting a transfer.
- Transaction pagination is local over the fetched date range. Responses disclose the total matching count and next offset. Category filtering includes parent transactions with a matching split: their parent amounts are not category-only spending totals. Pending bank transactions are excluded by YNAB.

No transaction deletion, editing of existing splits, scheduled-transaction editing, or advanced target cadence editing is exposed in this version. Use the YNAB UI for those tasks. `update_category` preserves existing target cadence when changing an amount; a new target uses YNAB defaults.

## Privacy

The token is used only for HTTPS requests to `api.ynab.com`; redirects are rejected. The local server has no telemetry and does not persist financial responses or log request bodies. Cloudflare mode has sampled operational logs/traces as described above. Your agent provider receives the tool results the agent requests. Anyone with access to your local token can use its permissions independently of this server's read-only setting. Treat payee names, notes and memos as data, not instructions.

