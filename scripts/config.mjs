import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { checkCli, checkProject, claudeAlreadyConfigured, desktopPath, expandClients, installCli, installDesktop, labels, registration } from './config-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const spec = registration(root);
const args = process.argv.slice(2).filter(arg => arg !== '--');
const help = `Connect YNAB to your agent\n\n  pnpm run config                  Pick clients and install\n  pnpm run config --client both    Install for Codex + Claude Code\n  pnpm run config --client codex   Install for Codex\n  pnpm run config --client claude  Install for Claude Code\n  pnpm run config --client desktop Install for Claude Desktop\n  pnpm run config --print codex    Print settings without changing anything\n`;
try {
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(help);
  } else if (args[0] === '--print' && args.length === 2) {
    for (const client of expandClients(args[1])) {
      if (client === 'codex') console.log(`[mcp_servers.ynab]\ncommand = ${JSON.stringify(spec.command)}\nargs = ${JSON.stringify(spec.args)}`);
      else console.log(JSON.stringify({ mcpServers: { ynab: spec } }, null, 2));
    }
  } else {
    let selected;
    if (args.length) {
      if (args.length !== 2 || args[0] !== '--client') throw new Error('Unknown option. Run pnpm run config --help for usage.');
      selected = expandClients(args[1]);
    } else {
      if (!process.stdin.isTTY) throw new Error('Choose a client: pnpm run config --client codex (or claude, desktop, both).');
      console.log('\nConnect YNAB\n\n  1  Codex\n  2  Claude Code\n  3  Both\n  4  Claude Desktop\n');
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        while (!selected) {
          const answer = (await prompt.question('Connect to [3]: ')).trim();
          const choice = { '': 'both', '1': 'codex', '2': 'claude', '3': 'both', '4': 'desktop' }[answer];
          if (choice) selected = expandClients(choice);
          else console.log('Enter 1, 2, 3, or 4.');
        }
      } finally { prompt.close(); }
    }
    await checkProject(root);
    // Check availability for every selected client before changing any settings.
    for (const client of selected) {
      if (client !== 'desktop') checkCli(client);
      else desktopPath(homedir());
    }
    console.log('');
    let failures = 0;
    for (const client of selected) {
      try {
        const result = client === 'desktop'
          ? await installDesktop(desktopPath(homedir()), spec)
          : client === 'claude' && await claudeAlreadyConfigured(homedir(), spec)
            ? { status: 'unchanged' }
            : installCli(client, spec);
        console.log(`✓ ${labels[client]} — ${result.status === 'unchanged' ? 'already configured' : 'configured'}`);
        if (result.backup) console.log(`  Previous settings backed up to ${result.backup}`);
      } catch (error) {
        failures++;
        console.error(`✗ ${labels[client]} — ${error.message}`);
      }
    }
    if (failures) process.exitCode = 1;
    else console.log('\nRestart your client or open a new session to load YNAB.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
