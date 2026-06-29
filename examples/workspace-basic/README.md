# workspace-basic

Script example for `@inbrowser/workspace`.

It creates a memory-backed browser workspace, writes a small React project, runs
the jailed shell, captures and restores a filesystem snapshot, creates a git
commit, and probes preview compilation.

```sh
bun run --cwd examples/workspace-basic start
bun run --cwd examples/workspace-basic test
```
