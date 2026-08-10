import { join } from 'node:path';
import { ARTIFACT_TYPES } from '../model.js';
import { definePath, scanAdapterPaths } from './common.js';

export const cursorAdapter = {
  id: 'cursor',
  name: 'Cursor',
  roots: (home) => [join(home, '.cursor')],
  worktreeRoots: (home) => [join(home, '.cursor', 'worktrees')],
  paths: (home) => {
    const root = join(home, '.cursor');
    return [
      definePath(join(root, 'projects'), 'Project sessions', ARTIFACT_TYPES.HISTORY, 'history', true),
      definePath(join(root, 'chats'), 'Chat history', ARTIFACT_TYPES.HISTORY, 'history', true),
      definePath(join(root, 'history'), 'History', ARTIFACT_TYPES.HISTORY, 'history'),
      definePath(join(root, 'logs'), 'Logs', ARTIFACT_TYPES.CACHE, 'cache'),
      definePath(join(root, 'cache'), 'Cache', ARTIFACT_TYPES.CACHE, 'cache'),
      definePath(join(root, 'CachedData'), 'Cached data', ARTIFACT_TYPES.CACHE, 'cache'),
      definePath(join(root, 'tmp'), 'Temporary files', ARTIFACT_TYPES.TEMP, 'temp'),
    ];
  },
  scan(context) {
    return scanAdapterPaths(this, context);
  },
};

export default cursorAdapter;
