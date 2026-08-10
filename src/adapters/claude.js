import { join } from 'node:path';
import { ARTIFACT_TYPES } from '../model.js';
import { definePath, scanAdapterPaths } from './common.js';

export const claudeAdapter = {
  id: 'claude',
  name: 'Claude Code',
  roots: (home) => [join(home, '.claude')],
  worktreeRoots: (home) => [join(home, '.claude', 'worktrees')],
  paths: (home) => {
    const root = join(home, '.claude');
    return [
      definePath(join(root, 'projects'), 'Project sessions', ARTIFACT_TYPES.HISTORY, 'history', true),
      definePath(join(root, 'history.jsonl'), 'Command history', ARTIFACT_TYPES.HISTORY, 'history'),
      definePath(join(root, 'file-history'), 'File history', ARTIFACT_TYPES.HISTORY, 'history'),
      definePath(join(root, 'shell-snapshots'), 'Shell snapshots', ARTIFACT_TYPES.SESSION, 'history'),
      definePath(join(root, 'session-env'), 'Session environments', ARTIFACT_TYPES.SESSION, 'history'),
      definePath(join(root, 'todos'), 'Session todos', ARTIFACT_TYPES.SESSION, 'history'),
      definePath(join(root, 'cache'), 'Cache', ARTIFACT_TYPES.CACHE, 'cache'),
      definePath(join(root, 'debug'), 'Debug logs', ARTIFACT_TYPES.CACHE, 'cache'),
      definePath(join(root, 'logs'), 'Logs', ARTIFACT_TYPES.CACHE, 'cache'),
      definePath(join(root, 'tmp'), 'Temporary files', ARTIFACT_TYPES.TEMP, 'temp'),
    ];
  },
  scan(context) {
    return scanAdapterPaths(this, context);
  },
};

export default claudeAdapter;
