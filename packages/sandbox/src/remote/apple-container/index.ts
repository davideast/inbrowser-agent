import type { SandboxDirent, SandboxSnapshot, SandboxStats } from '../../types.js';
import type {
  ContainerProviderFactory,
  ContainerRunOptions,
  ContainerSandboxProvider,
  ContainerSession,
  ContainerSessionOptions,
  HostCommandRunner,
} from '../host/types.js';
import { createNodeCommandRunner } from '../node/command.js';

export interface AppleContainerProviderOptions {
  image: string;
  containerBin?: string;
  namePrefix?: string;
  maxBufferedOutputChars?: number;
  commandRunner?: HostCommandRunner;
}

const DEFAULT_CONTAINER_PREFIX = 'inbrowser-';
const DEFAULT_MAX_BUFFERED_OUTPUT_CHARS = 1_048_576;

export function createAppleContainerProvider(
  options: AppleContainerProviderOptions,
): ContainerSandboxProvider {
  const containerBin = options.containerBin ?? 'container';
  const namePrefix = options.namePrefix ?? DEFAULT_CONTAINER_PREFIX;
  const commandRunner = options.commandRunner ?? createNodeCommandRunner();
  const maxBufferedOutputChars = Math.max(
    0,
    options.maxBufferedOutputChars ?? DEFAULT_MAX_BUFFERED_OUTPUT_CHARS,
  );
  const activeNames = new Set<string>();
  return {
    kind: 'apple-container',
    async ensureReady() {
      await commandRunner.run([containerBin, 'system', 'start'], { rejectOnFailure: true });
    },
    async diagnose() {
      const version = await commandRunner.run([containerBin, '--version']);
      const runtimeAvailable = version.exitCode === 0;
      return {
        providerKind: 'apple-container',
        state: runtimeAvailable ? 'idle' : 'error',
        runtimeAvailable,
        systemReady: runtimeAvailable,
        image: options.image,
        message: runtimeAvailable
          ? `Apple container CLI available for ${options.image}`
          : `Apple container CLI unavailable: ${version.stderr || version.stdout || 'command failed'}`,
        checkedAt: Date.now(),
      };
    },
    async cleanupStaleSessions() {
      const names = await listContainerNames(commandRunner, containerBin, namePrefix);
      await Promise.all(
        names
          .filter((name) => name.startsWith(namePrefix) && !activeNames.has(name))
          .map((name) => deleteContainer(commandRunner, containerBin, name)),
      );
    },
    async createSession(sessionOptions) {
      const name = safeContainerName(sessionOptions.id, namePrefix);
      await deleteContainer(commandRunner, containerBin, name);
      await commandRunner.run(
        [containerBin, 'run', '--detach', '--name', name, options.image, 'sleep', 'infinity'],
        { rejectOnFailure: true },
      );
      const session = new AppleContainerSession(
        commandRunner,
        containerBin,
        name,
        sessionOptions,
        maxBufferedOutputChars,
        () => activeNames.delete(name),
      );
      activeNames.add(name);
      const mkdir = await session.run(`mkdir -p ${shellQuote(sessionOptions.root)}`, { cwd: '/' });
      if (mkdir.exitCode !== 0) {
        await session.dispose();
        throw new Error(`Failed to create container root ${sessionOptions.root}: ${mkdir.stderr}`);
      }
      return session;
    },
  };
}

export const appleContainerProviderFactory: ContainerProviderFactory = {
  kind: 'apple-container',
  priority: 100,
  async detect(context) {
    if (!context.commandRunner && typeof process !== 'undefined' && process.platform !== 'darwin') {
      return { available: false, reason: 'not running on macOS' };
    }
    const containerBin = context.containerBin ?? 'container';
    const commandRunner = context.commandRunner ?? createNodeCommandRunner();
    try {
      const version = await commandRunner.run([containerBin, '--version']);
      return version.exitCode === 0
        ? { available: true, details: { version: version.stdout.trim() || version.stderr.trim() } }
        : {
            available: false,
            reason: `${containerBin} command failed: ${version.stderr || version.stdout}`,
          };
    } catch (err) {
      return {
        available: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  },
  create(options) {
    return createAppleContainerProvider(options);
  },
};

class AppleContainerSession implements ContainerSession {
  readonly id: string;
  readonly root: string;

  constructor(
    private readonly commandRunner: HostCommandRunner,
    private readonly containerBin: string,
    private readonly name: string,
    options: ContainerSessionOptions,
    private readonly maxBufferedOutputChars: number,
    private readonly onDispose: () => void,
  ) {
    this.id = options.id;
    this.root = options.root;
  }

  async run(command: string, options: ContainerRunOptions = {}) {
    const started = Date.now();
    const cwd = options.cwd ?? this.root;
    const result = await this.commandRunner.run(
      [this.containerBin, 'exec', this.name, 'sh', '-lc', `cd ${shellQuote(cwd)} && ${command}`],
      {
        signal: options.signal,
        onOutput: options.onOutput,
        maxBufferedOutputChars: this.maxBufferedOutputChars,
      },
    );
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      cwd,
      durationMs: Date.now() - started,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    };
  }

  async readFile(path: string): Promise<Uint8Array> {
    const result = await this.commandRunner.run(
      [this.containerBin, 'exec', this.name, 'sh', '-lc', `base64 < ${shellQuote(path)}`],
      { rejectOnFailure: true },
    );
    return base64ToBytes(result.stdout.replace(/\s/g, ''));
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const encoded = bytesToBase64(data);
    await this.run(`mkdir -p ${shellQuote(dirname(path))}`, { cwd: this.root });
    await this.commandRunner.run(
      [
        this.containerBin,
        'exec',
        this.name,
        'sh',
        '-lc',
        `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(path)}`,
      ],
      { rejectOnFailure: true },
    );
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.run(`${options?.recursive ? 'mkdir -p' : 'mkdir'} ${shellQuote(path)}`);
  }

  async readdir(
    path: string,
    options?: { withFileTypes?: boolean },
  ): Promise<string[] | SandboxDirent[]> {
    const result = await this.run(
      `find ${shellQuote(path)} -mindepth 1 -maxdepth 1 -printf '%f\\t%p\\t%y\\n'`,
    );
    const rows = result.stdout.trim() ? result.stdout.trim().split('\n') : [];
    if (!options?.withFileTypes) return rows.map((row) => row.split('\t')[0] ?? '');
    return rows.map((row) => {
      const [name = '', entryPath = '', type = 'f'] = row.split('\t');
      const direntType: 'file' | 'directory' = type === 'd' ? 'directory' : 'file';
      return {
        name,
        path: entryPath,
        type: direntType,
        isFile: () => direntType === 'file',
        isDirectory: () => direntType === 'directory',
      };
    });
  }

  stat(path: string): Promise<SandboxStats> {
    return this.statLike(path);
  }

  lstat(path: string): Promise<SandboxStats> {
    return this.statLike(path);
  }

  async unlink(path: string): Promise<void> {
    await this.run(`rm ${shellQuote(path)}`);
  }

  async rmdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.run(`${options?.recursive ? 'rm -rf' : 'rmdir'} ${shellQuote(path)}`);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.run(`mv ${shellQuote(from)} ${shellQuote(to)}`);
  }

  async snapshot(root = this.root): Promise<SandboxSnapshot> {
    const result = await this.run(`find ${shellQuote(root)} -type f -print`);
    const files = result.stdout.trim() ? result.stdout.trim().split('\n') : [];
    const entries = await Promise.all(
      files.map(async (path) => ({
        path,
        type: 'file' as const,
        content: new TextDecoder().decode(await this.readFile(path)),
      })),
    );
    return { root, entries, createdAt: Date.now() };
  }

  async restore(snapshot: SandboxSnapshot, options?: { clearRoot?: boolean }): Promise<void> {
    if (options?.clearRoot) await this.run(`rm -rf ${shellQuote(snapshot.root)}/*`);
    await this.run(`mkdir -p ${shellQuote(snapshot.root)}`);
    for (const entry of snapshot.entries) {
      if (entry.type === 'directory') {
        await this.mkdir(entry.path, { recursive: true });
      } else {
        await this.writeFile(entry.path, new TextEncoder().encode(entry.content ?? ''));
      }
    }
  }

  watch(): () => void {
    return () => {};
  }

  async exposePort(port: number) {
    const host = await this.resolveContainerAddress();
    return { id: `${this.name}-${port}`, port, host, targetUrl: `http://${host}:${port}` };
  }

  async dispose(): Promise<void> {
    try {
      await deleteContainer(this.commandRunner, this.containerBin, this.name);
    } finally {
      this.onDispose();
    }
  }

  private async statLike(path: string): Promise<SandboxStats> {
    const result = await this.run(`stat -c '%F\t%s\t%Y\t%Z' ${shellQuote(path)}`);
    const [kind = 'regular file', size = '0', mtime = '0', ctime = '0'] = result.stdout
      .trim()
      .split('\t');
    const type = kind.includes('directory') ? 'directory' : 'file';
    return {
      type,
      size: Number(size),
      mtimeMs: Number(mtime) * 1000,
      ctimeMs: Number(ctime) * 1000,
      isFile: () => type === 'file',
      isDirectory: () => type === 'directory',
    };
  }

  private async resolveContainerAddress(): Promise<string> {
    const inspect = await this.commandRunner.run([this.containerBin, 'inspect', this.name]);
    const inspectIp = firstRoutableIpv4(inspect.stdout);
    if (inspectIp) return inspectIp;

    const list = await this.commandRunner.run([this.containerBin, 'list', '--all']);
    const row = list.stdout
      .split('\n')
      .find((line) => line.includes(this.name) && firstRoutableIpv4(line));
    const listIp = row ? firstRoutableIpv4(row) : undefined;
    if (listIp) return listIp;

    throw new Error(
      `Could not resolve a network address for container ${this.name}; expose a published port or inspect the container network`,
    );
  }
}

function safeContainerName(id: string, prefix: string): string {
  return `${prefix}${id.replace(/[^A-Za-z0-9_.-]/g, '-')}`.slice(0, 63);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function deleteContainer(
  commandRunner: HostCommandRunner,
  containerBin: string,
  name: string,
): Promise<void> {
  await commandRunner.run([containerBin, 'stop', name]);
  await commandRunner.run([containerBin, 'delete', name]);
}

async function listContainerNames(
  commandRunner: HostCommandRunner,
  containerBin: string,
  prefix: string,
): Promise<string[]> {
  const result = await commandRunner.run([containerBin, 'list', '--all']);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split('\n')
    .flatMap((line) => line.trim().split(/\s+/))
    .filter((part) => part.startsWith(prefix));
}

function firstRoutableIpv4(text: string): string | undefined {
  for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    const ip = match[0];
    if (!ip.startsWith('127.') && ip !== '0.0.0.0') return ip;
  }
  return undefined;
}
