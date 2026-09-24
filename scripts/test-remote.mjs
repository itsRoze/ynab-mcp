import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { once } from 'node:events';
const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
await mkdir('work', { recursive: true });
const directory = await mkdtemp(join(root, 'work/remote-test-'));
const socket = createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
config.name = 'ynab-test';
config.main = join(root, 'worker/index.ts');
config.kv_namespaces = [{ binding: 'OAUTH_KV', id: 'test-only-namespace' }];
config.vars = { PUBLIC_ORIGIN: origin, YNAB_ACCESS_TOKEN: 'test-only-not-real', CONNECTOR_PASSWORD: 'test-only-connector-password-at-least-32-chars' };
await writeFile(join(directory, 'wrangler.json'), JSON.stringify(config));
const worker = spawn('pnpm', ['exec', 'wrangler', 'dev', '--local', '--config', join(directory, 'wrangler.json'), '--port', String(port), '--inspector-port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
worker.stdout.on('data', d => { logs = (logs + d).slice(-12000); });
worker.stderr.on('data', d => { logs = (logs + d).slice(-12000); });
let failure;
try {
  const deadline = Date.now() + 45_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) throw new Error('Local Worker exited before startup.');
    try { if ((await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('Local Worker did not start in time.');
  const child = spawn(process.execPath, ['test/remote-flow.mjs'], { stdio: 'inherit', env: { ...process.env, TEST_ORIGIN: origin } });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error('Remote integration checks failed.');
} catch (error) { failure = error; }
finally {
  worker.kill('SIGTERM');
  await Promise.race([once(worker, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
  if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
  await rm(directory, { recursive: true, force: true });
}
if (failure) { console.error(failure.message); console.error(logs); process.exitCode = 1; }
