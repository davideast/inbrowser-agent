# Tutorial: Create A Browser Workspace

This tutorial creates a browser workspace, writes a tiny React app into `/work`,
and prepares the services an app-builder agent needs. It uses memory storage so
the steps work in tests and local examples without browser storage setup.

## 1. Create The Workspace

```ts
import { createBrowserWorkspace } from '@inbrowser/workspace';

const workspace = await createBrowserWorkspace({
  id: 'tutorial',
  root: '/work',
  storage: 'memory',
});
```

The workspace now has a virtual root at `/work`. In a browser app, switch
`storage` to `opfs-with-memory-fallback` so OPFS is used when available.

## 2. Write The App Files

```ts
await workspace.fs.promises.writeFile(
  '/work/package.json',
  JSON.stringify(
    {
      scripts: { dev: 'vite' },
      dependencies: {
        '@vitejs/plugin-react': 'latest',
        vite: 'latest',
        react: 'latest',
        'react-dom': 'latest',
      },
      devDependencies: {
        typescript: 'latest',
      },
    },
    null,
    2,
  ),
);

await workspace.fs.promises.writeFile(
  '/work/src/App.tsx',
  `export default function App() {
  return <main>Hello from /work</main>;
}
`,
);
```

The file system creates parent directories automatically for writes. All paths
stay inside the workspace tree.

## 3. List The Files

```ts
const entries = await workspace.fs.promises.readdir('/work/src', {
  withFileTypes: true,
});

console.log(entries.map((entry) => `${entry.type}:${entry.path}`));
```

You should see `file:/work/src/App.tsx`.

## 4. Create A Shell

```ts
const shell = await workspace.createShell();
const result = await shell.exec('pwd && ls src');

console.log(result.cwd);
console.log(result.stdout);
```

The shell is jailed to `/work`. It is a browser shell over the workspace file
system, not an operating-system shell.

## 5. Create Git State

```ts
const git = await workspace.createGit();

await git.init();
await git.stageAll();
const oid = await git.commit({
  message: 'Initial app',
  authorName: 'Local User',
  authorEmail: 'local@example.com',
});

console.log(oid);
```

Git works through the same workspace file system, with typed status rows,
commit metadata, refs, and browser-written Git-shaped objects.

You now have the core runtime shape: files, shell, and git all operate on the
same browser workspace.
