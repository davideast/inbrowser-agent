// The compiler lowers each async function to an ordinary function whose body is
// one call to its `__async` (or `__asyncGenerator`) helper. The engine then
// describes that function as a plain Function: its prototype, constructor and
// tag come from Function.prototype and `new` constructs it. This pass finds the
// lowered functions in compiler output and arranges for each one, when it is
// created, to get the prototype a native async function (or async generator)
// has, and for lowered `function` forms to refuse `new`. Only functions the
// compiler lowered are marked: a lowered method's text ends with a comment its
// class or object recognizes. It only inserts text, never on a new line, and
// reports each insertion so stack positions can be mapped back through it.
import { parse } from 'acorn';
import { record } from './protocol';

type Node = Record<string, unknown> & { type: string; start: number; end: number };
function isNode(value: unknown): value is Node {
  return (
    record(value) &&
    typeof value.type === 'string' &&
    typeof value.start === 'number' &&
    typeof value.end === 'number'
  );
}

/** One insertion at an offset of the compiler output. */
interface Edit {
  position: number;
  text: string;
  /** Order at one position: closes, then statements, then opens (outermost first). */
  rank: number;
}

const HELPER = /^var (__async(?:Generator)?\d*) = /gm;

/**
 * The helpers the compiler injected into `output`. A guest identifier with the
 * same spelling makes the compiler rename its own helper, so a name that also
 * occurs in `input` is the guest's, not the compiler's.
 */
function injectedHelpers(output: string, input: string): Map<string, 'a' | 'g'> {
  const helpers = new Map<string, 'a' | 'g'>();
  for (const [, name] of output.matchAll(HELPER))
    if (!new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(input))
      helpers.set(name, name.startsWith('__asyncGenerator') ? 'g' : 'a');
  return helpers;
}

/** The comment that ends the text of a lowered method of kind `kind`. */
const methodMark = (runtime: string, kind: 'a' | 'g') => `/*${runtime}.${kind}*/`;

/**
 * `runtime` names the process global whose `a`, `g`, `k`, `n`, `c`, `o`
 * and `x` members implement the marks. Returns the output unchanged when the compiler
 * lowered nothing or the output does not parse.
 */
export function markLowered(
  output: string,
  input: string,
  runtime: string,
  module: boolean,
): { source: string; insertions: Map<number, number[]> } {
  const unchanged = { source: output, insertions: new Map<number, number[]>() };
  const helpers = injectedHelpers(output, input);
  if (helpers.size === 0) return unchanged;
  let tree: unknown;
  try {
    tree = parse(output, {
      ecmaVersion: 'latest',
      sourceType: module ? 'module' : 'script',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: module,
    });
  } catch {
    return unchanged;
  }
  const edits: Edit[] = [];
  const open = (node: Node, text: string) =>
    edits.push({ position: node.start, text, rank: 2 + 1 / (1 + node.end - node.start) });
  const close = (node: Node, text: string) =>
    edits.push({ position: node.end, text, rank: (node.end - node.start) / (1 + node.end) });
  const statement = (position: number, text: string) => edits.push({ position, text, rank: 1 });

  /** The helper kind when `node` is a function the compiler lowered. */
  const lowered = (node: Node): 'a' | 'g' | undefined => {
    if (
      node.type !== 'FunctionDeclaration' &&
      node.type !== 'FunctionExpression' &&
      node.type !== 'ArrowFunctionExpression'
    )
      return undefined;
    if (node.async === true || node.generator === true || !isNode(node.body)) return undefined;
    let call: unknown = node.body;
    if (node.body.type === 'BlockStatement') {
      const body = node.body.body;
      if (!Array.isArray(body) || body.length !== 1 || !isNode(body[0])) return undefined;
      if (body[0].type !== 'ReturnStatement') return undefined;
      call = body[0].argument;
    }
    if (!isNode(call) || call.type !== 'CallExpression' || !isNode(call.callee)) return undefined;
    if (call.callee.type !== 'Identifier' || typeof call.callee.name !== 'string') return undefined;
    const kind = helpers.get(call.callee.name);
    const args = call.arguments;
    if (!kind || !Array.isArray(args) || args.length !== 3) return undefined;
    const receiver = args[0];
    const generator = args[2];
    if (
      !isNode(receiver) ||
      !(
        receiver.type === 'ThisExpression' ||
        (receiver.type === 'Literal' && receiver.value === null)
      )
    )
      return undefined;
    if (
      !isNode(generator) ||
      generator.type !== 'FunctionExpression' ||
      generator.generator !== true
    )
      return undefined;
    return kind;
  };

  /** Lowered `function` forms keep their own [[Construct]]; the body refuses it. */
  const guard = (node: Node) => {
    if (node.type === 'ArrowFunctionExpression' || !isNode(node.body)) return;
    edits.push({
      position: node.body.start + 1,
      text: ` if (new.target) ${runtime}.x(new.target);`,
      rank: 1,
    });
  };

  /** The text that names an anonymous function the way its position would have. */
  const inferredName = (node: Node, parent: Node | undefined): string | undefined => {
    if (!parent) return undefined;
    const identifier = (value: unknown) =>
      isNode(value) && value.type === 'Identifier' && typeof value.name === 'string'
        ? value.name
        : undefined;
    switch (parent.type) {
      case 'VariableDeclarator':
        return parent.init === node ? identifier(parent.id) : undefined;
      case 'AssignmentExpression':
        return parent.right === node && parent.operator === '='
          ? identifier(parent.left)
          : undefined;
      case 'AssignmentPattern':
        return parent.right === node ? identifier(parent.left) : undefined;
      case 'ExportDefaultDeclaration':
        return 'default';
      case 'Property': {
        if (parent.value !== node || parent.kind !== 'init' || parent.shorthand === true)
          return undefined;
        if (parent.computed === true) return '';
        const key = parent.key;
        const name = identifier(key) ?? (isNode(key) && key.type === 'Literal' ? key.value : null);
        // `__proto__: value` sets the prototype; it names nothing.
        if (name === '__proto__') return undefined;
        return typeof name === 'string' || typeof name === 'number' || typeof name === 'bigint'
          ? String(name)
          : undefined;
      }
      default:
        return undefined;
    }
  };

  // Statements that mark hoisted declarations, by the offset they go at.
  const scopeMarks = new Map<number, string>();
  const scopeStart = (body: Node, statements: unknown[]): number => {
    // A hashbang line stays first; the loader removes it after compilation.
    let position =
      body.type === 'StaticBlock'
        ? output.indexOf('{', body.start) + 1
        : body.type !== 'Program'
          ? body.start + 1
          : output.startsWith('#!')
            ? output.indexOf('\n') + 1
            : body.start;
    for (const item of statements)
      if (isNode(item) && item.type === 'ExpressionStatement' && typeof item.directive === 'string')
        position = item.end;
      else break;
    return position;
  };
  /**
   * The last function declaration of each name in each scope: the binding
   * holds that one when the scope is entered, so only it may be marked there.
   */
  const declared = new Map<Node, Map<string, Node>>();
  const declarations: { node: Node; scope: Node; name: string; at: number; text: string }[] = [];
  /** Class bodies and object literals that define lowered methods. */
  const containers = new Set<Node>();

  const visit = (value: unknown, parent: Node | undefined, scope: Node | undefined) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, parent, scope);
      return;
    }
    if (!isNode(value)) return;
    const node = value;
    const kind = lowered(node);
    if (kind) {
      const mark = `${runtime}.${kind}`;
      if (node.type === 'FunctionDeclaration') {
        guard(node);
        const name = isNode(node.id) && typeof node.id.name === 'string' ? node.id.name : undefined;
        // A declaration is initialized when its scope is entered, so its mark
        // goes first in that scope. An anonymous default export has no binding
        // to mark and stays an ordinary function.
        if (name && scope && parent) {
          const statements = Array.isArray(scope.body) ? scope.body : [];
          const text = `${mark}(${name});`;
          if (parent.type === 'SwitchCase')
            declarations.push({ node, scope: parent, name, at: node.start, text });
          else if (
            parent === scope ||
            ((parent.type === 'ExportNamedDeclaration' ||
              parent.type === 'ExportDefaultDeclaration') &&
              scope.type === 'Program')
          )
            declarations.push({ node, scope, name, at: scopeStart(scope, statements), text });
        }
      } else if (
        parent &&
        ((parent.type === 'MethodDefinition' && parent.value === node) ||
          (parent.type === 'Property' && parent.value === node && parent.method === true))
      ) {
        // Methods cannot be wrapped; their class or object marks them once built.
      } else if (!(parent?.type === 'CallExpression' && parent.callee === node)) {
        // A function called where it is written is never observed. Any other is
        // marked as it is created, keeping the name its position gives it.
        guard(node);
        const anonymous = node.type === 'ArrowFunctionExpression' || !isNode(node.id);
        const name = anonymous ? inferredName(node, parent) : undefined;
        // The callee of `new` is parenthesized so `new` applies to the function.
        const callee = parent?.type === 'NewExpression' && parent.callee === node ? '(' : '';
        const end = callee ? ')' : '';
        open(node, `${callee}${mark}(`);
        if (name === undefined) close(node, `)${end}`);
        else if (name === '' && parent && isNode(parent.key)) {
          // Parenthesized: the key may be a comma expression.
          open(parent.key, `${runtime}.k((`);
          close(parent.key, '))');
          close(node, `, ${runtime}.n())${end}`);
        } else close(node, `, ${JSON.stringify(name)})${end}`);
      }
    }
    if (
      node.type === 'FunctionDeclaration' &&
      isNode(node.id) &&
      typeof node.id.name === 'string'
    ) {
      const owner = parent?.type === 'SwitchCase' ? parent : scope;
      if (owner) {
        const names = declared.get(owner) ?? new Map<string, Node>();
        names.set(node.id.name, node);
        declared.set(owner, names);
      }
    }
    if (
      parent &&
      ((node.type === 'MethodDefinition' && node.kind === 'method') ||
        (node.type === 'Property' && node.method === true)) &&
      isNode(node.value)
    ) {
      const kind = lowered(node.value);
      // The method's own text ends with a comment naming this process's marks,
      // which no function the compiler did not lower here can carry.
      if (kind && isNode(node.value.body)) {
        edits.push({ position: node.value.body.end - 1, text: methodMark(runtime, kind), rank: 1 });
        containers.add(parent);
      }
    }
    const opensScope =
      node.type === 'Program' || node.type === 'BlockStatement' || node.type === 'StaticBlock';
    for (const [key, child] of Object.entries(node))
      if (key !== 'type' && typeof child === 'object' && child !== null)
        visit(child, node, opensScope ? node : scope);
  };
  visit(tree, undefined, undefined);
  for (const { node, scope, name, at, text } of declarations)
    if (declared.get(scope)?.get(name) === node)
      scopeMarks.set(at, (scopeMarks.get(at) ?? '') + text);
  for (const [position, text] of scopeMarks) statement(position, text);
  for (const container of containers)
    if (container.type === 'ClassBody')
      statement(container.end - 1, ` static { ${runtime}.c(this); }`);
    else {
      open(container, `${runtime}.o(`);
      close(container, ')');
    }
  if (edits.length === 0) return unchanged;

  edits.sort((a, b) => a.position - b.position || a.rank - b.rank);
  // Line starts of the output, to report each insertion by line and column.
  const lineStarts = [0];
  for (let index = output.indexOf('\n'); index >= 0; index = output.indexOf('\n', index + 1))
    lineStarts.push(index + 1);
  const insertions = new Map<number, number[]>();
  let line = 0;
  let source = '';
  let copied = 0;
  for (const edit of edits) {
    while (line + 1 < lineStarts.length && lineStarts[line + 1] <= edit.position) line++;
    const pairs = insertions.get(line) ?? [];
    const column = edit.position - lineStarts[line];
    // Insertions at one column add up.
    if (pairs.length && pairs[pairs.length - 2] === column)
      pairs[pairs.length - 1] += edit.text.length;
    else pairs.push(column, edit.text.length);
    insertions.set(line, pairs);
    source += output.slice(copied, edit.position) + edit.text;
    copied = edit.position;
  }
  return { source: source + output.slice(copied), insertions };
}

/**
 * The members compiled output calls (`a`, `g`, `k`, `n`, `c`, `o`, `x`). The
 * prototypes are the engine's, read before guest code runs; their
 * `constructor` is whatever the loader installed there. Every built-in the
 * marks use is captured here too, before guest code runs, and called
 * uncurried: a guest that replaces Function.prototype.toString or a Reflect
 * method neither breaks marking nor observes a call native would not make.
 */
export function createLoweredMarks(runtime: string) {
  // call.bind(call)(method, self, ...args) is method.call(self, ...args); the
  // type only states that.
  const uncurry = Function.prototype.call.bind(Function.prototype.call) as <T>(
    method: (this: T, ...args: never[]) => unknown,
    self: T,
    ...args: unknown[]
  ) => unknown;
  const sourceOf = Function.prototype.toString;
  const endsWith = String.prototype.endsWith;
  const description = Reflect.getOwnPropertyDescriptor(Symbol.prototype, 'description')?.get;
  const { ownKeys, getOwnPropertyDescriptor, getPrototypeOf, setPrototypeOf, defineProperty } =
    Reflect;
  const functionPrototype = Function.prototype;
  const create = Object.create;
  const hasOwn = Object.hasOwn;
  /**
   * The value of an own data property, read without calling anything: a
   * descriptor of an accessor has no own `value`, and an inherited one could be
   * a guest getter.
   */
  const ownValue = (target: object, property: PropertyKey): unknown => {
    const descriptor = getOwnPropertyDescriptor(target, property);
    return descriptor && hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  };
  const NativeTypeError = TypeError;
  const prototypes = {
    a: getPrototypeOf(async () => {}) as object,
    g: getPrototypeOf(async function* () {}) as object,
  };
  const nameDescriptor = (value: string): PropertyDescriptor => {
    const descriptor: PropertyDescriptor = create(null);
    descriptor.configurable = true;
    descriptor.value = value;
    return descriptor;
  };
  const mark =
    (prototype: object) =>
    (fn: unknown, name?: string): unknown => {
      if (typeof fn === 'function') {
        setPrototypeOf(fn, prototype);
        // A function's own `name` is a data property; reading it calls nothing.
        // The descriptor has no prototype, so inherited `get`/`set` are not read.
        if (name !== undefined && fn.name === '') defineProperty(fn, 'name', nameDescriptor(name));
      }
      return fn;
    };
  // ToPropertyKey, exactly: the engine converts the key of a literal. A
  // computed key accepts any value; the type only describes the result.
  const toKey = (value: unknown): PropertyKey => ownKeys({ [value as PropertyKey]: 0 })[0];
  // The key of the computed property being defined; nothing runs between
  // `k` and the `n` that reads it.
  let key: PropertyKey = '';
  const endings = { a: methodMark(runtime, 'a') + '}', g: methodMark(runtime, 'g') + '}' };
  /** Marks the own methods of `target` whose text ends with this process's mark. */
  const methods = (target: unknown) => {
    if ((typeof target !== 'object' && typeof target !== 'function') || target === null) return;
    const keys = ownKeys(target);
    for (let index = 0; index < keys.length; index++) {
      const fn = ownValue(target, keys[index]);
      if (typeof fn !== 'function' || getPrototypeOf(fn) !== functionPrototype) continue;
      const text = uncurry(sourceOf, fn);
      if (uncurry(endsWith, text, endings.a)) setPrototypeOf(fn, prototypes.a);
      else if (uncurry(endsWith, text, endings.g)) setPrototypeOf(fn, prototypes.g);
    }
  };
  return {
    a: mark(prototypes.a),
    g: mark(prototypes.g),
    k: (value: unknown): PropertyKey => (key = toKey(value)),
    n: (): string => {
      // ownKeys yields only strings and symbols.
      if (typeof key !== 'symbol') return key as string;
      const text = description ? uncurry(description, key) : undefined;
      return typeof text === 'string' ? '[' + text + ']' : '';
    },
    c: (cls: unknown) => {
      methods(cls);
      if (typeof cls === 'function') methods(ownValue(cls, 'prototype'));
    },
    o: (object: unknown) => {
      methods(object);
      return object;
    },
    x: (target: unknown) => {
      // The engine names the callee expression, which is not known here.
      // Only a plain own string: a `name` getter on new.target is never called.
      const own = typeof target === 'function' ? ownValue(target, 'name') : undefined;
      const name = typeof own === 'string' ? own : '';
      throw new NativeTypeError((name || '(intermediate value)') + ' is not a constructor');
    },
  };
}
