# How To Preview A React App Without A Dev Server

This guide shows how to preview a React/TSX app by compiling the workspace
entry module and evaluating it with host-provided React modules.

Use this when you are building an in-browser app builder and do not want to
depend on a long-running Vite dev server.

## Provide Host React Modules

The preview compiler should use the host application's React runtime. This
prevents duplicate React copies and avoids errors caused by mixing CDN React
with the app shell's React.

```ts
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import * as jsxDevRuntime from 'react/jsx-dev-runtime';

const preview = await workspace.createReactPreview({
  entry: '/work/src/App.tsx',
  react: React as unknown as Record<string, unknown>,
  jsxRuntime: jsxRuntime as unknown as Record<string, unknown>,
  jsxDevRuntime: jsxDevRuntime as unknown as Record<string, unknown>,
});
```

## Compile The Entry

```ts
const source = await workspace.fs.promises.readFile('/work/src/App.tsx', 'utf8');
const result = await preview.compile(source);

if (!result.ok) {
  console.log(result.diagnostics);
}
```

The compiler resolves relative imports from the workspace file system. Bare
imports resolve only when they are host modules or installed in the workspace
package registry.

## Evaluate The Component

```ts
if (result.ok) {
  const Component = result.evaluate(preview.scope());
  console.log(Component);
}
```

The returned value is the compiled module's default export. A host UI can mount
it in a preview boundary or iframe-like surface.

## Add Browser-Compatible Packages

```ts
await workspace.packages.install({
  name: 'lucide-react',
  version: 'latest',
});

const importMap = await workspace.packages.getImportMap();
const preview = await workspace.createReactPreview({
  entry: '/work/src/App.tsx',
  react: React as unknown as Record<string, unknown>,
  jsxRuntime: jsxRuntime as unknown as Record<string, unknown>,
  importMap,
});
```

Installed packages are resolved through the package registry's CDN resolver and
made available to the preview compiler. They are not downloaded into
`node_modules`.

## Handle Errors

Compilation errors are returned as diagnostics:

```ts
if (!result.ok) {
  for (const diagnostic of result.diagnostics) {
    console.log(diagnostic.message, diagnostic.line, diagnostic.column);
  }
}
```

Runtime errors happen when the evaluated component renders. Catch them in the
host preview boundary and route them back to the agent or user as repair input.
