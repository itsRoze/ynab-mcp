import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from '../dist/server.js';
import { YnabApi } from '../dist/api.js';
import { toMilliunits, fromMilliunits, withAmounts } from '../dist/money.js';

const plan = '00000000-0000-4000-8000-000000000001';
const catA = '00000000-0000-4000-8000-000000000002';
const catB = '00000000-0000-4000-8000-000000000003';
const txId = '00000000-0000-4000-8000-000000000004';
const account = '00000000-0000-4000-8000-000000000005';
const month = '2026-09-01';
const ok = data => new Response(JSON.stringify({ data }), { status: 200 });
async function harness(t, fn, options = {}) {
  const requests = [];
  const api = new YnabApi({ token: 'test-secret', fetch: async (url, init) => {
    const request = { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined };
    requests.push(request);
    assert.equal(init.headers.Authorization, 'Bearer test-secret');
    assert.equal(init.redirect, 'manual');
    return fn(request, requests.length);
  } });
  const server = createServer(api, options);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, requests, call: (name, args) => client.callTool({ name, arguments: args }) };
}
const data = result => JSON.parse(result.content[0].text);

test('money preserves exact thousandths, signs and safe integer boundaries', () => {
  for (const [input, units] of [['0', 0], ['12.34', 12340], ['-0.001', -1], ['9007199254740.991', Number.MAX_SAFE_INTEGER]]) {
    assert.equal(toMilliunits(input), units);
    assert.equal(toMilliunits(fromMilliunits(units)), units);
  }
  for (const input of ['NaN', '1e3', '1.0001', '$10', '9007199254740.992']) assert.throws(() => toMilliunits(input));
  assert.deepEqual(withAmounts({ balance: -12340, goal_percentage_complete: 50 }), {
    balance: -12340, balance_decimal: '-12.340', goal_percentage_complete: 50,
  });
});

test('MCP handshake exposes read and write tools with correct annotations', async t => {
  const { client } = await harness(t, () => ok({}));
  const { tools } = await client.listTools();
  assert.equal(tools.length, 14);
  assert.equal(tools.find(t => t.name === 'get_month').annotations.readOnlyHint, true);
  assert.equal(tools.find(t => t.name === 'set_category_budget').annotations.destructiveHint, true);
  assert.equal(tools.find(t => t.name === 'move_category_money').annotations.idempotentHint, false);
});

test('read-only mode removes all mutation tools', async t => {
  const { client } = await harness(t, () => ok({}), { readOnly: true });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 9);
  assert.ok(tools.every(t => t.annotations.readOnlyHint));
});

test('monthly overview highlights overspending and underfunded targets', async t => {
  const { call } = await harness(t, () => ok({ month: { to_be_budgeted: 50000, categories: [
    { id: catA, name: 'Food', budgeted: 100000, balance: -12340, goal_under_funded: 50000 },
    { id: catB, name: 'Hidden', hidden: true, balance: -1000 },
  ] } }));
  const result = data(await call('get_month', { plan_id: plan, month }));
  assert.equal(result.attention.overspent.length, 1);
  assert.equal(result.attention.underfunded[0].goal_under_funded_decimal, '50.000');
  assert.equal(result.month.to_be_budgeted_decimal, '50.000');
});

test('assignment writes exact absolute amount and guards against stale observations', async t => {
  let budgeted = 100000;
  const { call, requests } = await harness(t, req => {
    if (req.method === 'PATCH') budgeted = req.body.category.budgeted;
    return ok({ category: { id: catA, budgeted } });
  });
  const args = { plan_id: plan, category_id: catA, month, assigned: '150.25', expected_assigned: '100' };
  assert.equal((await call('set_category_budget', args)).isError, undefined);
  assert.equal(budgeted, 150250);
  assert.equal(data(await call('set_category_budget', args)).status, 'already_applied');
  const stale = await call('set_category_budget', { ...args, assigned: '200' });
  assert.equal(stale.isError, true);
  assert.equal(requests.filter(r => r.method === 'PATCH').length, 1);
});

test('invalid dates, money precision and extra input fields never reach YNAB', async t => {
  const { call, requests } = await harness(t, () => ok({}));
  for (const args of [{ plan_id: plan, month: '2026-02-30' }, { plan_id: plan, month, surprise: true }]) {
    assert.equal((await call('get_month', args)).isError, true);
  }
  assert.equal((await call('set_category_budget', { plan_id: plan, category_id: catA, month, assigned: '1.00001', expected_assigned: '0' })).isError, true);
  assert.equal(requests.length, 0);
});

test('move preflights available funds and reports partial destination failure without rollback', async t => {
  const { call, requests } = await harness(t, req => {
    const source = req.url.endsWith(catA);
    if (req.method === 'PATCH' && !source) return new Response('{}', { status: 500 });
    return ok({ category: { id: source ? catA : catB, budgeted: req.body?.category.budgeted ?? (source ? 100000 : 20000), balance: source ? 50000 : 20000 } });
  });
  const args = { plan_id: plan, month, from_category_id: catA, to_category_id: catB, amount: '25', expected_from_assigned: '100', expected_to_assigned: '20' };
  const result = data(await call('move_category_money', args));
  assert.equal(result.status, 'partial_or_unknown');
  assert.equal(result.source.category.budgeted, 75000);
  assert.equal(result.intended_destination_budgeted, 45000);
  assert.equal(requests.filter(r => r.method === 'PATCH').length, 2);
});

test('move rejects insufficient available funds before any writes', async t => {
  const { call, requests } = await harness(t, req => ok({ category: { budgeted: 100000, balance: 1000 } }));
  const result = await call('move_category_money', { plan_id: plan, month, from_category_id: catA, to_category_id: catB, amount: '25', expected_from_assigned: '100', expected_to_assigned: '100' });
  assert.equal(result.isError, true);
  assert.ok(requests.every(r => r.method === 'GET'));
});

test('transaction retries reuse import ID and convert negative spending exactly', async t => {
  const { call, requests } = await harness(t, req => ok({ transaction: req.body.transaction }));
  const args = { plan_id: plan, account_id: account, date: '2026-09-01', amount: '-12.34', payee_name: 'Coffee', request_id: 'coffee-receipt-1' };
  await call('create_transaction', args);
  await call('create_transaction', args);
  const [a, b] = requests;
  assert.equal(a.body.transaction.amount, -12340);
  assert.equal(a.body.transaction.import_id, b.body.transaction.import_id);
  assert.equal(a.body.transaction.import_id.length, 36);
  assert.equal(a.body.transaction.request_id, undefined);
});

test('recategorization preserves omitted fields and refuses unsupported split edits', async t => {
  let split = false;
  const { call, requests } = await harness(t, req => ok({ transaction: req.method === 'GET'
    ? { id: txId, amount: -999, memo: 'keep', subtransactions: split ? [{ amount: -999 }] : [] }
    : req.body.transaction }));
  await call('update_transaction', { plan_id: plan, transaction_id: txId, category_id: catA });
  assert.deepEqual(requests.at(-1).body, { transaction: { category_id: catA } });
  split = true;
  assert.equal((await call('update_transaction', { plan_id: plan, transaction_id: txId, amount: '20' })).isError, true);
  assert.equal(requests.filter(r => r.method === 'PUT').length, 1);
});

test('transaction filtering includes splits and reports pagination explicitly', async t => {
  const { call } = await harness(t, req => {
    assert.ok(req.url.includes('since_date=2026-09-01'));
    assert.ok(req.url.includes('until_date=2026-09-30'));
    return ok({ transactions: [
      { id: 'a', category_id: catA }, { id: 'b', category_id: null, subtransactions: [{ category_id: catA }] },
      { id: 'c', category_id: catB }, { id: 'd', category_id: catA, deleted: true },
    ] });
  });
  const result = data(await call('list_transactions', { plan_id: plan, since_date: '2026-09-01', until_date: '2026-09-30', category_id: catA, limit: 1 }));
  assert.equal(result.total_matching, 2);
  assert.equal(result.next_offset, 1);
  assert.equal(result.transactions.length, 1);
});

test('read cache is bypassed on fresh reads and invalidated on writes', async () => {
  let calls = 0;
  const api = new YnabApi({ token: 'secret', fetch: async () => ok({ calls: ++calls }) });
  assert.equal((await api.request('/plans')).calls, 1);
  assert.equal((await api.request('/plans')).calls, 1);
  assert.equal((await api.request('/plans', { fresh: true })).calls, 2);
  await api.request('/plans/a/categories/b', { method: 'PATCH', body: {} });
  assert.equal((await api.request('/plans')).calls, 4);
});

test('429 backoff stops additional requests and API errors never echo sensitive bodies', async () => {
  let calls = 0;
  const api = new YnabApi({ token: 'secret', fetch: async () => {
    calls++;
    return new Response('secret private financial data', { status: 429, headers: { 'retry-after': '60' } });
  } });
  await assert.rejects(api.request('/plans'), /rate limit/);
  await assert.rejects(api.request('/plans'), /rate limit/);
  assert.equal(calls, 1);
  const denied = new YnabApi({ token: 'secret', fetch: async () => new Response('secret', { status: 401 }) });
  await assert.rejects(denied.request('/plans'), e => !e.message.includes('secret') && e.status === 401);
});

test('network failure on write is never retried and reports uncertainty', async () => {
  let calls = 0;
  const api = new YnabApi({ token: 'secret', fetch: async () => { calls++; throw new Error('secret'); } });
  await assert.rejects(api.request('/plans/a/transactions', { method: 'POST', body: {} }), /outcome is unknown/);
  assert.equal(calls, 1);
});

test('real stdio process completes MCP handshake with no YNAB network request', async t => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], env: { YNAB_ACCESS_TOKEN: 'test-only-unused' }, stderr: 'pipe' });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 14);
});

test('successful move conserves total assignments', async t => {
  const values = new Map([[catA, 100000], [catB, 20000]]);
  const { call } = await harness(t, req => {
    const id = req.url.split('/').at(-1);
    if (req.method === 'PATCH') values.set(id, req.body.category.budgeted);
    return ok({ category: { id, budgeted: values.get(id), balance: values.get(id) } });
  });
  const result = data(await call('move_category_money', { plan_id: plan, month, from_category_id: catA, to_category_id: catB, amount: '25.125', expected_from_assigned: '100', expected_to_assigned: '20' }));
  assert.equal(result.status, 'applied');
  assert.equal(values.get(catA), 74875);
  assert.equal(values.get(catB), 45125);
  assert.equal(values.get(catA) + values.get(catB), 120000);
});

test('concurrent assignments serialize so only one stale-based change succeeds', async t => {
  let budgeted = 100000;
  const { call, requests } = await harness(t, req => {
    if (req.method === 'PATCH') budgeted = req.body.category.budgeted;
    return ok({ category: { id: catA, budgeted } });
  });
  const args = { plan_id: plan, month, category_id: catA, expected_assigned: '100' };
  const results = await Promise.all([
    call('set_category_budget', { ...args, assigned: '150' }),
    call('set_category_budget', { ...args, assigned: '200' }),
  ]);
  assert.equal(results.filter(r => r.isError).length, 1);
  assert.equal(requests.filter(r => r.method === 'PATCH').length, 1);
});

test('a delayed pre-write read cannot repopulate the post-write cache', async () => {
  let finishRead;
  let calls = 0;
  const api = new YnabApi({ token: 'secret', fetch: async () => {
    calls++;
    if (calls === 1) return new Promise(resolve => { finishRead = () => resolve(ok({ value: 'old' })); });
    return ok({ value: 'new' });
  } });
  const oldRead = api.request('/plans');
  await api.request('/plans/a/categories/b', { method: 'PATCH', body: {} });
  finishRead();
  await oldRead;
  assert.equal((await api.request('/plans')).value, 'new');
  assert.equal(calls, 3);
});

test('default fetch retains its global receiver in runtimes that require it', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = function () {
      assert.equal(this, globalThis);
      return Promise.resolve(ok({ plans: [] }));
    };
    const api = new YnabApi({ token: 'fake-test-only' });
    assert.deepEqual(await api.request('/plans'), { plans: [] });
  } finally { globalThis.fetch = original; }
});

test('redirects are rejected without forwarding credentials to another origin', async () => {
  let requests = 0;
  const api = new YnabApi({ token: 'secret', fetch: async (_url, options) => {
    requests++;
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://untrusted.example' } });
  } });
  await assert.rejects(api.request('/plans'), error => error.status === 302);
  assert.equal(requests, 1);
});
