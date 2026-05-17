#!/usr/bin/env bun
/**
 * `agent` CLI entry. All logic lives in `src/cli/` so the package
 * can be both `import { main } from '@inbrowser/agent/cli'` and a
 * shebang-runnable binary. Treat this file as a one-liner.
 */
import { main } from '../src/cli/main.js';

const code = await main();
process.exit(code);
