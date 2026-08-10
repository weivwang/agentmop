import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoReport } from '../src/demo.js';
import { renderTerminal } from '../src/render/terminal.js';
import { renderHtml } from '../src/render/html.js';

test('demo report is deterministic, internally consistent, and unmistakably sample data', () => {
  const first = createDemoReport();
  const second = createDemoReport();
  assert.deepEqual(first, second);
  assert.equal(first.sampleData, true);
  assert.match(first.sampleLabel, /Sample data/i);
  assert.equal(first.artifacts.length, 8);
  assert.equal(first.processes.length, 3);
  assert.deepEqual(first.summary.counts, {
    live: 1,
    dirty: 1,
    safe: 3,
    review: 2,
    unknown: 1,
  });

  const artifactTotal = first.artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0);
  assert.equal(first.summary.totalBytes, artifactTotal);
  assert.ok(Math.abs(first.summary.totalBytes / 1024 ** 3 - 202.4) < 1e-8);
  assert.ok(first.artifacts.every((artifact) => artifact.metadata.sample));
  assert.deepEqual(first.agents.map((agent) => agent.id), ['claude', 'codex', 'cursor', 'opencode']);
  assert.equal(first.artifacts.filter((artifact) => artifact.status === 'safe').every((artifact) => artifact.cleanup.strategy === 'move'), true);
  assert.equal(first.processes.every((process) => process.cwd && !process.command.includes('--')), true);
  assert.doesNotMatch(JSON.stringify(first), /Library\/Caches|Heartbeat observed|Current bundle|Completion marker|Zero open file handles/);
});

test('plain terminal report is readable, risk-sorted, and gives safe next steps', () => {
  const output = renderTerminal(createDemoReport(), { color: false, width: 112 });
  assert.doesNotMatch(output, /\u001b\[/);
  assert.match(output, /AGENTMOP/);
  assert.match(output, /SAMPLE DATA — no files were scanned or changed/);
  assert.match(output, /202\.4 GB observed/);
  assert.match(output, /AGENT BREAKDOWN/);
  assert.match(output, /Resource|RESOURCE/);
  assert.match(output, /Privacy: local-only analysis/);
  assert.match(output, /agentmop clean --safe --dry-run/);
  assert.match(output, /recoverable quarantine/);

  const table = output.slice(output.indexOf('ARTIFACTS · HIGHEST RISK FIRST'));
  assert.ok(table.indexOf('[DIRTY]') < table.indexOf('[LIVE]'));
  assert.ok(table.indexOf('[LIVE]') < table.indexOf('[REVIEW]'));
  assert.ok(table.indexOf('[REVIEW]') < table.indexOf('[UNKNOWN]'));
  assert.ok(table.indexOf('[UNKNOWN]') < table.indexOf('[SAFE]'));
});

test('terminal renderer emits ANSI only when color is requested', () => {
  const report = createDemoReport();
  assert.match(renderTerminal(report, { color: true }), /\u001b\[/);
  assert.doesNotMatch(renderTerminal(report, { color: false }), /\u001b\[/);
});

test('terminal renderer strips control sequences from local paths and warnings', () => {
  const report = createDemoReport();
  report.artifacts[0].displayPath = '/tmp/clean\u001b]8;;https://evil.example\u0007\nspoof';
  report.artifacts[0].evidence = ['safe\u001b[2J\rspoof'];
  report.warnings = ['warning\u001b]0;owned\u0007\ncontinued'];
  const output = renderTerminal(report, { color: false });
  assert.doesNotMatch(output, /\u001b|\u0007/);
  assert.doesNotMatch(output, /evil\.example\u0007|owned\u0007/);
  assert.match(output, /continued/);
});

test('HTML report is a complete, self-contained interactive dashboard', () => {
  const output = renderHtml(createDemoReport(), { title: 'AgentMop sample report' });
  assert.match(output, /^<!doctype html>/);
  assert.match(output, /<title>AgentMop sample report<\/title>/);
  assert.match(output, />202\.4<span>GB<\/span>/);
  assert.match(output, /SAMPLE DATA/);
  assert.match(output, /Agent breakdown/);
  assert.match(output, /Artifact inventory/);
  assert.match(output, /Resource owner/);
  assert.match(output, /Why AgentMop marked this safe/);
  assert.match(output, /Private by construction/);
  assert.match(output, /id="artifact-search"/);
  assert.match(output, /data-filter="safe"/);
  assert.match(output, /id="expand-visible"/);
  assert.match(output, /01:42:18/);
  assert.match(output, /@media \(max-width:780px\)/);
  assert.doesNotMatch(output, /<link\b/i);
  assert.doesNotMatch(output, /<script\s+[^>]*src=/i);
});

test('HTML renderer neutralizes report and title injection, including closing-script XSS', () => {
  const payload = '</script><script>alert("mopped")</script><img src=x onerror=alert(1)>';
  const report = {
    generatedAt: '2026-08-10T00:00:00.000Z',
    hostname: payload,
    agents: [{ id: 'evil', name: payload, installed: true }],
    artifacts: [{
      id: payload,
      agent: 'evil',
      agentName: payload,
      type: 'cache',
      label: payload,
      path: `/tmp/${payload}`,
      displayPath: `/tmp/${payload}`,
      sizeBytes: 42,
      fileCount: 1,
      ageDays: 3,
      modifiedAt: payload,
      status: 'safe',
      reasons: [payload],
      evidence: [payload],
      references: [payload],
      cleanup: { eligible: true, strategy: 'quarantine' },
      metadata: { owner: payload },
    }],
    processes: [{ pid: 1, agent: payload, command: payload, reasons: [payload] }],
    warnings: [payload],
  };
  const output = renderHtml(report, { title: payload });

  assert.doesNotMatch(output, /<script>alert\("mopped"\)<\/script>/);
  assert.doesNotMatch(output, /<img src=x onerror=/);
  assert.match(output, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(output, /\\u003c\/script\\u003e\\u003cscript\\u003ealert/);
  assert.equal((output.match(/<script(?:\s|>)/g) ?? []).length, 2);

  const embedded = output.match(/<script id="agentmop-data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(embedded);
  assert.equal(JSON.parse(embedded[1]).artifacts[0].label, payload);
});

test('renderers tolerate sparse reports and calculate missing summary fields', () => {
  const sparse = {
    artifacts: [{
      agent: 'test-agent',
      agentName: 'Test Agent',
      type: 'cache',
      path: '/tmp/cache',
      sizeBytes: 1024 ** 3,
      ageDays: 40,
      status: 'safe',
      cleanup: { eligible: true, strategy: 'quarantine' },
    }],
  };
  assert.match(renderTerminal(sparse, { color: false }), /1\.0 GB observed/);
  const output = renderHtml(sparse);
  assert.match(output, />1\.0<span>GB<\/span>/);
  assert.match(output, /Test Agent/);
});
