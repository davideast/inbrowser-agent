import { parse } from 'acorn';
import { decoder, encoder, fault, record } from './protocol';
import { resourceLimits } from './resource-policy';

function invalidType(message: string): TypeError {
  return Object.assign(new TypeError(message), { code: 'ERR_INVALID_ARG_TYPE' });
}

type Program = ReturnType<typeof parse>;

/** Validates source, options and syntax. Returns the parsed program and its label. */
function parseVmSource(code: unknown, options: unknown): { program: Program; label: string } {
  if (typeof code !== 'string') throw invalidType('VM source must be a string');
  if (encoder.encode(code).length > resourceLimits().modules.sourceBytes)
    throw fault('E2BIG', 'VM source exceeds 8 MiB');
  if (options === undefined) options = {};
  if (typeof options === 'string') options = { filename: options };
  if (!record(options) || Array.isArray(options))
    throw invalidType('VM options must be an object or filename');
  if (
    Object.getPrototypeOf(options) !== Object.prototype &&
    Object.getPrototypeOf(options) !== null
  )
    throw fault('ENOSYS', 'VM options with custom prototypes are not implemented');
  for (const key of Reflect.ownKeys(options)) {
    if (key !== 'filename' && key !== 'lineOffset' && key !== 'columnOffset')
      throw fault('ENOSYS', `Unsupported VM option ${String(key)}`);
  }
  const filename = options.filename === undefined ? 'evalmachine.<anonymous>' : options.filename;
  if (typeof filename !== 'string') throw invalidType('VM filename must be a string');
  const label = sourceLabel(filename);
  checkOffsets(options);
  // These two fields are accepted diagnostic hints. Browser sourceURL labels do
  // not apply Node's line/column offsets; raw stack positions remain browser ones.
  const program = parse(code, { ecmaVersion: 'latest', sourceType: 'script' });
  return { program, label };
}

function checkOffsets(options: Record<string, unknown>): void {
  for (const key of ['lineOffset', 'columnOffset']) {
    const value = options[key] === undefined ? 0 : options[key];
    if (typeof value !== 'number') throw invalidType(`VM ${key} must be a number`);
    if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)
      throw Object.assign(new RangeError(`VM ${key} must be a signed 32-bit integer`), {
        code: 'ERR_OUT_OF_RANGE',
      });
  }
}

/** The sourceURL comment that names guest source in browser stacks. */
function sourceLabel(filename: string): string {
  if (filename.length > 4096 || /[\r\n\u2028\u2029]/.test(filename))
    throw fault('ENOSYS', 'VM source labels require a single line of at most 4096 characters');
  // UTF-8 round-tripping replaces lone surrogates in a diagnostic label without
  // preventing otherwise valid guest execution. Whitespace is URI-encoded.
  return '\n//# sourceURL=' + encodeURI(decoder.decode(encoder.encode(filename)));
}

/**
 * Validate the entire tree before execution, including imports inside functions
 * that might be called later. Native browser import must not bypass the loader.
 */
function rejectImports(program: Program): void {
  const pending: unknown[] = [program];
  while (pending.length) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      for (const value of node) pending.push(value);
    } else if (record(node)) {
      if (node.type === 'ImportExpression')
        throw fault('ENOSYS', 'VM dynamic import callbacks are not implemented');
      for (const value of Object.values(node))
        if (typeof value === 'object' && value !== null) pending.push(value);
    }
  }
}

/** Throws the syntax and option errors `new vm.Script` reports at construction. */
export function checkVmSource(code: unknown, options: unknown = {}): void {
  parseVmSource(code, options);
}

export function prepareVmSource(code: unknown, options: unknown = {}): string {
  const { program, label } = parseVmSource(code, options);
  if (
    program.body.some(
      (statement) =>
        statement.type !== 'ExpressionStatement' && statement.type !== 'EmptyStatement',
    )
  )
    throw fault(
      'ENOSYS',
      'VM supports expression scripts; persistent top-level declarations and control flow are not implemented',
    );
  rejectImports(program);
  return code + label;
}

const FUNCTION_NODES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ClassDeclaration',
  'ClassExpression',
]);

function bindingNames(pattern: unknown, names: string[]): void {
  if (!record(pattern)) return;
  if (pattern.type === 'Identifier' && typeof pattern.name === 'string') names.push(pattern.name);
  else if (pattern.type === 'ObjectPattern' && Array.isArray(pattern.properties))
    for (const property of pattern.properties)
      bindingNames(
        record(property) && property.type === 'Property' ? property.value : property,
        names,
      );
  else if (pattern.type === 'ArrayPattern' && Array.isArray(pattern.elements))
    for (const element of pattern.elements) bindingNames(element, names);
  else if (pattern.type === 'AssignmentPattern') bindingNames(pattern.left, names);
  else if (pattern.type === 'RestElement') bindingNames(pattern.argument, names);
}

/**
 * A script's var-scoped declarations: `var` names anywhere outside functions and
 * classes, and function declarations directly in the script body. `nested`
 * receives function declarations inside blocks (Annex B hoists them).
 */
function scriptDeclarations(program: Program) {
  const vars: string[] = [];
  const functions: string[] = [];
  let nested = false;
  const visit = (node: unknown, top: boolean): void => {
    if (Array.isArray(node)) {
      for (const value of node) visit(value, top);
      return;
    }
    if (!record(node)) return;
    if (node.type === 'FunctionDeclaration') {
      if (!top) nested = true;
      else if (record(node.id) && typeof node.id.name === 'string') functions.push(node.id.name);
      return;
    }
    if (typeof node.type === 'string' && FUNCTION_NODES.has(node.type)) return;
    if (
      node.type === 'VariableDeclaration' &&
      node.kind === 'var' &&
      Array.isArray(node.declarations)
    )
      for (const declaration of node.declarations)
        if (record(declaration)) bindingNames(declaration.id, vars);
    for (const value of Object.values(node))
      if (typeof value === 'object' && value !== null) visit(value, false);
  };
  for (const statement of program.body) visit(statement, true);
  return { vars, functions, nested };
}

function strictBody(statements: readonly unknown[]): boolean {
  for (const statement of statements) {
    if (!record(statement) || typeof statement.directive !== 'string') return false;
    if (statement.directive === 'use strict') return true;
  }
  return false;
}

export interface VmContextSource {
  /** Source with its sourceURL label, ready for the compiler. */
  source: string;
  strict: boolean;
  /** Function declarations the context receives before the script body runs. */
  functions: string[];
  /** Every var-scoped name the guest declared, so compiler-added ones can be told apart. */
  declared: Set<string>;
}

/**
 * The context-evaluation policy: var and function declarations, control flow and
 * expressions in sloppy scripts. Shapes whose native effect is a binding this
 * same-realm approximation cannot keep reject with ENOSYS before any effect.
 */
export function prepareVmContextSource(code: unknown, options: unknown = {}): VmContextSource {
  const { program, label } = parseVmSource(code, options);
  for (const statement of program.body) {
    if (
      statement.type === 'ClassDeclaration' ||
      (statement.type === 'VariableDeclaration' && statement.kind !== 'var')
    )
      throw fault(
        'ENOSYS',
        'VM context scripts cannot keep top-level let, const or class bindings between runs',
      );
  }
  const strict = strictBody(program.body);
  const { vars, functions, nested } = scriptDeclarations(program);
  if (nested) throw fault('ENOSYS', 'VM context scripts with block-level function declarations');
  if (strict && (vars.length || functions.length))
    throw fault('ENOSYS', 'VM context scripts with declarations in strict mode');
  rejectImports(program);
  return {
    source: String(code) + label,
    strict,
    functions,
    declared: new Set([...vars, ...functions]),
  };
}

/** Names a compiler added at the top of `compiled` that the guest did not declare. */
export function addedDeclarations(compiled: string, declared: Set<string>): Set<string> {
  const program = parse(compiled, { ecmaVersion: 'latest', sourceType: 'script' });
  const { vars, functions } = scriptDeclarations(program);
  return new Set([...vars, ...functions].filter((name) => !declared.has(name)));
}

export interface VmFunctionSource {
  source: string;
  strict: boolean;
  declared: Set<string>;
}

/**
 * `vm.compileFunction` source: one parenthesized function expression whose
 * parameters and body must be exactly the ones given, so neither can close the
 * wrapper early.
 */
export function prepareVmFunctionSource(
  code: string,
  params: string[],
  filename: string,
  offsets: Record<string, unknown>,
): VmFunctionSource {
  if (encoder.encode(code).length > resourceLimits().modules.sourceBytes)
    throw fault('E2BIG', 'VM source exceeds 8 MiB');
  // Node's compileFunction default filename is empty: no label then.
  const label = filename === '' ? '' : sourceLabel(filename);
  checkOffsets(offsets);
  const header = `(function (${params.join(', ')}) {\n`;
  const source = header + code + '\n})';
  const program = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const statement = program.body[0];
  const expression = statement?.type === 'ExpressionStatement' ? statement.expression : undefined;
  if (
    program.body.length !== 1 ||
    expression?.type !== 'FunctionExpression' ||
    expression.body.start !== header.length - 2 ||
    expression.body.end !== source.length - 1 ||
    expression.params.length !== params.length ||
    expression.params.some(
      (param, index) => param.type !== 'Identifier' || param.name !== params[index],
    )
  )
    throw new SyntaxError('Invalid compileFunction parameters or body');
  rejectImports(program);
  return { source: source + label, strict: strictBody(expression.body.body), declared: new Set() };
}
