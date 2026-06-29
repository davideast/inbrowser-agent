# workspace-browser

Browser example for `@inbrowser/workspace`.

It uses the shared example shell to visualize workspace files, preview
compilation, shell output, package import maps, git state, snapshots, and the
chronological workspace timeline.

```sh
bun run --cwd examples/workspace-browser dev
bun run --cwd examples/workspace-browser build
bun test examples/workspace-browser/test/render.test.tsx
```
