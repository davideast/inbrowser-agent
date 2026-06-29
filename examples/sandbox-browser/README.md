# Sandbox Browser

A browser UI for the same `@inbrowser/sandbox` flow shown by
`examples/sandbox-basic`.

```sh
bun run --cwd examples/sandbox-browser dev
```

The center timeline records sandbox events chronologically. Panels are opened by
the user and show files, checkpoints, raw events, shell output, and the React
preview compile result.
