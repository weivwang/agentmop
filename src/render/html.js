const STATUS = Object.freeze({
  dirty: { label: 'Dirty', description: 'Uncommitted work', rank: 0 },
  live: { label: 'Live', description: 'Actively owned', rank: 1 },
  review: { label: 'Review', description: 'Human decision', rank: 2 },
  unknown: { label: 'Unknown', description: 'Proof incomplete', rank: 3 },
  safe: { label: 'Safe', description: 'Positive evidence', rank: 4 },
});

function html(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function jsonForScript(value) {
  return JSON.stringify(value ?? {})
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function normalizedStatus(value) {
  return Object.hasOwn(STATUS, value) ? value : 'unknown';
}

function deriveSummary(report, artifacts, processes) {
  const derived = {
    totalBytes: 0,
    safeBytes: 0,
    reviewBytes: 0,
    artifactCount: artifacts.length,
    processCount: processes.length,
    counts: { dirty: 0, live: 0, review: 0, unknown: 0, safe: 0 },
  };
  for (const artifact of artifacts) {
    const status = normalizedStatus(artifact?.status);
    const bytes = Math.max(0, finite(artifact?.sizeBytes));
    derived.totalBytes += bytes;
    derived.counts[status] += 1;
    if (status === 'safe' && artifact?.cleanup?.eligible) derived.safeBytes += bytes;
    if (status === 'review' || status === 'unknown') derived.reviewBytes += bytes;
  }
  const source = report?.summary ?? {};
  return {
    totalBytes: finite(source.totalBytes, derived.totalBytes),
    safeBytes: finite(source.safeBytes, derived.safeBytes),
    reviewBytes: finite(source.reviewBytes, derived.reviewBytes),
    artifactCount: finite(source.artifactCount, derived.artifactCount),
    processCount: finite(source.processCount, derived.processCount),
    counts: Object.fromEntries(Object.keys(STATUS).map((status) => [
      status,
      finite(source.counts?.[status], derived.counts[status]),
    ])),
  };
}

function metricBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return { value: '0', unit: 'B' };
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  const digits = exponent === 0 ? 0 : 1;
  return { value: value.toFixed(digits), unit: units[exponent] };
}

function compactNumber(value) {
  return new Intl.NumberFormat('en-US').format(Math.max(0, finite(value)));
}

function ageLabel(days) {
  const value = Math.max(0, Math.floor(finite(days)));
  if (value === 0) return 'Today';
  if (value === 1) return '1 day';
  if (value < 30) return `${value} days`;
  if (value < 365) {
    const months = Math.floor(value / 30);
    return `${months} mo`;
  }
  const years = Math.floor(value / 365);
  return `${years} yr`;
}

function elapsedLabel(process) {
  if (process?.elapsed) return String(process.elapsed);
  if (!Number.isFinite(process?.elapsedSeconds) || process.elapsedSeconds < 0) return '—';
  const total = Math.floor(process.elapsedSeconds);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor(total % 86_400 / 3_600);
  const minutes = Math.floor(total % 3_600 / 60);
  const seconds = total % 60;
  const clock = [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
  return days ? `${days}d ${clock}` : clock;
}

function sentenceList(items, emptyText) {
  const values = Array.isArray(items) ? items.filter((item) => item != null && String(item).trim()) : [];
  if (!values.length) return `<li class="muted">${html(emptyText)}</li>`;
  return values.map((item) => `<li>${html(item)}</li>`).join('');
}

function ownerFor(artifact) {
  return artifact?.metadata?.owner
    ?? artifact?.metadata?.resourceOwnership
    ?? artifact?.references?.[0]
    ?? artifact?.agentName
    ?? artifact?.agent
    ?? 'Ownership was not established';
}

function verdictFor(artifact) {
  const status = normalizedStatus(artifact?.status);
  if (status === 'safe' && artifact?.cleanup?.eligible) {
    return {
      heading: 'Why AgentMop marked this safe',
      text: 'Positive ownership and liveness checks passed. Cleanup still quarantines it first, so it remains recoverable.',
      tone: 'safe',
    };
  }
  if (status === 'safe') {
    return {
      heading: 'Safe signal, cleanup disabled',
      text: 'Evidence looks safe, but there is no supported cleanup strategy. AgentMop will leave it untouched.',
      tone: 'review',
    };
  }
  if (status === 'dirty') {
    return {
      heading: 'Protected: unsaved Git work',
      text: 'Dirty Git resources are never cleanup candidates, regardless of their size or age.',
      tone: 'dirty',
    };
  }
  if (status === 'live') {
    return {
      heading: 'Protected: actively owned',
      text: 'A running agent process references this resource, so cleanup is blocked.',
      tone: 'live',
    };
  }
  if (status === 'review') {
    return {
      heading: 'Review: human context required',
      text: 'This may contain resumable history or useful output. Age alone is not enough proof to clean it.',
      tone: 'review',
    };
  }
  return {
    heading: 'Unknown: proof incomplete',
    text: 'AgentMop could not prove ownership and safety, so it will not offer cleanup.',
    tone: 'unknown',
  };
}

function renderStatusFilters(summary) {
  return Object.entries(STATUS).map(([status, info]) => `
    <button class="filter-chip status-${status}" type="button" data-filter="${status}" aria-pressed="true">
      <span class="status-dot" aria-hidden="true"></span>
      ${info.label}
      <span class="chip-count">${compactNumber(summary.counts[status])}</span>
    </button>`).join('');
}

function deriveAgents(report, artifacts) {
  const agents = new Map();
  for (const source of Array.isArray(report?.agents) ? report.agents : []) {
    const id = String(source?.id ?? source?.name ?? 'unknown');
    agents.set(id, {
      id,
      name: source?.name ?? id,
      installed: source?.installed !== false,
      totalBytes: Number.isFinite(source?.totalBytes) ? source.totalBytes : null,
      artifactCount: Number.isFinite(source?.artifactCount) ? source.artifactCount : null,
    });
  }
  const derived = new Map();
  for (const artifact of artifacts) {
    const id = String(artifact?.agent ?? 'unknown');
    const current = derived.get(id) ?? { bytes: 0, count: 0, name: artifact?.agentName ?? id };
    current.bytes += Math.max(0, finite(artifact?.sizeBytes));
    current.count += 1;
    derived.set(id, current);
  }
  for (const [id, values] of derived) {
    const current = agents.get(id) ?? { id, name: values.name, installed: true };
    current.totalBytes = current.totalBytes ?? values.bytes;
    current.artifactCount = current.artifactCount ?? values.count;
    agents.set(id, current);
  }
  return [...agents.values()].sort((left, right) => finite(right.totalBytes) - finite(left.totalBytes));
}

function renderAgents(agents, totalBytes) {
  if (!agents.length) return '<div class="empty-card">No supported agent storage was detected.</div>';
  return agents.map((agent) => {
    const bytes = metricBytes(finite(agent.totalBytes));
    const percent = totalBytes > 0 ? Math.min(100, Math.max(0, finite(agent.totalBytes) / totalBytes * 100)) : 0;
    const initial = String(agent.name ?? '?').trim().slice(0, 1).toUpperCase() || '?';
    return `
      <article class="agent-card">
        <div class="agent-head">
          <span class="agent-icon" aria-hidden="true">${html(initial)}</span>
          <div><h3>${html(agent.name)}</h3><p>${agent.installed ? 'Detected locally' : 'Not currently installed'}</p></div>
          <strong>${html(bytes.value)} <small>${html(bytes.unit)}</small></strong>
        </div>
        <div class="meter" aria-label="${html(percent.toFixed(1))}% of observed storage"><span style="width:${html(percent.toFixed(2))}%"></span></div>
        <div class="agent-foot"><span>${compactNumber(agent.artifactCount)} artifact${agent.artifactCount === 1 ? '' : 's'}</span><span>${percent.toFixed(1)}% of footprint</span></div>
      </article>`;
  }).join('');
}

function renderArtifactGroups(artifacts) {
  if (!artifacts.length) {
    return `<tbody id="empty-source"><tr><td colspan="6"><div class="empty-state"><span>✓</span><strong>No agent artifacts found</strong><p>This workspace is already tidy.</p></div></td></tr></tbody>`;
  }
  return artifacts.map((artifact, index) => {
    const status = normalizedStatus(artifact?.status);
    const info = STATUS[status];
    const bytes = metricBytes(finite(artifact?.sizeBytes));
    const verdict = verdictFor(artifact);
    const path = artifact?.displayPath ?? artifact?.path ?? 'Path unavailable';
    const reasons = Array.isArray(artifact?.reasons) ? artifact.reasons : [];
    const evidence = Array.isArray(artifact?.evidence) ? artifact.evidence : [];
    const references = Array.isArray(artifact?.references) ? artifact.references : [];
    const search = [
      artifact?.id,
      artifact?.agent,
      artifact?.agentName,
      artifact?.type,
      artifact?.label,
      path,
      ownerFor(artifact),
      ...reasons,
      ...evidence,
      ...references,
    ].filter(Boolean).join(' ').toLowerCase();
    const cleanup = artifact?.cleanup?.eligible
      ? `<span class="cleanup-yes">Recoverable quarantine available</span>`
      : `<span class="cleanup-no">Cleanup blocked</span>`;
    const git = artifact?.git ? `
      <div class="detail-block">
        <h4>Git state</h4>
        <dl class="mini-grid">
          <div><dt>Branch</dt><dd>${html(artifact.git.branch ?? 'detached')}</dd></div>
          <div><dt>HEAD</dt><dd>${html(artifact.git.head ?? 'unknown')}</dd></div>
          <div><dt>Ahead / behind</dt><dd>${compactNumber(artifact.git.ahead)} / ${compactNumber(artifact.git.behind)}</dd></div>
        </dl>
      </div>` : '';
    return `
      <tbody class="artifact-group" data-index="${index}" data-status="${status}" data-risk="${info.rank}" data-size="${finite(artifact?.sizeBytes)}" data-age="${finite(artifact?.ageDays)}" data-agent="${html(String(artifact?.agentName ?? artifact?.agent ?? '').toLowerCase())}" data-search="${html(search)}">
        <tr class="artifact-row">
          <td data-label="Risk"><span class="status-pill status-${status}"><span class="status-dot" aria-hidden="true"></span>${info.label}</span></td>
          <td data-label="Resource" class="resource-cell">
            <strong>${html(artifact?.label ?? artifact?.type ?? 'Agent artifact')}</strong>
            <code title="${html(path)}">${html(path)}</code>
            <span class="resource-id">${html(artifact?.type ?? 'other')} · ${html(artifact?.id ?? `artifact-${index + 1}`)}</span>
          </td>
          <td data-label="Agent"><span class="agent-name">${html(artifact?.agentName ?? artifact?.agent ?? 'Unknown')}</span></td>
          <td data-label="Size" class="size-cell"><strong>${html(bytes.value)}</strong> ${html(bytes.unit)}<small>${compactNumber(artifact?.fileCount)} files</small></td>
          <td data-label="Last touched"><strong>${html(ageLabel(artifact?.ageDays))}</strong><small>${html(artifact?.modifiedAt ?? 'Unknown')}</small></td>
          <td data-label="Evidence" class="evidence-cell">
            <details>
              <summary><span>Inspect</span><svg aria-hidden="true" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4"/></svg></summary>
              <div class="detail-popover">
                <div class="verdict verdict-${verdict.tone}">
                  <span class="verdict-icon" aria-hidden="true">${status === 'safe' ? '✓' : status === 'live' ? '●' : '!'}</span>
                  <div><strong>${html(verdict.heading)}</strong><p>${html(verdict.text)}</p>${cleanup}</div>
                </div>
                <div class="ownership"><span>Resource owner</span><strong>${html(ownerFor(artifact))}</strong></div>
                <div class="detail-columns">
                  <div class="detail-block"><h4>Reasoning</h4><ul>${sentenceList(reasons, 'No reasons recorded.')}</ul></div>
                  <div class="detail-block"><h4>Observed evidence</h4><ul>${sentenceList(evidence, 'No evidence recorded.')}</ul></div>
                </div>
                ${git}
                ${references.length ? `<div class="detail-block"><h4>References</h4><div class="reference-list">${references.map((reference) => `<code>${html(reference)}</code>`).join('')}</div></div>` : ''}
              </div>
            </details>
          </td>
        </tr>
      </tbody>`;
  }).join('');
}

function renderProcesses(processes) {
  if (!processes.length) return '<div class="empty-card">Process inspection was skipped or no agent processes are running.</div>';
  return processes.map((process) => {
    const memory = metricBytes(finite(process?.rssBytes));
    const reasons = Array.isArray(process?.reasons) ? process.reasons.join(' · ') : '';
    return `
      <article class="process-row">
        <span class="process-live" aria-hidden="true"></span>
        <div class="process-main"><strong>${html(process?.agentName ?? process?.agent ?? 'Agent')} <small>PID ${html(process?.pid ?? '—')}</small></strong><code>${html(process?.command ?? 'Command unavailable')}</code></div>
        <div><span>Elapsed</span><strong>${html(elapsedLabel(process))}</strong></div>
        <div><span>Memory</span><strong>${html(memory.value)} ${html(memory.unit)}</strong></div>
        <div class="process-owner"><span>Ownership evidence</span><strong>${html(reasons || process?.cwd || 'Running process detected')}</strong></div>
      </article>`;
  }).join('');
}

function dateLabel(value) {
  if (!value) return 'Generation time unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return String(value);
  return date.toISOString().replace('T', ' · ').replace('.000Z', ' UTC');
}

/**
 * Render a complete, self-contained visual report. No network access is used.
 */
export function renderHtml(report, { title = 'AgentMop · Agent workspace hygiene' } = {}) {
  const safeReport = report && typeof report === 'object' ? report : {};
  const artifacts = Array.isArray(safeReport.artifacts) ? safeReport.artifacts : [];
  const processes = Array.isArray(safeReport.processes) ? safeReport.processes : [];
  const warnings = Array.isArray(safeReport.warnings) ? safeReport.warnings : [];
  const summary = deriveSummary(safeReport, artifacts, processes);
  const total = metricBytes(summary.totalBytes);
  const reclaimable = metricBytes(summary.safeBytes);
  const review = metricBytes(summary.reviewBytes);
  const agents = deriveAgents(safeReport, artifacts);
  const protectedCount = finite(summary.counts.dirty) + finite(summary.counts.live);
  const safeCount = finite(summary.counts.safe);
  const sampleBanner = safeReport.sampleData ? `
    <div class="sample-banner" role="status">
      <span>SAMPLE DATA</span>
      <strong>No files were scanned or changed.</strong>
      <p>Every path, process, size, and verdict in this demo is fictional.</p>
    </div>` : '';
  const warningBlock = warnings.length ? `
    <section class="warning-stack" aria-label="Scan notes">
      ${warnings.map((warning) => `<div><span>!</span><p>${html(warning)}</p></div>`).join('')}
    </section>` : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="description" content="A private, local-first report of storage left by AI coding agents.">
  <title>${html(title)}</title>
  <style>
    :root{--bg:#070b12;--panel:#0c121d;--panel-2:#101824;--panel-3:#151f2e;--line:#202d41;--line-hi:#30415a;--text:#f2f6fc;--muted:#8c9bb2;--faint:#617087;--green:#70f2a1;--green-2:#37d988;--cyan:#58d2ff;--yellow:#ffcd5c;--red:#ff7076;--purple:#c792ff;--shadow:0 28px 80px rgba(0,0,0,.38);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--text);background:var(--bg);font-synthesis:none}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;min-width:320px;background:radial-gradient(circle at 76% -10%,rgba(58,205,139,.12),transparent 28rem),radial-gradient(circle at 12% 8%,rgba(63,123,219,.11),transparent 24rem),var(--bg);color:var(--text);line-height:1.5}button,input,select{font:inherit}button{color:inherit}code{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace}.shell{width:min(1480px,calc(100% - 48px));margin:0 auto;padding:22px 0 60px}.topbar{display:flex;align-items:center;justify-content:space-between;min-height:62px;margin-bottom:20px}.brand{display:flex;align-items:center;gap:13px}.brand-mark{display:grid;place-items:center;width:42px;height:42px;border:1px solid #335341;border-radius:13px;background:linear-gradient(145deg,rgba(112,242,161,.16),rgba(112,242,161,.03));box-shadow:inset 0 1px rgba(255,255,255,.08)}.brand-mark svg{width:27px;height:27px}.brand-word{font-size:19px;font-weight:760;letter-spacing:-.02em}.brand-word span{color:var(--green)}.brand-sub{margin-left:4px;color:var(--faint);font:10px/1.1 "SFMono-Regular",Consolas,monospace;letter-spacing:.11em;text-transform:uppercase}.scan-meta{display:flex;align-items:center;gap:14px;color:var(--muted);font:11px/1.4 "SFMono-Regular",Consolas,monospace;text-align:right}.scan-meta strong{display:block;color:#c4cfdf;font-weight:500}.local-chip{display:flex;align-items:center;gap:7px;padding:8px 11px;border:1px solid rgba(112,242,161,.23);border-radius:999px;background:rgba(112,242,161,.06);color:var(--green);text-transform:uppercase;letter-spacing:.08em}.local-chip:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--green);box-shadow:0 0 12px var(--green)}.sample-banner{display:grid;grid-template-columns:auto auto 1fr;align-items:center;gap:11px;margin-bottom:16px;padding:10px 14px;border:1px solid rgba(255,205,92,.27);border-radius:12px;background:rgba(255,205,92,.07);color:#f7e5b3;font-size:12px}.sample-banner span{padding:3px 7px;border-radius:5px;background:var(--yellow);color:#231a06;font:700 10px/1.4 "SFMono-Regular",monospace;letter-spacing:.08em}.sample-banner strong{font-size:12px}.sample-banner p{margin:0;color:#9e9172}.hero{position:relative;overflow:hidden;display:grid;grid-template-columns:minmax(0,1.35fr) minmax(340px,.65fr);min-height:334px;border:1px solid var(--line);border-radius:24px;background:linear-gradient(135deg,rgba(20,31,46,.96),rgba(9,15,24,.98));box-shadow:var(--shadow)}.hero:before{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.018) 1px,transparent 1px);background-size:36px 36px;mask-image:linear-gradient(90deg,#000,transparent 80%);pointer-events:none}.hero-main{position:relative;padding:48px 50px}.eyebrow{display:flex;align-items:center;gap:9px;margin:0 0 16px;color:var(--green);font:700 11px/1.2 "SFMono-Regular",Consolas,monospace;letter-spacing:.14em;text-transform:uppercase}.eyebrow:before{content:"";width:24px;height:1px;background:var(--green)}.hero-number{margin:0;font-size:clamp(72px,8.5vw,126px);font-weight:780;line-height:.84;letter-spacing:-.075em}.hero-number span{margin-left:12px;color:var(--muted);font-size:.22em;font-weight:620;letter-spacing:.03em}.hero-copy{max-width:630px;margin:26px 0 0;color:#aab6c8;font-size:15px}.hero-copy strong{color:#ecf5ff}.hero-aside{position:relative;display:grid;align-content:center;gap:1px;border-left:1px solid var(--line);background:rgba(5,9,15,.32)}.metric{padding:25px 30px;border-bottom:1px solid var(--line)}.metric:last-child{border-bottom:0}.metric-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;color:var(--muted);font:700 10px/1.2 "SFMono-Regular",monospace;letter-spacing:.1em;text-transform:uppercase}.metric-head span:last-child{font-size:15px}.metric strong{font-size:30px;letter-spacing:-.04em}.metric strong small{color:var(--muted);font-size:12px;letter-spacing:.04em}.metric p{margin:3px 0 0;color:var(--faint);font-size:12px}.metric.safe .metric-head span:last-child,.metric.safe strong{color:var(--green)}.metric.review .metric-head span:last-child,.metric.review strong{color:var(--yellow)}.metric.live .metric-head span:last-child,.metric.live strong{color:var(--cyan)}.status-strip{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:14px 0 0}.status-pill,.filter-chip{display:inline-flex;align-items:center;gap:7px;border-radius:999px;white-space:nowrap}.status-pill{padding:5px 9px;border:1px solid;color:#cad4e2;font:700 10px/1.2 "SFMono-Regular",monospace;text-transform:uppercase;letter-spacing:.04em}.status-dot{width:6px;height:6px;border-radius:50%;background:currentColor;box-shadow:0 0 9px currentColor}.status-dirty{color:var(--red);border-color:rgba(255,112,118,.28);background:rgba(255,112,118,.07)}.status-live{color:var(--cyan);border-color:rgba(88,210,255,.28);background:rgba(88,210,255,.07)}.status-review{color:var(--yellow);border-color:rgba(255,205,92,.28);background:rgba(255,205,92,.07)}.status-unknown{color:var(--purple);border-color:rgba(199,146,255,.28);background:rgba(199,146,255,.07)}.status-safe{color:var(--green);border-color:rgba(112,242,161,.28);background:rgba(112,242,161,.07)}.section{margin-top:44px}.section-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:17px}.section-heading h2{margin:0;font-size:19px;letter-spacing:-.025em}.section-heading p{margin:4px 0 0;color:var(--muted);font-size:13px}.section-kicker{margin-bottom:6px;color:var(--faint);font:700 10px/1.2 "SFMono-Regular",monospace;letter-spacing:.13em;text-transform:uppercase}.agent-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.agent-card,.empty-card{border:1px solid var(--line);border-radius:16px;background:linear-gradient(145deg,var(--panel-2),var(--panel));box-shadow:0 12px 30px rgba(0,0,0,.16)}.agent-card{padding:18px}.agent-head{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px}.agent-icon{display:grid;place-items:center;width:33px;height:33px;border:1px solid #314058;border-radius:10px;background:#111c2b;color:var(--green);font:750 13px/1 monospace}.agent-head h3{overflow:hidden;margin:0;font-size:13px;text-overflow:ellipsis;white-space:nowrap}.agent-head p{margin:2px 0 0;color:var(--faint);font-size:10px}.agent-head>strong{font-size:15px;text-align:right}.agent-head small{color:var(--faint);font-size:9px}.meter{overflow:hidden;height:4px;margin:17px 0 9px;border-radius:999px;background:#1b2738}.meter span{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--green-2),var(--green));box-shadow:0 0 14px rgba(112,242,161,.35)}.agent-foot{display:flex;justify-content:space-between;color:var(--faint);font:10px/1.2 "SFMono-Regular",monospace}.empty-card{padding:30px;color:var(--muted)}.toolbar{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:12px}.search-wrap{position:relative;flex:1;min-width:240px}.search-wrap svg{position:absolute;left:13px;top:50%;width:15px;transform:translateY(-50%);fill:none;stroke:var(--faint);stroke-width:1.8}.search-wrap input{width:100%;height:40px;padding:0 54px 0 38px;border:1px solid var(--line);border-radius:11px;outline:0;background:var(--panel);color:var(--text);font-size:12px}.search-wrap input::placeholder{color:var(--faint)}.search-wrap input:focus{border-color:#426b58;box-shadow:0 0 0 3px rgba(112,242,161,.07)}.shortcut{position:absolute;right:10px;top:50%;transform:translateY(-50%);padding:2px 6px;border:1px solid var(--line);border-radius:5px;color:var(--faint);font:10px monospace}.filter-chip{height:40px;padding:0 11px;border:1px solid var(--line);background:var(--panel);font:650 10px/1.2 "SFMono-Regular",monospace;cursor:pointer}.filter-chip[aria-pressed="false"]{filter:saturate(.15);opacity:.43}.filter-chip:hover{border-color:var(--line-hi)}.chip-count{padding:2px 5px;border-radius:5px;background:rgba(255,255,255,.06);color:#acb8c9}.control{height:40px;padding:0 12px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:#c0cad8;font-size:11px;outline:0;cursor:pointer}.control:hover{border-color:var(--line-hi)}button.control{display:flex;align-items:center;gap:6px}.table-shell{overflow:visible;border:1px solid var(--line);border-radius:16px;background:var(--panel);box-shadow:0 18px 45px rgba(0,0,0,.2)}table{width:100%;border-collapse:collapse;table-layout:fixed}thead th{padding:13px 15px;border-bottom:1px solid var(--line);color:var(--faint);font:700 9px/1.2 "SFMono-Regular",monospace;text-align:left;text-transform:uppercase;letter-spacing:.11em}thead th:nth-child(1){width:104px}thead th:nth-child(2){width:34%}thead th:nth-child(3){width:130px}thead th:nth-child(4){width:105px}thead th:nth-child(5){width:130px}thead th:nth-child(6){width:100px}.artifact-group:not(:last-child) .artifact-row td{border-bottom:1px solid rgba(32,45,65,.72)}.artifact-row{transition:background .16s}.artifact-row:hover{background:rgba(255,255,255,.018)}td{padding:15px;color:#a9b5c5;font-size:12px;vertical-align:middle}.resource-cell strong{display:block;overflow:hidden;color:#e8eef7;font-size:13px;text-overflow:ellipsis;white-space:nowrap}.resource-cell code{display:block;overflow:hidden;margin-top:4px;color:#8998ad;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.resource-id{display:block;margin-top:5px;color:#536278;font:9px/1.2 "SFMono-Regular",monospace;text-transform:uppercase;letter-spacing:.05em}.agent-name{color:#c9d3df}.size-cell>strong{color:#e9eff7;font-size:15px}.size-cell small,td[data-label="Last touched"] small{display:block;overflow:hidden;margin-top:3px;color:var(--faint);font-size:9px;text-overflow:ellipsis;white-space:nowrap}td[data-label="Last touched"]>strong{color:#b8c4d3;font-size:11px}.evidence-cell{position:relative}.evidence-cell details{position:relative}.evidence-cell summary{display:flex;align-items:center;justify-content:center;gap:5px;min-height:31px;border:1px solid var(--line);border-radius:8px;background:#111a28;color:#afbccd;font:650 10px/1 monospace;list-style:none;cursor:pointer}.evidence-cell summary::-webkit-details-marker{display:none}.evidence-cell summary:hover,.evidence-cell details[open] summary{border-color:#3c536f;color:var(--text)}.evidence-cell summary svg{width:12px;fill:none;stroke:currentColor;stroke-width:1.5;transition:transform .18s}.evidence-cell details[open] summary svg{transform:rotate(180deg)}.detail-popover{position:absolute;z-index:20;top:39px;right:0;width:min(620px,70vw);padding:18px;border:1px solid var(--line-hi);border-radius:14px;background:#101823;box-shadow:0 24px 70px rgba(0,0,0,.65)}.verdict{display:flex;gap:11px;padding:13px;border:1px solid;border-radius:11px}.verdict-safe{border-color:rgba(112,242,161,.22);background:rgba(112,242,161,.06)}.verdict-dirty{border-color:rgba(255,112,118,.22);background:rgba(255,112,118,.06)}.verdict-live{border-color:rgba(88,210,255,.22);background:rgba(88,210,255,.06)}.verdict-review{border-color:rgba(255,205,92,.22);background:rgba(255,205,92,.06)}.verdict-unknown{border-color:rgba(199,146,255,.22);background:rgba(199,146,255,.06)}.verdict-icon{display:grid;place-items:center;flex:0 0 26px;height:26px;border-radius:8px;background:rgba(255,255,255,.08);font-weight:800}.verdict strong{color:#eef4fb;font-size:12px}.verdict p{margin:3px 0 6px;color:#91a0b4;font-size:11px;line-height:1.45}.cleanup-yes,.cleanup-no{font:700 9px/1.2 monospace;text-transform:uppercase;letter-spacing:.05em}.cleanup-yes{color:var(--green)}.cleanup-no{color:var(--yellow)}.ownership{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:12px 0;padding:10px 12px;border-radius:9px;background:#0b111a}.ownership span{color:var(--faint);font:700 9px monospace;text-transform:uppercase;letter-spacing:.08em}.ownership strong{color:#c9d4e2;font-size:11px;text-align:right}.detail-columns{display:grid;grid-template-columns:1fr 1fr;gap:10px}.detail-block{padding:11px;border:1px solid var(--line);border-radius:9px}.detail-block h4{margin:0 0 7px;color:#8e9db1;font:700 9px monospace;text-transform:uppercase;letter-spacing:.09em}.detail-block ul{margin:0;padding-left:16px;color:#aab6c6;font-size:10px}.detail-block li+li{margin-top:4px}.detail-block .muted{color:var(--faint)}.mini-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:0}.mini-grid div{min-width:0}.mini-grid dt{color:var(--faint);font-size:9px}.mini-grid dd{overflow:hidden;margin:3px 0 0;color:#b9c5d4;font:10px monospace;text-overflow:ellipsis;white-space:nowrap}.reference-list{display:flex;gap:5px;flex-wrap:wrap}.reference-list code{padding:4px 6px;border-radius:5px;background:#0a1019;color:#91a2b8;font-size:9px}.empty-state{display:grid;justify-items:center;gap:3px;padding:44px;color:var(--muted)}.empty-state span{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:rgba(112,242,161,.09);color:var(--green)}.empty-state strong{margin-top:6px;color:var(--text)}.empty-state p{margin:0;font-size:11px}.table-result{padding:10px 14px;border-top:1px solid var(--line);color:var(--faint);font:10px monospace}.table-result strong{color:#bbc7d6}.safety-grid{display:grid;grid-template-columns:1.25fr .75fr;gap:14px}.safety-card,.privacy-card{border:1px solid var(--line);border-radius:17px;background:var(--panel)}.safety-card{display:grid;grid-template-columns:repeat(4,1fr);padding:5px}.safety-step{position:relative;padding:21px 17px}.safety-step:not(:last-child):after{content:"";position:absolute;right:0;top:20px;bottom:20px;width:1px;background:var(--line)}.step-number{display:grid;place-items:center;width:24px;height:24px;margin-bottom:13px;border:1px solid #35465c;border-radius:8px;color:var(--green);font:700 9px monospace}.safety-step h3{margin:0;color:#d9e2ed;font-size:12px}.safety-step p{margin:6px 0 0;color:var(--faint);font-size:10px;line-height:1.55}.privacy-card{position:relative;overflow:hidden;padding:24px;background:linear-gradient(145deg,rgba(112,242,161,.08),var(--panel) 60%)}.privacy-card:after{content:"";position:absolute;right:-35px;bottom:-50px;width:150px;height:150px;border:30px solid rgba(112,242,161,.025);border-radius:50%}.privacy-icon{display:grid;place-items:center;width:36px;height:36px;border:1px solid rgba(112,242,161,.25);border-radius:11px;background:rgba(112,242,161,.07)}.privacy-icon svg{width:18px;fill:none;stroke:var(--green);stroke-width:1.5}.privacy-card h3{margin:16px 0 6px;font-size:15px}.privacy-card p{margin:0;color:var(--muted);font-size:11px;line-height:1.6}.privacy-card strong{color:#dce8e0}.process-list{overflow:hidden;border:1px solid var(--line);border-radius:16px;background:var(--panel)}.process-row{display:grid;grid-template-columns:12px minmax(230px,1.5fr) 100px 100px minmax(220px,1fr);align-items:center;gap:13px;padding:14px 17px}.process-row:not(:last-child){border-bottom:1px solid var(--line)}.process-live{width:7px;height:7px;border-radius:50%;background:var(--cyan);box-shadow:0 0 12px var(--cyan)}.process-main{min-width:0}.process-main strong{display:block;color:#dce5f0;font-size:11px;text-transform:capitalize}.process-main small{margin-left:5px;color:var(--faint);font:9px monospace}.process-main code{display:block;overflow:hidden;margin-top:3px;color:#7f8ea3;font-size:9px;text-overflow:ellipsis;white-space:nowrap}.process-row>div:not(.process-main) span{display:block;color:var(--faint);font:8px monospace;text-transform:uppercase;letter-spacing:.06em}.process-row>div:not(.process-main) strong{display:block;overflow:hidden;margin-top:3px;color:#aebaca;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.warning-stack{display:grid;gap:7px;margin-top:14px}.warning-stack>div{display:flex;align-items:flex-start;gap:9px;padding:10px 12px;border:1px solid rgba(255,205,92,.18);border-radius:9px;background:rgba(255,205,92,.04);color:#b9aa82;font-size:10px}.warning-stack span{display:grid;place-items:center;flex:0 0 18px;height:18px;border-radius:5px;background:rgba(255,205,92,.1);color:var(--yellow);font-weight:800}.warning-stack p{margin:1px 0 0}.footer{display:flex;justify-content:space-between;gap:25px;margin-top:44px;padding:22px 2px 0;border-top:1px solid var(--line);color:var(--faint);font-size:10px}.footer strong{color:#aeb9c8}.noscript{margin:12px 0;padding:10px;border:1px solid rgba(255,205,92,.2);border-radius:8px;color:var(--yellow);font-size:11px}
    [hidden]{display:none!important}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
    @media (max-width:1100px){.agent-grid{grid-template-columns:repeat(2,1fr)}.hero{grid-template-columns:1fr 320px}.hero-main{padding:43px 38px}.safety-grid{grid-template-columns:1fr}.process-row{grid-template-columns:12px minmax(220px,1fr) 90px 90px}.process-owner{display:none}thead th:nth-child(3),td[data-label="Agent"]{display:none}}
    @media (max-width:780px){.shell{width:min(100% - 24px,680px);padding-top:12px}.brand-sub,.scan-meta>div:first-child{display:none}.topbar{margin-bottom:11px}.sample-banner{grid-template-columns:auto 1fr}.sample-banner p{display:none}.hero{display:block;min-height:0}.hero-main{padding:35px 24px}.hero-number{font-size:clamp(64px,22vw,100px)}.hero-aside{grid-template-columns:repeat(3,1fr);border-top:1px solid var(--line);border-left:0}.metric{padding:18px 15px;border-right:1px solid var(--line);border-bottom:0}.metric:last-child{border-right:0}.metric strong{font-size:20px}.metric p{display:none}.section{margin-top:32px}.section-heading{display:block}.toolbar{align-items:stretch}.search-wrap{flex-basis:100%}.filter-chip{flex:1;justify-content:center;min-width:83px}.control{flex:1}.table-shell{overflow:hidden}table,tbody,tr,td{display:block;width:100%}thead{display:none}.artifact-group{padding:0 14px}.artifact-group:not(:last-child) .artifact-row td{border:0}.artifact-row{display:grid;grid-template-columns:1fr 1fr;gap:12px 16px;padding:17px 0;border-bottom:1px solid var(--line)}td{padding:0}.resource-cell{grid-column:1/-1;grid-row:1}.artifact-row td:before{content:attr(data-label);display:block;margin-bottom:4px;color:var(--faint);font:700 8px monospace;text-transform:uppercase;letter-spacing:.08em}.resource-cell:before{display:none!important}.artifact-row td[data-label="Agent"]{display:block}.evidence-cell{grid-column:1/-1}.evidence-cell summary{justify-content:space-between;padding:0 12px}.detail-popover{position:static;width:100%;margin-top:8px;box-shadow:none}.detail-columns{grid-template-columns:1fr}.table-result{margin-top:0}.safety-card{grid-template-columns:repeat(2,1fr)}.safety-step:nth-child(2):after{display:none}.safety-step:nth-child(-n+2){border-bottom:1px solid var(--line)}.process-row{grid-template-columns:10px minmax(0,1fr) 75px}.process-row>div:nth-of-type(3),.process-owner{display:none}.footer{display:block}.footer span{display:block;margin-top:6px}}
    @media (max-width:520px){.scan-meta{gap:7px}.local-chip{font-size:9px}.agent-grid{grid-template-columns:1fr}.hero-aside{display:block}.metric{display:grid;grid-template-columns:1fr auto;align-items:center;border-right:0;border-bottom:1px solid var(--line)}.metric-head{margin:0}.metric strong{font-size:22px}.status-strip{gap:5px}.safety-card{display:block}.safety-step:not(:last-child){border-bottom:1px solid var(--line)}.safety-step:after{display:none!important}.filter-chip{min-width:100px}.detail-popover{padding:12px}.ownership{display:block}.ownership strong{display:block;margin-top:4px;text-align:left}.mini-grid{grid-template-columns:1fr}.process-row{grid-template-columns:10px minmax(0,1fr)}.process-row>div:not(.process-main){display:none}}
    @media print{body{background:#fff;color:#111}.shell{width:100%;padding:0}.topbar,.toolbar,.footer{display:none}.hero,.agent-card,.table-shell,.safety-card,.privacy-card,.process-list{box-shadow:none;break-inside:avoid}.detail-popover{position:static;width:auto;box-shadow:none}.evidence-cell details:not([open]) .detail-popover{display:none}}
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand" aria-label="AgentMop">
        <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="m21 4-6.5 14" fill="none" stroke="#70f2a1" stroke-width="3.6" stroke-linecap="round"/><path d="M9 16c3-2 7-1 9 2l3 4c1 2 0 4-2 5-6 2-12 1-16-3-1-1 0-4 2-5z" fill="#70f2a1"/><path d="m6 27-2 3m7-2-1 3m7-3 1 3m5-5 3 2" stroke="#b9ff66" stroke-width="1.8" stroke-linecap="round"/></svg></span>
        <div><span class="brand-word">Agent<span>Mop</span></span><span class="brand-sub">See the mess. Keep the work.</span></div>
      </div>
      <div class="scan-meta">
        <div>${html(safeReport.hostname ?? 'Local machine')}<strong>${html(dateLabel(safeReport.generatedAt))}</strong></div>
        <span class="local-chip">Local · read only</span>
      </div>
    </header>
    ${sampleBanner}
    <main>
      <section class="hero" aria-labelledby="overview-heading">
        <div class="hero-main">
          <p class="eyebrow">Observed agent footprint</p>
          <h1 class="hero-number" id="overview-heading">${html(total.value)}<span>${html(total.unit)}</span></h1>
          <p class="hero-copy"><strong>${compactNumber(summary.artifactCount)} resources across ${compactNumber(agents.length)} coding agents.</strong> AgentMop explains what owns each byte, protects live and unfinished work, and only offers cleanup when there is positive evidence.</p>
          <div class="status-strip" aria-label="Status totals">
            ${Object.entries(STATUS).map(([status, info]) => `<span class="status-pill status-${status}"><span class="status-dot"></span>${compactNumber(summary.counts[status])} ${info.label}</span>`).join('')}
          </div>
        </div>
        <aside class="hero-aside" aria-label="Summary metrics">
          <div class="metric safe"><div class="metric-head"><span>Proven safe</span><span>↘</span></div><strong>${html(reclaimable.value)} <small>${html(reclaimable.unit)}</small></strong><p>${compactNumber(safeCount)} item${safeCount === 1 ? '' : 's'} eligible for recoverable quarantine</p></div>
          <div class="metric review"><div class="metric-head"><span>Needs review</span><span>◇</span></div><strong>${html(review.value)} <small>${html(review.unit)}</small></strong><p>History and uncertain ownership stay untouched</p></div>
          <div class="metric live"><div class="metric-head"><span>Active processes</span><span>●</span></div><strong>${compactNumber(summary.processCount)} <small>LIVE</small></strong><p>${compactNumber(protectedCount)} protected resource${protectedCount === 1 ? '' : 's'}</p></div>
        </aside>
      </section>

      <section class="section" aria-labelledby="agents-heading">
        <div class="section-heading"><div><div class="section-kicker">Ownership map</div><h2 id="agents-heading">Agent breakdown</h2><p>Storage attributed from known roots, bounded session metadata, and live process references.</p></div></div>
        <div class="agent-grid">${renderAgents(agents, summary.totalBytes)}</div>
      </section>

      <section class="section" aria-labelledby="artifacts-heading">
        <div class="section-heading"><div><div class="section-kicker">Evidence ledger</div><h2 id="artifacts-heading">Artifact inventory</h2><p>Highest-risk resources first. Open any row to see ownership and safety evidence.</p></div></div>
        <div class="toolbar" aria-label="Artifact controls">
          <label class="search-wrap"><span class="sr-only">Search artifacts</span><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg><input id="artifact-search" type="search" autocomplete="off" placeholder="Search path, agent, type, owner, or evidence…"><span class="shortcut">/</span></label>
          ${renderStatusFilters(summary)}
          <label><span class="sr-only">Sort artifacts</span><select class="control" id="artifact-sort"><option value="risk">Risk first</option><option value="size">Largest first</option><option value="age">Oldest first</option><option value="agent">Agent A–Z</option></select></label>
          <button class="control" id="expand-visible" type="button" aria-expanded="false">Expand visible</button>
          <button class="control" id="reset-filters" type="button">Reset</button>
        </div>
        <div class="table-shell">
          <table>
            <caption class="sr-only">Agent-created artifacts and their cleanup safety status</caption>
            <thead><tr><th>Risk</th><th>Resource</th><th>Agent</th><th>Size</th><th>Last touched</th><th>Evidence</th></tr></thead>
            ${renderArtifactGroups(artifacts)}
          </table>
          <div class="table-result" aria-live="polite"><strong id="visible-count">${compactNumber(artifacts.length)}</strong> of ${compactNumber(artifacts.length)} artifacts shown · no files changed</div>
        </div>
        <div id="no-results" class="empty-state" hidden><span>⌕</span><strong>No matching artifacts</strong><p>Try another search or re-enable a status.</p></div>
      </section>

      <section class="section" aria-labelledby="safety-heading">
        <div class="section-heading"><div><div class="section-kicker">Designed against regret</div><h2 id="safety-heading">Why cleanup is safe</h2><p>A large directory is never enough evidence. Every gate must pass.</p></div></div>
        <div class="safety-grid">
          <div class="safety-card">
            <article class="safety-step"><span class="step-number">01</span><h3>Identify ownership</h3><p>Match agent metadata, workspace roots, session IDs, and repository state.</p></article>
            <article class="safety-step"><span class="step-number">02</span><h3>Check liveness</h3><p>Inspect processes and references. Anything active becomes LIVE and protected.</p></article>
            <article class="safety-step"><span class="step-number">03</span><h3>Protect work</h3><p>Dirty Git state, resumable history, and uncertain resources never auto-qualify.</p></article>
            <article class="safety-step"><span class="step-number">04</span><h3>Quarantine first</h3><p>SAFE items move to a recoverable batch. Permanent purge is always separate.</p></article>
          </div>
          <aside class="privacy-card">
            <span class="privacy-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5z"/><circle cx="12" cy="15" r="1.5"/></svg></span>
            <h3>Private by construction</h3>
            <p><strong>The scan runs locally and needs no account or upload.</strong> This HTML is fully self-contained and makes no network requests. It can contain local paths and command text, so review it before sharing.</p>
          </aside>
        </div>
      </section>

      <section class="section" aria-labelledby="processes-heading">
        <div class="section-heading"><div><div class="section-kicker">Live ownership proof</div><h2 id="processes-heading">Agent processes</h2><p>These references protect active resources from cleanup.</p></div></div>
        <div class="process-list">${renderProcesses(processes)}</div>
        ${warningBlock}
      </section>
    </main>
    <footer class="footer"><strong>AgentMop · local-first agent workspace hygiene</strong><span>Generated ${html(dateLabel(safeReport.generatedAt))} · ${html(safeReport.platform ?? 'platform unknown')} · v${html(safeReport.version ?? 1)}</span></footer>
    <noscript><div class="noscript">Filtering and search require JavaScript. The complete report remains visible above.</div></noscript>
  </div>
  <script id="agentmop-data" type="application/json">${jsonForScript(safeReport)}</script>
  <script>
    (() => {
      'use strict';
      const embedded = document.getElementById('agentmop-data');
      try { JSON.parse(embedded.textContent); } catch { embedded.dataset.invalid = 'true'; }
      const groups = [...document.querySelectorAll('.artifact-group')];
      const table = document.querySelector('.table-shell table');
      const search = document.getElementById('artifact-search');
      const sort = document.getElementById('artifact-sort');
      const count = document.getElementById('visible-count');
      const noResults = document.getElementById('no-results');
      const expand = document.getElementById('expand-visible');
      const filters = [...document.querySelectorAll('[data-filter]')];
      const enabled = new Set(filters.map((button) => button.dataset.filter));

      const update = () => {
        const query = search.value.trim().toLocaleLowerCase();
        let visible = 0;
        for (const group of groups) {
          const matchesStatus = enabled.has(group.dataset.status);
          const matchesQuery = !query || group.dataset.search.includes(query);
          group.hidden = !(matchesStatus && matchesQuery);
          if (!group.hidden) visible += 1;
        }
        count.textContent = String(visible);
        noResults.hidden = visible !== 0 || groups.length === 0;
      };

      const sortRows = () => {
        const mode = sort.value;
        const ordered = [...groups].sort((left, right) => {
          if (mode === 'size') return Number(right.dataset.size) - Number(left.dataset.size);
          if (mode === 'age') return Number(right.dataset.age) - Number(left.dataset.age);
          if (mode === 'agent') return left.dataset.agent.localeCompare(right.dataset.agent);
          return Number(left.dataset.risk) - Number(right.dataset.risk) || Number(right.dataset.size) - Number(left.dataset.size);
        });
        for (const group of ordered) table.append(group);
      };

      search.addEventListener('input', update);
      sort.addEventListener('change', sortRows);
      for (const button of filters) {
        button.addEventListener('click', () => {
          const status = button.dataset.filter;
          if (enabled.has(status)) enabled.delete(status); else enabled.add(status);
          button.setAttribute('aria-pressed', String(enabled.has(status)));
          update();
        });
      }
      document.getElementById('reset-filters').addEventListener('click', () => {
        search.value = '';
        enabled.clear();
        for (const button of filters) {
          enabled.add(button.dataset.filter);
          button.setAttribute('aria-pressed', 'true');
        }
        sort.value = 'risk';
        sortRows();
        update();
      });
      expand.addEventListener('click', () => {
        const next = expand.getAttribute('aria-expanded') !== 'true';
        for (const group of groups) {
          if (!group.hidden) group.querySelector('details').open = next;
        }
        expand.setAttribute('aria-expanded', String(next));
        expand.textContent = next ? 'Collapse visible' : 'Expand visible';
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName)) {
          event.preventDefault(); search.focus();
        }
        if (event.key === 'Escape' && document.activeElement === search) {
          search.value = ''; update(); search.blur();
        }
      });
      sortRows();
      update();
    })();
  </script>
</body>
</html>`.replace(/[ \t]+$/gm, '');
}
