import * as git from 'isomorphic-git';
import type { WorkspaceFileSystem } from '../fs/index.js';

export interface GitStatusRow {
  filepath: string;
  head: number;
  workdir: number;
  stage: number;
  status: 'unmodified' | 'modified' | 'added' | 'deleted' | 'staged' | 'unknown';
}

export interface GitCommitOptions {
  message: string;
  authorName: string;
  authorEmail: string;
}

export interface GitLogEntry {
  oid: string;
  message: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
}

export interface WorkspaceGit {
  init(): Promise<void>;
  currentBranch(): Promise<string | null>;
  status(): Promise<GitStatusRow[]>;
  stageAll(): Promise<void>;
  commit(options: GitCommitOptions): Promise<string>;
  checkout(branch: string, options?: { create?: boolean }): Promise<void>;
  log(options?: { depth?: number }): Promise<GitLogEntry[]>;
  listFiles(options?: { ref?: string }): Promise<string[]>;
}

export interface CreateWorkspaceGitOptions {
  fs: WorkspaceFileSystem;
  dir: string;
}

export function createWorkspaceGit(options: CreateWorkspaceGitOptions): WorkspaceGit {
  const fsArg = { promises: options.fs.promises };
  const dir = options.dir;
  return {
    async init() {
      ensureBufferPolyfill();
      await git.init({ fs: fsArg, dir, defaultBranch: 'main' });
    },
    async currentBranch() {
      try {
        return await git.currentBranch({ fs: fsArg, dir, fullname: false });
      } catch (err) {
        if (isNoGit(err)) return null;
        throw err;
      }
    },
    async status() {
      try {
        const matrix = await git.statusMatrix({ fs: fsArg, dir });
        return matrix.map(([filepath, head, workdir, stage]) => ({
          filepath,
          head,
          workdir,
          stage,
          status: classifyStatus(head, workdir, stage),
        }));
      } catch (err) {
        if (isNoGit(err)) return [];
        throw err;
      }
    },
    async stageAll() {
      const matrix = await git.statusMatrix({ fs: fsArg, dir });
      for (const [filepath, , workdir] of matrix) {
        if (workdir === 0) await git.remove({ fs: fsArg, dir, filepath });
        else await git.add({ fs: fsArg, dir, filepath });
      }
    },
    async commit(commitOptions) {
      return git.commit({
        fs: fsArg,
        dir,
        message: commitOptions.message,
        author: { name: commitOptions.authorName, email: commitOptions.authorEmail },
      });
    },
    async checkout(branch, checkoutOptions) {
      if (checkoutOptions?.create) {
        await git.branch({ fs: fsArg, dir, ref: branch, checkout: true });
        return;
      }
      await git.checkout({
        fs: fsArg,
        dir,
        ref: branch,
        checkout: true,
        force: false,
        noCheckout: false,
      });
    },
    async log(logOptions) {
      const commits = await git.log({ fs: fsArg, dir, depth: logOptions?.depth });
      return commits.map((entry) => ({
        oid: entry.oid,
        message: entry.commit.message,
        authorName: entry.commit.author.name,
        authorEmail: entry.commit.author.email,
        timestamp: entry.commit.author.timestamp * 1000,
      }));
    },
    async listFiles(listOptions) {
      return git.listFiles({ fs: fsArg, dir, ref: listOptions?.ref });
    },
  };
}

function classifyStatus(head: number, workdir: number, stage: number): GitStatusRow['status'] {
  if (head === 1 && workdir === 1 && stage === 1) return 'unmodified';
  if (head === 0 && workdir === 2) return 'added';
  if (head === 1 && workdir === 0) return 'deleted';
  if (stage !== head) return 'staged';
  if (workdir !== head) return 'modified';
  return 'unknown';
}

function ensureBufferPolyfill(): void {
  const record = globalThis as unknown as { Buffer?: unknown };
  if (!record.Buffer && typeof Buffer !== 'undefined') record.Buffer = Buffer;
}

function isNoGit(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /not.*git|could not find|ENOENT/i.test(message);
}
