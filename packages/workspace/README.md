# @inbrowser/workspace

`@inbrowser/workspace` is the browser-native workspace runtime for the
inbrowser stack. It gives an app or agent a local project space without
promising a full browser Node process.

The package owns infrastructure:

- a workspace file system over OPFS, with an in-memory fallback
- scoped workspaces so `/work` can map to isolated browser storage
- React/TSX preview compilation through `esbuild-wasm`
- host-module aliases so preview code uses the app's React runtime
- a jailed browser shell over the workspace file system
- structured local git operations through `isomorphic-git`
- a browser package registry that writes import maps for preview compilation
- optional thin agent-tool adapters

The package does not own prompting, model selection, UI, product copy, or
app-builder workflow. Those belong to the host application.

## Why It Exists

Running a real Vite dev server in a browser runtime is fragile. The reliable
browser-native shape is different: write files into a virtual workspace,
compile the entry module with `esbuild-wasm`, mount the result with host
runtime modules, and expose shell/git/package operations as structured
workspace services.

That is the contract this package provides.

## Basic Shape

```ts
import { createBrowserWorkspace } from '@inbrowser/workspace';

const workspace = await createBrowserWorkspace({
  id: 'local-project',
  root: '/work',
  storage: 'opfs-with-memory-fallback',
});

await workspace.fs.promises.writeFile(
  '/work/src/App.tsx',
  'export default function App() { return <h1>Hello</h1>; }',
);

const shell = await workspace.createShell();
const git = await workspace.createGit();
```

Preview, shell, and git are loaded lazily. Importing the package root does not
pull `esbuild-wasm`, `just-bash`, or `isomorphic-git` until the corresponding
service is requested.

## Documentation

- [Tutorial: Create a Browser Workspace](docs/tutorial.md)
- [How to preview a React app without a dev server](docs/how-to-preview-a-react-app.md)
- [API Reference](docs/reference.md)
- [Why this is not browser Node](docs/why-not-browser-node.md)
