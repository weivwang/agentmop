import codexAdapter from './codex.js';
import claudeAdapter from './claude.js';
import cursorAdapter from './cursor.js';
import opencodeAdapter from './opencode.js';

export const adapters = Object.freeze([
  codexAdapter,
  claudeAdapter,
  cursorAdapter,
  opencodeAdapter,
]);

export { codexAdapter, claudeAdapter, cursorAdapter, opencodeAdapter };
