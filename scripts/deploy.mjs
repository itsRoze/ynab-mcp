import { readFile, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
function wrangler(args, input) {
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...args, '--config', 'wrangler.private.json'], {
    encoding: 'utf8', timeout: 180_000, input, maxBuffer: 2_000_000,
  });
  // Wrangler receives secret values only through stdin; never echo that input.
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) throw new Error('Cloudflare command failed. Resolve the reported issue and rerun pnpm run deploy.');
  return result.stdout;
}
try {
  let config;
  try { config = JSON.parse(await readFile('wrangler.private.json', 'utf8')); }
  catch { throw new Error('Create wrangler.private.json from wrangler.jsonc with your account ID and OAuth KV namespace ID. See README.'); }
  const local = parseEnv(await readFile('.env', 'utf8'));
  if (!local.YNAB_ACCESS_TOKEN?.trim()) throw new Error('Run pnpm run setup to save your YNAB token first.');
  let privateEnv;
  try { privateEnv = parseEnv(await readFile('.env.remote', 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    privateEnv = { CONNECTOR_PASSWORD: randomBytes(32).toString('base64url') };
    await writeFile('.env.remote', `CONNECTOR_PASSWORD=${privateEnv.CONNECTOR_PASSWORD}\n`, { mode: 0o600, flag: 'wx' });
  }
  if (!privateEnv.CONNECTOR_PASSWORD || privateEnv.CONNECTOR_PASSWORD.length < 32) throw new Error('CONNECTOR_PASSWORD in .env.remote must have at least 32 characters.');
  await chmod('.env.remote', 0o600);
  if (!config.vars?.PUBLIC_ORIGIN) {
    console.log('Creating the Worker with all access disabled until secrets are configured.');
    const output = wrangler(['deploy']);
    const endpoint = output.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\b/i)?.[0];
    if (!endpoint) throw new Error('Could not determine the workers.dev URL. Set PUBLIC_ORIGIN in wrangler.private.json and rerun.');
    config.vars = { ...config.vars, PUBLIC_ORIGIN: endpoint };
    await writeFile('wrangler.private.json', JSON.stringify(config, null, 2) + '\n');
  }
  console.log('Saving the YNAB token and connector password as Cloudflare secrets.');
  wrangler(['secret', 'bulk'], JSON.stringify({ YNAB_ACCESS_TOKEN: local.YNAB_ACCESS_TOKEN, CONNECTOR_PASSWORD: privateEnv.CONNECTOR_PASSWORD }));
  wrangler(['deploy']);
  console.log(`\nConnector: ${config.vars.PUBLIC_ORIGIN}/mcp\nRun pnpm run remote:password to retrieve the login password locally.`);
} catch (error) {
  console.error(error.code === 'ENOENT' ? 'Required local setup file is missing. See README.' : error.message);
  process.exitCode = 1;
}
