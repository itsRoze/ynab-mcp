// Register this owner's private deployment and complete its OAuth flow locally.
// Credentials stay in memory; neither the password nor OAuth tokens are logged.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const config = JSON.parse(await readFile('wrangler.private.json', 'utf8'));
const origin = config.vars.PUBLIC_ORIGIN;
const { CONNECTOR_PASSWORD: password } = parseEnv(await readFile('.env.remote', 'utf8'));
if (!origin?.startsWith('https://') || !password) throw new Error('Deploy the private connector first.');
await mkdir('work', { recursive: true });
try {
  const old = await readFile(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml'));
  await writeFile(`work/codex-config-before-remote-${Date.now()}.toml`, old, { mode: 0o600, flag: 'wx' });
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const current = spawnSync('codex', ['mcp', 'get', 'ynab', '--json'], { encoding: 'utf8' });
const existingRemote = current.status === 0 && JSON.parse(current.stdout).transport?.url === `${origin}/mcp`;
if (!existingRemote) {
  // Native browser login owns the callback. Never race it with an automated submission.
  console.log('Follow the Codex browser login to connect YNAB.');
  const initial = spawnSync('codex', ['mcp', 'add', 'ynab', '--url', `${origin}/mcp`], { stdio: 'inherit' });
  process.exit(initial.status ?? 1);
}
const child = spawn('codex', ['mcp', 'login', 'ynab', '--no-browser'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
let output = '', authenticating = false;
let approval;
async function approve(value) {
  const url = new URL(value);
  if (url.origin !== origin || url.pathname !== '/authorize') throw new Error('Unexpected OAuth authorization URL.');
  const expectedCallback = new URL(url.searchParams.get('redirect_uri'));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(expectedCallback.hostname)) throw new Error('Expected a local Codex callback.');
  const options = { redirect: 'manual', signal: AbortSignal.timeout(30_000) };
  const page = await fetch(url, options);
  if (page.status !== 200) throw new Error('Could not open connector consent page.');
  const body = await page.text();
  const consent = body.match(/name="consent" value="([^"]+)"/)?.[1];
  const cookie = page.headers.get('set-cookie')?.split(';')[0];
  if (!consent || !cookie) throw new Error('Connector did not issue a consent challenge.');
  const authorized = await fetch(url, { ...options, method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, Cookie: cookie },
    body: new URLSearchParams({ consent, password }),
  });
  if (authorized.status !== 302) throw new Error('Connector authorization failed.');
  const callback = new URL(authorized.headers.get('location'));
  if (callback.origin !== expectedCallback.origin || callback.pathname !== expectedCallback.pathname || callback.searchParams.get('state') !== url.searchParams.get('state')) throw new Error('Unexpected OAuth callback.');
  // --no-browser consumes the callback URL on stdin; no local browser listener is opened.
  child.stdin.write(callback.href + '\n');
}
function consume(chunk) {
  output += chunk.toString();
  const url = output.match(/https:\/\/[^\s]+\/authorize\?[^\s]+/)?.[0];
  if (!authenticating && url) {
    authenticating = true;
    approval = approve(url).catch(error => { console.error(error.message); child.kill('SIGTERM'); throw error; });
    // Attach immediately to avoid unhandled rejection before the process exits.
    approval.catch(() => {});
  }
}
child.stdout.on('data', consume);
child.stderr.on('data', consume);
const timeout = setTimeout(() => child.kill('SIGTERM'), 90_000);
try {
  const [code] = await once(child, 'exit');
  if (approval) await approval;
  if (code !== 0) throw new Error('Codex registration did not finish. Try pnpm run connect:codex again.');
  const verified = spawnSync('codex', ['mcp', 'get', 'ynab', '--json'], { encoding: 'utf8' });
  if (verified.status !== 0 || JSON.parse(verified.stdout).transport?.url !== `${origin}/mcp`) throw new Error('Could not verify the remote Codex entry.');
  console.log('Codex is connected to your private hosted YNAB server. Restart Codex or open a new session to load it.');
} finally { clearTimeout(timeout); }
