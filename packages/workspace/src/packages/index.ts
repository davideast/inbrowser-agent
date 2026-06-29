import type { WorkspaceFileSystem } from '../fs/index.js';
import { dirname, joinPath } from '../fs/path.js';

const DEFAULT_REGISTRY_PATH = '.inbrowser/packages/registry.json';
const DEFAULT_IMPORT_MAP_PATH = '.inbrowser/packages/import-map.json';
const DEFAULT_CDN_BASE = 'https://esm.sh';

export interface InstalledPackage {
  name: string;
  version: string;
  url: string;
}

export interface PackageRegistryState {
  packages: Record<string, InstalledPackage>;
}

export interface PackageInstallSpec {
  name: string;
  version?: string;
}

export interface PackageResolver {
  resolve(spec: PackageInstallSpec): Promise<InstalledPackage>;
}

export interface WorkspacePackageRegistry {
  install(spec: PackageInstallSpec): Promise<InstalledPackage>;
  uninstall(name: string): Promise<void>;
  list(): Promise<Record<string, InstalledPackage>>;
  getImportMap(): Promise<Record<string, string>>;
}

export interface CreatePackageRegistryOptions {
  fs: WorkspaceFileSystem;
  registryPath?: string;
  importMapPath?: string;
  resolver?: PackageResolver;
}

export function createPackageRegistry(
  options: CreatePackageRegistryOptions,
): WorkspacePackageRegistry {
  const registryPath = options.registryPath ?? joinPath(options.fs.root, DEFAULT_REGISTRY_PATH);
  const importMapPath = options.importMapPath ?? joinPath(options.fs.root, DEFAULT_IMPORT_MAP_PATH);
  const resolver = options.resolver ?? createEsmShResolver();

  const load = async (): Promise<PackageRegistryState> => {
    try {
      const text = await options.fs.promises.readFile(registryPath, 'utf8');
      if (!text.trim()) return { packages: {} };
      return JSON.parse(text) as PackageRegistryState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { packages: {} };
      throw err;
    }
  };

  const save = async (state: PackageRegistryState) => {
    await options.fs.promises.mkdir(dirname(registryPath), { recursive: true });
    await options.fs.promises.writeFile(registryPath, `${JSON.stringify(state, null, 2)}\n`);
    const imports = Object.fromEntries(
      Object.values(state.packages).map((pkg) => [pkg.name, pkg.url]),
    );
    await options.fs.promises.mkdir(dirname(importMapPath), { recursive: true });
    await options.fs.promises.writeFile(importMapPath, `${JSON.stringify({ imports }, null, 2)}\n`);
  };

  return {
    async install(spec) {
      const resolved = await resolver.resolve(spec);
      const state = await load();
      state.packages[resolved.name] = resolved;
      await save(state);
      return resolved;
    },
    async uninstall(name) {
      const state = await load();
      delete state.packages[name];
      await save(state);
    },
    async list() {
      return (await load()).packages;
    },
    async getImportMap() {
      const state = await load();
      return Object.fromEntries(Object.values(state.packages).map((pkg) => [pkg.name, pkg.url]));
    },
  };
}

export function createEsmShResolver(baseUrl = DEFAULT_CDN_BASE): PackageResolver {
  return {
    async resolve(spec) {
      const requested = spec.version ?? 'latest';
      const probeUrl = `${baseUrl}/${spec.name}@${requested}`;
      const response = await fetch(probeUrl, { method: 'HEAD', redirect: 'follow' });
      if (!response.ok) {
        throw new Error(
          `Failed to resolve ${spec.name}@${requested}: ${response.status} ${response.statusText}`,
        );
      }
      const version = extractVersion(response.url, spec.name) ?? requested;
      return { name: spec.name, version, url: `${baseUrl}/${spec.name}@${version}` };
    },
  };
}

function extractVersion(url: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = url.match(new RegExp(`/(?:v\\d+/)?(${escaped})@([^/?]+)`));
  return match?.[2] ?? null;
}
