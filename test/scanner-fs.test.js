import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectPath, readSessionMetaPrefix } from '../src/fs-inspect.js';

test('inspectPath counts allocated and logical bytes without following symlinks', { skip: process.platform === 'win32' }, async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'agentmop-scanner-fs-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(fixture, { recursive: true, force: true })));
  const root = join(fixture, 'root');
  const outside = join(fixture, 'outside');
  await mkdir(root);
  await mkdir(outside);
  const sparse = join(root, 'sparse.jsonl');
  const handle = await open(sparse, 'w');
  await handle.truncate(16 * 1024 * 1024);
  await handle.close();
  await writeFile(join(outside, 'large.bin'), Buffer.alloc(2 * 1024 * 1024, 1));
  await symlink(outside, join(root, 'outside-link'));

  const result = await inspectPath(root);
  assert.equal(result.kind, 'directory');
  assert.equal(result.fileCount, 1);
  assert.equal(result.symlinkCount, 1);
  assert.equal(result.logicalBytes, 16 * 1024 * 1024);
  assert.ok(result.sizeBytes <= result.logicalBytes, 'allocated bytes should not exceed sparse logical size');
});

test('a root symlink is reported but never traversed', { skip: process.platform === 'win32' }, async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'agentmop-scanner-link-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(fixture, { recursive: true, force: true })));
  await mkdir(join(fixture, 'target'));
  await writeFile(join(fixture, 'target', 'secret'), 'not scanned');
  await symlink(join(fixture, 'target'), join(fixture, 'candidate'));

  const result = await inspectPath(join(fixture, 'candidate'));
  assert.equal(result.kind, 'symlink');
  assert.equal(result.sizeBytes, 0);
  assert.equal(result.fileCount, 0);
  assert.equal(result.symlinkCount, 1);
});

test('JSONL inspection returns only allowlisted session_meta fields', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'agentmop-scanner-meta-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(fixture, { recursive: true, force: true })));
  const session = join(fixture, 'session.jsonl');
  const secret = 'PROMPT-BODY-MUST-NOT-ESCAPE';
  await writeFile(
    session,
    [
      JSON.stringify({ type: 'user_message', text: `session_meta ${secret}` }),
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'session-1',
          cwd: fixture,
          source: 'cli',
          parent: 'parent-1',
          prompt: secret,
          arbitrary: { secret },
        },
      }),
      JSON.stringify({ type: 'user_message', text: secret }),
    ].join('\n'),
  );

  const result = await readSessionMetaPrefix(session);
  assert.deepEqual(result, {
    id: 'session-1',
    cwd: fixture,
    source: 'cli',
    parent: 'parent-1',
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test('session metadata identifiers reject free-form or oversized values', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'agentmop-scanner-meta-tokens-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(fixture, { recursive: true, force: true })));
  const session = join(fixture, 'session.jsonl');
  const secret = 'PROMPT TEXT MUST NOT ESCAPE';
  await writeFile(session, `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id: secret,
      cwd: fixture,
      source: secret,
      parent: 'x'.repeat(300),
    },
  })}\n`);
  const result = await readSessionMetaPrefix(session);
  assert.deepEqual(result, { cwd: fixture });
  assert.doesNotMatch(JSON.stringify(result), /PROMPT|xxx/);
});

test('session metadata reader refuses a symbolic-link file', { skip: process.platform === 'win32' }, async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'agentmop-scanner-meta-link-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(fixture, { recursive: true, force: true })));
  const target = join(fixture, 'target.jsonl');
  const link = join(fixture, 'session.jsonl');
  await writeFile(target, `${JSON.stringify({ type: 'session_meta', payload: { id: 'external', cwd: fixture } })}\n`);
  await symlink(target, link);
  await assert.rejects(readSessionMetaPrefix(link), /symbolic link|ELOOP/i);
});
