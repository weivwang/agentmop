#!/usr/bin/env node

import { main } from '../src/cli.js';
import { sanitizeTerminalText } from '../src/format.js';

main(process.argv.slice(2)).catch((error) => {
  const message = sanitizeTerminalText(error instanceof Error ? error.message : String(error));
  process.stderr.write(`\nAgentMop failed: ${message}\n`);
  if (process.env.AGENTMOP_DEBUG && error instanceof Error && error.stack) {
    process.stderr.write(`${sanitizeTerminalText(error.stack)}\n`);
  }
  process.exitCode = 1;
});
