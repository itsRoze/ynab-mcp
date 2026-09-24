import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const live = process.argv.includes('--live');
const privateConfig = live ? JSON.parse(await readFile('wrangler.private.json', 'utf8')) : null;
const origin = live ? privateConfig.vars.PUBLIC_ORIGIN : process.env.TEST_ORIGIN ?? 'http://localhost:8789';
const password = live ? parseEnv(await readFile('.env.remote', 'utf8')).CONNECTOR_PASSWORD : 'test-only-connector-password-at-least-32-chars';
const request = (path, options = {}) => fetch(new URL(path, origin), { redirect: 'manual', signal: AbortSignal.timeout(25_000), ...options });
const post = (path, body, headers = {}) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body) });
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };

const anonymous = await request('/mcp');
check(anonymous.status === 401, 'Anonymous MCP access must be denied');
check(anonymous.headers.get('www-authenticate')?.includes('resource_metadata'), 'OAuth discovery challenge is required');
check((await request('/mcp', { headers: { Authorization: 'Bearer invalid-test-token' } })).status === 401, 'Invalid tokens must be denied');
check((await request('/internal/consent')).status === 404, 'Internal coordinator is not a public endpoint');
check((await request('/authorize?client_id=unregistered&redirect_uri=https://evil.example')).status === 400, 'Unregistered clients must not redirect');
const metadata = await (await request('/.well-known/oauth-authorization-server')).json();
check(metadata.issuer === origin, 'Issuer must match canonical origin');
const registration = await request('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  client_name: '<script>bad()</script> integration check', redirect_uris: ['http://127.0.0.1:8979/callback'],
  grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
}) });
check(registration.status === 201, 'Test client registration must succeed');
const client = await registration.json();
const verifier = randomBytes(32).toString('base64url');
const authUrl = '/authorize?' + new URLSearchParams({ client_id: client.client_id, redirect_uri: 'http://127.0.0.1:8979/callback',
  response_type: 'code', scope: 'ynab:manage', state: 'integration-test-state', code_challenge_method: 'S256',
  code_challenge: createHash('sha256').update(verifier).digest('base64url'), resource: origin + '/mcp' });
async function consent() {
  const page = await request(authUrl);
  check(page.status === 200, 'Consent form must load');
  check(page.headers.get('referrer-policy') === 'same-origin', 'Browser form submissions must retain their same-origin Origin header');
  const html = await page.text();
  check(!html.includes('<script>bad()'), 'Client metadata must be HTML escaped');
  check(!html.includes(password), 'Consent page must not disclose connector password');
  return { id: html.match(/name="consent" value="([^"]+)"/)?.[1], cookie: page.headers.get('set-cookie')?.split(';')[0] };
}
const wrong = await consent();
check((await post(authUrl, { consent: wrong.id, password: 'incorrect-test-value' }, { Origin: origin, Cookie: wrong.cookie })).status === 403, 'Wrong password must be denied');
const form = await consent();
check((await post(authUrl, { consent: form.id, password }, { Origin: 'https://evil.example', Cookie: form.cookie })).status === 403, 'Cross-origin form submission must be rejected');
check((await post(authUrl, { consent: form.id, password }, { Origin: origin })).status === 403, 'Missing CSRF cookie must be rejected');
check((await post(authUrl, { consent: form.id, password }, { Origin: 'null', Cookie: form.cookie })).status === 403, 'Opaque origins must remain rejected');
const approved = await post(authUrl, { consent: form.id, password }, { Origin: origin, Cookie: form.cookie });
check(approved.status === 302, 'Owner login must complete OAuth authorization');
const callback = new URL(approved.headers.get('location'));
check(callback.searchParams.get('state') === 'integration-test-state', 'OAuth state must round-trip');
check((await post(authUrl, { consent: form.id, password }, { Origin: origin, Cookie: form.cookie })).status === 403, 'Consent challenge must be single-use');
const tokenResponse = await post('/oauth/token', { grant_type: 'authorization_code', client_id: client.client_id,
  code: callback.searchParams.get('code'), code_verifier: verifier, redirect_uri: 'http://127.0.0.1:8979/callback', resource: origin + '/mcp' });
check(tokenResponse.status === 200, 'PKCE token exchange must succeed');
const tokens = await tokenResponse.json();
check(Boolean(tokens.access_token && tokens.refresh_token), 'Access and refresh tokens must be returned');
let requestId = 0;
async function mcp(method, params) {
  const result = await request('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${tokens.access_token}`, 'MCP-Protocol-Version': '2025-03-26' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, ...(params ? { params } : {}) }) });
  check(result.status === 200, `Authenticated MCP ${method} must succeed`);
  return result.json();
}
const init = await mcp('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'private-deployment-verification', version: '1' } });
check(Boolean(init.result?.serverInfo), 'MCP initialization must return server info');
const listed = await mcp('tools/list');
check(listed.result?.tools?.length === 14, 'All 14 tools must be available after login');
if (live) {
  const plans = await mcp('tools/call', { name: 'list_plans', arguments: { fresh: true } });
  if (plans.result?.isError) console.error('YNAB tool error:', plans.result.content?.[0]?.text);
  check(!plans.result?.isError, 'Live read-only YNAB request must succeed');
  const payload = JSON.parse(plans.result.content[0].text);
  check(Array.isArray(payload.plans), 'YNAB must return accessible plans');
  console.log(`Live YNAB authentication verified (${payload.plans.length} plan(s)); no budget data printed or changed.`);
}
const refreshed = await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id, resource: origin + '/mcp' });
check(refreshed.status === 200, 'OAuth refresh must work');
const refreshData = await refreshed.json();
if (metadata.revocation_endpoint) {
  const revoked = await post(metadata.revocation_endpoint, { token: refreshData.refresh_token, token_type_hint: 'refresh_token', client_id: client.client_id });
  check(revoked.ok, 'Verification grant must be revoked after testing');
}
console.log(`${checks} remote checks passed: authentication, CSRF, consent, PKCE, token refresh, MCP tools${live ? ', and live YNAB read' : ''}.`);
