# resumable-basic

A script demo for `@inbrowser/resumable` using the in-memory job store.

It starts a streaming job, drains the first subscription, resumes from an event offset, and reads the final snapshot.

```sh
bun run --cwd examples/resumable-basic start
bun run --cwd examples/resumable-basic test
```
