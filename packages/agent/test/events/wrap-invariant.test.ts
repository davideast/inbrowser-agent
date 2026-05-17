import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openEventLog } from '../../src/events/log.js';
import { WRAPPED_MARKER, isWrappedHandler, wrapMutating } from '../../src/events/wrap.js';
import type { ToolContext, ToolHandler } from '../../src/index.js';

function freshDir(): string {
  return mkdtempSync(`${tmpdir()}/agent-wrap-invariant-`);
}

function fakeCtx(): ToolContext {
  return {
    workspace: {
      presetId: '',
      rules: '',
      code: '',
      appSource: '',
      stitch: { projectId: null, latestScreenUrl: null, brief: null },
    },
    runtime: {
      terminal: [],
      runSummary: null,
      deploy: null,
      parseError: null,
      uiErrors: [],
      sandboxVersion: 0,
    },
    sandbox: {
      async run() {
        return { ok: true, durationMs: 0, docsTouched: 0, errors: 0, entries: [] };
      },
      async deployRules() {
        return { ok: true, messages: [] };
      },
      async readState() {
        return {};
      },
      reseed() {},
      dispose() {},
    },
    lint: () => ({ warnings: [] }),
    signal: new AbortController().signal,
  };
}

const baseHandler: ToolHandler = {
  name: 'setDoc',
  description: 'set',
  parameters: { type: 'object' },
  async execute() {
    return { ok: true, summary: 'ok' };
  },
};

describe('isWrappedHandler / WRAPPED_MARKER', () => {
  test('returns false on a plain handler', () => {
    expect(isWrappedHandler(baseHandler)).toBe(false);
  });

  test('returns true on a wrapMutating output', () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p', logDir: dir });
      const wrapped = wrapMutating(baseHandler, {
        log,
        sessionId: 's',
        target: () => ({ kind: 'doc', path: 'x' }),
      });
      expect(isWrappedHandler(wrapped)).toBe(true);
      log.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('marker is non-enumerable (does not appear in JSON.stringify)', () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p', logDir: dir });
      const wrapped = wrapMutating(baseHandler, {
        log,
        sessionId: 's',
        target: () => ({ kind: 'doc', path: 'x' }),
      });
      const stringified = JSON.stringify({ ...wrapped });
      expect(stringified).not.toContain(WRAPPED_MARKER.toString());
      log.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('wrapped handler still passes args + ctx + returns the underlying result', async () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p', logDir: dir });
      const handler: ToolHandler<{ x: number }, { x: number }> = {
        name: 'echo',
        description: '',
        parameters: { type: 'object' },
        async execute({ x }) {
          return { ok: true, summary: 'ok', data: { x } };
        },
      };
      const wrapped = wrapMutating(handler, {
        log,
        sessionId: 's',
        target: () => ({ kind: 'doc', path: 'x' }),
      });
      const result = await wrapped.execute({ x: 42 }, fakeCtx());
      expect(result.ok).toBe(true);
      expect((result.data as { x: number }).x).toBe(42);
      log.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
