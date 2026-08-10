import { execFile as execFileCallback } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readlink } from 'node:fs/promises';
import { basename, isAbsolute, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const PROCESS_MATCHERS = [
  {
    id: 'codex',
    name: 'Codex',
    test: (tokens, command) =>
      executableTokens(tokens).some((token) => /^(codex|codex-cli)$/i.test(token)) ||
      tokens.some((token) => /(?:^|[/\\])@openai[/\\]codex(?:[/\\]|$)/i.test(token)) ||
      /[/\\]Codex\.app[/\\]/.test(command),
  },
  {
    id: 'claude',
    name: 'Claude Code',
    test: (tokens) =>
      executableTokens(tokens).some((token) => /^(claude|claude-code)$/i.test(token)) ||
      tokens.some((token) => /(?:^|[/\\])@anthropic-ai[/\\]claude-code(?:[/\\]|$)/i.test(token)),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    test: (tokens, command) =>
      executableTokens(tokens).some((token) => /^(cursor|cursor-agent)$/i.test(token)) ||
      /[/\\]Cursor\.app[/\\]/.test(command),
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    test: (tokens) => executableTokens(tokens).some((token) => /^opencode(?:-cli)?$/i.test(token)),
  },
];

export async function scanProcesses({ psOutput, cwdResolver = processCwd, agentIds } = {}) {
  const output = psOutput ?? (await readProcessTable());
  const rows = parseProcessTable(output);
  const matches = [];
  const incompleteAgents = new Set();
  const warnings = [];
  const allowedAgents = agentIds ? new Set(agentIds) : null;

  for (const row of rows) {
    const tokens = tokenizeCommand(row.rawCommand);
    const agent = PROCESS_MATCHERS.find((candidate) => candidate.test(tokens, row.rawCommand));
    if (!agent || (allowedAgents && !allowedAgents.has(agent.id))) continue;
    const cwd = await cwdResolver(row.pid);
    if (!cwd) {
      incompleteAgents.add(agent.id);
      warnings.push(`${agent.name} PID ${row.pid} working directory could not be observed; SAFE is disabled for ${agent.name}.`);
    }
    const references = uniquePaths([
      ...(cwd ? [cwd] : []),
      ...extractAbsolutePaths(tokens),
    ]);
    const detachedCandidate = row.ppid === 1 && (row.elapsedSeconds ?? 0) > 300;
    const reasons = ['Observed running process; AgentMop never stops processes'];
    if (detachedCandidate) reasons.push('PPID 1; verify before stopping');
    matches.push({
      pid: row.pid,
      ppid: row.ppid,
      elapsedSeconds: row.elapsedSeconds,
      rssBytes: row.rssBytes,
      agent: agent.id,
      agentName: agent.name,
      executable: identifyExecutable(tokens, agent.id),
      command: sanitizedCommand(tokens, agent.id),
      cwd,
      references,
      status: 'live',
      reasons,
      detachedCandidate,
      observedOnly: true,
    });
  }

  Object.defineProperties(matches, {
    incompleteAgents: { value: incompleteAgents, enumerable: false },
    warnings: { value: warnings, enumerable: false },
  });
  return matches;
}

async function readProcessTable() {
  try {
    const { stdout } = await execFile('ps', ['-axo', 'pid=,ppid=,etime=,rss=,command='], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 10_000,
    });
    return stdout;
  } catch (error) {
    const wrapped = new Error(`Unable to observe running processes: ${error.message}`);
    wrapped.code = error.code;
    throw wrapped;
  }
}

export function parseProcessTable(output) {
  const rows = [];
  for (const line of String(output).split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      elapsedSeconds: parseElapsed(match[3]),
      rssBytes: Number(match[4]) * 1024,
      rawCommand: match[5],
    });
  }
  return rows;
}

function parseElapsed(value) {
  const daySplit = value.split('-');
  const time = daySplit.pop().split(':').map(Number);
  if (time.some((item) => !Number.isFinite(item))) return null;
  let seconds = 0;
  if (time.length === 3) seconds = time[0] * 3600 + time[1] * 60 + time[2];
  else if (time.length === 2) seconds = time[0] * 60 + time[1];
  else return null;
  if (daySplit.length === 1 && /^\d+$/.test(daySplit[0])) seconds += Number(daySplit[0]) * 86_400;
  return seconds;
}

function tokenizeCommand(command) {
  const tokens = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
  for (const match of command.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}

function executableTokens(tokens) {
  if (!tokens.length) return [];
  const values = [tokens[0]];
  const first = basename(tokens[0]).toLowerCase();
  if (/^(?:node|nodejs|bun|deno)$/.test(first) && tokens[1]) values.push(tokens[1]);
  if (first === 'env' && tokens[1]) {
    values.push(tokens[1]);
    if (/^(?:node|nodejs|bun|deno)$/.test(basename(tokens[1]).toLowerCase()) && tokens[2]) {
      values.push(tokens[2]);
    }
  }
  return values.map((token) => basename(token.replace(/[),;]+$/, '')));
}

function identifyExecutable(tokens, agentId) {
  const match = executableTokens(tokens).find((token) => {
    if (agentId === 'codex') return /codex/i.test(token);
    if (agentId === 'claude') return /claude/i.test(token);
    if (agentId === 'cursor') return /cursor/i.test(token);
    return /opencode/i.test(token);
  });
  return match ?? basename(tokens[0] ?? agentId);
}

function sanitizedCommand(tokens, agentId) {
  const executable = identifyExecutable(tokens, agentId);
  return tokens.length > 1 ? `${executable} …` : executable;
}

function extractAbsolutePaths(tokens) {
  const paths = [];
  for (const token of tokens) {
    const candidates = [token, token.includes('=') ? token.slice(token.indexOf('=') + 1) : null];
    for (let value of candidates) {
      if (!value) continue;
      value = value.replace(/^["']|["',);]+$/g, '');
      if (!isAbsolute(value)) continue;
      paths.push(resolve(value));
    }
  }
  return paths;
}

export async function processCwd(pid, { platform = process.platform, lsofOutput } = {}) {
  if (platform === 'linux') {
    try {
      return resolve(await readlink(`/proc/${pid}/cwd`));
    } catch {
      return null;
    }
  }
  if (platform === 'darwin') {
    try {
      const output = lsofOutput ?? (await execFile(
        'lsof',
        ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
        {
          encoding: 'utf8',
          maxBuffer: 256 * 1024,
          timeout: 5_000,
          env: { ...process.env, LC_ALL: 'C' },
        },
      )).stdout;
      return parseLsofCwd(output);
    } catch {
      return null;
    }
  }
  return null;
}

export function parseLsofCwd(output) {
  for (const line of String(output).split(/\r?\n/)) {
    if (line.startsWith('n/') && line.length > 2) return resolve(line.slice(1));
  }
  return null;
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean).map((path) => resolve(path)))];
}

export function processReferencesPath(process, inputPath) {
  const target = resolve(inputPath);
  return (process.references ?? []).some((reference) => pathsOverlap(reference, target));
}

export function pathsOverlap(left, right) {
  const a = pathIdentity(left);
  const b = pathIdentity(right);
  return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}

function pathIdentity(inputPath) {
  const path = resolve(inputPath);
  // Process arguments and Git output can use the long spelling of a Windows
  // path while TEMP/HOME use an equivalent 8.3 spelling. Canonicalize only for
  // comparison so reports still contain the path that was actually observed.
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
