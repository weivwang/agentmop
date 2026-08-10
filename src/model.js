import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { relative, resolve, sep } from 'node:path';

export const STATUSES = Object.freeze({
  LIVE: 'live',
  DIRTY: 'dirty',
  SAFE: 'safe',
  REVIEW: 'review',
  UNKNOWN: 'unknown',
});

export const STATUS_ORDER = Object.freeze({
  dirty: 0,
  live: 1,
  review: 2,
  unknown: 3,
  safe: 4,
});

export const ARTIFACT_TYPES = Object.freeze({
  WORKTREE: 'worktree',
  TEMP_COPY: 'temp-copy',
  SESSION: 'session-store',
  CACHE: 'cache',
  TEMP: 'temp',
  HISTORY: 'history',
  PROCESS: 'process',
  OTHER: 'other',
});

export function artifactId(agent, type, path) {
  return createHash('sha256')
    .update(`${agent}\0${type}\0${resolve(path)}`)
    .digest('hex')
    .slice(0, 12);
}

export function displayPath(inputPath, home = homedir()) {
  const absolute = resolve(inputPath);
  const homeAbsolute = resolve(home);
  if (absolute === homeAbsolute) return '~';
  const child = relative(homeAbsolute, absolute);
  if (child && child !== '..' && !child.startsWith(`..${sep}`)) {
    return `~/${child.split(sep).join('/')}`;
  }
  return absolute;
}

export function createArtifact(input) {
  const now = input.now ?? Date.now();
  const modifiedMs = input.modifiedMs ?? now;
  const status = input.status ?? STATUSES.UNKNOWN;
  const cleanup = input.cleanup ?? { eligible: false, strategy: null };
  return {
    id: input.id ?? artifactId(input.agent, input.type, input.path),
    agent: input.agent,
    agentName: input.agentName,
    type: input.type,
    label: input.label,
    path: resolve(input.path),
    displayPath: input.displayPath ?? displayPath(input.path),
    sizeBytes: input.sizeBytes ?? 0,
    fileCount: input.fileCount ?? 0,
    modifiedAt: new Date(modifiedMs).toISOString(),
    ageDays: Math.max(0, Math.floor((now - modifiedMs) / 86_400_000)),
    status,
    confidence: input.confidence ?? (status === STATUSES.UNKNOWN ? 'low' : 'medium'),
    reasons: input.reasons ?? [],
    evidence: input.evidence ?? [],
    references: input.references ?? [],
    git: input.git ?? null,
    cleanup,
    metadata: input.metadata ?? {},
  };
}

export function summarizeReport(report) {
  const counts = Object.fromEntries(Object.values(STATUSES).map((status) => [status, 0]));
  let totalBytes = 0;
  let safeBytes = 0;
  let reviewBytes = 0;

  for (const artifact of report.artifacts) {
    counts[artifact.status] = (counts[artifact.status] ?? 0) + 1;
    totalBytes += artifact.sizeBytes;
    if (artifact.status === STATUSES.SAFE && artifact.cleanup?.eligible) safeBytes += artifact.sizeBytes;
    if (artifact.status === STATUSES.REVIEW || artifact.status === STATUSES.UNKNOWN) {
      reviewBytes += artifact.sizeBytes;
    }
  }

  return {
    totalBytes,
    safeBytes,
    reviewBytes,
    artifactCount: report.artifacts.length,
    processCount: report.processes.length,
    counts,
  };
}
