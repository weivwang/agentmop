import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createArtifact, displayPath, summarizeReport } from '../src/model.js';

test('displayPath only abbreviates descendants of home', () => {
  assert.equal(displayPath('/home/alice/.codex/cache', '/home/alice'), '~/.codex/cache');
  assert.equal(displayPath('/home/alice2/cache', '/home/alice'), resolve('/home/alice2/cache'));
});

test('createArtifact produces a stable id and computed age', () => {
  const now = Date.UTC(2026, 7, 10);
  const input = {
    agent: 'codex',
    agentName: 'Codex',
    type: 'cache',
    label: 'Cache',
    path: '/tmp/example',
    modifiedMs: now - 31 * 86_400_000,
    now,
  };
  const first = createArtifact(input);
  const second = createArtifact(input);
  assert.equal(first.id, second.id);
  assert.equal(first.ageDays, 31);
  assert.equal(first.status, 'unknown');
});

test('summarizeReport counts safe bytes only when cleanup eligible', () => {
  const report = {
    artifacts: [
      { status: 'safe', sizeBytes: 100, cleanup: { eligible: true } },
      { status: 'safe', sizeBytes: 50, cleanup: { eligible: false } },
      { status: 'review', sizeBytes: 25, cleanup: { eligible: false } },
      { status: 'dirty', sizeBytes: 5, cleanup: { eligible: false } },
    ],
    processes: [{ pid: 1 }],
  };
  const summary = summarizeReport(report);
  assert.equal(summary.totalBytes, 180);
  assert.equal(summary.safeBytes, 100);
  assert.equal(summary.reviewBytes, 25);
  assert.equal(summary.counts.safe, 2);
  assert.equal(summary.processCount, 1);
});
