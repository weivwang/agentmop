import { join } from 'node:path';
import { ARTIFACT_TYPES } from '../model.js';
import { definePath, scanAdapterPaths } from './common.js';

export const opencodeAdapter = {
  id: 'opencode',
  name: 'OpenCode',
  roots: (home) => [join(home, '.local', 'share', 'opencode'), join(home, '.config', 'opencode')],
  worktreeRoots: (home) => [
    join(home, '.local', 'share', 'opencode', 'worktrees'),
    join(home, '.local', 'share', 'opencode', 'worktree'),
  ],
  paths: (home) => {
    const data = join(home, '.local', 'share', 'opencode');
    const config = join(home, '.config', 'opencode');
    return [
      definePath(join(data, 'storage'), 'Session storage', ARTIFACT_TYPES.HISTORY, 'history', true),
      definePath(join(data, 'snapshot'), 'File snapshots', ARTIFACT_TYPES.HISTORY, 'history'),
      definePath(join(data, 'log'), 'Logs', ARTIFACT_TYPES.CACHE, 'cache'),
      definePath(join(data, 'logs'), 'Logs', ARTIFACT_TYPES.CACHE, 'cache'),
      definePath(join(data, 'cache'), 'Cache', ARTIFACT_TYPES.CACHE, 'cache'),
      definePath(join(data, 'tmp'), 'Temporary files', ARTIFACT_TYPES.TEMP, 'temp'),
      definePath(join(config, 'cache'), 'Configuration cache', ARTIFACT_TYPES.CACHE, 'cache'),
    ];
  },
  scan(context) {
    return scanAdapterPaths(this, context);
  },
};

export default opencodeAdapter;
