import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { scanSystem } from '../src/scan.js';

const NOW = Date.parse('2026-08-10T12:00:00.000Z');
const OLD = new Date('2026-01-01T00:00:00.000Z');
const STALE_MS = 30 * 86_400_000;
const noProcesses = async () => [];

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

async function fixture(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const home = join(root, 'home');
  const temp = join(root, 'tmp');
  await mkdir(home);
  await mkdir(temp);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, home, temp };
}

async function makeOld(path) {
  await utimes(path, OLD, OLD);
}

test('scanSystem reports supported agents, summary, safe caches, and protected history', async (t) => {
  const { home, temp } = await fixture(t, 'agentmop-scanner-report-');
  const sessions = join(home, '.codex', 'sessions', '2026', '01', '01');
  const cache = join(home, '.codex', 'cache');
  const dotTmp = join(home, '.codex', '.tmp');
  await mkdir(sessions, { recursive: true });
  await mkdir(cache, { recursive: true });
  await mkdir(dotTmp, { recursive: true });
  const secret = 'DO-NOT-REPORT-THIS-PROMPT';
  const sessionFile = join(sessions, 'rollout.jsonl');
  await writeFile(sessionFile, [
    JSON.stringify({
      type: 'session_meta',
      payload: { id: 'abc', cwd: join(home, 'project'), source: 'cli', parent: 'root', prompt: secret },
    }),
    JSON.stringify({ type: 'user_message', payload: { text: secret } }),
  ].join('\n'));
  await writeFile(join(cache, 'cache.bin'), 'cached');
  await writeFile(join(dotTmp, 'staging.bin'), 'temporary');
  for (const path of [sessionFile, sessions, join(sessions, '..'), join(sessions, '..', '..'), join(sessions, '..', '..', '..'), join(cache, 'cache.bin'), cache, join(dotTmp, 'staging.bin'), dotTmp]) {
    await makeOld(path);
  }

  const report = await scanSystem({ home, now: NOW, staleMs: STALE_MS, tmpRoots: [temp], includeSystemTmp: false, processScanner: noProcesses });
  assert.equal(report.version, '1');
  assert.equal(report.home, home);
  assert.deepEqual(report.agents.map((agent) => agent.id), ['codex', 'claude', 'cursor', 'opencode']);
  assert.equal(report.agents.find((agent) => agent.id === 'codex').installed, true);
  assert.equal(report.agents.every((agent) => Number.isFinite(agent.totalBytes)), true);

  const history = report.artifacts.find((artifact) => artifact.path.endsWith('/.codex/sessions'));
  assert.equal(history.status, 'review');
  assert.equal(history.cleanup.eligible, false);
  assert.deepEqual(history.metadata.sessionMeta, [
    { id: 'abc', cwd: join(home, 'project'), source: 'cli', parent: 'root' },
  ]);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));

  const cacheArtifact = report.artifacts.find((artifact) => artifact.path === cache);
  const tempArtifact = report.artifacts.find((artifact) => artifact.path === dotTmp);
  assert.equal(cacheArtifact.status, 'safe');
  assert.deepEqual(cacheArtifact.cleanup, { eligible: true, strategy: 'move' });
  assert.equal(tempArtifact.status, 'safe');
  assert.equal(report.summary.safeBytes, cacheArtifact.sizeBytes + tempArtifact.sizeBytes);
  assert.equal(report.summary.artifactCount, report.artifacts.length);
  assert.equal(report.summary.processCount, report.processes.length);
});

test('skipping process inspection prevents SAFE classification', async (t) => {
  const { home, temp } = await fixture(t, 'agentmop-scanner-no-processes-');
  const cache = join(home, '.cursor', 'cache');
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, 'old.bin'), 'old');
  await makeOld(join(cache, 'old.bin'));
  await makeOld(cache);

  const report = await scanSystem({
    home,
    now: NOW,
    staleMs: STALE_MS,
    includeProcesses: false,
    tmpRoots: [temp],
    includeSystemTmp: false,
  });
  const artifact = report.artifacts.find((candidate) => candidate.path === cache);
  assert.equal(artifact.status, 'review');
  assert.equal(artifact.cleanup.eligible, false);
  assert.match(report.warnings.join('\n'), /process inspection was skipped/i);
});

test('an unresolved matching process prevents SAFE for that agent', async (t) => {
  const { home, temp } = await fixture(t, 'agentmop-scanner-incomplete-process-');
  const cache = join(home, '.codex', 'cache');
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, 'old.bin'), 'old');
  await makeOld(join(cache, 'old.bin'));
  await makeOld(cache);
  const unresolved = [];
  Object.defineProperties(unresolved, {
    incompleteAgents: { value: new Set(['codex']) },
    warnings: { value: ['Codex cwd unavailable; SAFE is disabled.'] },
  });

  const report = await scanSystem({
    home,
    now: NOW,
    staleMs: STALE_MS,
    tmpRoots: [temp],
    includeSystemTmp: false,
    processScanner: async () => unresolved,
  });
  const artifact = report.artifacts.find((candidate) => candidate.path === cache);
  assert.equal(artifact.status, 'review');
  assert.equal(artifact.cleanup.eligible, false);
  assert.match(report.warnings.join('\n'), /SAFE is disabled/);
});

test('tmp discovery requires agent evidence and generic project-* remains REVIEW', async (t) => {
  const { home, temp } = await fixture(t, 'agentmop-scanner-tmp-');
  const sessions = join(home, '.codex', 'sessions');
  const generic = join(temp, 'project-checkout');
  const random = join(temp, 'project-unrelated');
  const nameOnly = join(temp, 'codex-personal-notes');
  const referenced = join(temp, 'codex-stale-task');
  await mkdir(sessions, { recursive: true });
  await mkdir(generic);
  await mkdir(random);
  await mkdir(nameOnly);
  await mkdir(referenced);
  await writeFile(join(generic, 'copy.txt'), 'copy');
  await writeFile(join(random, 'copy.txt'), 'copy');
  await writeFile(join(nameOnly, 'copy.txt'), 'personal data');
  await writeFile(join(referenced, 'copy.txt'), 'copy');
  await writeFile(
    join(sessions, 'session.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { id: 'tmp-ref', cwd: generic } })}\n`,
  );
  await writeFile(
    join(sessions, 'referenced.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { id: 'tmp-ref-2', cwd: referenced } })}\n`,
  );
  for (const directory of [generic, random, nameOnly, referenced]) {
    await makeOld(join(directory, 'copy.txt'));
    await makeOld(directory);
  }
  await makeOld(join(sessions, 'session.jsonl'));
  await makeOld(sessions);

  const report = await scanSystem({ home, now: NOW, staleMs: STALE_MS, tmpRoots: [temp], includeSystemTmp: false, processScanner: noProcesses });
  const genericArtifact = report.artifacts.find((artifact) => artifact.path === generic);
  const nameOnlyArtifact = report.artifacts.find((artifact) => artifact.path === nameOnly);
  const referencedArtifact = report.artifacts.find((artifact) => artifact.path === referenced);
  assert.equal(genericArtifact.status, 'review');
  assert.equal(genericArtifact.cleanup.eligible, false);
  assert.equal(nameOnlyArtifact.status, 'review');
  assert.equal(nameOnlyArtifact.cleanup.eligible, false);
  assert.equal(referencedArtifact.status, 'safe');
  assert.equal(report.artifacts.some((artifact) => artifact.path === random), false);
});

test('temporary Git repositories are never automatically cleaned', async (t) => {
  const { home, temp } = await fixture(t, 'agentmop-scanner-temp-git-');
  const sessions = join(home, '.codex', 'sessions');
  const dirty = join(temp, 'codex-dirty-copy');
  const clean = join(temp, 'codex-clean-copy');
  const bare = join(temp, 'codex-bare-copy');
  const container = join(temp, 'codex-container');
  const nested = join(container, 'repo');
  const bareContainer = join(temp, 'codex-bare-container');
  const nestedBare = join(bareContainer, 'unique.git');
  await mkdir(sessions, { recursive: true });

  for (const repository of [dirty, clean]) {
    await mkdir(repository);
    git(repository, 'init', '-b', 'main');
    git(repository, 'config', 'user.name', 'AgentMop Test');
    git(repository, 'config', 'user.email', 'agentmop@example.invalid');
    await writeFile(join(repository, 'tracked.txt'), 'tracked\n');
    git(repository, 'add', 'tracked.txt');
    git(repository, 'commit', '-m', 'unique local commit');
  }
  await writeFile(join(dirty, 'only-copy.secret'), 'unfinished work');
  await mkdir(bare);
  git(bare, 'init', '--bare', '-b', 'main');
  await mkdir(container);
  await mkdir(nested);
  git(nested, 'init', '-b', 'main');
  git(nested, 'config', 'user.name', 'AgentMop Test');
  git(nested, 'config', 'user.email', 'agentmop@example.invalid');
  await writeFile(join(nested, 'unique.txt'), 'unique nested commit\n');
  git(nested, 'add', 'unique.txt');
  git(nested, 'commit', '-m', 'nested local commit');
  await mkdir(bareContainer);
  await mkdir(nestedBare);
  git(nestedBare, 'init', '--bare', '-b', 'main');
  await writeFile(
    join(sessions, 'temp-repos.jsonl'),
    [
      JSON.stringify({ type: 'session_meta', payload: { id: 'dirty-copy', cwd: dirty } }),
      JSON.stringify({ type: 'session_meta', payload: { id: 'clean-copy', cwd: clean } }),
      JSON.stringify({ type: 'session_meta', payload: { id: 'bare-copy', cwd: bare } }),
      JSON.stringify({ type: 'session_meta', payload: { id: 'nested-copy', cwd: nested } }),
      JSON.stringify({ type: 'session_meta', payload: { id: 'nested-bare-copy', cwd: bareContainer } }),
    ].join('\n'),
  );

  const report = await scanSystem({
    home,
    now: NOW,
    staleMs: 0,
    tmpRoots: [temp],
    includeSystemTmp: false,
    processScanner: noProcesses,
  });
  const dirtyArtifact = report.artifacts.find((artifact) => artifact.path === dirty);
  const cleanArtifact = report.artifacts.find((artifact) => artifact.path === clean);
  const bareArtifact = report.artifacts.find((artifact) => artifact.path === bare);
  const nestedArtifact = report.artifacts.find((artifact) => artifact.path === container);
  const nestedBareArtifact = report.artifacts.find((artifact) => artifact.path === bareContainer);
  assert.equal(dirtyArtifact.status, 'dirty');
  assert.equal(dirtyArtifact.cleanup.eligible, false);
  assert.equal(cleanArtifact.status, 'review');
  assert.equal(cleanArtifact.cleanup.eligible, false);
  assert.match(cleanArtifact.reasons.join(' '), /unique commits/i);
  assert.equal(bareArtifact.git.bare, true);
  assert.equal(bareArtifact.status, 'review');
  assert.equal(bareArtifact.cleanup.eligible, false);
  assert.equal(nestedArtifact.git.isRepository, true);
  assert.equal(nestedArtifact.git.topLevel, await realpath(nested));
  assert.equal(nestedArtifact.status, 'review');
  assert.equal(nestedArtifact.cleanup.eligible, false);
  assert.equal(nestedBareArtifact.git.bare, true);
  assert.equal(nestedBareArtifact.status, 'review');
  assert.equal(nestedBareArtifact.cleanup.eligible, false);
});

test('session ownership overrides a misleading temp basename and carries process completeness', async (t) => {
  const { home, temp } = await fixture(t, 'agentmop-scanner-temp-owner-');
  const sessions = join(home, '.claude', 'projects');
  const candidate = join(temp, 'codex-misleading-name');
  await mkdir(sessions, { recursive: true });
  await mkdir(candidate);
  await writeFile(join(candidate, 'copy.txt'), 'owned by Claude session metadata');
  await writeFile(
    join(sessions, 'session.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { id: 'claude-owner', cwd: candidate } })}\n`,
  );
  const unresolved = [];
  Object.defineProperties(unresolved, {
    incompleteAgents: { value: new Set(['claude']) },
    warnings: { value: ['Claude Code cwd unavailable; SAFE is disabled.'] },
  });

  const report = await scanSystem({
    home,
    now: NOW,
    staleMs: 0,
    tmpRoots: [temp],
    includeSystemTmp: false,
    processScanner: async () => unresolved,
  });
  const artifact = report.artifacts.find((item) => item.path === candidate);
  assert.equal(artifact.agent, 'claude');
  assert.equal(artifact.status, 'review');
  assert.equal(artifact.cleanup.eligible, false);
});

test('a candidate that is itself a symlink is UNKNOWN and target data is not counted', { skip: process.platform === 'win32' }, async (t) => {
  const { home, temp } = await fixture(t, 'agentmop-scanner-symlink-');
  const outside = join(home, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'data'), 'valuable');
  const candidate = join(temp, 'codex-linked-cache');
  await symlink(outside, candidate);

  const report = await scanSystem({ home, now: NOW, staleMs: 0, tmpRoots: [temp], includeSystemTmp: false, processScanner: noProcesses });
  const artifact = report.artifacts.find((item) => item.path === candidate);
  assert.equal(artifact.status, 'unknown');
  assert.equal(artifact.sizeBytes, 0);
  assert.equal(artifact.cleanup.eligible, false);
});

test('an agent-root symlink is not followed into external cache or session data', { skip: process.platform === 'win32' }, async (t) => {
  const { root, home, temp } = await fixture(t, 'agentmop-scanner-ancestor-link-');
  const external = join(root, 'external-codex');
  const cache = join(external, 'cache');
  const sessions = join(external, 'sessions');
  await mkdir(cache, { recursive: true });
  await mkdir(sessions, { recursive: true });
  const secret = 'EXTERNAL-SESSION-MUST-NOT-BE-READ';
  await writeFile(join(cache, 'valuable.bin'), 'valuable');
  await writeFile(
    join(sessions, 'session.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { id: 'external', cwd: join(root, secret) } })}\n`,
  );
  await symlink(external, join(home, '.codex'));

  const report = await scanSystem({ home, now: NOW, staleMs: 0, tmpRoots: [temp], includeSystemTmp: false, processScanner: noProcesses });
  const cacheArtifact = report.artifacts.find((item) => item.path === join(home, '.codex', 'cache'));
  const historyArtifact = report.artifacts.find((item) => item.path === join(home, '.codex', 'sessions'));
  assert.equal(cacheArtifact.status, 'unknown');
  assert.equal(cacheArtifact.sizeBytes, 0);
  assert.equal(cacheArtifact.cleanup.eligible, false);
  assert.equal(historyArtifact.status, 'review');
  assert.equal(historyArtifact.metadata.sessionMeta, undefined);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
});
