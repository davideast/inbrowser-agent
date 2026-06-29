import type { WorkspaceFileSystem } from '../fs/index.js';
import { dirname } from '../fs/path.js';

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

interface GitStageFile {
  filepath: string;
  oid: string;
}

interface GitStageRecord {
  files: GitStageFile[];
  timestamp: number;
}

interface GitCommitRecord extends GitLogEntry {
  tree: string;
  parent: string[];
  files: GitStageFile[];
}

interface PendingTreeNode {
  files: Array<{ name: string; oid: string }>;
  directories: Map<string, PendingTreeNode>;
}

interface GitTreeEntry {
  mode: '040000' | '100644';
  path: string;
  oid: string;
  type: 'blob' | 'tree';
}

interface GitSignature {
  name: string;
  email: string;
  timestamp: number;
  timezoneOffset: number;
}

interface GitCommitObject {
  message: string;
  tree: string;
  parent: string[];
  author: GitSignature;
  committer: GitSignature;
}

export function createWorkspaceGit(options: CreateWorkspaceGitOptions): WorkspaceGit {
  const workspaceFs = options.fs.promises;
  const dir = options.dir;
  const gitdir = `${dir}/.git`;
  const metadataDir = `${gitdir}/inbrowser`;
  const stagePath = `${metadataDir}/stage.json`;
  const commitsPath = `${metadataDir}/commits.json`;

  async function pathExists(path: string): Promise<boolean> {
    try {
      await workspaceFs.stat(path);
      return true;
    } catch (err) {
      if (isNoGit(err)) return false;
      throw err;
    }
  }

  async function hasGitDir(): Promise<boolean> {
    try {
      const stats = await workspaceFs.stat(gitdir);
      return stats.isDirectory();
    } catch (err) {
      if (isNoGit(err)) return false;
      throw err;
    }
  }

  async function hasInitializedRepo(): Promise<boolean> {
    return (
      (await hasGitDir()) &&
      (await pathExists(`${gitdir}/config`)) &&
      (await pathExists(`${gitdir}/HEAD`))
    );
  }

  async function listWorkdirFiles(): Promise<string[]> {
    const files: string[] = [];

    async function visit(path: string): Promise<void> {
      const entries = await workspaceFs.readdir(path, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.path === gitdir || entry.path.startsWith(`${gitdir}/`)) continue;
        if (entry.isDirectory()) await visit(entry.path);
        else if (entry.isFile()) files.push(entry.path.slice(dir.length + 1));
      }
    }

    await visit(dir);
    return files.sort((a, b) => a.localeCompare(b));
  }

  async function readHeadOid(): Promise<string | null> {
    if (!(await hasInitializedRepo())) return null;
    const branch = await readCurrentBranch();
    if (!branch) return null;
    try {
      const ref = await workspaceFs.readFile(branchRefPath(branch), 'utf8');
      return ref.trim() || null;
    } catch (err) {
      if (isNoGit(err)) return null;
      throw err;
    }
  }

  async function readCurrentBranch(): Promise<string | null> {
    try {
      const head = await workspaceFs.readFile(`${gitdir}/HEAD`, 'utf8');
      const match = /^ref:\s+refs\/heads\/(.+)\s*$/.exec(head.trim());
      return match?.[1] ?? null;
    } catch (err) {
      if (isNoGit(err)) return null;
      throw err;
    }
  }

  function branchRefPath(branch: string): string {
    return `${gitdir}/refs/heads/${branch}`;
  }

  async function snapshotWorkdirFiles(options: { writeBlobs: boolean }): Promise<GitStageFile[]> {
    const files: GitStageFile[] = [];
    for (const filepath of await listWorkdirFiles()) {
      const content = await workspaceFs.readFile(`${dir}/${filepath}`);
      const oid = options.writeBlobs
        ? await writeGitObject('blob', content)
        : await gitBlobOid(content);
      files.push({ filepath, oid });
    }
    return files;
  }

  async function readStage(): Promise<GitStageRecord | null> {
    return readJson<GitStageRecord | null>(stagePath, null);
  }

  async function writeStage(stage: GitStageRecord): Promise<void> {
    await writeJson(stagePath, stage);
  }

  async function readCommitRecords(): Promise<GitCommitRecord[]> {
    return readJson<GitCommitRecord[]>(commitsPath, []);
  }

  async function writeCommitRecords(commits: GitCommitRecord[]): Promise<void> {
    await writeJson(commitsPath, commits);
  }

  async function readJson<T>(path: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await workspaceFs.readFile(path, 'utf8')) as T;
    } catch (err) {
      if (isNoGit(err)) return fallback;
      throw err;
    }
  }

  async function writeJson(path: string, value: unknown): Promise<void> {
    await workspaceFs.mkdir(dirname(path), { recursive: true });
    await workspaceFs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  async function writeTreeFromStage(files: readonly GitStageFile[]): Promise<string> {
    const root: PendingTreeNode = { files: [], directories: new Map() };
    for (const file of files) {
      const parts = file.filepath.split('/').filter(Boolean);
      let node = root;
      for (const part of parts.slice(0, -1)) {
        let child = node.directories.get(part);
        if (!child) {
          child = { files: [], directories: new Map() };
          node.directories.set(part, child);
        }
        node = child;
      }
      const name = parts.at(-1);
      if (name) node.files.push({ name, oid: file.oid });
    }

    async function writeNode(node: PendingTreeNode): Promise<string> {
      const tree: GitTreeEntry[] = [];
      for (const [name, child] of [...node.directories.entries()].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        tree.push({
          mode: '040000',
          path: name,
          oid: await writeNode(child),
          type: 'tree',
        });
      }
      for (const file of [...node.files].sort((a, b) => a.name.localeCompare(b.name))) {
        tree.push({
          mode: '100644',
          path: file.name,
          oid: file.oid,
          type: 'blob',
        });
      }
      return writeGitTree(tree);
    }

    return writeNode(root);
  }

  async function writeGitTree(tree: readonly GitTreeEntry[]): Promise<string> {
    const chunks: Uint8Array[] = [];
    for (const entry of tree) {
      chunks.push(new TextEncoder().encode(`${entry.mode} ${entry.path}\0`), hexToBytes(entry.oid));
    }
    return writeGitObject('tree', concatByteArrays(chunks));
  }

  async function writeGitCommit(commit: GitCommitObject): Promise<string> {
    const parentLines = commit.parent.map((parent) => `parent ${parent}`);
    return writeGitObject(
      'commit',
      new TextEncoder().encode(
        [
          `tree ${commit.tree}`,
          ...parentLines,
          `author ${formatGitSignature(commit.author)}`,
          `committer ${formatGitSignature(commit.committer)}`,
          '',
          commit.message,
        ].join('\n'),
      ),
    );
  }

  async function writeGitObject(
    type: 'blob' | 'commit' | 'tree',
    content: Uint8Array,
  ): Promise<string> {
    const wrapped = concatBytes(
      new TextEncoder().encode(`${type} ${content.byteLength}\0`),
      content,
    );
    const oid = await sha1Hex(wrapped);
    const objectDir = `${gitdir}/objects/${oid.slice(0, 2)}`;
    await workspaceFs.mkdir(objectDir, { recursive: true });
    await workspaceFs.writeFile(`${objectDir}/${oid.slice(2)}`, await deflateBytes(wrapped));
    return oid;
  }

  async function latestCommitRecord(): Promise<GitCommitRecord | undefined> {
    const head = await readHeadOid();
    const commits = await readCommitRecords();
    return head ? commits.find((commit) => commit.oid === head) : commits.at(-1);
  }

  return {
    async init() {
      if (await pathExists(`${gitdir}/config`)) return;

      for (const folder of [
        'hooks',
        'info',
        'objects/info',
        'objects/pack',
        'refs/heads',
        'refs/tags',
        'inbrowser',
      ]) {
        await workspaceFs.mkdir(`${gitdir}/${folder}`, { recursive: true });
      }

      await workspaceFs.writeFile(
        `${gitdir}/config`,
        '[core]\n' +
          '\trepositoryformatversion = 0\n' +
          '\tfilemode = false\n' +
          '\tbare = false\n' +
          '\tlogallrefupdates = true\n' +
          '\tsymlinks = false\n' +
          '\tignorecase = true\n',
      );
      await workspaceFs.writeFile(`${gitdir}/HEAD`, 'ref: refs/heads/main\n');
    },
    async currentBranch() {
      if (!(await hasInitializedRepo())) return null;
      return readCurrentBranch();
    },
    async status() {
      if (!(await hasInitializedRepo())) return [];
      const committed = new Map(
        (await latestCommitRecord())?.files.map((file) => [file.filepath, file.oid]) ?? [],
      );
      const current = new Map(
        (await snapshotWorkdirFiles({ writeBlobs: false })).map((file) => [
          file.filepath,
          file.oid,
        ]),
      );
      const filepaths = [...new Set([...committed.keys(), ...current.keys()])].sort((a, b) =>
        a.localeCompare(b),
      );
      return filepaths.flatMap((filepath): GitStatusRow[] => {
        const committedOid = committed.get(filepath);
        const currentOid = current.get(filepath);
        if (committedOid === currentOid) return [];
        if (!committedOid && currentOid) {
          return [{ filepath, head: 0, workdir: 2, stage: 2, status: 'added' }];
        }
        if (committedOid && !currentOid) {
          return [{ filepath, head: 1, workdir: 0, stage: 0, status: 'deleted' }];
        }
        return [{ filepath, head: 1, workdir: 2, stage: 2, status: 'modified' }];
      });
    },
    async stageAll() {
      if (!(await hasInitializedRepo())) return;
      await writeStage({
        files: await snapshotWorkdirFiles({ writeBlobs: true }),
        timestamp: Date.now(),
      });
    },
    async commit(commitOptions) {
      if (!(await hasInitializedRepo())) {
        throw new Error('Cannot commit before git.init() creates a repository.');
      }
      const stage = (await readStage()) ?? {
        files: await snapshotWorkdirFiles({ writeBlobs: true }),
        timestamp: Date.now(),
      };
      const tree = await writeTreeFromStage(stage.files);
      const parent = await readHeadOid();
      const timestamp = Math.floor(Date.now() / 1000);
      const timezoneOffset = new Date().getTimezoneOffset();
      const commit: GitCommitObject = {
        message: commitOptions.message.endsWith('\n')
          ? commitOptions.message
          : `${commitOptions.message}\n`,
        tree,
        parent: parent ? [parent] : [],
        author: {
          name: commitOptions.authorName,
          email: commitOptions.authorEmail,
          timestamp,
          timezoneOffset,
        },
        committer: {
          name: commitOptions.authorName,
          email: commitOptions.authorEmail,
          timestamp,
          timezoneOffset,
        },
      };
      const oid = await writeGitCommit(commit);
      const branch = (await readCurrentBranch()) ?? 'main';
      await workspaceFs.mkdir(dirname(branchRefPath(branch)), { recursive: true });
      await workspaceFs.writeFile(branchRefPath(branch), `${oid}\n`);
      const commits = await readCommitRecords();
      await writeCommitRecords([
        ...commits.filter((entry) => entry.oid !== oid),
        {
          oid,
          message: commit.message,
          authorName: commitOptions.authorName,
          authorEmail: commitOptions.authorEmail,
          timestamp: timestamp * 1000,
          tree,
          parent: commit.parent,
          files: stage.files,
        },
      ]);
      return oid;
    },
    async checkout(branch, checkoutOptions) {
      if (!(await hasInitializedRepo())) {
        throw new Error('Cannot checkout before git.init() creates a repository.');
      }
      const refPath = branchRefPath(branch);
      if (checkoutOptions?.create) {
        const oid = await readHeadOid();
        if (oid) {
          await workspaceFs.mkdir(dirname(refPath), { recursive: true });
          await workspaceFs.writeFile(refPath, `${oid}\n`);
        }
      } else if (!(await pathExists(refPath))) {
        throw new Error(`Branch not found: ${branch}`);
      }
      await workspaceFs.writeFile(`${gitdir}/HEAD`, `ref: refs/heads/${branch}\n`);
    },
    async log(logOptions) {
      if (!(await hasInitializedRepo())) return [];
      const commits = [...(await readCommitRecords())].reverse();
      return commits.slice(0, logOptions?.depth).map((entry) => ({
        oid: entry.oid,
        message: entry.message,
        authorName: entry.authorName,
        authorEmail: entry.authorEmail,
        timestamp: entry.timestamp,
      }));
    },
    async listFiles(listOptions) {
      if (!(await hasInitializedRepo())) return [];
      const commits = await readCommitRecords();
      const target = listOptions?.ref
        ? commits.find((entry) => entry.oid === listOptions.ref)
        : await latestCommitRecord();
      return target?.files.map((file) => file.filepath).sort((a, b) => a.localeCompare(b)) ?? [];
    },
  };
}

async function gitBlobOid(content: Uint8Array): Promise<string> {
  return sha1Hex(concatBytes(new TextEncoder().encode(`blob ${content.byteLength}\0`), content));
}

async function deflateBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('CompressionStream is required to write browser Git objects.');
  }
  const stream = new CompressionStream('deflate');
  const compressed = new Response(stream.readable).arrayBuffer();
  const writer = stream.writable.getWriter();
  await writer.write(bytes.slice() as unknown as BufferSource);
  await writer.close();
  return new Uint8Array(await compressed);
}

function formatGitSignature(signature: GitSignature): string {
  return `${signature.name} <${signature.email}> ${signature.timestamp} ${formatTimezoneOffset(
    signature.timezoneOffset,
  )}`;
}

function formatTimezoneOffset(offsetMinutes: number): string {
  const sign = offsetMinutes <= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60)
    .toString()
    .padStart(2, '0');
  const minutes = (absolute % 60).toString().padStart(2, '0');
  return `${sign}${hours}${minutes}`;
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('SHA-1 digest is unavailable in this runtime.');
  const digest = await subtle.digest('SHA-1', toArrayBuffer(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const source = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(source).set(bytes);
  return source;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left, 0);
  result.set(right, left.byteLength);
  return result;
}

function concatByteArrays(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function isNoGit(err: unknown): boolean {
  const code =
    typeof err === 'object' && err && 'code' in err ? String((err as { code?: unknown }).code) : '';
  if (code === 'ENOENT') return true;

  const message = err instanceof Error ? err.message : String(err);
  return /not.*git|could not find|ENOENT|No such (?:file or directory|directory): .*\/\.git/i.test(
    message,
  );
}
