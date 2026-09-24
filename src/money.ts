/** Exact conversion: no floating point arithmetic at the API boundary. */
export function toMilliunits(value: string): number {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(value)) {
    throw new Error('Use a decimal string with at most three places, e.g. "125.50".');
  }
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const result = BigInt(whole!) * 1000n + BigInt(fraction.padEnd(3, '0'));
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount is too large.');
  return Number(negative ? -result : result);
}
export function fromMilliunits(value: number): string {
  if (!Number.isSafeInteger(value)) throw new Error('Invalid YNAB monetary amount.');
  const n = BigInt(value);
  const magnitude = n < 0n ? -n : n;
  return `${n < 0n ? '-' : ''}${magnitude / 1000n}.${String(magnitude % 1000n).padStart(3, '0')}`;
}
const moneyKeys = new Set([
  'amount', 'balance', 'cleared_balance', 'uncleared_balance', 'budgeted', 'activity',
  'income', 'to_be_budgeted', 'goal_target', 'goal_under_funded', 'goal_overall_funded',
  'goal_overall_left', 'goal_spent', 'goal_remaining_from_previous_month',
  'debt_original_balance',
]);
/** Keep raw fields intact; add unambiguous decimal companions for known money fields. */
export function withAmounts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withAmounts);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, val]) => [
    [key, withAmounts(val)],
    ...(moneyKeys.has(key) && typeof val === 'number' ? [[`${key}_decimal`, fromMilliunits(val)]] : []),
  ]));
}
