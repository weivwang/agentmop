import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  parseLsofCwd,
  parseProcessTable,
  pathsOverlap,
  processCwd,
  processReferencesPath,
  scanProcesses,
} from '../src/processes.js';

test('process parser recognizes agents while hiding command arguments', async () => {
  const output = [
    '  101     1 01:02:03  2048 /usr/local/bin/codex exec --prompt TOP-SECRET --cwd=/tmp/codex-task',
    '  102     1 2-03:04:05  1024 node /opt/@anthropic-ai/claude-code/cli.js -p PRIVATE',
    '  103     1 00:00:03    64 rg codex',
    '  104     1 00:04:00   512 /usr/local/bin/opencode run hidden prompt',
  ].join('\n');

  const parsed = parseProcessTable(output);
  assert.equal(parsed[1].elapsedSeconds, 2 * 86_400 + 3 * 3600 + 4 * 60 + 5);
  const processes = await scanProcesses({ psOutput: output });
  assert.deepEqual(processes.map((process) => process.agent), ['codex', 'claude', 'opencode']);
  assert.equal(processes.every((process) => process.observedOnly), true);
  assert.equal(processes[0].rssBytes, 2048 * 1024);
  assert.equal(processes[0].status, 'live');
  assert.equal(processes[0].detachedCandidate, true);
  assert.match(processes[0].reasons.join(' '), /PPID 1; verify before stopping/);
  assert.equal(processes[2].detachedCandidate, false);
  assert.doesNotMatch(JSON.stringify(processes), /TOP-SECRET|PRIVATE|hidden prompt/);
  assert.ok(processes[0].references.includes(resolve('/tmp/codex-task')));
});

test('Darwin lsof cwd parser reads only the n-record', async () => {
  const output = 'p48217\nfcwd\nn/private/tmp/codex-task\n';
  assert.equal(parseLsofCwd(output), resolve('/private/tmp/codex-task'));
  assert.equal(
    await processCwd(48217, { platform: 'darwin', lsofOutput: output }),
    resolve('/private/tmp/codex-task'),
  );
  assert.equal(parseLsofCwd('p42\nfcwd\n'), null);
});

test('path reference checks work in either containment direction', () => {
  const process = { references: ['/tmp/codex-task/repo'] };
  assert.equal(processReferencesPath(process, '/tmp/codex-task'), true);
  assert.equal(processReferencesPath(process, '/tmp/other'), false);
  assert.equal(pathsOverlap('/a/b', '/a/b/c'), true);
  assert.equal(pathsOverlap('/a/b', '/a/bc'), false);
});

test('Windows path reference checks recognize native and 8.3 aliases', {
  skip: process.platform !== 'win32',
}, () => {
  assert.equal(pathsOverlap(tmpdir(), realpathSync.native(tmpdir())), true);
});

test('an unresolved matching cwd marks that agent process evidence incomplete', async () => {
  const output = '  201     1 00:10:00  1024 /usr/local/bin/codex exec';
  const processes = await scanProcesses({ psOutput: output, cwdResolver: async () => null });
  assert.equal(processes.length, 1);
  assert.equal(processes.incompleteAgents.has('codex'), true);
  assert.match(processes.warnings.join('\n'), /SAFE is disabled for Codex/);
});
