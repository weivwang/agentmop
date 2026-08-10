import { formatAge, formatBytes, formatCount, sanitizeTerminalText, truncateMiddle } from '../format.js';

const RISK_ORDER = Object.freeze({ dirty: 0, live: 1, review: 2, unknown: 3, safe: 4 });
const STATUS_LABELS = Object.freeze({
  dirty: 'DIRTY',
  live: 'LIVE',
  review: 'REVIEW',
  unknown: 'UNKNOWN',
  safe: 'SAFE',
});
const ANSI = Object.freeze({
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  green: '\u001b[38;2;112;242;161m',
  cyan: '\u001b[38;2;88;210;255m',
  yellow: '\u001b[38;2;255;205;92m',
  red: '\u001b[38;2;255;112;118m',
  magenta: '\u001b[38;2;199;146;255m',
  white: '\u001b[38;2;238;244;255m',
});

function colorize(enabled, code, text) {
  return enabled ? `${code}${text}${ANSI.reset}` : text;
}

function statusColor(status) {
  return {
    dirty: ANSI.red,
    live: ANSI.cyan,
    review: ANSI.yellow,
    unknown: ANSI.magenta,
    safe: ANSI.green,
  }[status] ?? ANSI.white;
}

function statusLabel(status) {
  return STATUS_LABELS[status] ?? sanitizeTerminalText(status || 'unknown').toUpperCase();
}

function detailedBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  const digits = exponent === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[exponent]}`;
}

function deriveSummary(report) {
  const artifacts = Array.isArray(report?.artifacts) ? report.artifacts : [];
  const processes = Array.isArray(report?.processes) ? report.processes : [];
  const counts = { live: 0, dirty: 0, safe: 0, review: 0, unknown: 0 };
  let totalBytes = 0;
  let safeBytes = 0;
  let reviewBytes = 0;
  for (const artifact of artifacts) {
    const status = STATUS_LABELS[artifact?.status] ? artifact.status : 'unknown';
    counts[status] += 1;
    const bytes = Number.isFinite(artifact?.sizeBytes) ? Math.max(0, artifact.sizeBytes) : 0;
    totalBytes += bytes;
    if (status === 'safe' && artifact.cleanup?.eligible) safeBytes += bytes;
    if (status === 'review' || status === 'unknown') reviewBytes += bytes;
  }
  const source = report?.summary ?? {};
  return {
    totalBytes: Number.isFinite(source.totalBytes) ? source.totalBytes : totalBytes,
    safeBytes: Number.isFinite(source.safeBytes) ? source.safeBytes : safeBytes,
    reviewBytes: Number.isFinite(source.reviewBytes) ? source.reviewBytes : reviewBytes,
    artifactCount: Number.isFinite(source.artifactCount) ? source.artifactCount : artifacts.length,
    processCount: Number.isFinite(source.processCount) ? source.processCount : processes.length,
    counts: Object.fromEntries(Object.keys(counts).map((status) => [
      status,
      Number.isFinite(source.counts?.[status]) ? source.counts[status] : counts[status],
    ])),
  };
}

function fit(value, width, align = 'left') {
  const text = truncateMiddle(sanitizeTerminalText(value ?? '—'), Math.max(1, width));
  return align === 'right' ? text.padStart(width) : text.padEnd(width);
}

function repeat(character, count) {
  return character.repeat(Math.max(0, count));
}

function ownerFor(artifact) {
  return artifact?.metadata?.owner
    ?? artifact?.metadata?.resourceOwnership
    ?? artifact?.references?.[0]
    ?? artifact?.agentName
    ?? artifact?.agent
    ?? 'ownership not established';
}

function safeEvidence(artifact) {
  if (artifact?.status === 'safe' && artifact?.cleanup?.eligible) {
    return artifact.evidence?.[0] ?? artifact.reasons?.[0] ?? 'positive safety evidence recorded';
  }
  if (artifact?.status === 'dirty') return 'protected: working tree contains changes';
  if (artifact?.status === 'live') return 'protected: an active agent process owns it';
  if (artifact?.status === 'review') return 'manual review: may hold resumable work';
  return artifact?.reasons?.[0] ?? 'not eligible until ownership and safety are proven';
}

function artifactRows(artifacts, width, color) {
  if (!artifacts.length) return ['  No agent artifacts found. Your workspace is already tidy.'];
  const sorted = [...artifacts].sort((left, right) => {
    const risk = (RISK_ORDER[left?.status] ?? 3) - (RISK_ORDER[right?.status] ?? 3);
    return risk || (right?.sizeBytes ?? 0) - (left?.sizeBytes ?? 0);
  });
  const lines = [];

  if (width < 92) {
    const locationWidth = Math.max(25, width - 22);
    lines.push(`  ${fit('RISK', 10)} ${fit('SIZE', 9, 'right')}  LOCATION`);
    lines.push(`  ${repeat('─', Math.max(30, width - 4))}`);
    for (const artifact of sorted) {
      const chip = fit(`[${statusLabel(artifact.status)}]`, 10);
      lines.push(`  ${colorize(color, statusColor(artifact.status), chip)} ${fit(formatBytes(artifact.sizeBytes), 9, 'right')}  ${fit(artifact.displayPath ?? artifact.path, locationWidth)}`);
      lines.push(`    ${sanitizeTerminalText(artifact.agentName ?? artifact.agent ?? 'Unknown')} · ${sanitizeTerminalText(artifact.type ?? 'artifact')} · ${formatAge(artifact.ageDays ?? 0)} · ${sanitizeTerminalText(safeEvidence(artifact))}`);
    }
    return lines;
  }

  const statusWidth = 10;
  const agentWidth = width >= 118 ? 14 : 11;
  const typeWidth = width >= 118 ? 15 : 12;
  const sizeWidth = 9;
  const ageWidth = 9;
  const fixed = 2 + statusWidth + 1 + agentWidth + 1 + typeWidth + 1 + sizeWidth + 1 + ageWidth + 2;
  const locationWidth = Math.max(24, width - fixed);
  lines.push(`  ${fit('RISK', statusWidth)} ${fit('AGENT', agentWidth)} ${fit('RESOURCE', typeWidth)} ${fit('SIZE', sizeWidth, 'right')} ${fit('AGE', ageWidth)}  ${fit('LOCATION', locationWidth)}`);
  lines.push(`  ${repeat('─', width - 4)}`);
  for (const artifact of sorted) {
    const chip = fit(`[${statusLabel(artifact.status)}]`, statusWidth);
    lines.push(`  ${colorize(color, statusColor(artifact.status), chip)} ${fit(artifact.agentName ?? artifact.agent, agentWidth)} ${fit(artifact.type, typeWidth)} ${fit(formatBytes(artifact.sizeBytes), sizeWidth, 'right')} ${fit(formatAge(artifact.ageDays ?? 0), ageWidth)}  ${fit(artifact.displayPath ?? artifact.path, locationWidth)}`);
    const evidence = sanitizeTerminalText(`${ownerFor(artifact)} · ${safeEvidence(artifact)}`);
    lines.push(colorize(color, ANSI.dim, `    ↳ ${truncateMiddle(evidence, Math.max(28, width - 8))}`));
  }
  return lines;
}

function agentBreakdown(report, totalBytes, width) {
  const artifacts = Array.isArray(report?.artifacts) ? report.artifacts : [];
  const supplied = Array.isArray(report?.agents) ? report.agents : [];
  const byAgent = new Map();
  for (const agent of supplied) {
    const hasTotal = Number.isFinite(agent.totalBytes);
    const hasCount = Number.isFinite(agent.artifactCount);
    byAgent.set(agent.id, {
      id: agent.id,
      name: agent.name ?? agent.id,
      totalBytes: hasTotal ? agent.totalBytes : 0,
      artifactCount: hasCount ? agent.artifactCount : 0,
      hasTotal,
      hasCount,
    });
  }
  for (const artifact of artifacts) {
    const id = artifact.agent ?? 'unknown';
    const current = byAgent.get(id) ?? { id, name: artifact.agentName ?? id, totalBytes: 0, artifactCount: 0 };
    if (!current.hasTotal) current.totalBytes += Number.isFinite(artifact.sizeBytes) ? artifact.sizeBytes : 0;
    if (!current.hasCount) current.artifactCount += 1;
    byAgent.set(id, current);
  }
  const agents = [...byAgent.values()].sort((a, b) => b.totalBytes - a.totalBytes);
  if (!agents.length) return ['  No supported agent storage found.'];
  const nameWidth = Math.min(18, Math.max(10, ...agents.map((agent) => String(agent.name).length)));
  const barWidth = Math.max(8, Math.min(28, width - nameWidth - 35));
  return agents.map((agent) => {
    const ratio = totalBytes > 0 ? agent.totalBytes / totalBytes : 0;
    const filled = Math.max(agent.totalBytes > 0 ? 1 : 0, Math.round(ratio * barWidth));
    const bar = `${repeat('█', filled)}${repeat('░', barWidth - filled)}`;
    return `  ${fit(agent.name, nameWidth)}  ${bar}  ${fit(detailedBytes(agent.totalBytes), 10, 'right')}  ${formatCount(agent.artifactCount)} item${agent.artifactCount === 1 ? '' : 's'}`;
  });
}

/**
 * Render a report as a compact, dependency-free terminal dashboard.
 */
export function renderTerminal(report, { color = false, width = 108 } = {}) {
  const safeWidth = Math.max(64, Math.min(140, Number.isFinite(width) ? Math.floor(width) : 108));
  const artifacts = Array.isArray(report?.artifacts) ? report.artifacts : [];
  const warnings = Array.isArray(report?.warnings) ? report.warnings : [];
  const summary = deriveSummary(report ?? {});
  const generated = report?.generatedAt ? new Date(report.generatedAt) : null;
  const generatedLabel = generated && !Number.isNaN(generated.valueOf())
    ? generated.toISOString().replace('.000Z', 'Z')
    : 'time unavailable';
  const line = repeat('─', safeWidth - 2);
  const lines = [
    colorize(color, ANSI.green, `╭${line}╮`),
    `${colorize(color, ANSI.green + ANSI.bold, '  AGENTMOP')}  ${colorize(color, ANSI.white, 'Agent workspace hygiene report')}`,
    colorize(color, ANSI.dim, `  See the mess. Keep the work. · ${generatedLabel}`),
  ];

  if (report?.sampleData) {
    lines.push(colorize(color, ANSI.yellow + ANSI.bold, `  ◆ SAMPLE DATA — no files were scanned or changed`));
  }
  lines.push(colorize(color, ANSI.green, `╰${line}╯`));
  lines.push('');
  lines.push(colorize(color, ANSI.bold, 'OVERVIEW'));
  lines.push(`  ${colorize(color, ANSI.white + ANSI.bold, detailedBytes(summary.totalBytes))} observed  ·  ${colorize(color, ANSI.green + ANSI.bold, detailedBytes(summary.safeBytes))} proven safe  ·  ${colorize(color, ANSI.yellow + ANSI.bold, detailedBytes(summary.reviewBytes))} needs review`);
  lines.push(`  ${formatCount(summary.artifactCount)} artifacts  ·  ${formatCount(summary.processCount)} live agent processes  ·  read-only scan`);
  lines.push('');
  lines.push(colorize(color, ANSI.bold, 'STATUS LEGEND'));
  lines.push(`  ${colorize(color, ANSI.red, '[DIRTY]')} uncommitted work    ${colorize(color, ANSI.cyan, '[LIVE]')} actively owned    ${colorize(color, ANSI.yellow, '[REVIEW]')} decide manually`);
  lines.push(`  ${colorize(color, ANSI.magenta, '[UNKNOWN]')} proof incomplete    ${colorize(color, ANSI.green, '[SAFE]')} positive evidence; eligible for quarantine`);
  lines.push('');
  lines.push(colorize(color, ANSI.bold, 'AGENT BREAKDOWN'));
  lines.push(...agentBreakdown(report ?? {}, summary.totalBytes, safeWidth));
  lines.push('');
  lines.push(colorize(color, ANSI.bold, 'ARTIFACTS · HIGHEST RISK FIRST'));
  lines.push(...artifactRows(artifacts, safeWidth, color));

  if (warnings.length) {
    lines.push('');
    lines.push(colorize(color, ANSI.yellow + ANSI.bold, 'NOTES'));
    for (const warning of warnings) lines.push(`  ! ${sanitizeTerminalText(warning)}`);
  }

  lines.push('');
  lines.push(colorize(color, ANSI.bold, 'NEXT STEPS'));
  lines.push(`  Preview only     ${colorize(color, ANSI.cyan, 'agentmop clean --safe --dry-run')}`);
  lines.push(`  Quarantine safe  ${colorize(color, ANSI.green, 'agentmop clean --safe')}`);
  lines.push(`  Visual report    ${colorize(color, ANSI.cyan, 'agentmop scan --html agentmop-report.html')}`);
  lines.push('');
  lines.push(colorize(color, ANSI.dim, '  Privacy: local-only analysis. Reports may contain paths and commands; review before sharing.'));
  lines.push(colorize(color, ANSI.dim, `  Safety: LIVE and DIRTY are protected. Cleanup moves SAFE items to a recoverable quarantine.`));
  return lines.join('\n');
}
