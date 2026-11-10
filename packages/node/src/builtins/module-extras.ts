import path from 'path-browserify';
import { fileURLToPath, pathToFileURL } from '../file-url';
import { invalidArgType, nodeError } from '../node-errors';
import { SourceMap } from '../source-map';
import { stripTypeScriptTypes as runStripTypeScriptTypes } from '../strip-types';

export interface ModuleExtrasDeps {
  Module: unknown;
  fs: Record<string, unknown>;
  cwd: () => string;
  isBuiltin: (id: string) => boolean;
  builtinModules: readonly string[];
  builtins: Record<string, unknown>;
  process: unknown;
  syncBuiltinESMExports: () => void;
}

const rawCompileCacheStatus: Record<string, number> = Object.create(null);
const compileCacheStatus = Object.freeze(
  Object.assign(rawCompileCacheStatus, {
    FAILED: 0,
    ENABLED: 1,
    ALREADY_ENABLED: 2,
    DISABLED: 3,
  }),
);

const rawModuleConstants: Record<string, unknown> = Object.create(null);
const moduleConstants = Object.freeze(
  Object.assign(rawModuleConstants, {
    compileCacheStatus,
  }),
);

const rawSourceMapsSupport: Record<string, boolean> = Object.create(null);
const disabledSourceMapsSupport = Object.freeze(
  Object.assign(rawSourceMapsSupport, {
    enabled: false,
    nodeModules: false,
    generatedCode: false,
  }),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isURLInstance(value: unknown): value is URL {
  if (value instanceof URL) return true;
  if (value !== null && typeof value === 'object') {
    const href = Reflect.get(value, 'href');
    const protocol = Reflect.get(value, 'protocol');
    const pathname = Reflect.get(value, 'pathname');
    return typeof href === 'string' && typeof protocol === 'string' && typeof pathname === 'string';
  }
  return false;
}

function parseUrl(input: string, base?: string | URL): URL {
  try {
    return base !== undefined ? new URL(input, base) : new URL(input);
  } catch {
    throw Object.assign(new TypeError('Invalid URL'), {
      code: 'ERR_INVALID_URL',
      input,
    });
  }
}

function canParseUrl(input: string): boolean {
  try {
    new URL(input);
    return true;
  } catch {
    return false;
  }
}

interface StatLike {
  isFile: () => boolean;
  isDirectory: () => boolean;
}

function statPath(fsObj: Record<string, unknown>, target: string): StatLike | undefined {
  const statSync = fsObj.statSync;
  if (typeof statSync !== 'function') return undefined;
  try {
    const res: unknown = Reflect.apply(statSync, fsObj, [target]);
    if (
      res !== null &&
      typeof res === 'object' &&
      typeof Reflect.get(res, 'isFile') === 'function' &&
      typeof Reflect.get(res, 'isDirectory') === 'function'
    ) {
      // Invariant: verified both isFile and isDirectory methods exist on res.
      return res as StatLike;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function readTextFile(fsObj: Record<string, unknown>, target: string): string | undefined {
  const readFileSync = fsObj.readFileSync;
  if (typeof readFileSync !== 'function') return undefined;
  try {
    const raw: unknown = Reflect.apply(readFileSync, fsObj, [target, 'utf8']);
    return typeof raw === 'string' ? raw : String(raw);
  } catch {
    return undefined;
  }
}

function findNearestParentPackageJSONPath(
  fsObj: Record<string, unknown>,
  checkFilePath: string,
): string | undefined {
  let dir = path.dirname(path.resolve(checkFilePath));
  for (;;) {
    if (path.basename(dir) !== 'node_modules') {
      const candidate = path.join(dir, 'package.json');
      const st = statPath(fsObj, candidate);
      if (st?.isFile()) {
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

const INVALID_PACKAGE_NAME_RE = /^\.|%|\\/;

function parseBarePackageName(
  specifier: string,
  baseLabel: string,
): { packageName: string; isScoped: boolean } {
  let sepIdx = specifier.indexOf('/');
  let valid = true;
  let isScoped = false;
  if (specifier[0] === '@') {
    isScoped = true;
    if (sepIdx === -1 || specifier.length === 0) {
      valid = false;
    } else {
      sepIdx = specifier.indexOf('/', sepIdx + 1);
    }
  }
  const packageName = sepIdx === -1 ? specifier : specifier.slice(0, sepIdx);
  if (INVALID_PACKAGE_NAME_RE.test(packageName)) {
    valid = false;
  }
  if (!valid) {
    throw nodeError(
      TypeError,
      'ERR_INVALID_MODULE_SPECIFIER',
      `Invalid module "${specifier}" is not a valid package name imported from ${baseLabel}`,
    );
  }
  return { packageName, isScoped };
}

export function createModuleExtras(deps: ModuleExtrasDeps): Record<string, unknown> {
  let warnedStripTypes = false;
  const emitStripTypesExperimentalWarning = (): void => {
    if (warnedStripTypes) return;
    warnedStripTypes = true;
    if (deps.process !== null && typeof deps.process === 'object') {
      const emitWarning = Reflect.get(deps.process, 'emitWarning');
      if (typeof emitWarning === 'function') {
        Reflect.apply(emitWarning, deps.process, [
          'stripTypeScriptTypes is an experimental feature and might change at any time',
          'ExperimentalWarning',
        ]);
      }
    }
  };

  function syncBuiltinESMExports(): void {
    deps.syncBuiltinESMExports();
  }

  function enableCompileCache(cacheDir?: unknown): {
    status: number;
    message?: string;
    directory?: string;
  } {
    if (cacheDir !== undefined && typeof cacheDir !== 'string') {
      throw invalidArgType('cacheDir', 'string', cacheDir);
    }
    return {
      status: compileCacheStatus.DISABLED,
      message: 'Compile cache is disabled in browser runtime',
    };
  }

  function getCompileCacheDir(): undefined {
    return undefined;
  }

  const nonConstructible = {
    flushCompileCache(): undefined {
      return undefined;
    },
  };

  function getSourceMapsSupport(): Record<string, boolean> {
    return disabledSourceMapsSupport;
  }

  function setSourceMapsSupport(enabled: unknown, options?: unknown): void {
    if (typeof enabled !== 'boolean') {
      throw invalidArgType('enabled', 'boolean', enabled);
    }
    let resolvedOptions: Record<string, unknown> = {};
    if (options !== undefined) {
      if (!isRecord(options)) {
        throw invalidArgType('options', 'object', options);
      }
      resolvedOptions = options;
    }
    const { nodeModules = false, generatedCode = false } = resolvedOptions;
    if (typeof nodeModules !== 'boolean') {
      throw invalidArgType('options.nodeModules', 'boolean', nodeModules);
    }
    if (typeof generatedCode !== 'boolean') {
      throw invalidArgType('options.generatedCode', 'boolean', generatedCode);
    }
    if (enabled) {
      throw Object.assign(new Error('Enabling source maps at runtime is not supported'), {
        code: 'ENOSYS',
      });
    }
  }

  function findPackageJSON(...args: unknown[]): string | undefined {
    if (args.length === 0) {
      throw nodeError(TypeError, 'ERR_MISSING_ARGS', 'The "specifier" argument must be specified');
    }
    const rawSpecifier = args[0];
    const rawBase = args[1];

    let specifier: string;
    if (isURLInstance(rawSpecifier)) {
      specifier = rawSpecifier.href;
    } else if (typeof rawSpecifier === 'string') {
      specifier = rawSpecifier;
    } else {
      try {
        specifier = `${String(rawSpecifier)}`;
        if (typeof rawSpecifier === 'symbol') {
          throw invalidArgType('specifier', 'string', rawSpecifier);
        }
      } catch {
        throw invalidArgType('specifier', 'string', rawSpecifier);
      }
    }

    let parentURL: URL;
    if (rawBase === undefined) {
      parentURL = new URL('data:');
    } else if (isURLInstance(rawBase)) {
      parentURL = parseUrl(rawBase.href);
    } else if (typeof rawBase === 'string') {
      parentURL = path.isAbsolute(rawBase) ? pathToFileURL(rawBase, deps.cwd()) : parseUrl(rawBase);
    } else {
      throw invalidArgType('base', 'string', rawBase);
    }

    const baseLabel =
      parentURL.protocol === 'file:' ? fileURLToPath(parentURL.href) : parentURL.href;

    // Bare package specifier
    if (specifier && specifier[0] !== '.' && specifier[0] !== '/' && !canParseUrl(specifier)) {
      const { packageName } = parseBarePackageName(specifier, baseLabel);

      if (parentURL.protocol !== 'file:') {
        throw nodeError(
          Error,
          'ERR_MODULE_NOT_FOUND',
          `Cannot find package '${packageName}' imported from ${baseLabel}`,
        );
      }

      const baseFilePath = fileURLToPath(parentURL.href);

      // Check package self-reference via nearest parent package.json with `exports` & matching `name`
      const selfPkgPath = findNearestParentPackageJSONPath(deps.fs, baseFilePath);
      if (selfPkgPath !== undefined) {
        const rawJson = readTextFile(deps.fs, selfPkgPath);
        if (rawJson !== undefined) {
          try {
            const parsed: unknown = JSON.parse(rawJson);
            if (isRecord(parsed) && parsed.exports != null && parsed.name === packageName) {
              return selfPkgPath;
            }
          } catch {
            // Ignore malformed package.json during self-reference probe
          }
        }
      }

      let dir = path.dirname(path.resolve(baseFilePath));
      for (;;) {
        if (path.basename(dir) !== 'node_modules') {
          const pkgDir = path.join(dir, 'node_modules', packageName);
          const st = statPath(deps.fs, pkgDir);
          if (st?.isDirectory()) {
            return path.join(pkgDir, 'package.json');
          }
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
          break;
        }
        dir = parent;
      }

      throw nodeError(
        Error,
        'ERR_MODULE_NOT_FOUND',
        `Cannot find package '${packageName}' imported from ${baseLabel}`,
      );
    }

    // Relative, absolute, or URL specifier
    if (specifier.startsWith('/') && parentURL.protocol !== 'file:') {
      throw nodeError(
        TypeError,
        'ERR_UNSUPPORTED_RESOLVE_REQUEST',
        `Failed to resolve module specifier "${specifier}" from "${parentURL.href}": Invalid relative URL or base scheme is not hierarchical.`,
      );
    }

    let resolvedURL: URL;
    if (canParseUrl(specifier)) {
      resolvedURL = parseUrl(specifier);
    } else {
      resolvedURL = parseUrl(specifier, parentURL);
    }

    const resolvedFilePath = fileURLToPath(resolvedURL.href);
    const targetStat = statPath(deps.fs, resolvedFilePath);
    if (!targetStat) {
      throw nodeError(
        Error,
        'ERR_MODULE_NOT_FOUND',
        `Cannot find module '${resolvedFilePath}' imported from ${baseLabel}`,
      );
    }

    return findNearestParentPackageJSONPath(deps.fs, resolvedFilePath);
  }

  function stripTypeScriptTypes(code: unknown, options?: unknown): string {
    return runStripTypeScriptTypes(code, options, emitStripTypesExperimentalWarning);
  }

  return {
    constants: moduleConstants,
    enableCompileCache,
    flushCompileCache: nonConstructible.flushCompileCache,
    getCompileCacheDir,
    getSourceMapsSupport,
    setSourceMapsSupport,
    syncBuiltinESMExports,
    findPackageJSON,
    stripTypeScriptTypes,
    SourceMap,
  };
}
