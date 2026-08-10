import { execFile as execFileCallback } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gitEnvironment } from './git-env.js';

const execFile = promisify(execFileCallback);

export async function inspectGitWorktree(inputPath) {
  const requestedPath = resolve(inputPath);
  const base = {
    isRepository: false,
    isWorktree: false,
    bare: false,
    linked: false,
    topLevel: null,
    gitDir: null,
    commonDir: null,
    mainWorktree: null,
    repositoryRoot: null,
    head: null,
    branch: null,
    dirty: null,
    registered: null,
    error: null,
  };

  try {
    const inside = await git(requestedPath, ['rev-parse', '--is-inside-work-tree']);
    if (inside.trim() !== 'true') {
      const bare = await git(requestedPath, ['rev-parse', '--is-bare-repository']);
      if (bare.trim() !== 'true') return base;
      const [gitDirText, commonDirText, headText, branchText] = await Promise.all([
        git(requestedPath, ['rev-parse', '--absolute-git-dir']),
        absoluteGitPath(requestedPath, '--git-common-dir'),
        git(requestedPath, ['rev-parse', '--verify', 'HEAD']).catch(() => ''),
        git(requestedPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
      ]);
      const gitDir = resolveGitOutput(requestedPath, gitDirText);
      return {
        ...base,
        isRepository: true,
        bare: true,
        gitDir,
        commonDir: resolveGitOutput(requestedPath, commonDirText),
        repositoryRoot: gitDir,
        head: headText.trim() || null,
        branch: branchText.trim() || null,
        registered: false,
      };
    }

    const [topLevelText, gitDirText, commonDirText, headText, branchText, statusText] = await Promise.all([
      git(requestedPath, ['rev-parse', '--show-toplevel']),
      git(requestedPath, ['rev-parse', '--absolute-git-dir']),
      absoluteGitPath(requestedPath, '--git-common-dir'),
      git(requestedPath, ['rev-parse', '--verify', 'HEAD']).catch(() => ''),
      git(requestedPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
      git(requestedPath, ['status', '--porcelain=v1', '--untracked-files=normal']),
    ]);

    const topLevel = resolve(topLevelText.trim());
    const gitDir = resolveGitOutput(topLevel, gitDirText);
    const commonDir = resolveGitOutput(topLevel, commonDirText);
    const worktrees = await listGitWorktrees(topLevel);
    const canonicalTop = await canonicalPath(topLevel);
    const registered = worktrees.some((worktree) => worktree.canonicalPath === canonicalTop);
    const main = worktrees[0]?.path ?? null;
    const linked = gitDir !== commonDir;

    return {
      ...base,
      isRepository: true,
      isWorktree: true,
      linked,
      topLevel,
      gitDir,
      commonDir,
      mainWorktree: main,
      repositoryRoot: main,
      head: headText.trim() || null,
      branch: branchText.trim() || null,
      dirty: statusText.trim().length > 0,
      registered,
    };
  } catch (error) {
    if (isNotRepository(error)) return base;
    return {
      ...base,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function absoluteGitPath(cwd, key) {
  try {
    return await git(cwd, ['rev-parse', '--path-format=absolute', key]);
  } catch {
    return git(cwd, ['rev-parse', key]);
  }
}

function resolveGitOutput(topLevel, output) {
  const value = output.trim();
  return resolve(isAbsolute(value) ? value : resolve(topLevel, value));
}

async function listGitWorktrees(cwd) {
  const output = await git(cwd, ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain']);
  const records = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) records.push(current);
      current = { path: resolve(line.slice('worktree '.length)) };
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (current && line === 'detached') {
      current.detached = true;
    }
  }
  if (current) records.push(current);
  for (const record of records) record.canonicalPath = await canonicalPath(record.path);
  return records;
}

async function canonicalPath(path) {
  return realpath(path).catch(() => resolve(path));
}

async function git(cwd, args) {
  const { stdout } = await execFile('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 16 * 1024 * 1024,
    env: gitEnvironment(),
  });
  return stdout;
}

function isNotRepository(error) {
  const message = `${error?.stderr ?? ''}\n${error?.message ?? ''}`;
  return /not a git repository|not a work tree|cannot change to/i.test(message);
}

export function hasReliableWorktreeIdentity(gitInfo) {
  return Boolean(
    gitInfo?.isWorktree &&
      gitInfo.linked &&
      gitInfo.registered === true &&
      gitInfo.dirty === false &&
      gitInfo.mainWorktree &&
      gitInfo.commonDir &&
      gitInfo.head &&
      gitInfo.branch,
  );
}

export function isManagedLinkedWorktree(gitInfo) {
  if (!gitInfo?.isWorktree || !gitInfo.linked) return false;
  if (!gitInfo.gitDir || !gitInfo.commonDir) return false;
  return dirname(gitInfo.gitDir) === resolve(gitInfo.commonDir, 'worktrees');
}
