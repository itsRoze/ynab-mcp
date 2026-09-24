#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { YnabApi } from './api.js';
import { createServer } from './server.js';

try {
  const readOnly = process.env.YNAB_READ_ONLY;
  if (readOnly !== undefined && !['true', 'false'].includes(readOnly)) {
    throw new Error('YNAB_READ_ONLY must be true or false.');
  }
  const api = new YnabApi({ token: process.env.YNAB_ACCESS_TOKEN ?? '' });
  const server = createServer(api, { readOnly: readOnly === 'true' });
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(error instanceof Error ? error.message : 'YNAB MCP startup failed.');
  process.exitCode = 1;
}
