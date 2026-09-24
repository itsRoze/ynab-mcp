import { writeFile, chmod, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { emitKeypressEvents } from 'node:readline';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
try {
  await access(envPath, constants.F_OK);
  console.error('A .env file already exists. Edit it locally to change your token; setup will not overwrite it.');
  process.exit(1);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (!process.stdin.isTTY) {
  console.error('Run pnpm run setup in an interactive terminal. Do not pass your token as a command argument.');
  process.exit(1);
}
console.log('Create a personal access token in YNAB → Account Settings → Developer Settings.');
process.stdout.write('Paste your YNAB token (input is hidden), then press Enter: ');
emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.resume();
const token = await new Promise(resolve => {
  let value = '';
  const finish = result => {
    process.stdin.off('keypress', keypress);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\n');
    resolve(result);
  };
  const keypress = (text, key) => {
    if (key?.ctrl && key.name === 'c') return finish('');
    if (key?.name === 'return') return finish(value);
    if (key?.name === 'backspace') { value = value.slice(0, -1); return; }
    if (text && !key?.ctrl && !key?.meta) value += text.replace(/[^\x21-\x7e]/g, '');
  };
  process.stdin.on('keypress', keypress);
});
if (!token || !/^[A-Za-z0-9._~-]+$/.test(token)) {
  console.error('No valid token entered. Nothing was saved.');
  process.exitCode = 1;
} else {
  await writeFile(envPath, `YNAB_ACCESS_TOKEN=${token}\nYNAB_READ_ONLY=false\n`, { mode: 0o600, flag: 'wx' });
  await chmod(envPath, 0o600);
  console.log('Saved .env with owner-only permissions. It is ignored by Git.');
  console.log('Run pnpm run doctor to check the connection, then pnpm run config to connect Claude or Codex.');
}
