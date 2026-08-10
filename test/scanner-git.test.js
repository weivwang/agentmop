import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, opendir, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectGitWorktree } from '../src/git.js';
import { scanSystem } from '../src/scan.js';

const NOW = Date.parse('2026-08-10T12:00:00.000Z');
const OLD = new Date('2026-01-01T00:00:00.000Z');
const gitAvailable = spawnSync('git', ['--version']).status === 0;
const noProcesses = async () => [];

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

async function ageTree(path) {
  const stats = await lstat(path);
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    const handle = await opendir(path);
    for await (const entry of handle) await ageTree(join(path, entry.name));
  }
  await utimes(path, OLD, OLD);
}

test('managed clean linked worktree records identity and becomes SAFE only with strong evidence', { skip: !gitAvailable }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentmop-scanner-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const temp = join(root, 'tmp');
  const main = join(root, 'main');
  const linked = join(temp, 'codex-old-worktree');
  const sessions = join(home, '.codex', 'sessions');
  await mkdir(home);
  await mkdir(temp);
  await mkdir(main);
  await mkdir(sessions, { recursive: true });
  git(main, 'init', '-b', 'main');
  git(main, 'config', 'user.name', 'AgentMop Test');
  git(main, 'config', 'user.email', 'agentmop@example.invalid');
  await writeFile(join(main, 'README.md'), 'fixture\n');
  git(main, 'add', 'README.md');
  git(main, 'commit', '-m', 'fixture');
  git(main, 'worktree', 'add', '-b', 'agentmop-test', linked);
  await writeFile(
    join(sessions, 'session.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { id: 'git-ref', cwd: linked } })}\n`,
  );
  await ageTree(linked);
  await ageTree(sessions);

  const gitInfo = await inspectGitWorktree(linked);
  assert.equal(gitInfo.isWorktree, true);
  assert.equal(gitInfo.linked, true);
  assert.equal(gitInfo.registered, true);
  assert.equal(gitInfo.dirty, false);
  assert.equal(gitInfo.branch, 'agentmop-test');
  assert.equal(gitInfo.mainWorktree, await realpath(main));

  const report = await scanSystem({ home, now: NOW, staleMs: 30 * 86_400_000, tmpRoots: [temp], includeSystemTmp: false, processScanner: noProcesses });
  const linkedReal = await realpath(linked);
  const artifact = report.artifacts.find((candidate) => candidate.path === linkedReal);
  assert.equal(artifact.type, 'worktree');
  assert.equal(artifact.status, 'safe');
  assert.deepEqual(artifact.cleanup, { eligible: true, strategy: 'git-worktree-move' });
  assert.equal(artifact.git.head, git(main, 'rev-parse', 'agentmop-test'));
  assert.equal(artifact.git.commonDir, join(await realpath(main), '.git'));

  await writeFile(join(linked, 'unfinished.txt'), 'do not delete');
  const dirtyReport = await scanSystem({ home, now: NOW, staleMs: 0, tmpRoots: [temp], includeSystemTmp: false, processScanner: noProcesses });
  const dirty = dirtyReport.artifacts.find((candidate) => candidate.path === linkedReal);
  assert.equal(dirty.status, 'dirty');
  assert.equal(dirty.cleanup.eligible, false);
});

test('generic project-* linked worktree referenced by history is never SAFE', { skip: !gitAvailable }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentmop-scanner-generic-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const temp = join(root, 'tmp');
  const main = join(root, 'main');
  const linked = join(temp, 'project-checkout');
  const sessions = join(home, '.claude', 'projects');
  await mkdir(home);
  await mkdir(temp);
  await mkdir(main);
  await mkdir(sessions, { recursive: true });
  git(main, 'init', '-b', 'main');
  git(main, 'config', 'user.name', 'AgentMop Test');
  git(main, 'config', 'user.email', 'agentmop@example.invalid');
  await writeFile(join(main, 'file.txt'), 'fixture\n');
  git(main, 'add', 'file.txt');
  git(main, 'commit', '-m', 'fixture');
  git(main, 'worktree', 'add', '-b', 'generic-test', linked);
  await writeFile(
    join(sessions, 'session.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { id: 'generic-ref', cwd: linked } })}\n`,
  );
  await ageTree(linked);
  await ageTree(sessions);

  const report = await scanSystem({ home, now: NOW, staleMs: 0, tmpRoots: [temp], includeSystemTmp: false, processScanner: noProcesses });
  const linkedReal = await realpath(linked);
  const artifact = report.artifacts.find((candidate) => candidate.path === linkedReal);
  assert.equal(artifact.type, 'worktree');
  assert.equal(artifact.status, 'review');
  assert.equal(artifact.cleanup.eligible, false);
});

test('read-only Git inspection disables repository fsmonitor commands', {
  skip: !gitAvailable || process.platform === 'win32',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentmop-scanner-fsmonitor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, 'repo');
  const hook = join(root, 'fsmonitor.sh');
  const marker = join(root, 'fsmonitor-ran');
  await mkdir(repository);
  git(repository, 'init', '-b', 'main');
  git(repository, 'config', 'user.name', 'AgentMop Test');
  git(repository, 'config', 'user.email', 'agentmop@example.invalid');
  await writeFile(join(repository, 'tracked.txt'), 'fixture\n');
  git(repository, 'add', 'tracked.txt');
  git(repository, 'commit', '-m', 'fixture');
  await writeFile(hook, `#!/bin/sh\ntouch "${marker}"\n`);
  await chmod(hook, 0o700);
  git(repository, 'config', 'core.fsmonitor', hook);

  const info = await inspectGitWorktree(repository);
  assert.equal(info.isWorktree, true);
  await assert.rejects(stat(marker), { code: 'ENOENT' });
});
