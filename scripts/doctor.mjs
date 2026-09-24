import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { YnabApi } from '../dist/api.js';
try {
  if (!process.env.YNAB_ACCESS_TOKEN) loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
  const api = new YnabApi({ token: process.env.YNAB_ACCESS_TOKEN ?? '' });
  const { plans } = await api.request('/plans', { fresh: true });
  console.log(`YNAB connection OK. ${plans.length} plan(s) accessible. No changes made.`);
} catch (error) {
  console.error(error.code === 'ENOENT' ? 'No .env file found. Run pnpm run setup first.' : error.message);
  process.exitCode = 1;
}
