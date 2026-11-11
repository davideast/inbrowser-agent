import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const srcRoot = path.join(repoRoot, 'src');
const preloadRoot = path.join(srcRoot, 'preload');
const puppeteerRoot = path.join(srcRoot, 'puppeteer');
const nodeBuiltins = new Set(
  builtinModules.flatMap((mod) => [
    mod,
    mod.replace(/^node:/, ''),
    `node:${mod.replace(/^node:/, '')}`,
  ]),
);

const ignoredDirs = new Set([
  '.git',
  'node_modules',
  'dist',
  'test-results',
  'playwright-report',
  'coverage',
]);

// Construct hygiene patterns dynamically so no forbidden literal appears in tracked source.
const forbiddenTextRules = [
  {
    label: 'machine-local path',
    pattern: new RegExp(['/usr', 'local', 'google'].join('/')),
  },
  {
    label: 'machine-local workspace path',
    pattern: new RegExp(['/google', 'src'].join('/')),
  },
  {
    label: 'temp directory path',
    pattern: new RegExp(['', 'tmp', ''].join('/')),
  },
  {
    label: 'local config directory',
    pattern: new RegExp(['\\.', 'gemini'].join('')),
  },
  {
    label: 'conversation or session UUID',
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  },
  {
    label: 'internal shortlink',
    pattern: /(?:^|[\s([<'`"])(?:go|b|cl)\/[A-Za-z0-9_-]{2,}/,
  },
  {
    label: 'target-consumer application noun',
    pattern: new RegExp(`\\b${['md', 'media'].join('')}\\b`, 'i'),
  },
];

const failures = [];

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function stripScriptExt(filePath) {
  return filePath.replace(/\.(?:[cm]?[jt]s)$/, '');
}

async function collectWorkspaceFiles(dir, out) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectWorkspaceFiles(fullPath, out);
      continue;
    }
    if (entry.name === 'package-lock.json') continue;
    out.add(fullPath);
  }
}

function collectGitTrackedFiles(out) {
  try {
    const stdout = execFileSync('git', ['ls-files', '-z', '--', '.'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const rel of stdout.split('\0')) {
      if (!rel || rel === 'package-lock.json') continue;
      out.add(path.join(repoRoot, rel));
    }
  } catch {
    // Fall back to workspace walk when git metadata is unavailable.
  }
}

function hasInvariantComment(lines, lineIndex) {
  const invariantPattern = /\/\/\s*Invariant:\s*\S+/;
  const sameLine = lines[lineIndex] ?? '';
  const prevLine = lineIndex > 0 ? (lines[lineIndex - 1] ?? '') : '';
  return invariantPattern.test(sameLine) || invariantPattern.test(prevLine);
}

function isConstAssertion(node) {
  return (
    ts.isTypeReferenceNode(node.type) &&
    ts.isIdentifier(node.type.typeName) &&
    node.type.typeName.text === 'const'
  );
}

function checkSrcImport(filename, relFromRepo, specifier) {
  const inPreload = filename.startsWith(`${preloadRoot}${path.sep}`);
  const inPuppeteer = filename.startsWith(`${puppeteerRoot}${path.sep}`);
  const strippedSelf = stripScriptExt(filename);
  const typesFile = path.join(srcRoot, 'types');
  const protocolFile = path.join(srcRoot, 'protocol');

  if (strippedSelf === typesFile) {
    failures.push(
      `${relFromRepo}: src/types.ts must remain a zero-import leaf contract (imported '${specifier}')`,
    );
    return;
  }

  if (strippedSelf === protocolFile) {
    if (!specifier.startsWith('./')) {
      failures.push(
        `${relFromRepo}: src/protocol.ts may only import ./types.js (imported '${specifier}')`,
      );
      return;
    }
    const target = stripScriptExt(path.resolve(path.dirname(filename), specifier));
    if (target !== typesFile) {
      failures.push(
        `${relFromRepo}: src/protocol.ts may only import ./types.js (imported '${specifier}')`,
      );
    }
    return;
  }

  if (inPreload) {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
      failures.push(
        `${relFromRepo}: src/preload/** must not import external or host module '${specifier}'`,
      );
      return;
    }
    const resolved = stripScriptExt(path.resolve(path.dirname(filename), specifier));
    const insidePreload = resolved.startsWith(`${preloadRoot}${path.sep}`);
    const isSharedLeaf = resolved === typesFile || resolved === protocolFile;
    if (!insidePreload && !isSharedLeaf) {
      failures.push(
        `${relFromRepo}: src/preload/** may only import sibling preload modules or pure leaf contracts src/types.ts and src/protocol.ts (imported '${specifier}')`,
      );
    }
    return;
  }

  if (specifier.startsWith('node:') || nodeBuiltins.has(specifier)) {
    failures.push(
      `${relFromRepo}: forbidden Node built-in import '${specifier}' in browser-safe source`,
    );
  }

  if (specifier === 'puppeteer' || specifier.startsWith('puppeteer/')) {
    failures.push(
      `${relFromRepo}: forbidden 'puppeteer' import '${specifier}'; use 'puppeteer-core' inside src/puppeteer/** only`,
    );
  }

  if (!inPuppeteer && (specifier === 'puppeteer-core' || specifier.startsWith('puppeteer-core/'))) {
    failures.push(
      `${relFromRepo}: forbidden 'puppeteer-core' import '${specifier}' outside src/puppeteer/**`,
    );
  }
}

function inspectTypeScriptAst(filename, relFromRepo, content) {
  const sourceFile = ts.createSourceFile(
    relFromRepo,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const lines = content.split(/\r?\n/);
  const isSrcFile = filename.startsWith(`${srcRoot}${path.sep}`);

  function formatPos(node) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return `${relFromRepo}:${line + 1}:${character + 1}`;
  }

  function visit(node) {
    if (isSrcFile) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (ts.isStringLiteral(node.moduleSpecifier)) {
          checkSrcImport(filename, relFromRepo, node.moduleSpecifier.text);
        } else {
          failures.push(`${formatPos(node)}: non-literal module specifier`);
        }
      }

      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const firstArg = node.arguments[0];
        if (firstArg && ts.isStringLiteral(firstArg)) {
          checkSrcImport(filename, relFromRepo, firstArg.text);
        } else {
          failures.push(`${formatPos(node)}: dynamic import/require must use a string literal`);
        }
      }
    }

    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      failures.push(`${formatPos(node)}: forbidden 'any' type (TSAnyKeyword)`);
    }

    if (ts.isTypeAssertionExpression(node)) {
      failures.push(
        `${formatPos(node)}: angle-bracket type assertion is forbidden; use runtime narrowing`,
      );
    }

    if (ts.isAsExpression(node) && !isConstAssertion(node)) {
      const exprLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
      const typeLine = sourceFile.getLineAndCharacterOfPosition(
        node.type.getStart(sourceFile),
      ).line;
      if (!hasInvariantComment(lines, exprLine) && !hasInvariantComment(lines, typeLine)) {
        failures.push(
          `${formatPos(node)}: bare 'as' type assertion requires an immediately preceding or same-line '// Invariant: <reason>' comment`,
        );
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

function inspectHygiene(relFromRepo, content) {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    for (const rule of forbiddenTextRules) {
      if (rule.pattern.test(line)) {
        failures.push(`${relFromRepo}:${i + 1}: forbidden ${rule.label}`);
      }
    }
  }
}

const candidateFiles = new Set();
await collectWorkspaceFiles(repoRoot, candidateFiles);
collectGitTrackedFiles(candidateFiles);

for (const filename of [...candidateFiles].sort()) {
  let content;
  try {
    content = await readFile(filename, 'utf8');
  } catch {
    continue;
  }
  const relFromRepo = toPosix(path.relative(repoRoot, filename));
  inspectHygiene(relFromRepo, content);

  const isCheckedTs =
    (relFromRepo.startsWith('src/') ||
      relFromRepo.startsWith('tests/') ||
      relFromRepo === 'playwright.config.ts' ||
      relFromRepo === 'vitest.config.ts') &&
    /\.[cm]?ts$/.test(relFromRepo) &&
    !relFromRepo.endsWith('.d.ts');

  if (isCheckedTs) {
    inspectTypeScriptAst(filename, relFromRepo, content);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('Architecture and hygiene boundaries passed.');
