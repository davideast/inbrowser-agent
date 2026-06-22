import type { FileContent, FsStat, IFileSystem, MkdirOptions, RmOptions } from 'just-bash';
import type { WorkspaceFileSystem } from '../fs/index.js';
import { joinPath, normalizePath } from '../fs/index.js';

interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}

interface WriteFileOptions {
  encoding?: BufferEncoding;
}

interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export class WorkspaceBashFileSystem implements IFileSystem {
  constructor(
    private readonly fs: WorkspaceFileSystem,
    private readonly prefix = '/',
  ) {}

  resolvePath(base: string, path: string): string {
    return path.startsWith('/') ? normalizePath(path) : joinPath(base || '/', path);
  }

  async readFile(path: string, _options?: ReadFileOptions | BufferEncoding): Promise<string> {
    return this.fs.promises.readFile(this.toWorkspacePath(path), 'utf8');
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return this.fs.promises.readFile(this.toWorkspacePath(path));
  }

  async writeFile(
    path: string,
    content: FileContent,
    _options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    await this.fs.promises.writeFile(this.toWorkspacePath(path), normalizeContent(content));
  }

  async appendFile(path: string, content: FileContent): Promise<void> {
    const target = this.toWorkspacePath(path);
    let existing = '';
    try {
      existing = await this.fs.promises.readFile(target, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await this.fs.promises.writeFile(
      target,
      existing + new TextDecoder().decode(normalizeContent(content)),
    );
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.fs.promises.lstat(this.toWorkspacePath(path));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  async stat(path: string): Promise<FsStat> {
    return toFsStat(await this.fs.promises.stat(this.toWorkspacePath(path)));
  }

  async lstat(path: string): Promise<FsStat> {
    return toFsStat(await this.fs.promises.lstat(this.toWorkspacePath(path)));
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await this.fs.promises.mkdir(this.toWorkspacePath(path), {
      recursive: options?.recursive ?? false,
    });
  }

  async readdir(path: string): Promise<string[]> {
    return this.fs.promises.readdir(this.toWorkspacePath(path));
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const entries = await this.fs.promises.readdir(this.toWorkspacePath(path), {
      withFileTypes: true,
    });
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymbolicLink: false,
    }));
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const target = this.toWorkspacePath(path);
    try {
      const stat = await this.fs.promises.lstat(target);
      if (stat.isDirectory())
        await this.fs.promises.rmdir(target, { recursive: options?.recursive ?? false });
      else await this.fs.promises.unlink(target);
    } catch (err) {
      if (options?.force && (err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  async cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
    const source = this.toWorkspacePath(src);
    const target = this.toWorkspacePath(dest);
    const stat = await this.fs.promises.lstat(source);
    if (stat.isDirectory()) {
      if (!options?.recursive) throw new Error(`cp: '${src}' is a directory`);
      await this.copyDir(source, target);
      return;
    }
    await this.fs.promises.writeFile(target, await this.fs.promises.readFile(source));
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.fs.promises.rename(this.toWorkspacePath(src), this.toWorkspacePath(dest));
  }

  async chmod(_path: string, _mode: number): Promise<void> {}

  async link(): Promise<void> {
    throw new Error('hard links are not supported by @inbrowser/workspace shell');
  }

  async symlink(): Promise<void> {
    throw new Error('symlinks are not supported by @inbrowser/workspace shell');
  }

  async readlink(): Promise<string> {
    throw new Error('symlinks are not supported by @inbrowser/workspace shell');
  }

  async realpath(path: string): Promise<string> {
    return normalizePath(path);
  }

  async utimes(): Promise<void> {}

  async getAllPaths(): Promise<string[]> {
    const snapshot = await this.fs.snapshot(this.prefix);
    return snapshot.entries.map((entry) => entry.path);
  }

  private async copyDir(source: string, target: string): Promise<void> {
    await this.fs.promises.mkdir(target, { recursive: true });
    const entries = await this.fs.promises.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      const nextSource = joinPath(source, entry.name);
      const nextTarget = joinPath(target, entry.name);
      if (entry.isDirectory()) await this.copyDir(nextSource, nextTarget);
      else
        await this.fs.promises.writeFile(nextTarget, await this.fs.promises.readFile(nextSource));
    }
  }

  private toWorkspacePath(path: string): string {
    const normalized = normalizePath(path);
    if (this.prefix === '/' || this.prefix === '') return normalized;
    if (normalized === '/') return normalizePath(this.prefix);
    return joinPath(this.prefix, normalized);
  }
}

function normalizeContent(content: FileContent): Uint8Array {
  if (typeof content === 'string') return new TextEncoder().encode(content);
  if (content instanceof Uint8Array) return content;
  return new TextEncoder().encode(String(content));
}

function toFsStat(stat: {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode?: number;
}): FsStat {
  return {
    isFile: () => stat.isFile(),
    isDirectory: () => stat.isDirectory(),
    isSymbolicLink: () => false,
    size: stat.size,
    mtime: new Date(stat.mtimeMs),
    ctime: new Date(stat.ctimeMs),
    mode: stat.mode ?? (stat.isFile() ? 0o100644 : 0o040755),
  } as FsStat;
}
