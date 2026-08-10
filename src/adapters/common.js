import { opendir, lstat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { inspectPath, pathExists, readSessionMetaPrefix } from '../fs-inspect.js';

export async function scanAdapterPaths(adapter, context) {
  const artifacts = [];
  const references = [];
  const warnings = [];

  for (const definition of adapter.paths(context.home)) {
    const path = resolve(definition.path);
    const inspection = await inspectPath(path, { boundary: context.home });
    if (!inspection.exists) continue;

    const metadataReadable = inspection.exists && inspection.errors.length === 0 &&
      inspection.kind !== 'symlink' && inspection.kind !== 'symlink-ancestor';
    const pathReferences = definition.sessionMeta && metadataReadable
      ? await collectSessionReferences(path, {
          agent: adapter.id,
          maxFiles: context.deep ? 50_000 : 10_000,
          warnings,
        })
      : [];
    references.push(...pathReferences);
    artifacts.push({
      agent: adapter.id,
      agentName: adapter.name,
      type: definition.type,
      label: definition.label,
      path,
      policy: definition.policy,
      strongEvidence: true,
      owner: `${adapter.name} known ${definition.type} path`,
      inspection,
      references: pathReferences,
      boundary: context.home,
      metadata: {
        sessionCount: definition.sessionMeta ? pathReferences.length : undefined,
        symlinkCount: inspection.symlinkCount,
        directoryCount: inspection.directoryCount,
      },
    });

    for (const error of inspection.errors) {
      warnings.push({
        code: 'FS_INSPECTION_FAILED',
        agent: adapter.id,
        path: error.path,
        message: error.message,
      });
    }
  }

  const roots = adapter.roots(context.home).map((path) => resolve(path));
  const installed = (await Promise.all(roots.map(pathExists))).some(Boolean);
  return {
    agent: { id: adapter.id, name: adapter.name, installed, roots },
    artifacts,
    references: dedupeReferences(references),
    worktreeRoots: adapter.worktreeRoots(context.home).map((path) => resolve(path)),
    warnings,
  };
}

export async function collectSessionReferences(root, { agent, maxFiles = 10_000, warnings = [] } = {}) {
  const files = [];
  const rootStats = await lstat(root).catch(() => null);
  if (!rootStats || rootStats.isSymbolicLink()) return [];
  if (rootStats.isFile()) {
    if (extname(root).toLowerCase() === '.jsonl') files.push(root);
  } else if (rootStats.isDirectory()) {
    await collectJsonlFiles(root, files, maxFiles);
  }

  const references = [];
  for (const file of files) {
    try {
      const meta = await readSessionMetaPrefix(file);
      if (!meta?.cwd) continue;
      const stats = await lstat(file).catch(() => null);
      references.push({
        kind: 'session-cwd',
        agent,
        path: meta.cwd,
        sessionId: meta.id ?? null,
        source: meta.source ?? null,
        parent: meta.parent ?? null,
        observedAt: stats ? new Date(stats.mtimeMs).toISOString() : null,
      });
    } catch (error) {
      warnings.push({
        code: 'SESSION_META_UNREADABLE',
        agent,
        path: file,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return dedupeReferences(references);
}

async function collectJsonlFiles(directory, output, maxFiles) {
  if (output.length >= maxFiles) return;
  let handle;
  try {
    handle = await opendir(directory);
    for await (const entry of handle) {
      if (output.length >= maxFiles) break;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await collectJsonlFiles(path, output, maxFiles);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === '.jsonl') output.push(path);
    }
  } catch {
    await handle?.close().catch(() => {});
  }
}

function dedupeReferences(references) {
  const seen = new Set();
  return references.filter((reference) => {
    const key = `${reference.agent}\0${reference.path}\0${reference.sessionId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function definePath(path, label, type, policy, sessionMeta = false) {
  return { path, label, type, policy, sessionMeta };
}
