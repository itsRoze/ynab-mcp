import { access, mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';

export const labels = { codex: 'Codex', claude: 'Claude Code', desktop: 'Claude Desktop' };
export function expandClients(value) {
  if (value === 'both') return ['codex', 'claude'];
  if (value in labels) return [value];
  throw new Error('Choose codex, claude, desktop, or both.');
}
export function registration(root, node = process.execPath) {
  return { command: node, args: [`--env-file=${join(root, '.env')}`, join(root, 'dist/index.js')] };
}
export function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true });
}
export function checkCli(client, execute = run) {
  const command = client === 'claude' ? 'claude' : 'codex';
  const result = execute(command, ['--version']);
  if (result.error || result.status !== 0) throw new Error(`${labels[client]} CLI was not found or could not start. Install it and retry.`);
}
export async function checkProject(root) {
  try { await access(join(root, 'dist/index.js')); }
  catch { throw new Error('Build the server first: pnpm run build'); }
  let env;
  try { env = await readFile(join(root, '.env'), 'utf8'); }
  catch { throw new Error('Save your YNAB token first: pnpm run setup'); }
  if (!parseEnv(env).YNAB_ACCESS_TOKEN?.trim()) throw new Error('Your .env file needs a YNAB_ACCESS_TOKEN. Add the token locally, then retry.');
}
function sameRegistration(a, b) {
  return a?.command === b.command && JSON.stringify(a.args ?? []) === JSON.stringify(b.args) &&
    !Object.keys(a.env ?? {}).length && (!a.type || a.type === 'stdio');
}
async function readOptional(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error(`Could not read configuration at ${path}.`); }
}
export function desktopPath(home, platform = process.platform, appdata = process.env.APPDATA) {
  if (platform === 'darwin') return join(home, 'Library/Application Support/Claude/claude_desktop_config.json');
  if (platform === 'win32' && appdata) return join(appdata, 'Claude/claude_desktop_config.json');
  throw new Error('Automatic Claude Desktop setup is supported on macOS and Windows. Use --print desktop for manual configuration.');
}
export async function installDesktop(path, spec) {
  const raw = await readOptional(path);
  let config;
  try { config = raw === null ? {} : JSON.parse(raw); }
  catch { throw new Error('Claude Desktop configuration is invalid JSON. Fix it before retrying; no changes were made.'); }
  if (!config || Array.isArray(config) || typeof config !== 'object' ||
      (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)))) {
    throw new Error('Claude Desktop configuration has an unexpected structure. No changes were made.');
  }
  if (sameRegistration(config.mcpServers?.ynab, spec)) return { status: 'unchanged' };
  const updated = { ...config, mcpServers: { ...config.mcpServers, ynab: spec } };
  await mkdir(dirname(path), { recursive: true });
  const backup = raw === null ? undefined : `${path}.ynab-backup-${randomUUID()}`;
  if (backup) await writeFile(backup, raw, { mode: 0o600, flag: 'wx' });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    if (await readOptional(path) !== raw) throw new Error('Claude Desktop settings changed during setup. Retry; the newer settings were left intact.');
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
  return { status: 'installed', backup };
}
export function installCli(client, spec, execute = run) {
  const command = client === 'claude' ? 'claude' : 'codex';
  // Codex exposes JSON retrieval. Claude's add command handles user-scope registration.
  if (client === 'codex') {
    const current = execute(command, ['mcp', 'get', 'ynab', '--json']);
    if (current.status === 0) {
      try {
        const value = JSON.parse(current.stdout);
        if (sameRegistration(value.transport ?? value, spec) && value.enabled !== false) return { status: 'unchanged' };
      } catch { /* Let the native add command validate/update configuration. */ }
    }
  }
  const args = client === 'claude'
    ? ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'ynab', '--', spec.command, ...spec.args]
    : ['mcp', 'add', 'ynab', '--', spec.command, ...spec.args];
  const result = execute(command, args);
  if (result.error || result.status !== 0) {
    // Client output can contain secrets from unrelated configuration. Never echo it.
    if (client === 'claude' && /already exists/i.test(`${result.stderr ?? ''} ${result.stdout ?? ''}`)) {
      throw new Error('Claude Code already has a user-scope ynab entry. To replace it, run: claude mcp remove --scope user ynab; then rerun config.');
    }
    throw new Error(`${labels[client]} could not register YNAB. Check that its CLI starts and its configuration is writable, then retry.`);
  }
  return { status: 'installed' };
}
export async function claudeAlreadyConfigured(home, spec) {
  // Only optimize the documented default path; alternate config locations stay CLI-owned.
  if (process.env.CLAUDE_CONFIG_DIR) return false;
  const raw = await readOptional(join(home, '.claude.json'));
  if (!raw) return false;
  try { return sameRegistration(JSON.parse(raw).mcpServers?.ynab, spec); }
  catch { return false; }
}
