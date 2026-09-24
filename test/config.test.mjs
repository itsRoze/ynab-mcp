import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkProject, expandClients, installCli, installDesktop, registration } from '../scripts/config-lib.mjs';

async function sandbox(t) {
  const base = resolve('work');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'config-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('desktop installer preserves other servers/settings, backs up and is repeatable', async t => {
  const root = await sandbox(t);
  const path = join(root, 'settings.json');
  const original = JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'existing' }, ynab: { command: 'old' } } });
  await writeFile(path, original);
  const spec = registration('/some checkout with spaces', '/node with spaces');
  const result = await installDesktop(path, spec);
  const config = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(config.theme, 'dark');
  assert.equal(config.mcpServers.other.command, 'existing');
  assert.deepEqual(config.mcpServers.ynab, spec);
  assert.equal(await readFile(result.backup, 'utf8'), original);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(result.backup)).mode & 0o777, 0o600);
  }
  assert.equal((await installDesktop(path, spec)).status, 'unchanged');
});

test('desktop installer rejects invalid JSON without touching it', async t => {
  const root = await sandbox(t);
  const path = join(root, 'settings.json');
  await writeFile(path, '{broken');
  await assert.rejects(installDesktop(path, registration(root)), /invalid JSON/);
  assert.equal(await readFile(path, 'utf8'), '{broken');
});

test('desktop installer creates a new config and parent directory', async t => {
  const root = await sandbox(t);
  const path = join(root, 'new', 'settings.json');
  const result = await installDesktop(path, registration(root));
  assert.equal(result.backup, undefined);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).mcpServers.ynab.command, process.execPath);
});

test('CLI installers pass paths as separate arguments without shell interpretation', () => {
  const spec = registration('/path with spaces/$(no)', '/node path');
  for (const client of ['codex', 'claude']) {
    const calls = [];
    const result = installCli(client, spec, (command, args) => {
      calls.push({ command, args });
      return { status: args.includes('get') ? 1 : 0 };
    });
    assert.equal(result.status, 'installed');
    assert.deepEqual(calls.at(-1).args.slice(-4), ['--', spec.command, ...spec.args]);
    assert.equal(calls.at(-1).command, client === 'claude' ? 'claude' : 'codex');
  }
});

test('matching Codex registration does not get rewritten', () => {
  const spec = registration('/path');
  let calls = 0;
  const result = installCli('codex', spec, () => {
    calls++;
    return { status: 0, stdout: JSON.stringify({ enabled: true, transport: { type: 'stdio', ...spec } }) };
  });
  assert.equal(result.status, 'unchanged');
  assert.equal(calls, 1);
});

test('CLI errors are actionable and do not expose captured config/secrets', () => {
  const spec = registration('/path');
  assert.throws(() => installCli('claude', spec, () => ({ status: 1, stderr: 'already exists secret-value' })), error =>
    error.message.includes('claude mcp remove') && !error.message.includes('secret-value'));
  assert.throws(() => installCli('codex', spec, () => ({ status: 1, stderr: 'secret-value' })), error =>
    error.message.includes('could not register') && !error.message.includes('secret-value'));
});

test('preflight requires a built server and a nonempty token without exposing it', async t => {
  const root = await sandbox(t);
  await assert.rejects(checkProject(root), /build/);
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist/index.js'), '');
  await assert.rejects(checkProject(root), /setup/);
  await writeFile(join(root, '.env'), 'YNAB_ACCESS_TOKEN=""\n');
  await assert.rejects(checkProject(root), /needs a YNAB_ACCESS_TOKEN/);
  await writeFile(join(root, '.env'), 'YNAB_ACCESS_TOKEN=test-only\n');
  await checkProject(root);
});

test('config help and manual mode work without changing client settings', () => {
  const help = spawnSync(process.execPath, ['scripts/config.mjs', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--client both/);
  const manual = spawnSync(process.execPath, ['scripts/config.mjs', '--print', 'codex'], { encoding: 'utf8' });
  assert.equal(manual.status, 0);
  assert.match(manual.stdout, /\[mcp_servers.ynab\]/);
  const noSelection = spawnSync(process.execPath, ['scripts/config.mjs'], { encoding: 'utf8' });
  assert.equal(noSelection.status, 1);
  assert.match(noSelection.stderr, /Choose a client/);
  assert.deepEqual(expandClients('both'), ['codex', 'claude']);
  assert.throws(() => expandClients('nope'), /Choose/);
});
