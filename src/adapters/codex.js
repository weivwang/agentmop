import { join } from 'node:path';
import { ARTIFACT_TYPES } from '../model.js';
import { definePath, scanAdapterPaths } from './common.js';

export const codexAdapter = {
  id: 'codex',
  name: 'Codex',
  roots: (home) => [join(home, '.codex')],
  worktreeRoots: (home) => [join(home, '.codex', 'worktrees')],
  paths: (home) => {
    const root = join(home, '.codex');
    return [
      definePath(join(root, 'sessions'), 'Session history', ARTIFACT_TYPES.HISTORY, 'history', true),
      definePath(join(root, 'archived_sessions'), 'Archived sessions', ARTIFACT_TYPES.HISTORY, 'history', true),
      definePath(join(root, 'history.jsonl'), 'Command history', ARTIFACT_TYPES.HISTORY, 'history', false),
      definePath(join(root, 'log'), 'Logs', ARTIFACT_TYPES.CACHE, 'cache'),
      definePath(join(root, 'logs'), 'Logs', ARTIFACT_TYPES.CACHE, 'cache'),
      definePath(join(root, 'cache'), 'Cache', ARTIFACT_TYPES.CACHE, 'cache'),
      definePath(join(root, 'tmp'), 'Temporary files', ARTIFACT_TYPES.TEMP, 'temp'),
      definePath(join(root, '.tmp'), 'Temporary files', ARTIFACT_TYPES.TEMP, 'temp'),
    ];
  },
  scan(context) {
    return scanAdapterPaths(this, context);
  },
};

export default codexAdapter;
