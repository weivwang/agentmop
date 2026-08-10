import { realpathSync } from 'node:fs';
import { opendir, lstat } from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { adapters } from './adapters/index.js';
import { findDirectoriesWithEntry, inspectPath, pathBoundaryIssue } from './fs-inspect.js';
import { hasReliableWorktreeIdentity, inspectGitWorktree, isManagedLinkedWorktree } from './git.js';
import {
  ARTIFACT_TYPES,
  STATUSES,
  STATUS_ORDER,
  createArtifact,
  displayPath,
  summarizeReport,
} from './model.js';
import { pathsOverlap, processReferencesPath, scanProcesses } from './processes.js';

export const SCAN_VERSION = '1';
export const DEFAULT_STALE_MS = 30 * 86_400_000;

export async function scanSystem(options = {}) {
  const home = resolve(options.home ?? homedir());
  const now = normalizeNow(options.now);
  const staleMs = normalizeStaleMs(options.staleMs);
  const includeProcesses = options.includeProcesses !== false;
  const deep = options.deep === true;
  const tmpRoots = normalizeTmpRoots(options.tmpRoots, options.includeSystemTmp !== false);
  const warnings = [];

  let processes = [];
  let processEvidenceAvailable = false;
  if (includeProcesses) {
    try {
      const processScanner = options.processScanner ?? scanProcesses;
      processes = await processScanner();
      processEvidenceAvailable = true;
      warnings.push(...(processes.warnings ?? []));
    } catch (error) {
      warnings.push(`Process inspection failed; no artifact will be marked safe: ${error.message}`);
    }
  } else {
    warnings.push('Process inspection was skipped; no artifact will be marked safe.');
  }

  const adapterResults = await Promise.all(
    adapters.map((adapter) => adapter.scan({ home, now, staleMs, deep })),
  );
  for (const result of adapterResults) warnings.push(...result.warnings.map(formatWarning));

  const sessionReferences = adapterResults.flatMap((result) => result.references);
  const worktreeDescriptors = await discoverWorktrees({
    adapterResults,
    sessionReferences,
    tmpRoots,
    deep,
    home,
  });
  const tempDescriptors = await discoverTemporaryArtifacts({
    tmpRoots,
    sessionReferences,
    worktreeDescriptors,
  });

  const discoveredDescriptors = [
    ...adapterResults.flatMap((result) => result.artifacts),
    ...worktreeDescriptors,
    ...tempDescriptors,
  ];
  const descriptors = await addTemporaryGitEvidence(discoveredDescriptors);
  const artifacts = descriptors.map((descriptor) =>
    materializeArtifact(descriptor, {
      home,
      now,
      staleMs,
      processes,
      processEvidenceAvailable:
        processEvidenceAvailable && (descriptor.evidenceAgents?.length
          ? descriptor.evidenceAgents.every((agent) => !processes.incompleteAgents?.has(agent))
          : !processes.incompleteAgents?.has(descriptor.agent)),
    }),
  );
  artifacts.sort((left, right) => {
    const status = (STATUS_ORDER[left.status] ?? 99) - (STATUS_ORDER[right.status] ?? 99);
    return status || right.sizeBytes - left.sizeBytes || left.path.localeCompare(right.path);
  });

  const agents = adapterResults.map((result) => {
    const owned = artifacts.filter((artifact) => artifact.agent === result.agent.id);
    const totalBytes = owned.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
    return {
      ...result.agent,
      totalBytes,
      sizeBytes: totalBytes,
      artifactCount: owned.length,
    };
  });

  const report = {
    version: SCAN_VERSION,
    generatedAt: new Date(now).toISOString(),
    platform: `${process.platform}-${process.arch}`,
    hostname: hostname(),
    home,
    agents,
    artifacts,
    processes,
    warnings: [...new Set(warnings)],
  };
  report.summary = summarizeReport(report);
  return report;
}

function materializeArtifact(descriptor, context) {
  const activeProcesses = context.processes.filter((process) =>
    processReferencesPath(process, descriptor.path),
  );
  const state = classifyDescriptor(descriptor, {
    ...context,
    activeProcesses,
  });
  const inspection = descriptor.inspection;
  const sessionMeta = (descriptor.references ?? []).map((reference) => ({
    id: reference.sessionId ?? undefined,
    cwd: reference.path,
    source: reference.source ?? undefined,
    parent: reference.parent ?? undefined,
  }));
  const referenceLabels = (descriptor.references ?? []).map((reference) => {
    const session = reference.sessionId ? ` session ${reference.sessionId}` : ' session metadata';
    return `${descriptor.agentName}${session} references ${displayPath(reference.path, context.home)}`;
  });
  referenceLabels.push(...activeProcesses.map((process) => `PID ${process.pid} references this path`));

  return createArtifact({
    agent: descriptor.agent,
    agentName: descriptor.agentName,
    type: descriptor.type,
    label: descriptor.label,
    path: descriptor.path,
    displayPath: displayPath(descriptor.path, context.home),
    sizeBytes: inspection.sizeBytes,
    fileCount: inspection.fileCount,
    modifiedMs: inspection.modifiedMs || context.now,
    now: context.now,
    status: state.status,
    confidence: state.confidence,
    reasons: state.reasons,
    evidence: state.evidence,
    references: referenceLabels,
    git: descriptor.git ?? null,
    cleanup: state.cleanup,
    metadata: compactObject({
      ...descriptor.metadata,
      owner: descriptor.owner,
      sessionMeta: sessionMeta.length ? sessionMeta : undefined,
      device: inspection.device ?? undefined,
      inode: inspection.inode ?? undefined,
      logicalBytes: inspection.logicalBytes,
      symlinkCount: inspection.symlinkCount,
      inspectionErrors: inspection.errors.length || undefined,
      strongAgentEvidence: descriptor.strongEvidence,
      scanRoot: descriptor.boundary,
    }),
  });
}

export function classifyDescriptor(descriptor, context) {
  const inspection = descriptor.inspection;
  const ageMs = Math.max(0, context.now - inspection.modifiedMs);
  const stale = ageMs >= context.staleMs;
  const active = context.activeProcesses.length > 0;
  const noCleanup = { eligible: false, strategy: null };
  const ageEvidence = `Last content change was ${Math.floor(ageMs / 86_400_000)} day(s) ago`;

  if (descriptor.policy === 'history') {
    const detail = inspection.kind === 'symlink'
      ? 'Symbolic link was not followed'
      : 'Session and history data may be resumable or personally valuable';
    return {
      status: STATUSES.REVIEW,
      confidence: 'high',
      reasons: [detail, 'AgentMop never automatically cleans session history'],
      evidence: [ageEvidence],
      cleanup: noCleanup,
    };
  }

  if (inspection.kind === 'symlink') {
    return {
      status: STATUSES.UNKNOWN,
      confidence: 'high',
      reasons: ['Symbolic links are never followed or cleaned'],
      evidence: ['lstat identified the candidate as a symbolic link'],
      cleanup: noCleanup,
    };
  }
  if (inspection.errors.length) {
    return {
      status: STATUSES.UNKNOWN,
      confidence: 'low',
      reasons: ['Filesystem inspection was incomplete'],
      evidence: [`${inspection.errors.length} path(s) could not be inspected`],
      cleanup: noCleanup,
    };
  }

  if (descriptor.policy === 'temp' && descriptor.git?.error) {
    return unknown('Git state in this temporary path could not be inspected', descriptor.git.error, ageEvidence);
  }
  if (descriptor.policy === 'temp' && descriptor.git?.isRepository) {
    if (descriptor.git.dirty === true) {
      return {
        status: STATUSES.DIRTY,
        confidence: 'high',
        reasons: ['Temporary path is a Git repository with modified or untracked files'],
        evidence: [`HEAD ${descriptor.git.head ?? 'unknown'}`, `Branch ${descriptor.git.branch ?? '(detached)'}`],
        cleanup: noCleanup,
      };
    }
    if (active) {
      return {
        status: STATUSES.LIVE,
        confidence: 'high',
        reasons: ['An active agent process references this temporary Git repository'],
        evidence: context.activeProcesses.map((process) => `PID ${process.pid} (${process.agentName})`),
        cleanup: noCleanup,
      };
    }
    return review(
      'Standalone Git repositories in temporary paths may contain unique commits and are never automatically cleaned',
      ageEvidence,
    );
  }

  if (descriptor.policy === 'worktree') {
    const git = descriptor.git;
    if (!git?.isWorktree || git.error) {
      return unknown('Git worktree identity could not be established', git?.error, ageEvidence);
    }
    if (git.dirty === true) {
      return {
        status: STATUSES.DIRTY,
        confidence: 'high',
        reasons: ['Git reports modified or untracked files'],
        evidence: [`HEAD ${git.head ?? 'unknown'}`, `Branch ${git.branch ?? '(detached)'}`],
        cleanup: noCleanup,
      };
    }
    if (active) {
      return {
        status: STATUSES.LIVE,
        confidence: 'high',
        reasons: ['An active agent process references this worktree'],
        evidence: context.activeProcesses.map((process) => `PID ${process.pid} (${process.agentName})`),
        cleanup: noCleanup,
      };
    }
    if (!hasReliableWorktreeIdentity(git)) {
      return unknown(
        'Linked worktree registration, branch, HEAD, or main repository evidence is incomplete',
        null,
        ageEvidence,
      );
    }
    if (!descriptor.strongEvidence) {
      return review('This linked worktree lacks a strong agent-owned path signature', ageEvidence);
    }
    if (!context.processEvidenceAvailable) {
      return review('Active process references were not checked', ageEvidence);
    }
    if (!stale) return review('Clean linked worktree is newer than the staleness threshold', ageEvidence);
    return {
      status: STATUSES.SAFE,
      confidence: 'high',
      reasons: ['Clean, registered, stale linked worktree with preserved branch and HEAD'],
      evidence: [
        `Main worktree ${git.mainWorktree}`,
        `Branch ${git.branch} at ${git.head}`,
        'Fresh process scan found no references',
        ageEvidence,
      ],
      cleanup: { eligible: true, strategy: 'git-worktree-move' },
    };
  }

  if (active) {
    return {
      status: STATUSES.LIVE,
      confidence: 'high',
      reasons: ['An active agent process references this path'],
      evidence: context.activeProcesses.map((process) => `PID ${process.pid} (${process.agentName})`),
      cleanup: noCleanup,
    };
  }
  if (!descriptor.strongEvidence) {
    return review('Agent ownership is insufficient for automatic cleanup', ageEvidence);
  }
  if (!context.processEvidenceAvailable) {
    return review('Active process references were not checked', ageEvidence);
  }
  if (!stale) return review('Candidate is newer than the staleness threshold', ageEvidence);

  return {
    status: STATUSES.SAFE,
    confidence: 'high',
    reasons: ['Known agent cache or temporary path is stale and unreferenced'],
    evidence: ['Fresh process scan found no references', ageEvidence],
    cleanup: { eligible: true, strategy: 'move' },
  };
}

async function addTemporaryGitEvidence(descriptors) {
  return Promise.all(descriptors.map(async (descriptor) => {
    if (descriptor.policy !== 'temp') return descriptor;
    if (descriptor.inspection.kind === 'symlink' || descriptor.inspection.errors.length) return descriptor;
    let git = strongerGitEvidence(descriptor.git, await inspectGitWorktree(descriptor.path));
    if (!git?.isRepository && !git?.error) {
      for (const repositoryRoot of descriptor.inspection.gitRepositoryRoots ?? []) {
        git = strongerGitEvidence(git, await inspectGitWorktree(repositoryRoot));
        if (git?.error || git?.dirty === true) break;
      }
    }
    return { ...descriptor, git };
  }));
}

function strongerGitEvidence(left, right) {
  const rank = (value) => value?.error ? 3 : value?.dirty === true ? 2 : value?.isRepository ? 1 : 0;
  return rank(right) > rank(left) ? right : left;
}

async function discoverWorktrees({ adapterResults, sessionReferences, tmpRoots, deep, home }) {
  const candidates = new Map();
  const rootOwners = [];
  for (const result of adapterResults) {
    for (const root of result.worktreeRoots) rootOwners.push({ root, agent: result.agent });
  }

  for (const owner of rootOwners) {
    const directories = await findDirectoriesWithEntry(owner.root, '.git', {
      maxDepth: deep ? 8 : 4,
      boundary: home,
    });
    for (const path of directories) {
      candidates.set(resolve(path), {
        requestedPath: path,
        agent: owner.agent,
        strongEvidence: true,
        evidenceAgents: [owner.agent.id],
        references: [],
        boundary: home,
      });
    }
  }

  const uniqueReferencePaths = new Map();
  for (const reference of sessionReferences) {
    const key = `${reference.agent}\0${reference.path}`;
    if (!uniqueReferencePaths.has(key)) uniqueReferencePaths.set(key, reference);
  }
  for (const reference of uniqueReferencePaths.values()) {
    const agent = adapterResults.find((result) => result.agent.id === reference.agent)?.agent;
    if (!agent) continue;
    const referencePath = resolve(reference.path);
    const referenceBoundary = isWithin(referencePath, home)
      ? home
      : tmpRoots.find((root) => isWithin(referencePath, root));
    if (!referenceBoundary) continue;
    if (await pathBoundaryIssue(referencePath, referenceBoundary, { includeLeaf: true })) continue;
    const git = await inspectGitWorktree(referencePath);
    if (!isManagedLinkedWorktree(git)) continue;
    const topLevel = resolve(git.topLevel);
    const existing = candidates.get(topLevel);
    const rootOwned = rootOwners.some(
      (owner) => owner.agent.id === agent.id && isWithin(topLevel, owner.root),
    );
    const tmpEvidenceRoot = tmpRoots.find((root) => {
      const child = directChild(root, topLevel);
      return child && strongAgentPathEvidence(basename(child))?.id === agent.id;
    });
    candidates.set(topLevel, {
      requestedPath: topLevel,
      agent: existing?.agent ?? agent,
      strongEvidence: existing?.strongEvidence || rootOwned || Boolean(tmpEvidenceRoot),
      evidenceAgents: [...new Set([...(existing?.evidenceAgents ?? []), reference.agent])],
      references: [...(existing?.references ?? []), reference],
      git,
      boundary: existing?.boundary ?? (rootOwned ? home : tmpEvidenceRoot ?? referenceBoundary),
    });
  }

  const descriptors = [];
  for (const candidate of candidates.values()) {
    const git = candidate.git ?? (await inspectGitWorktree(candidate.requestedPath));
    if (!isManagedLinkedWorktree(git)) continue;
    const path = resolve(git.topLevel);
    const boundary = pathIdentity(candidate.boundary);
    const inspection = await inspectPath(path, { boundary });
    descriptors.push({
      agent: candidate.agent.id,
      agentName: candidate.agent.name,
      type: ARTIFACT_TYPES.WORKTREE,
      label: git.branch ? `Linked worktree: ${git.branch}` : 'Linked Git worktree',
      path,
      policy: 'worktree',
      inspection,
      references: candidate.references,
      strongEvidence: Boolean(candidate.strongEvidence),
      evidenceAgents: candidate.evidenceAgents,
      git,
      owner: `${candidate.agent.name} managed linked worktree`,
      metadata: {},
      boundary,
    });
  }
  return dedupeByPath(descriptors);
}

async function discoverTemporaryArtifacts({ tmpRoots, sessionReferences, worktreeDescriptors }) {
  const candidates = new Map();
  const referenceGit = new Map();
  for (const root of tmpRoots) {
    for (const entry of await directEntries(root)) {
      const path = join(root, entry.name);
      const agent = strongAgentPathEvidence(entry.name);
      if (!agent) continue;
      candidates.set(resolve(path), {
        path,
        agent,
        // A user can name any directory codex-* (or similar). Keep it visible,
        // but never let a basename alone authorize cleanup.
        strongEvidence: false,
        evidenceAgents: [],
        references: [],
        boundary: root,
      });
    }
  }

  for (const reference of sessionReferences) {
    for (const root of tmpRoots) {
      const path = directChild(root, reference.path);
      if (!path) continue;
      const name = basename(path);
      const signature = strongAgentPathEvidence(name);
      const generic = /^(?:project|repo|workspace)[-_]/i.test(name);
      const agent = signature ?? agentIdentity(reference.agent);
      if (!agent) continue;
      const current = candidates.get(path);
      const referencedAgent = agentIdentity(reference.agent) ?? agent;
      if (!referenceGit.has(reference.path)) {
        referenceGit.set(reference.path, await inspectGitWorktree(reference.path));
      }
      candidates.set(path, {
        path,
        agent: current?.references?.length ? current.agent : referencedAgent,
        // An exact session reference proves association, except deliberately
        // generic project-* style names which always remain manual review.
        strongEvidence: generic ? false : current?.strongEvidence || true,
        evidenceAgents: [...new Set([...(current?.evidenceAgents ?? []), reference.agent])],
        references: [...(current?.references ?? []), reference],
        git: strongerGitEvidence(current?.git, referenceGit.get(reference.path)),
        boundary: current?.boundary ?? root,
      });
    }
  }

  const descriptors = [];
  for (const candidate of candidates.values()) {
    if (worktreeDescriptors.some((worktree) => pathsOverlap(worktree.path, candidate.path))) continue;
    const inspection = await inspectPath(candidate.path, { boundary: candidate.boundary });
    if (!inspection.exists) continue;
    descriptors.push({
      agent: candidate.agent.id,
      agentName: candidate.agent.name,
      type: ARTIFACT_TYPES.TEMP,
      label: 'Temporary agent data',
      path: resolve(candidate.path),
      policy: 'temp',
      inspection,
      references: candidate.references,
      strongEvidence: candidate.strongEvidence,
      evidenceAgents: candidate.evidenceAgents,
      git: candidate.git,
      owner: candidate.strongEvidence ? `${candidate.agent.name} temporary path` : undefined,
      metadata: {},
      boundary: candidate.boundary,
    });
  }
  return dedupeByPath(descriptors);
}

async function directEntries(root) {
  const entries = [];
  let handle;
  try {
    const stats = await lstat(root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return entries;
    handle = await opendir(root);
    for await (const entry of handle) entries.push(entry);
  } catch {
    await handle?.close().catch(() => {});
  }
  return entries;
}

function strongAgentPathEvidence(name) {
  const identities = [
    ['codex', 'Codex', /^(?:\.?codex|openai-codex)(?:[-_.]|$)/i],
    ['claude', 'Claude Code', /^(?:\.?claude|anthropic-claude)(?:[-_.]|$)/i],
    ['cursor', 'Cursor', /^\.?cursor(?:[-_.]|$)/i],
    ['opencode', 'OpenCode', /^\.?opencode(?:[-_.]|$)/i],
  ];
  const match = identities.find(([, , pattern]) => pattern.test(name));
  return match ? { id: match[0], name: match[1] } : null;
}

function agentIdentity(id) {
  const adapter = adapters.find((candidate) => candidate.id === id);
  return adapter ? { id: adapter.id, name: adapter.name } : null;
}

function directChild(root, inputPath) {
  const rootPath = resolve(root);
  const rootIdentity = pathIdentity(rootPath);
  const targetIdentity = pathIdentity(inputPath);
  if (!isWithin(targetIdentity, rootIdentity) || targetIdentity === rootIdentity) return null;
  const childName = relative(rootIdentity, targetIdentity).split(sep)[0];
  return childName ? resolve(rootPath, childName) : null;
}

function isWithin(path, parent) {
  const child = relative(pathIdentity(parent), pathIdentity(path));
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`));
}

function pathIdentity(inputPath) {
  const path = resolve(inputPath);
  // Git for Windows expands 8.3 paths (for example RUNNER~1) while Node's
  // tmpdir() can retain the short spelling. Resolve existing paths through the
  // native filesystem only for identity/boundary comparisons; artifact paths
  // and report.home keep their original, user-facing spelling.
  if (process.platform === 'win32') {
    try {
      return realpathSync.native(path);
    } catch {
      return path;
    }
  }
  if (process.platform !== 'darwin') return path;
  if (path === '/tmp' || path.startsWith('/tmp/')) return `/private${path}`;
  if (path === '/var' || path.startsWith('/var/')) return `/private${path}`;
  if (path === '/etc' || path.startsWith('/etc/')) return `/private${path}`;
  return path;
}

function normalizeNow(value) {
  if (value === undefined) return Date.now();
  const numeric = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(numeric)) throw new TypeError('scanSystem now must be a Date or epoch milliseconds');
  return numeric;
}

function normalizeStaleMs(value) {
  if (value === undefined) return DEFAULT_STALE_MS;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) throw new TypeError('scanSystem staleMs must be non-negative');
  return numeric;
}

function normalizeTmpRoots(value, includeSystemTmp = true) {
  const roots = [
    ...(includeSystemTmp ? [tmpdir()] : []),
    ...(Array.isArray(value) ? value : []),
  ];
  return [...new Set(roots.map((path) => resolve(path)))];
}

function formatWarning(warning) {
  if (typeof warning === 'string') return warning;
  return [warning.code, warning.path, warning.message].filter(Boolean).join(': ');
}

function dedupeByPath(values) {
  const seen = new Set();
  return values.filter((value) => {
    const path = resolve(value.path);
    if (seen.has(path)) return false;
    seen.add(path);
    return true;
  });
}

function review(reason, evidence) {
  return {
    status: STATUSES.REVIEW,
    confidence: 'medium',
    reasons: [reason],
    evidence: [evidence],
    cleanup: { eligible: false, strategy: null },
  };
}

function unknown(reason, detail, evidence) {
  return {
    status: STATUSES.UNKNOWN,
    confidence: 'low',
    reasons: [reason],
    evidence: [detail, evidence].filter(Boolean),
    cleanup: { eligible: false, strategy: null },
  };
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export const scannerInternals = {
  directChild,
  isWithin,
  normalizeTmpRoots,
  strongAgentPathEvidence,
};
