import { defineCommand } from 'just-bash';
import type { Command, ExecResult } from 'just-bash';
import type { GitStatusRow, WorkspaceGit } from '../git/index.js';

export interface CreateWorkspaceGitCommandOptions {
  git: WorkspaceGit;
  root?: string;
  authorName?: string;
  authorEmail?: string;
}

const SUPPORTED_COMMANDS =
  'supported commands: git init, git status, git add ., git commit -m "message", git log --oneline, git branch, git checkout -b name';

export function createWorkspaceGitCommand(options: CreateWorkspaceGitCommandOptions): Command {
  const authorName = options.authorName ?? 'Workspace User';
  const authorEmail = options.authorEmail ?? 'workspace@example.invalid';

  return defineCommand('git', async (args): Promise<ExecResult> => {
    try {
      const [command, ...commandArgs] = args;
      switch (command) {
        case undefined:
        case '--help':
        case 'help':
          return ok(`${SUPPORTED_COMMANDS}\n`);
        case 'init':
          if (commandArgs.length > 0) return unsupported();
          await options.git.init();
          return ok(
            `Initialized empty Git repository${options.root ? ` in ${options.root}/.git` : ''}\n`,
          );
        case 'status':
          return status(options.git, commandArgs);
        case 'add':
          return add(options.git, commandArgs);
        case 'commit':
          return commit(options.git, commandArgs, { authorName, authorEmail });
        case 'log':
          return log(options.git, commandArgs);
        case 'branch':
          return branch(options.git, commandArgs);
        case 'checkout':
          return checkout(options.git, commandArgs);
        default:
          return unsupported();
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });
}

async function status(git: WorkspaceGit, args: readonly string[]): Promise<ExecResult> {
  if (args.some((arg) => arg !== '--short' && arg !== '-s')) return unsupported();
  const branchName = await git.currentBranch();
  if (!branchName) return notInitialized();

  const rows = await git.status();
  if (args.includes('--short') || args.includes('-s')) {
    return ok(rows.length > 0 ? `${rows.map(formatShortStatus).join('\n')}\n` : '');
  }

  if (rows.length === 0) {
    return ok(`On branch ${branchName}\nnothing to commit, working tree clean\n`);
  }

  return ok(
    [
      `On branch ${branchName}`,
      'Changes:',
      ...rows.map((row) => `  ${row.status}: ${row.filepath}`),
      '',
    ].join(
      '\n',
    ),
  );
}

async function add(git: WorkspaceGit, args: readonly string[]): Promise<ExecResult> {
  if (args.length !== 1 || args[0] !== '.') return fail('only git add . is supported');
  if (!(await git.currentBranch())) return notInitialized();
  const changedFiles = await git.status();
  await git.stageAll();
  return ok(`staged ${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'}\n`);
}

async function commit(
  git: WorkspaceGit,
  args: readonly string[],
  author: { authorName: string; authorEmail: string },
): Promise<ExecResult> {
  if (!(await git.currentBranch())) return notInitialized();
  const message = parseCommitMessage(args);
  if (!message) return fail('git commit requires -m "message"');

  const oid = await git.commit({
    message,
    authorName: author.authorName,
    authorEmail: author.authorEmail,
  });
  const branchName = (await git.currentBranch()) ?? 'main';
  return ok(`[${branchName} ${oid.slice(0, 7)}] ${firstLine(message)}\n`);
}

async function log(git: WorkspaceGit, args: readonly string[]): Promise<ExecResult> {
  if (args.some((arg) => arg !== '--oneline')) return unsupported();
  if (!(await git.currentBranch())) return notInitialized();
  const entries = await git.log({ depth: 20 });
  if (entries.length === 0) return ok('');
  return ok(
    `${entries
      .map((entry) => `${entry.oid.slice(0, 7)} ${firstLine(entry.message)}`)
      .join('\n')}\n`,
  );
}

async function branch(git: WorkspaceGit, args: readonly string[]): Promise<ExecResult> {
  if (args.length > 0) return unsupported();
  const branchName = await git.currentBranch();
  if (!branchName) return notInitialized();
  return ok(`* ${branchName}\n`);
}

async function checkout(git: WorkspaceGit, args: readonly string[]): Promise<ExecResult> {
  const branchName = parseCheckoutBranch(args);
  if (!branchName) return unsupported();
  if (!(await git.currentBranch())) return notInitialized();
  await git.checkout(branchName, { create: true });
  return ok(`Switched to a new branch '${branchName}'\n`);
}

function parseCommitMessage(args: readonly string[]): string | undefined {
  if (args.length === 2 && (args[0] === '-m' || args[0] === '--message')) {
    return args[1]?.trim() || undefined;
  }
  if (args.length === 1 && args[0]?.startsWith('--message=')) {
    return args[0].slice('--message='.length).trim() || undefined;
  }
  return undefined;
}

function parseCheckoutBranch(args: readonly string[]): string | undefined {
  if (args.length === 2 && args[0] === '-b') return args[1]?.trim() || undefined;
  return undefined;
}

function formatShortStatus(row: GitStatusRow): string {
  const code = row.status === 'added' ? 'A' : row.status === 'deleted' ? 'D' : 'M';
  return `${code}  ${row.filepath}`;
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? '';
}

function ok(stdout: string): ExecResult {
  return { stdout, stderr: '', exitCode: 0 };
}

function fail(stderr: string, exitCode = 1): ExecResult {
  return { stdout: '', stderr: `${stderr}\n`, exitCode };
}

function unsupported(): ExecResult {
  return fail(SUPPORTED_COMMANDS);
}

function notInitialized(): ExecResult {
  return fail('fatal: not a git repository; run git init', 128);
}
