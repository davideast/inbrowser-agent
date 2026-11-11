import type { EventEmitter } from 'events';
import { parse as acornParse } from 'acorn';
import path from 'path-browserify';
import { inspect as fallbackInspect } from 'util/';
import { builtinModules as fallbackBuiltinModules } from './builtin-modules';
import type { DomainInstance, DomainModule } from './domain';
import { invalidArgType, nodeError } from './node-errors';

export const REPL_MODE_SLOPPY = Symbol('repl-sloppy');
export const REPL_MODE_STRICT = Symbol('repl-strict');

const kBufferedCommandSymbol = Symbol('bufferedCommand');

export interface ReplDeps {
  process: EventEmitter;
  fs: Record<string, unknown>;
  cwd: () => string;
  util: Record<string, unknown>;
  events: unknown;
  readline: unknown;
  stream: unknown;
  console: Record<string, unknown>;
  vm: unknown;
  module: unknown;
  getDomainModule: () => DomainModule;
}

export interface ReplCommand {
  help?: string;
  action: (this: ReplServerInstance, text: string) => void;
}

export interface ReplServerInstance extends EventEmitter {
  context: Record<string, unknown>;
  input: EventEmitter;
  output: { write: (chunk: string) => boolean; isTTY?: boolean };
  commands: Record<string, ReplCommand>;
  lines: string[] & { level?: unknown[] };
  editorMode: boolean;
  useColors: boolean;
  useGlobal: boolean;
  ignoreUndefined: boolean;
  replMode: symbol;
  terminal: boolean;
  last: unknown;
  lastError: unknown;
  underscoreAssigned: boolean;
  underscoreErrAssigned: boolean;
  writer: ((obj: unknown) => string) & { options?: Record<string, unknown> };
  eval: (
    code: string,
    context: Record<string, unknown>,
    file: string,
    cb: (err: unknown, result?: unknown) => void,
  ) => void;
  _domain: DomainInstance;
  _initialPrompt: string;
  [kBufferedCommandSymbol]: string;
  setPrompt: (prompt: string) => void;
  getPrompt: () => string;
  prompt: (preserveCursor?: boolean) => void;
  close: () => void;
  write: (data: string, key?: Record<string, unknown>) => void;
  clearBufferedCommand: () => void;
  defineCommand: (
    keyword: string,
    cmd: ReplCommand | ((this: ReplServerInstance, text: string) => void),
  ) => void;
  displayPrompt: (preserveCursor?: boolean) => void;
  setupHistory: (
    historyConfig: unknown,
    cb: (err: Error | null, repl: ReplServerInstance) => void,
  ) => void;
  resetContext: () => Record<string, unknown>;
  createContext: () => Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isObjectOrFunction(value: unknown): value is Record<string, unknown> {
  return (value !== null && typeof value === 'object') || typeof value === 'function';
}

export interface RecoverableInstance extends SyntaxError {
  err: Error;
}

export interface RecoverableConstructor {
  new (err: Error): RecoverableInstance;
  (this: RecoverableInstance, err: Error): void;
  prototype: RecoverableInstance;
}

function RecoverableImpl(this: unknown, err: Error): RecoverableInstance {
  if (!(this instanceof Recoverable)) {
    return new Recoverable(err);
  }
  this.err = err;
  return this;
}
Object.setPrototypeOf(RecoverableImpl.prototype, SyntaxError.prototype);
Object.setPrototypeOf(RecoverableImpl, SyntaxError);
// Invariant: `RecoverableImpl` constructs instances inheriting from `SyntaxError.prototype`.
export const Recoverable = RecoverableImpl as unknown as RecoverableConstructor;

interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

function isAstNode(value: unknown): value is AstNode {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    typeof value.start === 'number' &&
    typeof value.end === 'number'
  );
}

function createReplLines(): string[] & { level: unknown[] } {
  const arr: string[] = [];
  const level: unknown[] = [];
  return Object.assign(arr, { level });
}

function collectPatternNames(pattern: unknown, out: string[]): void {
  if (!isRecord(pattern)) return;
  const type = pattern.type;
  if (type === 'Identifier' && typeof pattern.name === 'string') {
    out.push(pattern.name);
  } else if (type === 'ObjectPattern' && Array.isArray(pattern.properties)) {
    for (const prop of pattern.properties) {
      if (isRecord(prop)) {
        collectPatternNames(prop.type === 'Property' ? prop.value : prop.argument, out);
      }
    }
  } else if (type === 'ArrayPattern' && Array.isArray(pattern.elements)) {
    for (const el of pattern.elements) {
      collectPatternNames(el, out);
    }
  } else if (type === 'AssignmentPattern') {
    collectPatternNames(pattern.left, out);
  } else if (type === 'RestElement') {
    collectPatternNames(pattern.argument, out);
  }
}

function containsTopLevelAwait(node: unknown): boolean {
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      for (const child of cur) stack.push(child);
      continue;
    }
    if (!isRecord(cur)) continue;
    const t = cur.type;
    if (
      t === 'FunctionDeclaration' ||
      t === 'FunctionExpression' ||
      t === 'ArrowFunctionExpression'
    ) {
      continue;
    }
    if (t === 'AwaitExpression') return true;
    if (t === 'ForOfStatement' && cur.await === true) return true;
    for (const val of Object.values(cur)) {
      if (val !== null && typeof val === 'object') {
        stack.push(val);
      }
    }
  }
  return false;
}

function isObjectLiteralCandidate(src: string): boolean {
  const trimmed = src.trim();
  return trimmed.startsWith('{') && trimmed.endsWith('}');
}

function isRecoverableSyntaxError(err: unknown, code: string): boolean {
  if (!(err instanceof SyntaxError)) return false;
  const msg = err.message;
  if (
    /Unexpected end of input/i.test(msg) ||
    /Unterminated/i.test(msg) ||
    /Unexpected token \)/i.test(msg)
  ) {
    const pos = Reflect.get(err, 'pos');
    if (typeof pos === 'number') {
      return pos >= code.trimEnd().length;
    }
    return /Unexpected end of input|Unterminated/i.test(msg);
  }
  return false;
}

interface PreparedReplCode {
  script: string;
  isAsync: boolean;
}

/**
 * Rewrites REPL input into `var`-hoisted code compatible with `vm.runInContext`,
 * supporting persistent `const`/`let`/`class` bindings, `{ a: 1 }` object literal
 * convenience wrapping, and top-level `await`.
 */
function prepareReplCode(rawCode: string, strictMode: boolean): PreparedReplCode {
  // Try object literal convenience wrapping `{ a: 1 }` -> `({ a: 1 })` first when no `;` at end
  if (isObjectLiteralCandidate(rawCode)) {
    try {
      const wrappedObj = `(${rawCode}\n)`;
      acornParse(wrappedObj, { ecmaVersion: 'latest', sourceType: 'script' });
      return { script: strictMode ? `'use strict';\n${wrappedObj}` : wrappedObj, isAsync: false };
    } catch {
      // Fall through to normal statement/TLA parsing
    }
  }

  // Check if code contains top-level `await` by parsing inside `(async () => { ... })()`
  const asyncPrefix = '(async () => { ';
  const asyncSuffix = '\n})()';
  const asyncWrapped = `${asyncPrefix}${rawCode}${asyncSuffix}`;
  let parsedProgram: AstNode | undefined;
  let parsedAsAsync = false;

  try {
    const ast: unknown = acornParse(rawCode, {
      ecmaVersion: 'latest',
      sourceType: 'script',
    });
    if (isAstNode(ast)) parsedProgram = ast;
  } catch (syncErr) {
    if (rawCode.includes('await')) {
      try {
        const ast: unknown = acornParse(asyncWrapped, {
          ecmaVersion: 'latest',
          sourceType: 'script',
        });
        if (isAstNode(ast)) parsedProgram = ast;
        parsedAsAsync = true;
      } catch (asyncErr) {
        if (
          isRecoverableSyntaxError(asyncErr, asyncWrapped) ||
          isRecoverableSyntaxError(syncErr, rawCode)
        ) {
          throw new Recoverable(
            syncErr instanceof Error ? syncErr : new SyntaxError(String(syncErr)),
          );
        }
        throw syncErr;
      }
    } else {
      if (isRecoverableSyntaxError(syncErr, rawCode)) {
        throw new Recoverable(
          syncErr instanceof Error ? syncErr : new SyntaxError(String(syncErr)),
        );
      }
      throw syncErr;
    }
  }

  if (parsedAsAsync && parsedProgram) {
    const bodyArr = Reflect.get(parsedProgram, 'body');
    const exprStmt = Array.isArray(bodyArr) ? bodyArr[0] : undefined;
    const callExpr = isRecord(exprStmt) ? exprStmt.expression : undefined;
    const arrowFn = isRecord(callExpr) ? callExpr.callee : undefined;
    const blockBody = isRecord(arrowFn) ? arrowFn.body : undefined;
    if (
      !isRecord(blockBody) ||
      !Array.isArray(blockBody.body) ||
      !containsTopLevelAwait(blockBody)
    ) {
      throw new SyntaxError('Unexpected await');
    }
    const statements = blockBody.body.filter(isAstNode);
    const hoistedVars = new Set<string>();
    const edits: Array<{ start: number; end: number; text: string }> = [];

    for (let idx = 0; idx < statements.length; idx += 1) {
      const stmt = statements[idx];
      const isLast = idx === statements.length - 1;
      if (stmt.type === 'VariableDeclaration' && Array.isArray(stmt.declarations)) {
        const decls = stmt.declarations.filter(isAstNode);
        const assignParts: string[] = [];
        for (const d of decls) {
          const names: string[] = [];
          collectPatternNames(d.id, names);
          for (const n of names) hoistedVars.add(n);
          if (isAstNode(d.id)) {
            const idText = asyncWrapped.slice(d.id.start, d.id.end);
            const initText = isAstNode(d.init)
              ? asyncWrapped.slice(d.init.start, d.init.end)
              : 'undefined';
            assignParts.push(`(${idText} = ${initText})`);
          }
        }
        edits.push({
          start: stmt.start,
          end: stmt.end,
          text: `void (${assignParts.join(', ')});`,
        });
      } else if (
        stmt.type === 'ClassDeclaration' &&
        isRecord(stmt.id) &&
        typeof stmt.id.name === 'string'
      ) {
        const name = stmt.id.name;
        hoistedVars.add(name);
        const classExpr = asyncWrapped.slice(stmt.start, stmt.end);
        edits.push({
          start: stmt.start,
          end: stmt.end,
          text: `void (${name} = ${classExpr});`,
        });
      } else if (
        stmt.type === 'FunctionDeclaration' &&
        isRecord(stmt.id) &&
        typeof stmt.id.name === 'string'
      ) {
        const name = stmt.id.name;
        hoistedVars.add(name);
        const fnText = asyncWrapped.slice(stmt.start, stmt.end);
        edits.push({
          start: stmt.start,
          end: stmt.end,
          text: `${fnText}; void (${name});`,
        });
      } else if (isLast && stmt.type === 'ExpressionStatement' && isAstNode(stmt.expression)) {
        const exprText = asyncWrapped.slice(stmt.expression.start, stmt.expression.end);
        edits.push({
          start: stmt.start,
          end: stmt.end,
          text: `return (${exprText});`,
        });
      }
    }

    let rewritten = asyncWrapped;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end);
    }
    const hoistPrefix = hoistedVars.size > 0 ? `var ${[...hoistedVars].join(', ')}; ` : '';
    return { script: `${hoistPrefix}${rewritten}`, isAsync: true };
  }

  // Synchronous script: rewrite top-level `let`/`const`/`class` into `var` so `vm.runInContext` persists them!
  const bodyStatements = Array.isArray(parsedProgram?.body)
    ? parsedProgram.body.filter(isAstNode)
    : [];
  const hoistedVars: string[] = [];
  const edits: Array<{ start: number; end: number; text: string }> = [];

  for (const stmt of bodyStatements) {
    if (
      stmt.type === 'VariableDeclaration' &&
      stmt.kind !== 'var' &&
      Array.isArray(stmt.declarations)
    ) {
      const decls = stmt.declarations.filter(isAstNode);
      const assignParts: string[] = [];
      for (const d of decls) {
        collectPatternNames(d.id, hoistedVars);
        if (isAstNode(d.id)) {
          const idText = rawCode.slice(d.id.start, d.id.end);
          const initText = isAstNode(d.init)
            ? rawCode.slice(d.init.start, d.init.end)
            : 'undefined';
          assignParts.push(`(${idText} = ${initText})`);
        }
      }
      edits.push({
        start: stmt.start,
        end: stmt.end,
        text: `void (${assignParts.join(', ')});`,
      });
    } else if (
      stmt.type === 'ClassDeclaration' &&
      isRecord(stmt.id) &&
      typeof stmt.id.name === 'string'
    ) {
      const name = stmt.id.name;
      hoistedVars.push(name);
      const classText = rawCode.slice(stmt.start, stmt.end);
      edits.push({
        start: stmt.start,
        end: stmt.end,
        text: `void (${name} = (${classText}));`,
      });
    }
  }

  let out = rawCode;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  const uniqueHoisted = [...new Set(hoistedVars)];
  const hoistCode = uniqueHoisted.length > 0 ? `var ${uniqueHoisted.join(', ')};\n` : '';
  const strictPrefix = strictMode && uniqueHoisted.length === 0 ? `'use strict';\n` : '';
  return { script: `${strictPrefix}${hoistCode}${out}`, isAsync: false };
}

export function createReplBuiltin(deps: ReplDeps): Record<string, unknown> {
  const rawInspect = deps.util.inspect;
  const inspectFn = (val: unknown, opts?: Record<string, unknown>): string => {
    if (typeof rawInspect === 'function') {
      return String(Reflect.apply(rawInspect, deps.util, [val, opts]));
    }
    return fallbackInspect(val, opts);
  };

  const writerOptions: Record<string, unknown> =
    isObjectOrFunction(deps.util.inspect) && isRecord(deps.util.inspect.defaultOptions)
      ? { ...deps.util.inspect.defaultOptions, showProxy: true }
      : { showProxy: true };

  const writer = Object.assign(
    function writer(obj: unknown): string {
      return inspectFn(obj, writerOptions);
    },
    { options: writerOptions },
  );

  const rawReadline = deps.readline;
  if (!isObjectOrFunction(rawReadline) || typeof rawReadline.Interface !== 'function') {
    throw new TypeError('repl requires readline.Interface');
  }
  // Invariant: narrowed `rawReadline.Interface` to constructor function above.
  const ReadlineInterface = rawReadline.Interface as unknown as {
    new (...args: unknown[]): EventEmitter;
    prototype: Record<string, unknown>;
  };

  if (!isObjectOrFunction(deps.vm)) {
    throw new TypeError('repl requires vm module');
  }
  const vmRecord: Record<string, unknown> = deps.vm;

  const moduleObj = deps.module;
  const rawBuiltinModules =
    isObjectOrFunction(moduleObj) && Array.isArray(moduleObj.builtinModules)
      ? moduleObj.builtinModules.map(String)
      : [...fallbackBuiltinModules];
  let builtinLibs = rawBuiltinModules.filter((name) => !name.startsWith('_'));

  let nextReplId = 1;

  function addBuiltinsToContext(
    context: Record<string, unknown>,
    loadBuiltin: (id: string) => unknown,
  ): void {
    for (const name of builtinLibs) {
      if (name.includes('/') || Object.prototype.hasOwnProperty.call(context, name)) {
        continue;
      }
      const setReal = (val: unknown): void => {
        Reflect.deleteProperty(context, name);
        context[name] = val;
      };
      Object.defineProperty(context, name, {
        get() {
          const lib = loadBuiltin(name);
          try {
            Object.defineProperty(context, name, {
              get: () => lib,
              set: setReal,
              configurable: true,
              enumerable: false,
            });
          } catch {
            // Ignore non-configurable overrides
          }
          return lib;
        },
        set: setReal,
        configurable: true,
        enumerable: false,
      });
    }
  }

  function REPLServer(
    this: unknown,
    prompt?: unknown,
    stream?: unknown,
    evalArg?: unknown,
    useGlobal?: unknown,
    ignoreUndefined?: unknown,
    replMode?: unknown,
  ): ReplServerInstance {
    if (!new.target) {
      const constructed: unknown = Reflect.construct(REPLServer, [
        prompt,
        stream,
        evalArg,
        useGlobal,
        ignoreUndefined,
        replMode,
      ]);
      // Invariant: `REPLServer` constructs a `ReplServerInstance`.
      return constructed as ReplServerInstance;
    }

    let options: Record<string, unknown>;
    let resolvedPrompt = prompt;
    let resolvedStream = stream;
    let resolvedEval = evalArg;
    let resolvedUseGlobal = useGlobal;
    let resolvedIgnoreUndefined = ignoreUndefined;
    let resolvedReplMode = replMode;

    if (isRecord(prompt)) {
      options = { ...prompt };
      resolvedStream = options.stream ?? options.socket;
      resolvedEval = options.eval;
      resolvedUseGlobal = options.useGlobal;
      resolvedIgnoreUndefined = options.ignoreUndefined;
      resolvedPrompt = options.prompt;
      resolvedReplMode = options.replMode;
    } else {
      options = {};
    }

    if (!options.input && !options.output) {
      const fallbackSource = isRecord(resolvedStream)
        ? resolvedStream
        : {
            stdin: Reflect.get(deps.process, 'stdin'),
            stdout: Reflect.get(deps.process, 'stdout'),
          };
      options.input = fallbackSource.stdin ?? fallbackSource;
      options.output = fallbackSource.stdout ?? fallbackSource;
    }

    const outCandidate = options.output;
    const isTtyOut = isRecord(outCandidate) && Boolean(outCandidate.isTTY);
    const terminal = options.terminal !== undefined ? Boolean(options.terminal) : isTtyOut;
    const useColors = options.useColors !== undefined ? Boolean(options.useColors) : terminal;

    const initialPrompt = typeof resolvedPrompt === 'string' ? resolvedPrompt : '> ';

    const defaultCompleter = (line: string, cb?: (err: null, res: [string[], string]) => void) => {
      const tuple: [string[], string] = [[], line];
      if (typeof cb === 'function') {
        cb(null, tuple);
        return undefined;
      }
      return tuple;
    };

    const constructedBase: unknown = Reflect.construct(
      ReadlineInterface,
      [
        {
          input: options.input,
          output: options.output,
          completer: typeof options.completer === 'function' ? options.completer : defaultCompleter,
          terminal,
          historySize: options.historySize,
          prompt: initialPrompt,
        },
      ],
      new.target,
    );
    // Invariant: `Reflect.construct(ReadlineInterface, ..., new.target)` constructs a `REPLServer` instance.
    const self = constructedBase as ReplServerInstance;

    self._initialPrompt = initialPrompt;
    self.useColors = useColors;
    self.useGlobal = Boolean(resolvedUseGlobal);
    self.ignoreUndefined = Boolean(resolvedIgnoreUndefined);
    self.replMode = resolvedReplMode === REPL_MODE_STRICT ? REPL_MODE_STRICT : REPL_MODE_SLOPPY;
    self.editorMode = false;
    self.underscoreAssigned = false;
    self.underscoreErrAssigned = false;
    self.last = undefined;
    self.lastError = undefined;
    self.lines = createReplLines();

    const domMod = deps.getDomainModule();
    self._domain = options.domain instanceof domMod.Domain ? options.domain : domMod.create();

    let closed = false;

    self._domain.on('error', (e: unknown) => {
      if (!self.underscoreErrAssigned) {
        self.lastError = e;
      }
      let errText = '';
      if (isRecord(e) && typeof e.stack === 'string') {
        errText = e.stack;
      } else {
        errText = self.writer(e);
      }
      const prefixed = errText.startsWith('Uncaught') ? errText : `Uncaught ${errText}`;
      self.output.write(prefixed.endsWith('\n') ? prefixed : `${prefixed}\n`);
      self.clearBufferedCommand();
      if (!closed) {
        self.displayPrompt();
      }
    });

    self.clearBufferedCommand();

    Object.defineProperty(self, 'inputStream', {
      get: () => self.input,
      set: (val: EventEmitter) => {
        self.input = val;
      },
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(self, 'outputStream', {
      get: () => self.output,
      set: (val: ReplServerInstance['output']) => {
        self.output = val;
      },
      enumerable: false,
      configurable: true,
    });

    const defaultEval = (
      code: string,
      context: Record<string, unknown>,
      file: string,
      cb: (err: unknown, result?: unknown) => void,
    ): void => {
      if (code.trim() === '') {
        cb(null);
        return;
      }
      let prepared: PreparedReplCode;
      try {
        prepared = prepareReplCode(code, self.replMode === REPL_MODE_STRICT);
      } catch (parseErr) {
        cb(parseErr);
        return;
      }

      try {
        let evaluated: unknown;
        if (self.useGlobal) {
          const runThis = vmRecord.runInThisContext;
          if (typeof runThis !== 'function') {
            throw new Error('vm.runInThisContext is unavailable');
          }
          evaluated = Reflect.apply(runThis, vmRecord, [prepared.script, { filename: file }]);
        } else {
          const runCtx = vmRecord.runInContext;
          if (typeof runCtx !== 'function') {
            throw new Error('vm.runInContext is unavailable');
          }
          evaluated = Reflect.apply(runCtx, vmRecord, [
            prepared.script,
            context,
            { filename: file },
          ]);
        }

        if (
          prepared.isAsync &&
          evaluated !== null &&
          (typeof evaluated === 'object' || typeof evaluated === 'function')
        ) {
          const thenCandidate = Reflect.get(evaluated, 'then');
          if (typeof thenCandidate === 'function') {
            Reflect.apply(thenCandidate, evaluated, [
              (val: unknown) => cb(null, val),
              (err: unknown) => cb(err ?? new Error('Unhandled rejection')),
            ]);
            return;
          }
        }

        cb(null, evaluated);
      } catch (execErr) {
        cb(execErr);
      }
    };

    if (resolvedEval !== undefined && typeof resolvedEval !== 'function') {
      throw invalidArgType('options.eval', 'function', resolvedEval);
    }
    if (typeof resolvedEval === 'function') {
      // Invariant: narrowed `resolvedEval` to function above.
      self.eval = resolvedEval as ReplServerInstance['eval'];
    } else {
      self.eval = defaultEval;
    }

    if (typeof options.writer === 'function') {
      // Invariant: narrowed `options.writer` to function above.
      self.writer = options.writer as ReplServerInstance['writer'];
    } else {
      self.writer = writer;
    }
    if (self.writer === writer) {
      writerOptions.colors = self.useColors;
    }

    const rawCommands: Record<string, ReplCommand> = Object.create(null);
    self.commands = rawCommands;
    defineDefaultCommands(self, deps.fs);
    self.resetContext();

    let sawSIGINT = false;

    self.on('close', () => {
      if (!closed) {
        closed = true;
        self.emit('exit');
      }
    });

    self.on('SIGINT', () => {
      const rawLine = Reflect.get(self, 'line');
      const currentLine = typeof rawLine === 'string' ? rawLine : '';
      const hasBuffered = self[kBufferedCommandSymbol].length > 0;
      const clearLineFn = Reflect.get(self, 'clearLine');
      if (typeof clearLineFn === 'function') {
        Reflect.apply(clearLineFn, self, []);
      }
      if (!hasBuffered && currentLine.length === 0) {
        if (sawSIGINT) {
          self.close();
          sawSIGINT = false;
          return;
        }
        self.output.write('(To exit, press Ctrl+C again or Ctrl+D or type .exit)\n');
        sawSIGINT = true;
      } else {
        sawSIGINT = false;
      }
      self.clearBufferedCommand();
      self.displayPrompt();
    });

    self.on('line', (rawCmd: unknown) => {
      const cmd = typeof rawCmd === 'string' ? rawCmd : String(rawCmd ?? '');
      sawSIGINT = false;

      if (self.editorMode) {
        self[kBufferedCommandSymbol] += `${cmd}\n`;
        self.lines.push(cmd);
        return;
      }

      const trimmed = cmd.trim();
      if (
        trimmed.length > 0 &&
        trimmed[0] === '.' &&
        trimmed[1] !== '.' &&
        Number.isNaN(Number.parseFloat(trimmed))
      ) {
        const match = /^\.([^\s]+)\s*(.*)$/.exec(trimmed);
        const keyword = match?.[1];
        const rest = match?.[2] ?? '';
        if (keyword && Object.prototype.hasOwnProperty.call(self.commands, keyword)) {
          const entry = self.commands[keyword];
          Reflect.apply(entry.action, self, [rest]);
          return;
        }
        if (!self[kBufferedCommandSymbol]) {
          self.output.write('Invalid REPL keyword\n');
          self.clearBufferedCommand();
          self.displayPrompt();
          return;
        }
      }

      const evalCmd = `${self[kBufferedCommandSymbol]}${cmd}\n`;
      self.lines.push(cmd);
      const resourceName = `REPL${nextReplId}`;
      nextReplId += 1;

      function finish(err: unknown, ret?: unknown): void {
        if (err) {
          if (err instanceof Recoverable) {
            self[kBufferedCommandSymbol] += `${cmd}\n`;
            self.displayPrompt();
            return;
          }
          const actualErr = isRecord(err) && 'err' in err && err.err ? err.err : err;
          self._domain.emit('error', actualErr);
          return;
        }

        self.clearBufferedCommand();
        if (arguments.length === 2 && (!self.ignoreUndefined || ret !== undefined)) {
          if (!self.underscoreAssigned) {
            self.last = ret;
          }
          self.output.write(`${self.writer(ret)}\n`);
        }
        if (!closed) {
          self.displayPrompt();
        }
      }

      self.eval(evalCmd, self.context, resourceName, finish);
    });

    self.displayPrompt();
    return self;
  }

  Object.setPrototypeOf(REPLServer.prototype, ReadlineInterface.prototype);
  Object.setPrototypeOf(REPLServer, ReadlineInterface);

  REPLServer.prototype.clearBufferedCommand = function clearBufferedCommand(
    this: ReplServerInstance,
  ): void {
    this[kBufferedCommandSymbol] = '';
  };

  REPLServer.prototype.displayPrompt = function displayPrompt(
    this: ReplServerInstance,
    preserveCursor?: boolean,
  ): void {
    let promptStr = this._initialPrompt;
    if (this[kBufferedCommandSymbol].length > 0) {
      promptStr = '... ';
    }
    this.setPrompt(promptStr);
    this.prompt(preserveCursor);
  };

  REPLServer.prototype.defineCommand = function defineCommand(
    this: ReplServerInstance,
    keyword: string,
    cmd: ReplCommand | ((this: ReplServerInstance, text: string) => void),
  ): void {
    if (typeof cmd === 'function') {
      this.commands[keyword] = { action: cmd };
    } else if (isRecord(cmd) && typeof cmd.action === 'function') {
      const actionFn = cmd.action;
      this.commands[keyword] = {
        help: typeof cmd.help === 'string' ? cmd.help : undefined,
        action(this: ReplServerInstance, text: string) {
          Reflect.apply(actionFn, this, [text]);
        },
      };
    } else {
      throw new TypeError('Command must be a function or an object with an action function');
    }
  };

  REPLServer.prototype.createContext = function createContext(
    this: ReplServerInstance,
  ): Record<string, unknown> {
    let context: Record<string, unknown>;
    if (this.useGlobal) {
      // Invariant: `globalThis` is an object dictionary in every JS realm.
      context = globalThis as unknown as Record<string, unknown>;
    } else {
      const createCtx = vmRecord.createContext;
      if (typeof createCtx !== 'function') {
        throw new Error('vm.createContext is unavailable');
      }
      const seed: Record<string, unknown> = {
        console: deps.console,
        process: deps.process,
        Buffer: Reflect.get(globalThis, 'Buffer'),
        setTimeout: Reflect.get(globalThis, 'setTimeout'),
        clearTimeout: Reflect.get(globalThis, 'clearTimeout'),
        setInterval: Reflect.get(globalThis, 'setInterval'),
        clearInterval: Reflect.get(globalThis, 'clearInterval'),
        setImmediate: Reflect.get(globalThis, 'setImmediate'),
        clearImmediate: Reflect.get(globalThis, 'clearImmediate'),
        queueMicrotask: Reflect.get(globalThis, 'queueMicrotask'),
      };
      seed.global = seed;
      seed.globalThis = seed;
      const createdCtx: unknown = Reflect.apply(createCtx, vmRecord, [seed]);
      if (!isRecord(createdCtx)) {
        throw new Error('vm.createContext did not return an object');
      }
      context = createdCtx;
    }

    let replReq: ((id: string) => unknown) | undefined;
    if (isObjectOrFunction(moduleObj) && typeof moduleObj.createRequire === 'function') {
      try {
        const reqPath = path.resolve(deps.cwd(), '<repl>');
        const created = Reflect.apply(moduleObj.createRequire, moduleObj, [reqPath]);
        if (typeof created === 'function') {
          replReq = (id: string) => Reflect.apply(created, undefined, [id]);
        }
      } catch {
        // Ignore if createRequire rejects synthetic path
      }
    }
    if (replReq) {
      context.require = replReq;
      addBuiltinsToContext(context, replReq);
    }

    return context;
  };

  REPLServer.prototype.resetContext = function resetContext(
    this: ReplServerInstance,
  ): Record<string, unknown> {
    this.context = this.createContext();
    this.underscoreAssigned = false;
    this.underscoreErrAssigned = false;
    this.lines = createReplLines();

    Object.defineProperty(this.context, '_', {
      configurable: true,
      get: () => this.last,
      set: (value: unknown) => {
        this.last = value;
        if (!this.underscoreAssigned) {
          this.underscoreAssigned = true;
          this.output.write('Expression assignment to _ now disabled.\n');
        }
      },
    });
    Object.defineProperty(this.context, '_error', {
      configurable: true,
      get: () => this.lastError,
      set: (value: unknown) => {
        this.lastError = value;
        if (!this.underscoreErrAssigned) {
          this.underscoreErrAssigned = true;
          this.output.write('Expression assignment to _error now disabled.\n');
        }
      },
    });

    this.emit('reset', this.context);
    return this.context;
  };

  REPLServer.prototype.setupHistory = function setupHistory(
    this: ReplServerInstance,
    historyConfig: unknown,
    cb: (err: Error | null, repl: ReplServerInstance) => void,
  ): void {
    if (typeof cb !== 'function') {
      throw invalidArgType('cb', 'Function', cb);
    }
    void historyConfig;
    cb(null, this);
  };

  function defineDefaultCommands(repl: ReplServerInstance, fsObj: Record<string, unknown>): void {
    repl.defineCommand('break', {
      help: 'Sometimes you get stuck, this gets you out',
      action() {
        this.clearBufferedCommand();
        this.displayPrompt();
      },
    });

    const clearHelp = repl.useGlobal
      ? 'Alias for .break'
      : 'Break, and also clear the local context';
    repl.defineCommand('clear', {
      help: clearHelp,
      action() {
        this.clearBufferedCommand();
        if (!this.useGlobal) {
          this.output.write('Clearing context...\n');
          this.resetContext();
        }
        this.displayPrompt();
      },
    });

    repl.defineCommand('exit', {
      help: 'Exit the REPL',
      action() {
        this.close();
      },
    });

    repl.defineCommand('help', {
      help: 'Print this help message',
      action() {
        const names = Object.keys(this.commands).sort();
        const longest = names.reduce((max, n) => Math.max(max, n.length), 0);
        for (const name of names) {
          const cmd = this.commands[name];
          const pad = ' '.repeat(longest - name.length + 3);
          const line = `.${name}${cmd.help ? `${pad}${cmd.help}` : ''}\n`;
          this.output.write(line);
        }
        this.output.write('\nPress Ctrl+C to abort current expression, Ctrl+D to exit the REPL\n');
        this.displayPrompt();
      },
    });

    repl.defineCommand('save', {
      help: 'Save all evaluated commands in this REPL session to a file',
      action(file: string) {
        try {
          if (file === '') {
            throw nodeError(TypeError, 'ERR_MISSING_ARGS', 'The "file" argument must be specified');
          }
          const writeSync = fsObj.writeFileSync;
          if (typeof writeSync !== 'function') throw new Error('fs.writeFileSync unavailable');
          Reflect.apply(writeSync, fsObj, [file, this.lines.join('\n')]);
          this.output.write(`Session saved to: ${file}\n`);
        } catch (err) {
          if (isRecord(err) && err.code === 'ERR_MISSING_ARGS' && typeof err.message === 'string') {
            this.output.write(`${err.message}\n`);
          } else {
            this.output.write(`Failed to save: ${file}\n`);
          }
        }
        this.displayPrompt();
      },
    });

    repl.defineCommand('load', {
      help: 'Load JS from a file into the REPL session',
      action(file: string) {
        try {
          if (file === '') {
            throw nodeError(TypeError, 'ERR_MISSING_ARGS', 'The "file" argument must be specified');
          }
          const statSync = fsObj.statSync;
          const readSync = fsObj.readFileSync;
          const stats =
            typeof statSync === 'function' ? Reflect.apply(statSync, fsObj, [file]) : null;
          if (
            isRecord(stats) &&
            typeof stats.isFile === 'function' &&
            stats.isFile() &&
            typeof readSync === 'function'
          ) {
            this.editorMode = true;
            this.setPrompt('');
            const content = String(Reflect.apply(readSync, fsObj, [file, 'utf8']));
            this.write(content);
            this.editorMode = false;
            this.setPrompt(this._initialPrompt);
            this.write('\n');
          } else {
            this.output.write(`Failed to load: ${file} is not a valid file\n`);
          }
        } catch (err) {
          if (isRecord(err) && err.code === 'ERR_MISSING_ARGS' && typeof err.message === 'string') {
            this.output.write(`${err.message}\n`);
          } else {
            this.output.write(`Failed to load: ${file}\n`);
          }
        }
        this.displayPrompt();
      },
    });

    if (repl.terminal) {
      repl.defineCommand('editor', {
        help: 'Enter editor mode',
        action() {
          this.editorMode = true;
          this.setPrompt('');
          this.output.write('// Entering editor mode (Ctrl+D to finish, Ctrl+C to cancel)\n');
        },
      });
    }
  }

  function start(
    prompt?: unknown,
    source?: unknown,
    evalArg?: unknown,
    useGlobal?: unknown,
    ignoreUndefined?: unknown,
    replMode?: unknown,
  ): ReplServerInstance {
    const constructed: unknown = Reflect.construct(REPLServer, [
      prompt,
      source,
      evalArg,
      useGlobal,
      ignoreUndefined,
      replMode,
    ]);
    // Invariant: `REPLServer` constructs a `ReplServerInstance`.
    return constructed as ReplServerInstance;
  }

  const replExports: Record<string, unknown> = {
    start,
    writer,
    REPLServer,
    REPL_MODE_SLOPPY,
    REPL_MODE_STRICT,
    Recoverable,
  };

  Object.defineProperty(replExports, 'builtinModules', {
    get: () => builtinLibs,
    set: (val: string[]) => {
      builtinLibs = val;
    },
    enumerable: false,
    configurable: true,
  });

  Object.defineProperty(replExports, '_builtinLibs', {
    get: () => builtinLibs,
    set: (val: string[]) => {
      builtinLibs = val;
    },
    enumerable: false,
    configurable: true,
  });

  return replExports;
}
