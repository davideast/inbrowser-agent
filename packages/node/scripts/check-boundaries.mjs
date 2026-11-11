import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const defaultSrcRoot = fileURLToPath(new URL('../src', import.meta.url));
const root = process.argv[2] ? path.resolve(process.argv[2]) : defaultSrcRoot;
const failures = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(filename);
      continue;
    }
    if (!/\.[cm]?[jt]s$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
    const file = path.relative(root, filename);
    const source = ts.createSourceFile(
      file,
      await readFile(filename, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    function checkImport(name) {
      if (name.startsWith('node:')) failures.push(`${file}: Node-host import ${name}`);
      if ((name === 'memfs' || name.startsWith('memfs/')) && file !== 'kernel.ts')
        failures.push(`${file}: only kernel owns memfs`);
      const local = path.resolve(path.dirname(filename), name).replace(/\.[cm]?[jt]s$/, '');
      if (local === path.join(root, 'kernel') && file !== 'kernel.ts')
        failures.push(`${file}: kernel must run across the worker boundary`);
    }
    function visit(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        checkImport(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          node.expression.getText(source) === 'require')
      ) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) checkImport(arg.text);
        else if (!(file === 'loader.ts' && node.expression.kind === ts.SyntaxKind.ImportKeyword))
          failures.push(`${file}: nonliteral host imports cannot be checked`);
      }
      if (
        (ts.isCallExpression(node) && node.expression.getText(source) === 'eval') ||
        (ts.isNewExpression(node) && node.expression.getText(source) === 'Function')
      ) {
        if (file !== 'loader.ts') failures.push(`${file}: guest evaluation belongs in loader.ts`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}

await walk(root);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Architecture boundaries passed');
