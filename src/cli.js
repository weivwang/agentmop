import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { scanSystem } from './scan.js';
import { createDemoReport } from './demo.js';
import { renderTerminal } from './render/terminal.js';
import { renderHtml } from './render/html.js';
import { formatBytes, parseDuration, sanitizeTerminalText } from './format.js';
import {
  confirmationToken,
  executeCleanup,
  listBatches,
  planCleanup,
  purgeBatch,
  restoreBatch,
} from './cleanup.js';

const VERSION = '0.1.0';
const DEFAULT_STALE = '30d';

function help() {
  return `
  🧹 AgentMop ${VERSION}
  Your coding agents made a mess. Mop it up safely.

  Usage
    agentmop [scan] [options]          Scan without changing anything
    agentmop demo [options]            Open a sample report
    agentmop clean --safe [options]    Quarantine proven-safe artifacts
    agentmop quarantine list           List recoverable cleanup batches
    agentmop restore <batch-id>         Restore a cleanup batch
    agentmop purge <batch-id> --yes     Permanently delete quarantined data

  Scan options
    --deep                 Inspect individual large session files
    --older-than <30d>     Staleness threshold (minutes/hours/days/weeks)
    --no-processes         Skip read-only process inspection
    --tmp-root <path>      Add an explicit temporary-directory root (repeatable)
    --json                 Print machine-readable JSON
    --html [path]          Write a self-contained visual report
    --no-open              Do not open an HTML report in the browser
    --no-color             Disable terminal colors

  Clean options
    --safe                 Required: select SAFE + cleanup-eligible items only
    --id <artifact-id>     Limit cleanup to an exact artifact id (repeatable)
    --dry-run              Show the plan without moving anything
    --yes                  Skip the interactive confirmation

  Examples
    npx agentmop
    npx agentmop scan --deep --html agentmop-report.html
    npx agentmop clean --safe --dry-run
    npx agentmop clean --safe
    npx agentmop quarantine list

  Safety model
    LIVE and DIRTY are never cleanup candidates. Sessions are REVIEW because
    deleting them can erase resumable history. SAFE requires positive evidence,
    no live reference, and a fresh scan. Cleanups are recoverable until purged.
`;
}

function parseArgs(argv) {
  const args = [...argv];
  const first = args[0];
  const command = !first || first.startsWith('-') ? 'scan' : args.shift();
  const options = {
    command,
    ids: [],
    tmpRoots: [],
    stale: DEFAULT_STALE,
    includeProcesses: true,
    open: true,
    color: true,
    home: homedir(),
  };

  while (args.length) {
    const arg = args.shift();
    const nextValue = () => {
      const value = args.shift();
      if (!value || value.startsWith('-')) throw new Error(`${arg} needs a value.`);
      return value;
    };
    switch (arg) {
      case '--deep': options.deep = true; break;
      case '--json': options.json = true; break;
      case '--safe': options.safe = true; break;
      case '--dry-run': options.dryRun = true; break;
      case '--yes': case '-y': options.yes = true; break;
      case '--no-open': options.open = false; break;
      case '--no-color': options.color = false; break;
      case '--no-processes': options.includeProcesses = false; break;
      case '--older-than': options.stale = nextValue(); break;
      case '--id': options.ids.push(nextValue()); break;
      case '--tmp-root': options.tmpRoots.push(resolve(nextValue())); break;
      case '--home': options.home = resolve(nextValue()); break;
      case '--html': {
        const candidate = args[0];
        options.html = candidate && !candidate.startsWith('-') ? resolve(args.shift()) : null;
        break;
      }
      case '--help': case '-h': options.help = true; break;
      case '--version': case '-v': options.version = true; break;
      default:
        if (!arg.startsWith('-') && ['restore', 'purge'].includes(command) && !options.batchId) {
          options.batchId = arg;
        } else if (command === 'quarantine' && arg === 'list') {
          options.action = 'list';
        } else {
          throw new Error(`Unknown argument: ${arg}`);
        }
    }
  }
  options.staleMs = parseDuration(options.stale);
  return options;
}

function openFile(path) {
  const commands = process.platform === 'darwin'
    ? ['open', [path]]
    : process.platform === 'win32'
      ? ['explorer.exe', [path]]
      : ['xdg-open', [path]];
  try {
    const child = spawn(commands[0], commands[1], { detached: true, stdio: 'ignore' });
    child.once('error', () => {});
    child.unref();
  } catch {
    // Opening is a convenience; the written report remains usable.
  }
}

async function writeReportHtml(report, requestedPath, shouldOpen) {
  const path = requestedPath ?? resolve(tmpdir(), `agentmop-${randomUUID()}.html`);
  await mkdir(dirname(path), { recursive: true });
  const existing = await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) throw new Error(`Refusing to overwrite an HTML report symlink: ${path}`);
  const temporary = `${path}.agentmop-${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(renderHtml(report), { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  process.stderr.write(`Visual report: ${sanitizeTerminalText(path)}\n`);
  if (shouldOpen) openFile(path);
  return path;
}

async function buildReport(options, demo = false) {
  if (demo) return createDemoReport();
  return scanSystem({
    home: options.home,
    staleMs: options.staleMs,
    includeProcesses: options.includeProcesses,
    deep: options.deep,
    tmpRoots: options.tmpRoots,
  });
}

async function commandScan(options, demo = false) {
  const report = await buildReport(options, demo);
  if (options.html !== undefined || demo) {
    await writeReportHtml(report, options.html, options.open);
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderTerminal(report, { color: options.color && process.stdout.isTTY })}\n`);
  }
}

function cleanupPlanText(plan) {
  const lines = [
    '',
    `Cleanup plan: ${plan.items.length} proven-safe artifact${plan.items.length === 1 ? '' : 's'}, ${formatBytes(plan.totalBytes)}`,
  ];
  for (const item of plan.items) {
    lines.push(`  ${sanitizeTerminalText(item.artifact.id)}  ${formatBytes(item.sizeBytes).padStart(9)}  ${sanitizeTerminalText(item.artifact.displayPath)}`);
  }
  if (!plan.items.length) lines.push('  Nothing is both SAFE and cleanup-eligible.');
  lines.push('');
  return lines.join('\n');
}

async function confirm(plan) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive confirmation needs a TTY. Re-run with --dry-run or --yes.');
  }
  const token = confirmationToken(plan);
  const reader = createInterface({ input, output });
  try {
    const answer = await reader.question(`Type ${token} to quarantine these items (they remain restorable): `);
    return answer.trim().toUpperCase() === token;
  } finally {
    reader.close();
  }
}

async function commandClean(options) {
  if (!options.safe) throw new Error('Clean is conservative by design. Add --safe to select proven-safe items.');
  const report = await buildReport(options);
  const plan = planCleanup(report, { ids: options.ids });
  process.stdout.write(cleanupPlanText(plan));
  if (plan.missingIds.length) throw new Error(`Not safe or not found: ${plan.missingIds.join(', ')}`);
  if (!plan.items.length) return;
  if (options.dryRun) {
    process.stdout.write('Dry run only — no files changed.\n');
    return;
  }
  if (!options.yes && !(await confirm(plan))) {
    process.stdout.write('Cancelled — no files changed.\n');
    return;
  }
  const result = await executeCleanup(report, {
    ids: options.ids,
    home: options.home,
  });
  const completed = result.batch.items.filter((item) => item.operationState === 'completed').length;
  process.stdout.write(`Quarantined ${completed} item(s) in batch ${sanitizeTerminalText(result.batch.id)}.\n`);
  if (result.batch.failures.length) {
    process.stdout.write(`Stopped after ${result.batch.failures.length} failure(s). Restore remains available.\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Restore: agentmop restore ${sanitizeTerminalText(result.batch.id)}\n`);
    process.stdout.write(`After review, reclaim space permanently: agentmop purge ${sanitizeTerminalText(result.batch.id)} --yes\n`);
  }
}

async function commandList(options) {
  const batches = await listBatches({ home: options.home });
  if (!batches.length) {
    process.stdout.write('No AgentMop quarantine batches.\n');
    return;
  }
  process.stdout.write('BATCH                                STATE             ITEMS       SIZE\n');
  for (const batch of batches) {
    process.stdout.write(`${sanitizeTerminalText(batch.id).padEnd(36)} ${sanitizeTerminalText(batch.state).padEnd(17)} ${String(batch.items?.length ?? 0).padStart(5)}  ${formatBytes(batch.bytes).padStart(9)}\n`);
  }
}

async function commandRestore(options) {
  if (!options.batchId) throw new Error('Restore needs an exact batch id.');
  const manifest = await restoreBatch(options.batchId, { home: options.home });
  process.stdout.write(`Batch ${sanitizeTerminalText(manifest.id)}: ${sanitizeTerminalText(manifest.state)}.\n`);
  if (manifest.state === 'restore-partial') process.exitCode = 1;
}

async function commandPurge(options) {
  if (!options.batchId) throw new Error('Purge needs an exact batch id.');
  if (!options.yes) throw new Error('Purge is permanent. Inspect the batch, then repeat with --yes.');
  const manifest = await purgeBatch(options.batchId, { home: options.home });
  process.stdout.write(`Batch ${sanitizeTerminalText(manifest.id)}: ${sanitizeTerminalText(manifest.state)}.\n`);
  if (manifest.state === 'purge-partial') process.exitCode = 1;
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(help());
    return;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  switch (options.command) {
    case 'scan': return commandScan(options, false);
    case 'demo': return commandScan(options, true);
    case 'clean': return commandClean(options);
    case 'quarantine':
      if (options.action !== 'list') throw new Error('Try: agentmop quarantine list');
      return commandList(options);
    case 'restore': return commandRestore(options);
    case 'purge': return commandPurge(options);
    case 'help': process.stdout.write(help()); return;
    default: throw new Error(`Unknown command: ${options.command}`);
  }
}

export const cliInternals = { parseArgs, help, cleanupPlanText };
