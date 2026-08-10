import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAge, formatBytes, parseDuration, sanitizeTerminalText, truncateMiddle } from '../src/format.js';

test('formatBytes uses binary units without noisy precision', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(202.4 * 1024 ** 3), '202 GB');
});

test('parseDuration accepts explicit units and rejects ambiguity', () => {
  assert.equal(parseDuration('30d'), 30 * 86_400_000);
  assert.equal(parseDuration('2w'), 14 * 86_400_000);
  assert.throws(() => parseDuration('30'), /Invalid duration/);
});

test('human helpers are compact', () => {
  assert.equal(formatAge(0), 'today');
  assert.equal(formatAge(45), '1 month');
  assert.equal(truncateMiddle('abcdefghijklmnopqrstuvwxyz', 9), 'abcd…wxyz');
  assert.equal(sanitizeTerminalText('safe\u001b]8;;https://evil\u0007\nname'), 'safe ]8;;https://evil name');
});
