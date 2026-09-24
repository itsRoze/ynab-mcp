import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
try {
  if (!process.stdout.isTTY) throw new Error('Run this command in your own interactive terminal; the password should not be captured in agent output.');
  const env = parseEnv(await readFile(fileURLToPath(new URL('../.env.remote', import.meta.url)), 'utf8'));
  if (!env.CONNECTOR_PASSWORD) throw new Error('Deploy first to create a connector password.');
  console.log('Your connector login password (save it in your password manager):\n');
  console.log(env.CONNECTOR_PASSWORD);
} catch (error) {
  console.error(error.code === 'ENOENT' ? 'Deploy first to create a connector password.' : error.message);
  process.exitCode = 1;
}
