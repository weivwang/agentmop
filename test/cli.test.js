import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { cliInternals } from '../src/cli.js';
import { executeCleanup } from '../src/cleanup.js';

const execFile = promisify(execFileCallback);

test('CLI defaults to a read-only scan', () => {
  const parsed = cliInternals.parseArgs([]);
  assert.equal(parsed.command, 'scan');
  assert.equal(parsed.includeProcesses, true);
  assert.equal(parsed.staleMs, 30 * 86_400_000);
});

test('CLI accepts repeatable exact ids and tmp roots', () => {
  const parsed = cliInternals.parseArgs([
    'clean', '--safe', '--dry-run', '--id', 'one', '--id', 'two', '--tmp-root', '/tmp/demo',
  ]);
  assert.equal(parsed.command, 'clean');
  assert.equal(parsed.safe, true);
  assert.deepEqual(parsed.ids, ['one', 'two']);
  assert.deepEqual(parsed.tmpRoots, [resolve('/tmp/demo')]);
});

test('CLI help explains destructive boundary', () => {
  const text = cliInternals.help();
  assert.match(text, /LIVE and DIRTY are never cleanup candidates/);
  assert.match(text, /Permanently delete/);
});

test('HTML reports are written with private permissions', { skip: process.platform === 'win32' }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentmop-html-mode-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const output = join(directory, 'report.html');
  const bin = fileURLToPath(new URL('../bin/agentmop.js', import.meta.url));
  await execFile(process.execPath, [bin, 'demo', '--html', output, '--no-open', '--no-color']);
  const info = await stat(output);
  assert.equal(info.mode & 0o777, 0o600);
});

test('HTML report output refuses a symbolic-link destination', { skip: process.platform === 'win32' }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentmop-html-symlink-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const target = join(directory, 'target.txt');
  const output = join(directory, 'report.html');
  await writeFile(target, 'do not overwrite');
  await symlink(target, output);
  const bin = fileURLToPath(new URL('../bin/agentmop.js', import.meta.url));
  await assert.rejects(
    execFile(process.execPath, [bin, 'demo', '--html', output, '--no-open']),
    /HTML report symlink/,
  );
  assert.equal(await readFile(target, 'utf8'), 'do not overwrite');
});

test('partial restore and purge outcomes return a non-zero CLI exit code', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'agentmop-cli-partial-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(home, { recursive: true, force: true })));
  const bin = fileURLToPath(new URL('../bin/agentmop.js', import.meta.url));
  const makeReport = (path, id) => ({
    generatedAt: new Date().toISOString(),
    home,
    processes: [],
    artifacts: [{
      id,
      agent: 'fixture',
      type: 'cache',
      label: 'Fixture cache',
      path,
      displayPath: path,
      sizeBytes: 1,
      status: 'safe',
      cleanup: { eligible: true, strategy: 'move' },
      metadata: { scanRoot: home },
    }],
  });

  const restorePath = join(home, 'restore-cache');
  await mkdir(restorePath);
  await executeCleanup(makeReport(restorePath, 'restore-artifact'), {
    home,
    batchId: 'restore-partial-cli',
    processScanner: async () => [],
  });
  await mkdir(restorePath);
  await assert.rejects(
    execFile(process.execPath, [bin, 'restore', 'restore-partial-cli', '--home', home]),
    (error) => error.code === 1 && /restore-partial/.test(error.stdout),
  );

  const purgePath = join(home, 'purge-cache');
  await mkdir(purgePath);
  const cleaned = await executeCleanup(makeReport(purgePath, 'purge-artifact'), {
    home,
    batchId: 'purge-partial-cli',
    processScanner: async () => [],
  });
  await rename(cleaned.batch.items[0].quarantinedPath, join(home, 'parked-purge-payload'));
  await assert.rejects(
    execFile(process.execPath, [bin, 'purge', 'purge-partial-cli', '--yes', '--home', home]),
    (error) => error.code === 1 && /purge-partial/.test(error.stdout),
  );
});
