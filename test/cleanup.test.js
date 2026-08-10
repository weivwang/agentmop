import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeCleanup,
  listBatches,
  planCleanup,
  purgeBatch,
  restoreBatch,
} from '../src/cleanup.js';
import { scanSystem } from '../src/scan.js';

const noProcesses = async () => [];

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

function report(home, artifacts) {
  return {
    generatedAt: new Date().toISOString(),
    home,
    artifacts: artifacts.map((item) => ({
      ...item,
      metadata: { scanRoot: home, ...(item.metadata ?? {}) },
    })),
    processes: [],
  };
}

function artifact(path, overrides = {}) {
  return {
    id: overrides.id ?? 'abc123',
    agent: 'fixture',
    type: 'cache',
    label: 'Fixture cache',
    path,
    displayPath: path,
    sizeBytes: 12,
    status: 'safe',
    cleanup: { eligible: true, strategy: 'move' },
    ...overrides,
  };
}

test('planCleanup only selects exact safe eligible artifacts', () => {
  const artifacts = [
    artifact('/tmp/a', { id: 'safe' }),
    artifact('/tmp/b', { id: 'dirty', status: 'dirty' }),
    artifact('/tmp/c', { id: 'review', status: 'review' }),
    artifact('/tmp/d', { id: 'locked', cleanup: { eligible: false } }),
  ];
  const plan = planCleanup(report('/tmp', artifacts));
  assert.deepEqual(plan.items.map((item) => item.artifact.id), ['safe']);
  assert.equal(plan.totalBytes, 12);
});

test('move cleanup is recoverable and purge is explicit', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agentmop-cleanup-'));
  const cache = join(home, '.fixture', 'cache');
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, 'entry.txt'), 'hello');
  const scan = report(home, [artifact(cache)]);

  const cleaned = await executeCleanup(scan, { home, batchId: 'test-batch', processScanner: noProcesses });
  await assert.rejects(stat(cache), { code: 'ENOENT' });
  assert.equal(cleaned.batch.state, 'quarantined');

  const batches = await listBatches({ home });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].id, 'test-batch');

  const restored = await restoreBatch('test-batch', { home });
  assert.equal(restored.state, 'restored');
  assert.equal(await readFile(join(cache, 'entry.txt'), 'utf8'), 'hello');

  const cacheTwo = join(home, '.fixture', 'cache-two');
  await mkdir(cacheTwo, { recursive: true });
  await writeFile(join(cacheTwo, 'entry.txt'), 'bye');
  const cleanedTwo = await executeCleanup(report(home, [artifact(cacheTwo, { id: 'def456' })]), {
    home,
    batchId: 'purge-batch',
    processScanner: noProcesses,
  });
  assert.equal(cleanedTwo.batch.state, 'quarantined');
  const purged = await purgeBatch('purge-batch', { home });
  assert.equal(purged.state, 'purged');
  await assert.rejects(restoreBatch('purge-batch', { home }), /permanently purged/);
});

test('cleanup refuses stale scans', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agentmop-stale-'));
  const cache = join(home, 'cache');
  await mkdir(cache);
  const scan = report(home, [artifact(cache)]);
  scan.generatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  await assert.rejects(executeCleanup(scan, { home }), /scan is stale/i);
});

test('cleanup independently refuses broad and non-cleanable targets', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agentmop-boundary-'));
  await assert.rejects(
    executeCleanup(report(home, [artifact(home)]), { home }),
    /broad cleanup target/i,
  );

  const history = join(home, 'history');
  await mkdir(history);
  await assert.rejects(
    executeCleanup(report(home, [artifact(history, { type: 'history' })]), { home }),
    /not implemented for history/i,
  );
});

test('cleanup refuses symbolic-link targets even when a report says safe', { skip: process.platform === 'win32' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'agentmop-symlink-'));
  const real = join(home, 'real-cache');
  const link = join(home, 'linked-cache');
  await mkdir(real);
  await symlink(real, link, 'dir');
  await assert.rejects(
    executeCleanup(report(home, [artifact(link)]), { home }),
    /symbolic link/i,
  );
  await stat(real);
});

test('cleanup refuses a target below a symbolic-link ancestor', { skip: process.platform === 'win32' }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'agentmop-ancestor-symlink-'));
  const external = await mkdtemp(join(tmpdir(), 'agentmop-external-cache-'));
  t.after(() => import('node:fs/promises').then(async ({ rm }) => {
    await rm(home, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }));
  const cache = join(external, 'cache');
  await mkdir(cache);
  await writeFile(join(cache, 'valuable.txt'), 'keep me');
  await symlink(external, join(home, '.codex'), 'dir');
  const apparent = join(home, '.codex', 'cache');
  await assert.rejects(
    executeCleanup(report(home, [artifact(apparent)]), { home }),
    /symbolic link/i,
  );
  assert.equal(await readFile(join(cache, 'valuable.txt'), 'utf8'), 'keep me');
});

test('restore refuses to overwrite a recreated target', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agentmop-restore-'));
  const cache = join(home, 'cache');
  await mkdir(cache);
  const cleaned = await executeCleanup(report(home, [artifact(cache)]), {
    home,
    batchId: 'collision',
    processScanner: noProcesses,
  });
  assert.equal(cleaned.batch.state, 'quarantined');
  await mkdir(cache);
  const restored = await restoreBatch('collision', { home });
  assert.equal(restored.state, 'restore-partial');
  assert.match(restored.restoreFailures[0].message, /already exists/);
});

test('restore never mistakes a replacement at the original path for recovered data', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'agentmop-restore-identity-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(home, { recursive: true, force: true })));
  const cache = join(home, 'cache');
  await mkdir(cache);
  await writeFile(join(cache, 'valuable.txt'), 'quarantined original');
  const cleaned = await executeCleanup(report(home, [artifact(cache)]), {
    home,
    batchId: 'identity-collision',
    processScanner: noProcesses,
  });
  const quarantined = cleaned.batch.items[0].quarantinedPath;
  await rename(quarantined, join(home, 'parked-original'));
  await mkdir(cache);
  await writeFile(join(cache, 'different.txt'), 'replacement');

  const restored = await restoreBatch('identity-collision', { home });
  assert.equal(restored.state, 'restore-partial');
  assert.match(restored.restoreFailures[0].message, /different object/i);
  assert.equal(await readFile(join(cache, 'different.txt'), 'utf8'), 'replacement');
});

test('cleanup stops when content changes after the safety scan', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentmop-content-race-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const home = join(root, 'home');
  const temp = join(root, 'tmp');
  const cache = join(home, '.codex', 'cache');
  await mkdir(cache, { recursive: true });
  await mkdir(temp);
  await writeFile(join(cache, 'entry.bin'), 'before');
  const scan = await scanSystem({
    home,
    staleMs: 0,
    tmpRoots: [temp],
    includeSystemTmp: false,
    processScanner: noProcesses,
  });
  await writeFile(join(cache, 'entry.bin'), 'after safety scan');
  const result = await executeCleanup(scan, {
    home,
    batchId: 'content-race',
    processScanner: noProcesses,
  });
  assert.equal(result.batch.state, 'partial');
  assert.match(result.batch.failures[0].message, /changed after scan/i);
  assert.equal(await readFile(join(cache, 'entry.bin'), 'utf8'), 'after safety scan');
});

test('cleanup stops when a new live process references an artifact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentmop-process-race-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const home = join(root, 'home');
  const temp = join(root, 'tmp');
  const cache = join(home, '.codex', 'cache');
  await mkdir(cache, { recursive: true });
  await mkdir(temp);
  await writeFile(join(cache, 'entry.bin'), 'protected');
  const scan = await scanSystem({
    home,
    staleMs: 0,
    tmpRoots: [temp],
    includeSystemTmp: false,
    processScanner: noProcesses,
  });
  const liveScanner = async () => [{ agent: 'codex', references: [cache] }];
  const result = await executeCleanup(scan, {
    home,
    batchId: 'process-race',
    processScanner: liveScanner,
  });
  assert.equal(result.batch.state, 'partial');
  assert.match(result.batch.failures[0].message, /live codex process/i);
  assert.equal(await readFile(join(cache, 'entry.bin'), 'utf8'), 'protected');
});

test('cleanup notices when a different agent starts referencing the artifact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentmop-cross-agent-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const temp = join(root, 'tmp');
  const cache = join(home, '.codex', 'cache');
  await mkdir(cache, { recursive: true });
  await mkdir(temp);
  await writeFile(join(cache, 'entry.bin'), 'cross-agent protected');
  const scan = await scanSystem({
    home,
    staleMs: 0,
    tmpRoots: [temp],
    includeSystemTmp: false,
    processScanner: noProcesses,
  });
  const result = await executeCleanup(scan, {
    home,
    batchId: 'cross-agent-race',
    processScanner: async () => [{ agent: 'claude', agentName: 'Claude Code', references: [cache] }],
  });
  assert.equal(result.batch.state, 'partial');
  assert.match(result.batch.failures[0].message, /live (?:codex|claude code) process/i);
  assert.equal(await readFile(join(cache, 'entry.bin'), 'utf8'), 'cross-agent protected');
});

test('a pre-recorded operation remains restorable if bookkeeping fails after mutation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentmop-crash-recovery-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const home = join(root, 'home');
  const temp = join(root, 'tmp');
  const cache = join(home, '.codex', 'cache');
  await mkdir(cache, { recursive: true });
  await mkdir(temp);
  await writeFile(join(cache, 'entry.bin'), 'recover me');
  const scan = await scanSystem({
    home,
    staleMs: 0,
    tmpRoots: [temp],
    includeSystemTmp: false,
    processScanner: noProcesses,
  });
  const result = await executeCleanup(scan, {
    home,
    batchId: 'crash-recovery',
    processScanner: noProcesses,
    afterMutation: async () => { throw new Error('simulated manifest write failure'); },
  });
  assert.equal(result.batch.state, 'partial');
  assert.equal(result.batch.items[0].operationState, 'planned');
  await assert.rejects(stat(cache), { code: 'ENOENT' });
  const restored = await restoreBatch('crash-recovery', { home });
  assert.equal(restored.state, 'restored');
  assert.equal(await readFile(join(cache, 'entry.bin'), 'utf8'), 'recover me');
});

test('linked worktree quarantine and restore preserve ignored files until explicit purge', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentmop-worktree-roundtrip-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const home = join(root, 'home');
  const main = join(root, 'main');
  const temp = join(root, 'tmp');
  const linked = join(home, '.codex', 'worktrees', 'stale-task');
  await mkdir(home);
  await mkdir(main);
  await mkdir(temp);
  git(main, 'init', '-b', 'main');
  git(main, 'config', 'user.name', 'AgentMop Test');
  git(main, 'config', 'user.email', 'agentmop@example.invalid');
  await writeFile(join(main, '.gitignore'), 'local.secret\n');
  await writeFile(join(main, 'tracked.txt'), 'tracked\n');
  git(main, 'add', '.gitignore', 'tracked.txt');
  git(main, 'commit', '-m', 'fixture');
  await mkdir(join(home, '.codex', 'worktrees'), { recursive: true });
  git(main, 'worktree', 'add', '-b', 'stale-task', linked);
  await writeFile(join(linked, 'local.secret'), 'must survive quarantine');

  const firstReport = await scanSystem({ home, staleMs: 0, tmpRoots: [temp], includeSystemTmp: false, processScanner: noProcesses });
  const linkedCanonical = await realpath(linked);
  const firstArtifact = firstReport.artifacts.find((item) => item.path === linkedCanonical);
  assert.equal(firstArtifact.status, 'safe');
  assert.equal(firstArtifact.cleanup.strategy, 'git-worktree-move');
  const cleaned = await executeCleanup(firstReport, {
    home,
    batchId: 'worktree-restore',
    processScanner: noProcesses,
  });
  const quarantined = cleaned.batch.items[0].quarantinedPath;
  await assert.rejects(stat(linked), { code: 'ENOENT' });
  assert.equal(await readFile(join(quarantined, 'local.secret'), 'utf8'), 'must survive quarantine');

  const restored = await restoreBatch('worktree-restore', { home });
  assert.equal(restored.state, 'restored');
  assert.equal(await readFile(join(linked, 'local.secret'), 'utf8'), 'must survive quarantine');
  const restoredCanonical = await realpath(linked);
  const restoredRegistration = `worktree ${restoredCanonical.replaceAll('\\', '/')}`;
  assert.equal(git(main, 'worktree', 'list', '--porcelain').replaceAll('\\', '/').includes(restoredRegistration), true);

  const secondReport = await scanSystem({ home, staleMs: 0, tmpRoots: [temp], includeSystemTmp: false, processScanner: noProcesses });
  const cleanedAgain = await executeCleanup(secondReport, {
    home,
    batchId: 'worktree-purge',
    processScanner: noProcesses,
  });
  assert.equal(cleanedAgain.batch.state, 'quarantined');
  const purged = await purgeBatch('worktree-purge', { home });
  assert.equal(purged.state, 'purged');
  await assert.rejects(stat(linked), { code: 'ENOENT' });
  assert.equal(git(main, 'worktree', 'list', '--porcelain').replaceAll('\\', '/').includes(restoredRegistration), false);
});

test('partial purge records permanent loss and a later restore cannot claim full success', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentmop-purge-partial-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const home = join(root, 'home');
  const main = join(root, 'main');
  const temp = join(root, 'tmp');
  const cache = join(home, '.codex', 'cache');
  const linked = join(home, '.codex', 'worktrees', 'purge-task');
  await mkdir(cache, { recursive: true });
  await mkdir(main);
  await mkdir(temp);
  await writeFile(join(cache, 'cache.bin'), 'cache payload');
  git(main, 'init', '-b', 'main');
  git(main, 'config', 'user.name', 'AgentMop Test');
  git(main, 'config', 'user.email', 'agentmop@example.invalid');
  await writeFile(join(main, 'tracked.txt'), 'tracked\n');
  git(main, 'add', 'tracked.txt');
  git(main, 'commit', '-m', 'fixture');
  await mkdir(join(home, '.codex', 'worktrees'), { recursive: true });
  git(main, 'worktree', 'add', '-b', 'purge-task', linked);

  const scanned = await scanSystem({
    home,
    staleMs: 0,
    tmpRoots: [temp],
    includeSystemTmp: false,
    processScanner: noProcesses,
  });
  const cacheArtifact = scanned.artifacts.find((item) => item.path === cache);
  const linkedCanonical = await realpath(linked);
  const worktreeArtifact = scanned.artifacts.find((item) => item.path === linkedCanonical);
  assert.equal(cacheArtifact.status, 'safe');
  assert.equal(worktreeArtifact.status, 'safe');
  const orderedReport = { ...scanned, artifacts: [cacheArtifact, worktreeArtifact] };
  const cleaned = await executeCleanup(orderedReport, {
    home,
    batchId: 'mixed-purge',
    processScanner: noProcesses,
  });
  const worktreeItem = cleaned.batch.items.find((item) => item.strategy === 'git-worktree-move');
  await writeFile(join(worktreeItem.quarantinedPath, 'new-after-quarantine.txt'), 'keep this too');

  const purged = await purgeBatch('mixed-purge', { home });
  assert.equal(purged.state, 'purge-partial');
  assert.equal(purged.purgeFailures.length, 1);
  assert.equal(purged.items[0].purgeState, 'completed');
  assert.match(purged.purgeFailures[0].message, /new changes/i);

  const restored = await restoreBatch('mixed-purge', { home });
  assert.equal(restored.state, 'restore-partial');
  assert.match(restored.restoreFailures[0].message, /permanently purged/i);
  assert.equal(await readFile(join(linked, 'new-after-quarantine.txt'), 'utf8'), 'keep this too');
  await assert.rejects(stat(cache), { code: 'ENOENT' });
});

test('an interrupted recursive purge can restore remnants but never claims they are complete', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'agentmop-purge-interrupted-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cache = join(home, 'cache');
  await mkdir(cache);
  await writeFile(join(cache, 'deleted-first.txt'), 'will be removed before failure');
  await writeFile(join(cache, 'survivor.txt'), 'must be recovered');
  await executeCleanup(report(home, [artifact(cache)]), {
    home,
    batchId: 'interrupted-purge',
    processScanner: noProcesses,
  });

  const purged = await purgeBatch('interrupted-purge', {
    home,
    removePath: async (path) => {
      await rm(join(path, 'deleted-first.txt'));
      throw new Error('simulated recursive deletion failure');
    },
  });
  assert.equal(purged.state, 'purge-partial');
  assert.equal(purged.items[0].purgeState, 'uncertain');

  const restored = await restoreBatch('interrupted-purge', { home });
  assert.equal(restored.state, 'restore-partial');
  assert.match(restored.restoreFailures[0].message, /completeness cannot be guaranteed/i);
  assert.equal(await readFile(join(cache, 'survivor.txt'), 'utf8'), 'must be recovered');
  await assert.rejects(stat(join(cache, 'deleted-first.txt')), { code: 'ENOENT' });

  const repeated = await restoreBatch('interrupted-purge', { home });
  assert.equal(repeated.state, 'restore-partial');
});
