import { parse } from 'acorn';
import { fault, record } from './protocol';

/** Keep direct eval syntactically direct; compile only its string argument. */
export function prepareContextSource(source: string, helper: string): string {
  if (!/\beval\b/.test(source)) return source;
  const tree = parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowReturnOutsideFunction: true,
  });
  const edits: { position: number; end?: number; text: string }[] = [];
  const seen = new Set<object>();
  function visit(value: unknown, parent?: Record<string, unknown>, mutation = false) {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, parent, mutation);
      return;
    }
    if (!record(value) || seen.has(value)) return;
    seen.add(value);
    const replace = (text: string) => {
      if (typeof value.start !== 'number' || typeof value.end !== 'number')
        throw fault('EPROTO', 'Missing syntax positions');
      edits.push({ position: value.start, end: value.end, text });
    };
    if (
      value.type === 'MemberExpression' &&
      record(value.object) &&
      value.object.type === 'Identifier' &&
      ['globalThis', 'global', 'self'].includes(String(value.object.name)) &&
      record(value.property) &&
      (value.computed ? value.property.value === 'eval' : value.property.name === 'eval')
    ) {
      if (mutation)
        throw fault('ENOSYS', 'Eval mutation is unsupported in experimental async context');
      replace(helper + '.indirect');
      return;
    }
    if (value.type === 'Identifier' && value.name === 'eval') {
      // Property names are not references to the global eval binding.
      if (parent?.type === 'MemberExpression' && parent.property === value && !parent.computed)
        return;
      if (
        parent?.type === 'Property' &&
        parent.key === value &&
        !parent.computed &&
        !parent.shorthand
      )
        return;
      if (mutation)
        throw fault('ENOSYS', 'Eval mutation is unsupported in experimental async context');
      if (
        parent?.type !== 'CallExpression' ||
        parent.callee !== value ||
        parent.optional === true
      ) {
        if (parent?.type === 'MemberExpression' && parent.property === value && !parent.computed)
          return;
        if (parent?.type === 'Property' && parent.key === value && !parent.computed) {
          if (parent.shorthand) replace('eval: ' + helper + '.indirect');
          return;
        }
        if (parent?.type === 'VariableDeclarator' && parent.id === value)
          throw fault('ENOSYS', 'Shadowed eval is unsupported in experimental async context');
        replace(helper + '.indirect');
        return;
      }
      const args = parent.arguments;
      if (
        !Array.isArray(args) ||
        args.length !== 1 ||
        !record(args[0]) ||
        args[0].type === 'SpreadElement' ||
        typeof args[0].start !== 'number' ||
        typeof args[0].end !== 'number'
      )
        throw fault('ENOSYS', 'Experimental direct eval requires one argument');
      edits.push(
        { position: args[0].start, text: helper + '(eval,' },
        { position: args[0].end, text: ')' },
      );
    }
    for (const [key, child] of Object.entries(value)) {
      const target =
        (key === 'left' &&
          [
            'AssignmentExpression',
            'AssignmentPattern',
            'ForInStatement',
            'ForOfStatement',
          ].includes(String(value.type))) ||
        (key === 'argument' &&
          (value.type === 'UpdateExpression' ||
            (value.type === 'UnaryExpression' && value.operator === 'delete')));
      if (typeof child === 'object' && child !== null) visit(child, value, mutation || target);
    }
  }
  visit(tree);
  for (const edit of edits.sort((a, b) => b.position - a.position))
    source = source.slice(0, edit.position) + edit.text + source.slice(edit.end ?? edit.position);
  return source;
}

type Node = Record<string, unknown> & { type: string; start: number; end: number };
function isNode(value: unknown): value is Node {
  return (
    record(value) &&
    typeof value.type === 'string' &&
    typeof value.start === 'number' &&
    typeof value.end === 'number'
  );
}

/**
 * The compiler cannot lower `await` at module top level: there is no function to
 * turn into a generator. Each top-level `await value` becomes
 * `helper.r(mark, helper.s(value))`, which the caller turns back into
 * `helper.r(await helper.s(value))` after compilation, so the engine suspends the
 * module and the runtime restores the awaiting frame on resume. A top-level
 * `for await` is lowered here to the same loop the compiler emits inside a
 * function. Line numbers are preserved; columns on rewritten lines are not.
 */
export function prepareModuleSource(
  source: string,
  helper: string,
  mark: string,
  id: number,
): { source: string; topLevelAwait: boolean; prologue: number } {
  const prologue = `${helper}.m(${id});`;
  const plain = { source: prologue + source, topLevelAwait: false, prologue: prologue.length };
  if (!/\bawait\b/.test(source)) return plain;
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module', preserveParens: true });
  const targets: Node[] = [];
  const visit = (value: unknown, parent?: Node) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, parent);
      return;
    }
    if (!isNode(value)) return;
    // Function bodies are lowered by the compiler; only the module body is ours.
    if (
      value.type === 'FunctionDeclaration' ||
      value.type === 'FunctionExpression' ||
      value.type === 'ArrowFunctionExpression'
    )
      return;
    if (value.type === 'VariableDeclaration' && value.kind === 'await using')
      throw fault('ENOSYS', 'Top-level await using is unsupported in experimental async context');
    if (value.type === 'AwaitExpression') targets.push(value);
    if (value.type === 'ForOfStatement' && value.await === true) {
      if (parent?.type === 'LabeledStatement')
        throw fault(
          'ENOSYS',
          'Labeled top-level for await is unsupported in experimental async context',
        );
      targets.push(value);
    }
    for (const child of Object.values(value))
      if (typeof child === 'object' && child !== null) visit(child, value);
  };
  visit(tree);
  if (!targets.length) return plain;
  targets.sort((a, b) => a.start - b.start || b.end - a.end);
  let loops = 0;
  const awaited = (text: string) => `${helper}.r(${mark},${helper}.s(${text}))`;
  // Renders [start, end) with every outermost target inside it rewritten.
  const render = (start: number, end: number, skip?: Node): string => {
    let text = '';
    let position = start;
    for (const target of targets) {
      if (target === skip || target.start < position || target.end > end) continue;
      text += source.slice(position, target.start) + rewrite(target);
      position = target.end;
    }
    return text + source.slice(position, end);
  };
  const part = (node: unknown): string => {
    if (!isNode(node)) throw fault('EPROTO', 'Missing syntax positions');
    return render(node.start, node.end);
  };
  const rewrite = (node: Node): string => {
    if (node.type === 'AwaitExpression') return awaited(part(node.argument));
    const name = (role: string) => `${helper}_${role}${loops}`;
    loops++;
    const [iterator, more, step, error, caught] = ['i', 'm', 't', 'e', 'c'].map(name);
    const left = node.left;
    if (!isNode(left)) throw fault('EPROTO', 'Missing syntax positions');
    let bind: string;
    if (left.type === 'VariableDeclaration') {
      const declarations = left.declarations;
      if (!Array.isArray(declarations) || !isNode(declarations[0]) || !isNode(declarations[0].id))
        throw fault('EPROTO', 'Missing syntax positions');
      bind = `${String(left.kind)} ${part(declarations[0].id)}=${step}.value;`;
    } else bind = `(${part(left)}=${step}.value);`;
    return (
      `{const ${iterator}=${helper}.f(${part(node.right)});let ${more},${step},${error};` +
      `try{for(;${more}=!(${step}=${awaited(`${iterator}.next()`)}).done;${more}=false){${bind}${part(node.body)}}}` +
      `catch(${caught}){${error}=[${caught}]}` +
      `finally{try{${more}&&(${step}=${iterator}.return)&&${awaited(`${step}.call(${iterator})`)}}` +
      `finally{if(${error})throw ${error}[0]}}}`
    );
  };
  return {
    source: prologue + render(0, source.length) + `\n;${helper}.l(${id});`,
    topLevelAwait: true,
    prologue: prologue.length,
  };
}
