import { Buffer } from 'buffer';
import { init as initCjs, parse as parseCjs } from 'cjs-module-lexer';
import { parse } from 'es-module-lexer/js';
import path from 'path-browserify';
import { exports as resolveExports, imports as resolveImports } from 'resolve.exports';
import { builtinModules, isBuiltin } from './builtin-modules';
import { createModuleExtras } from './builtins/module-extras';
import type { parseExecArgv } from './exec-argv';
import { fileURLToPath, pathToFileURL } from './file-url';
import { invalidArgType, invalidArgValue } from './node-errors';
import { decoder, encoder, fault, record } from './protocol';
import { type ScopeHolder, createVm } from './vm-context';

// Capture before guest globals can replace eval. Calling this alias evaluates in
// the dedicated process realm without closing over loader or caller variables.
const evaluateScript = globalThis.eval;
const NativeFunction = globalThis.Function;
// vm contexts: a Function body is sloppy, so it may use `with`. The `eval`
// parameter holds the realm's intrinsic eval, which makes the call a direct
// eval inside the context scope. The holder name is unguessable and the scope
// never answers for it.
const vmHolder = '__vmScope_' + crypto.randomUUID().replaceAll('-', '');
const evaluateInVmScope = new NativeFunction(
  'eval',
  vmHolder,
  `with (${vmHolder}.scope) return eval(${vmHolder}.source());`,
) as (this: object, nativeEval: typeof evaluateScript, holder: ScopeHolder) => unknown;

import type { createFs } from './fs';
type Fs = ReturnType<typeof createFs>;
export function createLoader(
  fs: Fs,
  builtins: Record<string, unknown>,
  globals: Record<string, unknown>,
  transport: {
    compileContext?: (
      source: string,
      filename: string,
      options?: {
        generated?: boolean;
        module?: number;
        script?: { name: string; lineOffset: number };
      },
    ) => string;
    /** Experimental async context: frames for ESM graph evaluation. */
    moduleContext?: {
      open(evaluation: number): void;
      begin(evaluation: number): void;
      close(evaluation: number): void;
      link(id: number, imports: number[]): void;
    };
    base: string;
    cwd?: () => string;
    publish: (modules: [string, string][]) => Promise<void>;
    retain: () => () => void;
  },
  startup: ReturnType<typeof parseExecArgv>,
) {
  const cache: Record<string, Module> = Object.create(null);
  const isFile = (name: string) => {
    try {
      const stat = fs.statSync(name);
      return record(stat) && typeof stat.isFile === 'function' && stat.isFile();
    } catch (error) {
      if (record(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
      throw error;
    }
  };
  function file(candidate: string, mode: 'require' | 'import'): string | undefined {
    // ESM legacy package lookup is independent of CommonJS extension hooks.
    const suffixes = mode === 'require' ? Object.keys(extensions) : ['.js', '.json', '.node'];
    return [candidate, ...suffixes.map((extension) => candidate + extension)].find(isFile);
  }
  function directory(candidate: string, mode: 'require' | 'import'): string | undefined {
    const manifest = path.join(candidate, 'package.json');
    if (isFile(manifest)) {
      const pkg: unknown = JSON.parse(String(fs.readFileSync(manifest, 'utf8')));
      if (record(pkg) && typeof pkg.main === 'string') {
        const main = path.resolve(candidate, pkg.main);
        const found = file(main, mode) ?? file(path.join(main, 'index'), mode);
        if (found) return found;
      }
    }
    return file(path.join(candidate, 'index'), mode);
  }
  function esmFile(candidate: string): string | undefined {
    if (isFile(candidate)) return candidate;
    if (fs.existsSync(candidate))
      throw fault('ERR_UNSUPPORTED_DIR_IMPORT', `Directory import is not supported: ${candidate}`);
    return undefined;
  }
  function resolve(
    id: string,
    parent: string,
    mode: 'require' | 'import' = 'require',
    mustExist = true,
  ): string {
    const resolved = resolvePath(id, parent, mode, mustExist);
    // CommonJS identity and relative imports follow the real file, including
    // package bin symlinks. ESM canonicalizes its file URL separately.
    return mode === 'require' && !resolved.startsWith('node:')
      ? String(fs.realpathSync(resolved))
      : resolved;
  }
  function resolvePath(
    id: string,
    parent: string,
    mode: 'require' | 'import',
    mustExist: boolean,
  ): string {
    const builtin = id.replace(/^node:/, '');
    if (Object.hasOwn(builtins, builtin) && isBuiltin(id)) return 'node:' + builtin;
    if (id.startsWith('node:')) throw fault('ENOSYS', `Unsupported builtin ${id}`);
    if (id.startsWith('#')) {
      let dir = path.dirname(parent);
      while (path.basename(dir) !== 'node_modules') {
        const manifest = path.join(dir, 'package.json');
        if (isFile(manifest)) {
          const pkg: unknown = JSON.parse(String(fs.readFileSync(manifest, 'utf8')));
          let target: string | undefined;
          try {
            if (record(pkg))
              target = resolveImports(pkg, id, {
                require: mode === 'require',
                conditions: startup.conditions,
              })?.[0];
          } catch {
            throw fault('ERR_PACKAGE_IMPORT_NOT_DEFINED', `Package does not import ${id}`);
          }
          if (!target)
            throw fault('ERR_PACKAGE_IMPORT_NOT_DEFINED', `Package does not import ${id}`);
          if (!target.startsWith('./')) {
            if (target.startsWith('.') || target.startsWith('/') || target.includes(':'))
              throw fault('ERR_INVALID_PACKAGE_TARGET', `Invalid import target for ${id}`);
            if (target.startsWith('#'))
              throw fault('ENOSYS', 'Indirect private import aliases are not implemented');
            const resolved = resolve(target, manifest, mode, mustExist);
            // Match the pinned Node 22.18 CJS private-import behavior: builtin
            // aliases are accepted by ESM, but CJS rejects their non-file URL.
            if (mode === 'require' && resolved.startsWith('node:'))
              throw Object.assign(new TypeError('The URL must be of scheme file'), {
                code: 'ERR_INVALID_URL_SCHEME',
              });
            return resolved;
          }
          const resolved = path.resolve(dir, target);
          if (
            !resolved.startsWith(dir === '/' ? '/' : dir + '/') ||
            target.split('/').includes('node_modules')
          )
            throw fault('ERR_INVALID_PACKAGE_TARGET', `Import escapes package: ${id}`);
          if (mode === 'import' && !mustExist) return resolved;
          if (mode === 'import' ? esmFile(resolved) : isFile(resolved)) return resolved;
          throw fault(
            mode === 'import' ? 'ERR_MODULE_NOT_FOUND' : 'MODULE_NOT_FOUND',
            `Cannot find import target ${id}`,
          );
        }
        if (dir === '/') break;
        dir = path.dirname(dir);
      }
      throw fault('ERR_PACKAGE_IMPORT_NOT_DEFINED', `Package does not import ${id}`);
    }
    if (id.startsWith('.') || id.startsWith('/')) {
      const candidate = path.resolve(path.dirname(parent), id);
      const found =
        mode === 'import'
          ? esmFile(candidate)
          : (file(candidate, mode) ?? directory(candidate, mode));
      if (found) return found;
    } else {
      let dir = path.dirname(parent);
      for (;;) {
        const packageName = id.startsWith('@')
          ? id.split('/').slice(0, 2).join('/')
          : id.split('/')[0];
        const packageRoot = path.join(dir, 'node_modules', packageName);
        const manifest = path.join(packageRoot, 'package.json');
        if (isFile(manifest)) {
          const pkg: unknown = JSON.parse(String(fs.readFileSync(manifest, 'utf8')));
          if (record(pkg) && Object.hasOwn(pkg, 'exports')) {
            let targets: string[] | undefined;
            try {
              targets =
                resolveExports(pkg, '.' + id.slice(packageName.length), {
                  require: mode === 'require',
                  conditions: startup.conditions,
                }) || undefined;
            } catch {
              throw fault('ERR_PACKAGE_PATH_NOT_EXPORTED', `Package does not export ${id}`);
            }
            const target = targets?.[0];
            if (!target || !target.startsWith('./'))
              throw fault('ERR_INVALID_PACKAGE_TARGET', `Invalid export for ${id}`);
            const resolved = path.resolve(packageRoot, target);
            if (!resolved.startsWith(packageRoot + '/'))
              throw fault('ERR_INVALID_PACKAGE_TARGET', `Export escapes package: ${id}`);
            if (mode === 'import' && !mustExist) return resolved;
            if (mode === 'import' ? esmFile(resolved) : isFile(resolved)) return resolved;
            throw fault(
              mode === 'import' ? 'ERR_MODULE_NOT_FOUND' : 'MODULE_NOT_FOUND',
              `Cannot find exported module ${id}`,
            );
          }
        }
        const candidate = path.join(dir, 'node_modules', id);
        if (mode === 'import' && id !== packageName && !mustExist && fs.existsSync(packageRoot))
          return candidate;
        const found =
          mode === 'import' && id !== packageName
            ? esmFile(candidate)
            : (file(candidate, mode) ?? directory(candidate, mode));
        if (found) return found;
        if (dir === '/') break;
        dir = path.dirname(dir);
      }
    }
    throw fault(
      mode === 'import' ? 'ERR_MODULE_NOT_FOUND' : 'MODULE_NOT_FOUND',
      `Cannot find module '${id}'`,
    );
  }
  function isEsm(filename: string): boolean {
    if (filename.endsWith('.mjs')) return true;
    if (!filename.endsWith('.js')) return false;
    let dir = path.dirname(filename);
    for (;;) {
      const manifest = path.join(dir, 'package.json');
      if (isFile(manifest)) {
        const pkg: unknown = JSON.parse(String(fs.readFileSync(manifest, 'utf8')));
        return record(pkg) && pkg.type === 'module';
      }
      if (dir === '/' || path.basename(dir) === 'node_modules') return false;
      dir = path.dirname(dir);
    }
  }
  function resolveImport(id: string, parent: string, mustExist = true): string {
    if (id.startsWith('node:') || (Object.hasOwn(builtins, id) && isBuiltin(id)))
      return resolve(id, '/entry.cjs');
    const parentURL = parent.startsWith('file:') ? parent : pathToFileURL(parent).href;
    const direct = id.startsWith('.') || id.startsWith('/') || /^[a-zA-Z][\w+.-]*:/.test(id);
    let url: URL;
    if (direct) url = new URL(id, parentURL);
    else {
      const resolved = resolve(id, fileURLToPath(parentURL), 'import', mustExist);
      if (resolved.startsWith('node:')) return resolved;
      url = pathToFileURL(resolved);
    }
    if (url.protocol !== 'file:')
      throw fault('ENOSYS', `Unsupported ESM URL scheme: ${url.protocol}`);
    if (/%2f|%5c/i.test(url.pathname))
      throw fault(
        'ERR_INVALID_MODULE_SPECIFIER',
        'Module URL must not contain encoded path separators',
      );
    const filename = fileURLToPath(url);
    if (mustExist && !esmFile(filename))
      throw fault('ERR_MODULE_NOT_FOUND', `Cannot find module '${id}'`);
    if (isFile(filename)) url.pathname = pathToFileURL(String(fs.realpathSync(filename))).pathname;
    return url.href;
  }
  function load(id: string, parent = '/entry.cjs', owner?: Module): unknown {
    const filename = resolve(id, parent);
    if (filename.startsWith('node:')) return builtins[filename.slice(5)];
    const parentModule = owner ?? cache[parent];
    if (cache[filename]) {
      const cached = cache[filename];
      if (parentModule && !parentModule.children.includes(cached))
        parentModule.children.push(cached);
      return cached.exports;
    }
    if (filename.endsWith('.node') || isEsm(filename))
      throw fault('ENOSYS', 'Native addons and synchronous require of ESM are not supported');
    const module = new Module(filename, parentModule);
    module.filename = filename;
    module.paths = Module._nodeModulePaths(path.dirname(filename));
    cache[filename] = module;
    try {
      // Node chooses the longest registered suffix, excluding a leading dot.
      const name = path.basename(filename);
      let extension = '.js';
      for (let index = name.indexOf('.', 1); index >= 0; index = name.indexOf('.', index + 1)) {
        const suffix = name.slice(index);
        if (extensions[suffix]) {
          extension = suffix;
          break;
        }
      }
      extensions[extension](module, filename);
      module.loaded = true;
      return module.exports;
    } catch (error) {
      delete cache[filename];
      const index = parentModule?.children.indexOf(module) ?? -1;
      if (index >= 0) parentModule.children.splice(index, 1);
      throw error;
    }
  }
  function isRelativeLookupRequest(request: string): boolean {
    return (
      request === '.' || request === '..' || request.startsWith('./') || request.startsWith('../')
    );
  }
  function resolveFromCustomPaths(request: string, rawPaths: unknown[]): string {
    const validatedPaths: string[] = [];
    for (let i = 0; i < rawPaths.length; i++) {
      const entry = rawPaths[i];
      if (typeof entry !== 'string') {
        throw invalidArgType(`paths[${i}]`, 'string', entry);
      }
      validatedPaths.push(entry);
    }
    if (validatedPaths.length === 0) {
      throw fault('MODULE_NOT_FOUND', `Cannot find module '${request}'`);
    }
    const cwdPath = () => String(fs.realpathSync('.'));
    for (const rawBase of validatedPaths) {
      const baseDir = path.isAbsolute(rawBase)
        ? path.resolve(rawBase)
        : path.resolve(cwdPath(), rawBase);
      const syntheticParent = path.join(baseDir, '__resolve__.js');
      try {
        const resolved = resolve(request, syntheticParent);
        return resolved.startsWith('node:') ? request : resolved;
      } catch (error) {
        if (record(error) && error.code === 'MODULE_NOT_FOUND') continue;
        throw error;
      }
    }
    throw fault('MODULE_NOT_FOUND', `Cannot find module '${request}'`);
  }
  function createRequire(value: unknown, owner?: Module) {
    // Mirrors Node 22.18 lib/internal/modules/cjs/loader.js createRequire: URLs and
    // non-absolute strings go through fileURLToPath, any failure is
    // ERR_INVALID_ARG_VALUE, and a trailing slash names a directory.
    const reason = 'must be a file URL object, file URL string, or absolute path string';
    let filename: string;
    if (value instanceof URL || (typeof value === 'string' && !path.isAbsolute(value))) {
      try {
        filename = fileURLToPath(value);
      } catch {
        throw invalidArgValue('filename', value, reason);
      }
    } else if (typeof value !== 'string') {
      throw invalidArgValue('filename', value, reason);
    } else {
      filename = value;
    }
    if (filename.endsWith('/')) filename = path.join(filename, 'noop.js');
    const getParentTarget = () => owner ?? { filename };
    const reqPaths = {
      paths(request: unknown): string[] | null {
        return Module._resolveLookupPaths(request, getParentTarget());
      },
    }.paths;
    const reqResolve = Object.assign(
      {
        resolve(request: unknown, options?: unknown): string {
          return Module._resolveFilename(request, getParentTarget(), false, options);
        },
      }.resolve,
      { paths: reqPaths },
    );
    return Object.assign((id: string) => (owner ? owner.require(id) : load(id, filename)), {
      resolve: reqResolve,
      cache,
      extensions,
    });
  }
  class Module {
    id: string;
    path: string;
    filename: string | null = null;
    loaded = false;
    exports: unknown = {};
    children: Module[] = [];
    paths: string[] | undefined;
    parent: Module | null | undefined;

    constructor(id: unknown = '', parent?: unknown) {
      if (typeof id !== 'string' || (parent != null && !(parent instanceof Module)))
        throw Object.assign(new TypeError('Invalid module id or parent'), {
          code: 'ERR_INVALID_ARG_TYPE',
        });
      this.id = id;
      this.path = path.dirname(id);
      this.parent = parent;
      parent?.children.push(this);
    }

    require(id: unknown) {
      if (typeof id !== 'string')
        throw Object.assign(new TypeError('Module request must be a string'), {
          code: 'ERR_INVALID_ARG_TYPE',
        });
      if (typeof this.filename !== 'string')
        throw fault('ENOSYS', 'Module require needs an assigned filename');
      return load(id, this.filename, this);
    }

    _compile(content: unknown, filename: unknown) {
      if (typeof content !== 'string' || typeof filename !== 'string')
        throw Object.assign(new TypeError('Module source and filename must be strings'), {
          code: 'ERR_INVALID_ARG_TYPE',
        });
      // The label the engine reports for this script. The Function constructor
      // puts a two-line header before the body it is given.
      const label = 'guest:' + encodeURI(decoder.decode(encoder.encode(filename)));
      let source =
        transport.compileContext?.(content, filename, {
          script: { name: label, lineOffset: 2 },
        }) ?? content;
      // CJS owns a synchronous wrapper. Redirect only dynamic import tokens;
      // hooks can compile source without changing the canonical filesystem.
      const [imports] = parse(source, filename);
      for (const item of [...imports].reverse()) {
        if (item.t === 2) {
          source =
            source.slice(0, item.ss) +
            `${bridge}.import.bind(null,${JSON.stringify(filename)})` +
            source.slice(item.d);
        }
      }
      const require = createRequire(filename, this);
      const fn = new NativeFunction(
        'exports',
        'require',
        'module',
        '__filename',
        '__dirname',
        source.replace(/^#![^\n]*/, '') + '\n//# sourceURL=' + label,
      );
      return fn.call(this.exports, this.exports, require, this, filename, path.dirname(filename));
    }

    static _nodeModulePaths(from: unknown) {
      if (typeof from !== 'string')
        throw Object.assign(new TypeError('Module search directory must be a string'), {
          code: 'ERR_INVALID_ARG_TYPE',
        });
      let directory = path.isAbsolute(from)
        ? path.resolve(from)
        : path.resolve(String(fs.realpathSync('.')), from);
      const paths: string[] = [];
      for (;;) {
        if (path.basename(directory) !== 'node_modules')
          paths.push(path.join(directory, 'node_modules'));
        if (directory === '/') return paths;
        directory = path.dirname(directory);
      }
    }

    static _resolveLookupPaths(request: unknown, parent: unknown): string[] | null {
      if (typeof request !== 'string') {
        throw invalidArgType('request', 'string', request);
      }
      if (isBuiltin(request)) return null;
      const parentFilename =
        record(parent) && typeof parent.filename === 'string' && parent.filename.length > 0
          ? parent.filename
          : null;
      if (!isRelativeLookupRequest(request)) {
        if (record(parent) && Array.isArray(parent.paths) && parent.paths.length > 0) {
          return parent.paths.map(String);
        }
        return Module._nodeModulePaths(parentFilename ? path.dirname(parentFilename) : '.');
      }
      if (!parentFilename) return ['.'];
      return [path.dirname(parentFilename)];
    }

    static _resolveFilename(
      id: unknown,
      parent: unknown,
      _isMain?: unknown,
      options?: unknown,
    ): string {
      if (typeof id !== 'string') {
        throw invalidArgType('request', 'string', id);
      }
      const builtin = id.replace(/^node:/, '');
      if (Object.hasOwn(builtins, builtin) && isBuiltin(id)) return id;
      if (id.startsWith('node:')) throw fault('ENOSYS', `Unsupported builtin ${id}`);
      if (typeof options === 'object' && options !== null) {
        const customPaths = Reflect.get(options, 'paths');
        if (Array.isArray(customPaths)) {
          return resolveFromCustomPaths(id, customPaths);
        }
        if (customPaths !== undefined) {
          throw invalidArgValue('options.paths', customPaths);
        }
      }
      if (!record(parent) || typeof parent.filename !== 'string')
        throw fault('ENOSYS', 'Module resolution needs an assigned parent filename');
      const filename = resolve(id, parent.filename);
      return filename.startsWith('node:') ? id : filename;
    }
  }
  const extensions: Record<string, (module: Module, filename: string) => void> = Object.assign(
    Object.create(null),
    {
      '.js': (module: Module, filename: string) => {
        module._compile(String(fs.readFileSync(filename, 'utf8')), filename);
      },
      '.json': (module: Module, filename: string) => {
        module.exports = JSON.parse(String(fs.readFileSync(filename, 'utf8')));
      },
      '.node': () => {
        throw fault('ENOSYS', 'Native addons are not supported');
      },
    },
  );
  const builtinSyncCallbacks = new Set<() => void>();
  const syncBuiltinESMExports = (): void => {
    for (const refresh of builtinSyncCallbacks) {
      refresh();
    }
  };
  const registerBuiltinSync = (refresh: () => void): void => {
    builtinSyncCallbacks.add(refresh);
  };
  builtins.module = Object.assign(
    Module,
    {
      Module,
      _extensions: extensions,
      createRequire,
      builtinModules: [...builtinModules],
      isBuiltin,
      // module.md "module.findSourceMap(path)" (1760-1773): a SourceMap if one is
      // found, undefined otherwise. Nothing parses source maps for guest files and
      // startup rejects --enable-source-maps, so source map support is never on and
      // "not found" is the truthful, documented answer. This does not claim lookup
      // works; if support is ever added this must start finding maps.
      findSourceMap(_path: unknown): undefined {
        return undefined;
      },
    },
    createModuleExtras({
      Module,
      fs,
      cwd: transport.cwd ?? (() => String(fs.realpathSync('.'))),
      isBuiltin,
      builtinModules,
      builtins,
      process: globals.process,
      syncBuiltinESMExports,
    }),
  );
  builtins.vm = createVm({
    compile: (source) => transport.compileContext?.(source, 'vm') ?? source,
    evaluate: (source) => evaluateScript(source),
    evaluateInScope: (thisValue, holder) =>
      Reflect.apply(evaluateInVmScope, thisValue, [evaluateScript, holder]),
    holderName: vmHolder,
  });
  // URLs are allocated before traversing dependencies. The browser links cycles
  // and owns live bindings; no import/export semantics are transpiled to CJS.
  const modules = new Map<string, string>();
  const bridgeKey = '__guestModules_' + crypto.randomUUID().replaceAll('-', '');
  const bridge = `globalThis[${JSON.stringify(bridgeKey)}]`;
  let preparation: Promise<unknown> = Promise.resolve();
  let nextEvaluation = 1;
  const evaluations = new Map<string, Promise<unknown>>();
  let entryURL = '';
  const metadata = new Map<string, Record<string, unknown>>();
  const meta = (identity: string) => {
    const value = metadata.get(identity);
    if (!value) {
      const filename = fileURLToPath(identity);
      const created: Record<string, unknown> = Object.assign(Object.create(null), {
        url: identity,
        filename,
        dirname: path.dirname(filename),
        main: identity === entryURL,
        resolve: (id: string, parent?: unknown) => {
          if (startup.importMetaResolve && parent instanceof URL) parent = parent.href;
          if (startup.importMetaResolve && parent !== undefined && typeof parent !== 'string')
            throw fault('ERR_INVALID_ARG_TYPE', 'Parent URL must be a string');
          return resolveImport(
            String(id),
            startup.importMetaResolve && typeof parent === 'string' ? parent : identity,
            false,
          );
        },
      });
      metadata.set(identity, created);
      return created;
    }
    return value;
  };
  const loading = new Map<number, () => void>();
  const moduleIds = new Map<string, number>();
  let nextModuleId = 1;
  const release = (id: number) => {
    loading.get(id)?.();
    loading.delete(id);
  };
  // Runs as the first statement of an import's evaluation job.
  const begin = (id: number) => {
    transport.moduleContext?.begin(id);
    release(id);
  };
  function cjsNames(filename: string, seen = new Set<string>()): string[] {
    if (seen.has(filename)) return [];
    seen.add(filename);
    if (filename.startsWith('node:')) return Object.keys(Object(builtins[filename.slice(5)]));
    const parsed = parseCjs(String(fs.readFileSync(filename, 'utf8')), filename);
    return [
      ...parsed.exports,
      ...parsed.reexports.flatMap((id) => cjsNames(resolve(id, filename), seen)),
    ];
  }
  async function prepare(identity: string): Promise<string> {
    await initCjs();
    const pending = new Map<string, string>();
    const added: string[] = [];
    async function visit(identity: string): Promise<string> {
      const existing = modules.get(identity);
      if (existing) return existing;
      const filename = identity.startsWith('node:') ? identity : fileURLToPath(identity);
      const url = new URL(encodeURIComponent(identity), transport.base).href;
      modules.set(identity, url);
      added.push(identity);
      if (!isEsm(filename)) {
        if (filename.endsWith('.node') || filename.endsWith('.json'))
          throw fault(
            'ENOSYS',
            `ESM import of native addons or JSON is not yet supported: ${filename}`,
          );
        const names = cjsNames(filename);
        const exportedNames = [...new Set(names)].filter((name) => name !== 'default');
        let facade = `const value = ${bridge}.load(${JSON.stringify(filename)}); export default value;\n`;
        if (filename.startsWith('node:')) {
          for (const [index, name] of exportedNames.entries()) {
            facade += `let e${index} = value?.[${JSON.stringify(name)}]; export { e${index} as ${JSON.stringify(name)} };\n`;
          }
          if (exportedNames.length > 0) {
            const updates = exportedNames
              .map((name, index) => `e${index} = current?.[${JSON.stringify(name)}];`)
              .join(' ');
            facade += `${bridge}.registerBuiltinSync(() => { const current = ${bridge}.load(${JSON.stringify(filename)}); ${updates} });\n`;
          }
        } else {
          for (const [index, name] of exportedNames.entries()) {
            facade += `const e${index} = value?.[${JSON.stringify(name)}]; export { e${index} as ${JSON.stringify(name)} };\n`;
          }
        }
        pending.set(url, facade);
        return url;
      }
      let source = String(fs.readFileSync(filename, 'utf8')).replace(/^#![^\n]*/, '');
      const moduleId = nextModuleId++;
      moduleIds.set(identity, moduleId);
      const linked: number[] = [];
      source =
        transport.compileContext?.(source, filename, {
          module: moduleId,
          script: { name: url, lineOffset: 0 },
        }) ?? source;
      const [imports] = await parse(source, filename);
      const edits: { start: number; end: number; text: string }[] = [];
      for (const item of imports) {
        if (item.t === 1 && typeof item.n === 'string') {
          if (item.a >= 0) throw fault('ENOSYS', 'Import attributes are not yet supported');
          const dependency = resolveImport(item.n, identity);
          const target = await visit(dependency);
          const dependencyId = moduleIds.get(dependency);
          if (dependencyId !== undefined) linked.push(dependencyId);
          edits.push({ start: item.s - 1, end: item.e + 1, text: JSON.stringify(target) });
        } else if (item.t === 2) {
          edits.push({
            start: item.ss,
            end: item.d,
            text: `${bridge}.import.bind(null,${JSON.stringify(identity)})`,
          });
        } else if (item.t === 3) {
          edits.push({
            start: item.s,
            end: item.e,
            text: `${bridge}.meta(${JSON.stringify(identity)})`,
          });
        } else {
          throw fault('ENOSYS', 'Source/defer imports are not yet supported');
        }
      }
      for (const edit of edits.sort((a, b) => b.start - a.start)) {
        source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
      }
      transport.moduleContext?.link(moduleId, linked);
      pending.set(url, source);
      return url;
    }
    try {
      const url = await visit(identity);
      if (pending.size)
        await transport.publish(
          [...pending].map(([url, source]) => [new URL(url).pathname, source]),
        );
      return url;
    } catch (error) {
      for (const identity of added) modules.delete(identity);
      throw error;
    }
  }
  const bridgeApi = { import: importModule, load, begin, meta, registerBuiltinSync };
  async function importModule(parent: string, id: unknown, options?: unknown): Promise<unknown> {
    if (options !== undefined) throw fault('ENOSYS', 'Import attributes are not yet supported');
    if (!Object.hasOwn(globalThis, bridgeKey)) {
      Object.defineProperty(globalThis, bridgeKey, {
        value: bridgeApi,
        configurable: true,
        writable: true,
        enumerable: false,
      });
    }
    const identity = resolveImport(String(id), parent);
    const existing = evaluations.get(identity);
    if (existing) return existing;
    const evaluation = nextEvaluation++;
    // Synchronous with the guest's import() call, so this is the importer's frame.
    transport.moduleContext?.open(evaluation);
    loading.set(evaluation, transport.retain());
    const task = preparation.then(() => prepare(identity));
    // Serialize preparation, not evaluation: a graph may itself await a dynamic import.
    preparation = task.then(
      () => undefined,
      () => undefined,
    );
    const result = (async () => {
      try {
        const url = await task;
        const start = new URL(`@start/${evaluation}`, transport.base);
        const wrapper = new URL(`@load/${evaluation}`, transport.base);
        // The first dependency runs only after the browser has linked the whole
        // graph. Release import I/O ownership there; pending guest promises alone
        // must not act like live handles. The real namespace retains its identity.
        await transport.publish([
          [start.pathname, `${bridge}.begin(${evaluation});`],
          [
            wrapper.pathname,
            `import ${JSON.stringify(start.href)}; import * as namespace from ${JSON.stringify(url)}; export { namespace };`,
          ],
        ]);
        const namespace: unknown = await import(wrapper.href);
        if (!record(namespace)) throw fault('EPROTO', 'Invalid module namespace');
        return namespace.namespace;
      } finally {
        transport.moduleContext?.close(evaluation);
        release(evaluation);
      }
    })();
    evaluations.set(identity, result);
    return result;
  }
  /**
   * `failed` receives a throw from the preloads or a CommonJS entry in the same
   * turn, before any reaction the entry queued, which is when Node raises it.
   * An ESM entry's failure rejects the returned promise instead.
   */
  async function run(
    filename: string,
    cwd: string,
    failed: (error: unknown) => void,
  ): Promise<void> {
    // This realm belongs to one guest process. Native ESM resolves globals in
    // that realm, as does CJS through its ordinary five-argument wrapper.
    if (transport.compileContext) {
      const compile = transport.compileContext;
      // Every function constructor is a compilation surface. Native parsing
      // validates parameter/body boundaries before transformation; generators
      // stay generators, and async bodies are lowered like any other source.
      const install = (Native: FunctionConstructor, global: boolean) => {
        const Context = (...args: unknown[]) => {
          const original = new Native(...args.map(String));
          return new NativeFunction(
            compile('return (' + original.toString() + ');', 'Function', { generated: true }),
          )();
        };
        Context.prototype = Native.prototype;
        Object.defineProperty(Context, 'name', { configurable: true, value: Native.name });
        Object.defineProperty(Context, 'length', { configurable: true, value: 1 });
        Object.defineProperty(Native.prototype, 'constructor', {
          configurable: true,
          writable: !global,
          value: Context,
        });
        if (global)
          Object.defineProperty(globalThis, 'Function', {
            configurable: true,
            writable: true,
            value: Context,
          });
      };
      install(NativeFunction, true);
      // Reachable only through a function's prototype chain. Guest async
      // functions are lowered, but runtime-provided ones expose these.
      for (const sample of [function* () {}, async () => {}, async function* () {}])
        install(Object.getPrototypeOf(sample).constructor, false);
    }
    Object.assign(globalThis, globals, {
      Buffer,
      global: globalThis,
      [bridgeKey]: bridgeApi,
    });
    let entry: string;
    try {
      for (const preload of startup.preloads) load(preload, path.join(cwd, '__preload__.cjs'));
      entry = resolve(filename, '/entry.cjs');
      if (!isEsm(entry)) {
        load(entry);
        return;
      }
    } catch (error) {
      failed(error);
      return;
    }
    entryURL = resolveImport(pathToFileURL(entry).href, '/entry.mjs');
    await importModule('/entry.mjs', entryURL);
  }
  return { load, import: importModule, run };
}
