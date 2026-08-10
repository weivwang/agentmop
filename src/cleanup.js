import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectPath, pathBoundaryIssue } from './fs-inspect.js';
import { gitEnvironment } from './git-env.js';
import { processReferencesPath, scanProcesses } from './processes.js';

const MANIFEST_VERSION = 1;

function quarantineRoot(home = homedir()) {
  return join(home, '.agentmop', 'quarantine');
}

function batchId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

function safeName(artifact) {
  const cleanId = String(artifact.id ?? 'artifact').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'artifact';
  const cleanBase = basename(artifact.path).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 72) || 'artifact';
  return `${cleanId}-${cleanBase}`;
}

function assertInside(child, parent) {
  const resolvedChild = resolve(child);
  const resolvedParent = resolve(parent);
  if (resolvedChild === resolvedParent || !resolvedChild.startsWith(`${resolvedParent}${sep}`)) {
    throw new Error(`Refusing path outside quarantine: ${resolvedChild}`);
  }
}

function assertNarrowTarget(artifact, home) {
  const sourcePath = artifact.path ?? artifact.originalPath;
  if (!sourcePath) throw new Error('Cleanup target path is missing.');
  const target = resolve(sourcePath);
  const protectedPaths = new Set([
    resolve('/'),
    resolve(home),
    resolve(join(home, '.codex')),
    resolve(join(home, '.claude')),
    resolve(join(home, '.cursor')),
    resolve(join(home, '.config')),
    resolve(join(home, '.local')),
  ]);
  if (protectedPaths.has(target)) {
    throw new Error(`Refusing broad cleanup target: ${artifact.displayPath ?? target}`);
  }
  if (!['cache', 'temp', 'temp-copy', 'worktree'].includes(artifact.type)) {
    throw new Error(`Cleanup is not implemented for ${artifact.type}: ${artifact.displayPath ?? target}`);
  }
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function runGit(args, cwd) {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnvironment(),
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function freshEnough(artifact, report, maxAgeMs = 5 * 60_000) {
  const generated = Date.parse(report.generatedAt);
  const age = Date.now() - generated;
  return Number.isFinite(generated) && age >= 0 && age <= maxAgeMs && artifact.status === 'safe';
}

function trustedScanRoot(artifact) {
  const root = artifact.metadata?.scanRoot;
  if (!root) throw new Error(`Missing trusted scan root for ${artifact.displayPath ?? artifact.path}`);
  const resolvedRoot = resolve(root);
  if (resolvedRoot === resolve('/')) {
    throw new Error(`Refusing an unbounded scan root for ${artifact.displayPath ?? artifact.path}`);
  }
  assertInside(artifact.path, resolvedRoot);
  return resolvedRoot;
}

async function assertNoSymlinkComponents(path, boundary, label) {
  const issue = await pathBoundaryIssue(path, boundary, { includeLeaf: true });
  if (issue) throw new Error(`${label}: ${issue.message}`);
}

function assertSameSnapshot(artifact, inspection) {
  const changed = [];
  const hasIdentitySnapshot = artifact.metadata?.device !== undefined && artifact.metadata?.inode !== undefined;
  if (artifact.metadata?.device !== undefined && inspection.device !== artifact.metadata.device) changed.push('device');
  if (artifact.metadata?.inode !== undefined && inspection.inode !== artifact.metadata.inode) changed.push('inode');
  if (hasIdentitySnapshot && Number.isFinite(artifact.sizeBytes) && inspection.sizeBytes !== artifact.sizeBytes) changed.push('allocated size');
  if (hasIdentitySnapshot && Number.isFinite(artifact.fileCount) && inspection.fileCount !== artifact.fileCount) changed.push('file count');
  if (hasIdentitySnapshot && Number.isFinite(artifact.metadata?.logicalBytes) && inspection.logicalBytes !== artifact.metadata.logicalBytes) {
    changed.push('logical size');
  }
  const scannedModified = Date.parse(artifact.modifiedAt);
  if (hasIdentitySnapshot && Number.isFinite(scannedModified) && Math.abs(inspection.modifiedMs - scannedModified) > 1) changed.push('mtime');
  if (changed.length) {
    throw new Error(`Artifact changed after scan (${changed.join(', ')}): ${artifact.displayPath ?? artifact.path}`);
  }
}

function identityKind(identity) {
  if (identity.isDirectory()) return 'directory';
  if (identity.isFile()) return 'file';
  if (identity.isSymbolicLink()) return 'symlink';
  return 'other';
}

async function revalidateBeforeMutation(artifact, options = {}) {
  const root = trustedScanRoot(artifact);
  await assertNoSymlinkComponents(artifact.path, root, 'Unsafe artifact path');
  const inspection = await inspectPath(artifact.path, { boundary: root });
  if (!inspection.exists) throw new Error(`Artifact no longer exists: ${artifact.displayPath ?? artifact.path}`);
  if (inspection.kind === 'symlink' || inspection.kind === 'symlink-ancestor' || inspection.errors.length) {
    throw new Error(`Artifact path can no longer be inspected safely: ${artifact.displayPath ?? artifact.path}`);
  }
  assertSameSnapshot(artifact, inspection);

  const processScanner = options.processScanner ?? scanProcesses;
  const processes = await processScanner();
  if (processes.incompleteAgents?.size) {
    throw new Error(`Live-process evidence became incomplete during cleanup revalidation; cleanup was stopped.`);
  }
  const liveReference = processes.find((process) => processReferencesPath(process, artifact.path));
  if (liveReference) {
    throw new Error(`A live ${liveReference.agentName ?? liveReference.agent ?? 'agent'} process now references ${artifact.displayPath ?? artifact.path}`);
  }
  return { inspection, root };
}

export function planCleanup(report, options = {}) {
  const requestedIds = new Set(options.ids ?? []);
  const candidates = report.artifacts.filter((artifact) => {
    if (requestedIds.size > 0 && !requestedIds.has(artifact.id)) return false;
    return artifact.status === 'safe' && artifact.cleanup?.eligible === true;
  });

  const missingIds = [...requestedIds].filter((id) => !candidates.some((artifact) => artifact.id === id));
  const items = candidates.map((artifact) => ({
    artifact,
    strategy: artifact.cleanup.strategy ?? 'move',
    sizeBytes: artifact.sizeBytes,
  }));

  return {
    items,
    missingIds,
    totalBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
  };
}

async function plannedOperation(artifact, strategy, batchDirectory) {
  const normalizedStrategy = strategy === 'quarantine' ? 'move' : strategy;
  const itemDirectory = join(batchDirectory, 'items');
  await mkdir(itemDirectory, { recursive: true, mode: 0o700 });
  const destination = join(itemDirectory, safeName(artifact));
  assertInside(destination, batchDirectory);
  if (await exists(destination)) throw new Error(`Quarantine destination already exists: ${destination}`);
  const sourceIdentity = await lstat(artifact.path);
  const operation = {
    strategy: normalizedStrategy,
    operationState: 'planned',
    originalPath: artifact.path,
    quarantinedPath: destination,
    scanRoot: trustedScanRoot(artifact),
    device: artifact.metadata?.device ?? sourceIdentity.dev,
    inode: artifact.metadata?.inode ?? sourceIdentity.ino,
    objectKind: identityKind(sourceIdentity),
  };
  if (normalizedStrategy === 'git-worktree-move') {
    const git = artifact.git ?? {};
    operation.repository = git.mainWorktree ?? git.repositoryRoot ?? git.commonRoot;
    operation.head = git.head ?? null;
    operation.branch = git.branch && git.branch !== 'HEAD' ? git.branch : null;
    if (!operation.repository || !operation.head) {
      throw new Error(`Missing worktree recovery metadata for ${artifact.displayPath}`);
    }
  }
  return operation;
}

async function quarantineMove(artifact, operation) {
  await rename(artifact.path, operation.quarantinedPath);
  const destination = operation.quarantinedPath;
  const identity = await lstat(destination);
  return {
    ...operation,
    operationState: 'completed',
    device: identity.dev,
    inode: identity.ino,
    objectKind: identityKind(identity),
    completedAt: new Date().toISOString(),
  };
}

async function quarantineWorktree(artifact, operation) {
  const git = artifact.git ?? {};
  const repository = operation.repository;
  if (!repository) throw new Error(`Missing main worktree metadata for ${artifact.displayPath}`);

  const status = runGit(['-C', artifact.path, 'status', '--porcelain=v1', '--untracked-files=all'], repository);
  if (status) throw new Error(`Worktree became dirty after scan: ${artifact.displayPath}`);

  const currentHead = runGit(['-C', artifact.path, 'rev-parse', 'HEAD'], repository);
  if (git.head && currentHead !== git.head) {
    throw new Error(`Worktree HEAD changed after scan: ${artifact.displayPath}`);
  }

  const destination = operation.quarantinedPath;
  runGit(['worktree', 'move', '--', artifact.path, destination], repository);
  const movedHead = runGit(['-C', destination, 'rev-parse', 'HEAD'], repository);
  if (movedHead !== currentHead) throw new Error(`Worktree HEAD changed while quarantining: ${artifact.displayPath}`);
  const identity = await lstat(destination);
  return {
    ...operation,
    operationState: 'completed',
    head: currentHead,
    device: identity.dev,
    inode: identity.ino,
    objectKind: identityKind(identity),
    completedAt: new Date().toISOString(),
  };
}

export async function executeCleanup(report, options = {}) {
  const plan = planCleanup(report, options);
  if (plan.missingIds.length) {
    throw new Error(`Not safe or not found: ${plan.missingIds.join(', ')}`);
  }
  if (options.dryRun || plan.items.length === 0) return { ...plan, dryRun: true, batch: null };

  const home = resolve(report.home ?? options.home ?? homedir());
  for (const { artifact } of plan.items) {
    assertNarrowTarget(artifact, home);
    const scanRoot = trustedScanRoot(artifact);
    if (!freshEnough(artifact, report, options.maxScanAgeMs)) {
      throw new Error('Safety scan is stale. Run AgentMop again before cleaning.');
    }
    await assertNoSymlinkComponents(artifact.path, scanRoot, 'Unsafe artifact path');
  }

  const root = resolve(options.quarantineRoot ?? quarantineRoot(home));
  assertInside(root, home);
  const rootIssue = await pathBoundaryIssue(root, home, { includeLeaf: false });
  if (rootIssue) throw new Error(`Unsafe quarantine root: ${rootIssue.message}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(root, home, 'Unsafe quarantine root');
  const id = options.batchId ?? batchId();
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error('A valid quarantine batch id is required.');
  }
  const directory = join(root, id);
  assertInside(directory, root);
  if (await exists(directory)) throw new Error(`Quarantine batch already exists: ${id}`);
  await mkdir(directory, { mode: 0o700 });

  const manifest = {
    version: MANIFEST_VERSION,
    id,
    home,
    createdAt: new Date().toISOString(),
    sourceScanAt: report.generatedAt,
    state: 'in-progress',
    items: [],
    failures: [],
  };
  const manifestPath = join(directory, 'manifest.json');
  await writeJsonAtomic(manifestPath, manifest);

  for (const item of plan.items) {
    const { artifact, strategy } = item;
    let manifestItem = null;
    try {
      const operation = await plannedOperation(artifact, strategy, directory);
      manifestItem = {
        artifactId: artifact.id,
        agent: artifact.agent,
        type: artifact.type,
        label: artifact.label,
        sizeBytes: artifact.sizeBytes,
        ...operation,
      };
      manifest.items.push(manifestItem);
      await writeJsonAtomic(manifestPath, manifest);

      await revalidateBeforeMutation(artifact, options);
      let completed;
      if (strategy === 'git-worktree-move') {
        completed = await quarantineWorktree(artifact, operation);
      } else if (strategy === 'move' || strategy === 'quarantine') {
        completed = await quarantineMove(artifact, operation);
      } else {
        throw new Error(`Unsupported cleanup strategy: ${strategy}`);
      }
      await options.afterMutation?.({ artifact, operation: completed });
      Object.assign(manifestItem, completed);
    } catch (error) {
      manifest.failures.push({
        artifactId: artifact.id,
        message: error instanceof Error ? error.message : String(error),
      });
      break;
    } finally {
      await writeJsonAtomic(manifestPath, manifest);
    }
  }

  manifest.state = manifest.failures.length ? 'partial' : 'quarantined';
  manifest.completedAt = new Date().toISOString();
  await writeJsonAtomic(manifestPath, manifest);
  return { ...plan, dryRun: false, batch: manifest, directory };
}

export async function listBatches(options = {}) {
  const root = options.quarantineRoot ?? quarantineRoot(options.home);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const batches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(await readFile(join(root, entry.name, 'manifest.json'), 'utf8'));
      batches.push({
        ...manifest,
        bytes: (manifest.items ?? []).reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0),
      });
    } catch {
      batches.push({ id: entry.name, state: 'unreadable', items: [], bytes: 0 });
    }
  }
  return batches.sort((a, b) => String(b.createdAt ?? b.id).localeCompare(String(a.createdAt ?? a.id)));
}

function assertBatchId(id) {
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error('A valid quarantine batch id is required.');
  }
}

function validateManifest(manifest, id, home) {
  if (!manifest || manifest.version !== MANIFEST_VERSION || manifest.id !== id || !Array.isArray(manifest.items)) {
    throw new Error(`Quarantine manifest is invalid for batch ${id}.`);
  }
  if (!manifest.home || resolve(manifest.home) !== home) {
    throw new Error(`Quarantine manifest HOME does not match this cleanup root.`);
  }
}

async function loadBatch(id, options = {}) {
  assertBatchId(id);
  const home = resolve(options.home ?? homedir());
  const root = resolve(options.quarantineRoot ?? quarantineRoot(home));
  assertInside(root, home);
  await assertNoSymlinkComponents(root, home, 'Unsafe quarantine root');
  const directory = join(root, id);
  assertInside(directory, root);
  await assertNoSymlinkComponents(directory, root, 'Unsafe quarantine batch path');
  const manifestPath = join(directory, 'manifest.json');
  await assertNoSymlinkComponents(manifestPath, directory, 'Unsafe quarantine manifest path');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  validateManifest(manifest, id, home);
  return { home, root, directory, manifestPath, manifest };
}

function assertManifestItemShape(item) {
  if (!item || !['move', 'git-worktree-move'].includes(item.strategy)) {
    throw new Error(`Unsupported or invalid quarantine item strategy: ${item?.strategy ?? 'missing'}`);
  }
  if (!isAbsolute(item.originalPath ?? '') || !isAbsolute(item.quarantinedPath ?? '') || !isAbsolute(item.scanRoot ?? '')) {
    throw new Error(`Quarantine item paths must be absolute: ${item?.artifactId ?? 'unknown'}`);
  }
  if (item.device === undefined || item.inode === undefined || !['directory', 'file', 'other'].includes(item.objectKind)) {
    throw new Error(`Quarantine item identity is incomplete: ${item?.artifactId ?? 'unknown'}`);
  }
}

async function validateManifestItem(item, context) {
  assertManifestItemShape(item);
  const scanRoot = resolve(item.scanRoot);
  if (scanRoot === resolve('/')) throw new Error(`Quarantine item has an unbounded scan root.`);
  assertInside(item.originalPath, scanRoot);
  assertNarrowTarget(item, context.home);
  const itemRoot = join(context.directory, 'items');
  assertInside(item.quarantinedPath, itemRoot);
  await assertNoSymlinkComponents(item.quarantinedPath, context.directory, 'Unsafe quarantined item path');
  await assertNoSymlinkComponents(dirname(item.originalPath), scanRoot, 'Unsafe restore parent path');
  const identity = await lstat(item.quarantinedPath);
  if (identity.isSymbolicLink()) throw new Error(`Quarantined item became a symbolic link: ${item.quarantinedPath}`);
  if (item.device !== undefined && identity.dev !== item.device) throw new Error(`Quarantined item device changed.`);
  if (item.inode !== undefined && identity.ino !== item.inode) throw new Error(`Quarantined item identity changed.`);
  if (identityKind(identity) !== item.objectKind) throw new Error(`Quarantined item type changed.`);
}

async function validateOriginalRecovery(item, context) {
  assertManifestItemShape(item);
  const scanRoot = resolve(item.scanRoot);
  if (scanRoot === resolve('/')) throw new Error(`Quarantine item has an unbounded scan root.`);
  assertInside(item.originalPath, scanRoot);
  assertNarrowTarget(item, context.home);
  await assertNoSymlinkComponents(item.originalPath, scanRoot, 'Unsafe original item path');
  const identity = await lstat(item.originalPath);
  if (identity.isSymbolicLink()) throw new Error(`Original item became a symbolic link: ${item.originalPath}`);
  if (identity.dev !== item.device || identity.ino !== item.inode) {
    throw new Error(`Original path contains a different object; refusing recovery shortcut.`);
  }
  if (identityKind(identity) !== item.objectKind) throw new Error(`Original item type changed.`);

  if (item.strategy === 'git-worktree-move') {
    const currentHead = runGit(['-C', item.originalPath, 'rev-parse', 'HEAD'], item.originalPath);
    if (!item.head || currentHead !== item.head) throw new Error(`Original worktree HEAD no longer matches its manifest.`);
    const repository = mainWorktreeFor(item.originalPath);
    if (!item.repository || resolve(item.repository) !== repository) {
      throw new Error(`Original worktree repository no longer matches its manifest.`);
    }
  }
}

async function prepareRestoreTarget(item) {
  if (await exists(item.originalPath)) throw new Error(`Restore target already exists: ${item.originalPath}`);
  await mkdir(dirname(item.originalPath), { recursive: true });
  await assertNoSymlinkComponents(dirname(item.originalPath), item.scanRoot, 'Unsafe restore parent path');
}

async function restoreMovedItem(item) {
  await prepareRestoreTarget(item);
  await rename(item.quarantinedPath, item.originalPath);
}

function mainWorktreeFor(worktreePath) {
  const output = runGit(['-C', worktreePath, 'worktree', 'list', '--porcelain'], worktreePath);
  const first = output.split(/\r?\n/).find((line) => line.startsWith('worktree '));
  if (!first) throw new Error(`Unable to identify the main worktree for ${worktreePath}`);
  return resolve(first.slice('worktree '.length));
}

async function restoreWorktree(item) {
  await prepareRestoreTarget(item);
  const currentHead = runGit(['-C', item.quarantinedPath, 'rev-parse', 'HEAD'], item.quarantinedPath);
  if (!item.head || currentHead !== item.head) throw new Error(`Quarantined worktree HEAD no longer matches its manifest.`);
  const repository = mainWorktreeFor(item.quarantinedPath);
  if (item.repository && resolve(item.repository) !== repository) throw new Error(`Worktree repository no longer matches its manifest.`);
  runGit(['worktree', 'move', '--', item.quarantinedPath, item.originalPath], repository);
}

export async function restoreBatch(id, options = {}) {
  const context = await loadBatch(id, options);
  const { manifest, manifestPath } = context;
  if (manifest.state === 'purged') throw new Error(`Batch ${id} was permanently purged.`);

  const failures = [];
  for (const item of [...manifest.items].reverse()) {
    if (item.purgedAt || item.purgeState === 'completed') {
      failures.push({
        artifactId: item.artifactId,
        message: 'Quarantined payload was permanently purged and cannot be restored.',
      });
      continue;
    }
    if (item.purgeState === 'restored-after-uncertain-purge') {
      failures.push({
        artifactId: item.artifactId,
        message: 'Remaining data was restored after an interrupted purge, but its completeness cannot be guaranteed.',
      });
      continue;
    }
    if (item.restoredAt) continue;
    try {
      assertManifestItemShape(item);
      const originalExists = await exists(item.originalPath);
      const quarantinedExists = await exists(item.quarantinedPath);
      const purgeWasUncertain = item.purgeState === 'planned' || item.purgeState === 'uncertain';
      if (!quarantinedExists && !originalExists && purgeWasUncertain) {
        item.purgeState = 'completed';
        item.purgedAt = new Date().toISOString();
        failures.push({
          artifactId: item.artifactId,
          message: 'A planned purge removed the quarantined payload before completion was recorded; it cannot be restored.',
        });
        await writeJsonAtomic(manifestPath, manifest);
        continue;
      }
      if (!quarantinedExists && originalExists) {
        await validateOriginalRecovery(item, context);
        item.operationState = item.operationState === 'completed' ? 'restored-before-record' : 'not-moved';
        item.restoredAt = new Date().toISOString();
        if (purgeWasUncertain) {
          item.purgeState = 'restored-after-uncertain-purge';
          failures.push({
            artifactId: item.artifactId,
            message: 'Original data is present after an interrupted purge, but its completeness cannot be guaranteed.',
          });
        }
        await writeJsonAtomic(manifestPath, manifest);
        continue;
      }
      if (!quarantinedExists) throw new Error(`Both original and quarantined paths are missing.`);
      await validateManifestItem(item, context);
      if (item.strategy === 'move') await restoreMovedItem(item);
      else await restoreWorktree(item);
      if (purgeWasUncertain) {
        item.purgeState = 'restored-after-uncertain-purge';
        failures.push({
          artifactId: item.artifactId,
          message: 'Remaining data was restored after an interrupted purge, but its completeness cannot be guaranteed.',
        });
      }
      item.restoredAt = new Date().toISOString();
    } catch (error) {
      failures.push({ artifactId: item.artifactId, message: error instanceof Error ? error.message : String(error) });
    }
    await writeJsonAtomic(manifestPath, manifest);
  }
  manifest.state = failures.length ? 'restore-partial' : 'restored';
  if (failures.length) {
    manifest.restoreAttemptedAt = new Date().toISOString();
    delete manifest.restoredAt;
  } else {
    manifest.restoredAt = new Date().toISOString();
  }
  manifest.restoreFailures = failures;
  await writeJsonAtomic(manifestPath, manifest);
  return manifest;
}

export async function purgeBatch(id, options = {}) {
  const context = await loadBatch(id, options);
  const { manifest, manifestPath } = context;
  const failures = [];
  for (const item of manifest.items) {
    if (item.restoredAt || item.purgedAt) continue;
    try {
      assertManifestItemShape(item);
      const originalExists = await exists(item.originalPath);
      const quarantinedExists = await exists(item.quarantinedPath);
      if (!quarantinedExists && originalExists) {
        await validateOriginalRecovery(item, context);
        item.operationState = item.operationState === 'completed' ? 'restored-before-purge' : 'not-moved';
        item.purgeState = 'skipped-original-present';
        item.purgeSkippedAt = new Date().toISOString();
        item.restoredAt = item.restoredAt ?? new Date().toISOString();
        await writeJsonAtomic(manifestPath, manifest);
        continue;
      }
      if (!quarantinedExists && (item.purgeState === 'planned' || item.purgeState === 'uncertain')) {
        item.purgeState = 'completed';
        item.purgedAt = new Date().toISOString();
        await writeJsonAtomic(manifestPath, manifest);
        continue;
      }
      if (!quarantinedExists) throw new Error(`Both original and quarantined paths are missing.`);
      await validateManifestItem(item, context);

      let repository = null;
      if (item.strategy === 'git-worktree-move') {
        const status = runGit(
          ['-C', item.quarantinedPath, 'status', '--porcelain=v1', '--untracked-files=all'],
          item.quarantinedPath,
        );
        if (status) throw new Error(`Quarantined worktree contains new changes; refusing purge.`);
        const currentHead = runGit(['-C', item.quarantinedPath, 'rev-parse', 'HEAD'], item.quarantinedPath);
        if (!item.head || currentHead !== item.head) throw new Error(`Quarantined worktree HEAD changed; refusing purge.`);
        repository = mainWorktreeFor(item.quarantinedPath);
        if (item.repository && resolve(item.repository) !== repository) throw new Error(`Worktree repository changed; refusing purge.`);
      }

      item.purgeState = 'planned';
      item.purgePlannedAt = new Date().toISOString();
      delete item.purgeFailure;
      await writeJsonAtomic(manifestPath, manifest);

      if (item.strategy === 'git-worktree-move') {
        runGit(['worktree', 'remove', '--force', '--', item.quarantinedPath], repository);
      } else {
        const removePath = options.removePath ?? rm;
        await removePath(item.quarantinedPath, { recursive: true, force: false });
      }
      await options.afterPurgeMutation?.({ item });
      item.purgeState = 'completed';
      item.purgedAt = new Date().toISOString();
      await writeJsonAtomic(manifestPath, manifest);
    } catch (error) {
      const failure = {
        artifactId: item.artifactId,
        message: error instanceof Error ? error.message : String(error),
      };
      if (item.purgeState === 'planned') item.purgeState = 'uncertain';
      item.purgeFailure = failure.message;
      failures.push(failure);
      await writeJsonAtomic(manifestPath, manifest);
      break;
    }
  }
  manifest.state = failures.length ? 'purge-partial' : 'purged';
  manifest.purgeFailures = failures;
  if (failures.length) {
    manifest.purgeAttemptedAt = new Date().toISOString();
    delete manifest.purgedAt;
  } else {
    manifest.purgedAt = new Date().toISOString();
  }
  await writeJsonAtomic(manifestPath, manifest);
  return manifest;
}

export function confirmationToken(plan) {
  return createHash('sha256')
    .update(plan.items.map((item) => item.artifact.id).sort().join('\0'))
    .digest('hex')
    .slice(0, 6)
    .toUpperCase();
}
