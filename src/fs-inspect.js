import { constants } from 'node:fs';
import { open, opendir, lstat, readlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const DEFAULT_JSONL_PREFIX_BYTES = 64 * 1024;
const DEFAULT_JSONL_LINES = 32;

export async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

/**
 * Calculate allocated content size without ever following symbolic links.
 * Errors are returned as data so a scan can fail closed and keep going.
 */
export async function inspectPath(inputPath, { boundary } = {}) {
  const path = resolve(inputPath);
  const result = {
    path,
    exists: false,
    kind: 'missing',
    sizeBytes: 0,
    logicalBytes: 0,
    fileCount: 0,
    directoryCount: 0,
    symlinkCount: 0,
    gitRepositoryRoots: [],
    modifiedMs: 0,
    device: null,
    inode: null,
    errors: [],
  };

  if (boundary) {
    const issue = await pathBoundaryIssue(path, boundary, { includeLeaf: false });
    if (issue) {
      result.exists = true;
      result.kind = issue.code === 'SYMLINK_IN_PATH' ? 'symlink-ancestor' : 'unknown';
      result.errors.push(issue);
      return result;
    }
  }

  let root;
  try {
    root = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return result;
    result.kind = 'unknown';
    result.errors.push(toInspectionError(path, error));
    return result;
  }

  result.exists = true;
  result.modifiedMs = root.mtimeMs;
  result.device = root.dev;
  result.inode = root.ino;

  if (root.isSymbolicLink()) {
    result.kind = 'symlink';
    result.symlinkCount = 1;
    return result;
  }

  if (!root.isDirectory()) {
    result.kind = root.isFile() ? 'file' : 'other';
    result.sizeBytes = root.isFile() ? allocatedBytes(root) : 0;
    result.logicalBytes = root.isFile() ? root.size : 0;
    result.fileCount = root.isFile() ? 1 : 0;
    return result;
  }

  result.kind = 'directory';
  await walkDirectory(path, result);
  return result;
}

/**
 * Validate a path component-by-component without following links. The boundary
 * is an already trusted scan root (for example the canonical HOME or tmp root).
 */
export async function pathBoundaryIssue(inputPath, boundary, { includeLeaf = true } = {}) {
  const target = resolve(inputPath);
  const root = resolve(boundary);
  const child = relative(root, target);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    return {
      path: target,
      code: 'PATH_OUTSIDE_BOUNDARY',
      message: `Path is outside its trusted scan root: ${root}`,
    };
  }

  const components = child ? child.split(sep).filter(Boolean) : [];
  const paths = [root];
  let current = root;
  const traversed = includeLeaf ? components : components.slice(0, -1);
  for (const component of traversed) {
    current = join(current, component);
    paths.push(current);
  }

  for (const candidate of paths) {
    let stats;
    try {
      stats = await lstat(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
      return toInspectionError(candidate, error);
    }
    if (stats.isSymbolicLink()) {
      return {
        path: candidate,
        code: 'SYMLINK_IN_PATH',
        message: `Symbolic link path component is not trusted: ${candidate}`,
      };
    }
  }
  return null;
}

async function walkDirectory(directory, result) {
  result.directoryCount += 1;
  let handle;
  let hasBareHead = false;
  let hasBareObjects = false;
  let hasBareRefs = false;
  try {
    handle = await opendir(directory);
    for await (const entry of handle) {
      if (entry.name === 'HEAD') hasBareHead = true;
      else if (entry.name === 'objects') hasBareObjects = true;
      else if (entry.name === 'refs') hasBareRefs = true;
      const entryPath = join(directory, entry.name);
      let stats;
      try {
        // Dirent data can be stale; lstat is deliberate because stat follows links.
        stats = await lstat(entryPath);
      } catch (error) {
        result.errors.push(toInspectionError(entryPath, error));
        continue;
      }

      result.modifiedMs = Math.max(result.modifiedMs, stats.mtimeMs);
      if (stats.isSymbolicLink()) {
        result.symlinkCount += 1;
      } else if (stats.isDirectory()) {
        if (entry.name === '.git' && result.gitRepositoryRoots.length < 64) {
          result.gitRepositoryRoots.push(directory);
        }
        await walkDirectory(entryPath, result);
      } else if (stats.isFile()) {
        if (entry.name === '.git' && result.gitRepositoryRoots.length < 64) {
          result.gitRepositoryRoots.push(directory);
        }
        result.sizeBytes += allocatedBytes(stats);
        result.logicalBytes += stats.size;
        result.fileCount += 1;
      }
    }
  } catch (error) {
    result.errors.push(toInspectionError(directory, error));
    // opendir may have succeeded but iteration failed. Explicit close is harmless.
    await handle?.close().catch(() => {});
  }
  if (hasBareHead && hasBareObjects && hasBareRefs && result.gitRepositoryRoots.length < 64) {
    result.gitRepositoryRoots.push(directory);
  }
}

function allocatedBytes(stats) {
  // POSIX st_blocks counts 512-byte units. This matters for sparse session
  // logs: logical length can be gigabytes while actual disk use is tiny.
  return Number.isFinite(stats.blocks) ? stats.blocks * 512 : stats.size;
}

function toInspectionError(path, error) {
  return {
    path,
    code: error?.code ?? 'UNKNOWN',
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Read only a bounded prefix of JSONL and return the first session_meta record.
 * The returned object is an allowlist; prompt/message fields can never escape.
 */
export async function readSessionMetaPrefix(
  filePath,
  { maxBytes = DEFAULT_JSONL_PREFIX_BYTES, maxLines = DEFAULT_JSONL_LINES } = {},
) {
  let file;
  try {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    file = await open(filePath, flags);
    const stats = await file.stat();
    if (!stats.isFile()) return null;
    const buffer = Buffer.alloc(Math.max(1, maxBytes));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const prefix = buffer.subarray(0, bytesRead).toString('utf8');
    const lines = prefix.split(/\r?\n/, maxLines + 1).slice(0, maxLines);

    for (const line of lines) {
      // Do not parse arbitrary history records. A cheap textual gate prevents
      // deserialising prompt/message payloads that happen to be in the prefix.
      if (!/"type"\s*:\s*"session_meta"/.test(line)) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record?.type !== 'session_meta') continue;
      const payload = record.payload && typeof record.payload === 'object' ? record.payload : record;
      const cwd = absolutePathOrNull(payload.cwd);
      return compactObject({
        id: identifierOrNull(payload.id),
        cwd,
        source: tokenOrNull(payload.source, 64),
        parent: identifierOrNull(payload.parent ?? payload.parent_id ?? payload.parentId),
      });
    }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  } finally {
    await file?.close().catch(() => {});
  }
  return null;
}

function identifierOrNull(value) {
  return tokenOrNull(value, 256);
}

function tokenOrNull(value, maxLength) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  return text.length > 0 && text.length <= maxLength && /^[a-zA-Z0-9._:-]+$/.test(text) ? text : null;
}

function absolutePathOrNull(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) return null;
  return resolve(value);
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null));
}

export async function findDirectoriesWithEntry(root, entryName, { maxDepth = 4, boundary } = {}) {
  const matches = [];
  const rootPath = resolve(root);
  if (boundary && await pathBoundaryIssue(rootPath, boundary)) return matches;
  if (!(await pathExists(rootPath))) return matches;

  async function visit(directory, depth) {
    let handle;
    try {
      handle = await opendir(directory);
      for await (const entry of handle) {
        if (entry.name === entryName) {
          const entryPath = join(directory, entry.name);
          const stats = await lstat(entryPath).catch(() => null);
          if (stats && !stats.isSymbolicLink()) matches.push(directory);
          continue;
        }
        if (depth >= maxDepth || !entry.isDirectory() || entry.isSymbolicLink()) continue;
        await visit(join(directory, entry.name), depth + 1);
      }
    } catch {
      await handle?.close().catch(() => {});
    }
  }

  await visit(rootPath, 0);
  return matches;
}

export async function nearestExistingAncestor(inputPath) {
  let candidate = resolve(inputPath);
  while (!(await pathExists(candidate))) {
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
  return candidate;
}

export async function symlinkTarget(inputPath) {
  try {
    const stats = await lstat(inputPath);
    if (!stats.isSymbolicLink()) return null;
    return await readlink(inputPath);
  } catch {
    return null;
  }
}
