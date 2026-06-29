# Sandbox Basic

A small command-line example for `@inbrowser/sandbox`. It creates a memory-backed
browser workspace, binds it to a sandbox, runs standard tools, creates a
checkpoint, edits a file, restores the checkpoint, and prints the chronological
sandbox event log.

```sh
bun run --cwd examples/sandbox-basic start
```

The example intentionally uses the same scenario helper as the browser example,
so the script and UI teach the same API path.
