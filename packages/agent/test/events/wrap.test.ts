import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openEventLog } from '../../src/events/log.js';
import { wrapMutating } from '../../src/events/wrap.js';
import type { ToolContext, ToolHandler } from '../../src/index.js';

function freshDir(): string {
  return mkdtempSync(`${tmpdir()}/agent-wrap-`);
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

const writeRulesHandler: ToolHandler<{ source: string }, { source: string }> = {
  name: 'writeRules',
  description: 'write rules',
  parameters: { type: 'object' },
  async execute({ source }) {
    return {
      ok: true,
      summary: `wrote ${source.length} chars`,
      data: { source },
      workspacePatch: { rules: source },
    };
  },
};

describe('wrapMutating', () => {
  test('emits plan + commit on success', async () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      const wrapped = wrapMutating(writeRulesHandler, {
        log,
        sessionId: 's1',
        target: () => ({ kind: 'workspace', path: 'workspace.rules' }),
        snapshot: () => 'previous rules',
        reverseOp: (args) => ({
          tool: 'writeRules',
          args: { source: 'previous rules' },
          description: `restore prior rules over ${args.source.length} new chars`,
        }),
      });

      const result = await wrapped.execute({ source: 'new rules' }, fakeCtx());
      expect(result.ok).toBe(true);

      const events = log.read();
      expect(events).toHaveLength(2);
      expect(events[0]!.phase).toBe('plan');
      expect(events[0]!.before).toBe('previous rules');
      expect(events[0]!.reversible).toBe(true);
      expect(events[1]!.phase).toBe('commit');
      expect(events[1]!.reversible).toBe(true);
      expect(events[1]!.reverseOp?.tool).toBe('writeRules');
      expect((events[1]!.metadata as { ok?: boolean }).ok).toBe(true);
      log.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('emits plan + rollback when handler throws', async () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      const broken: ToolHandler = {
        name: 'broken',
        description: 'broken',
        parameters: { type: 'object' },
        async execute() {
          throw new Error('boom');
        },
      };
      const wrapped = wrapMutating(broken, {
        log,
        sessionId: 's1',
        target: () => ({ kind: 'workspace', path: 'x' }),
      });

      let caught: unknown;
      try {
        await wrapped.execute({}, fakeCtx());
      } catch (err) {
        caught = err;
      }
      expect((caught as Error).message).toBe('boom');

      const events = log.read();
      expect(events).toHaveLength(2);
      expect(events[0]!.phase).toBe('plan');
      expect(events[1]!.phase).toBe('rollback');
      expect(events[1]!.metadata?.['reason']).toBe('failure');
      expect(events[1]!.metadata?.['originalEventId']).toBe(events[0]!.id);
      log.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('commit event carries reversible=false when no reverseOp is provided', async () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      const wrapped = wrapMutating(writeRulesHandler, {
        log,
        sessionId: 's1',
        target: () => ({ kind: 'workspace', path: 'workspace.rules' }),
        irreversibleReason: 'tested by hand',
      });

      await wrapped.execute({ source: 'x' }, fakeCtx());
      const events = log.read();
      const commit = events.find((e) => e.phase === 'commit')!;
      expect(commit.reversible).toBe(false);
      expect(commit.reverseOp).toBeUndefined();
      expect(commit.irreversibleReason).toBe('tested by hand');
      log.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('preserves handler.available for capability filtering', () => {
    const log = openEventLog({ projectId: 'p1', logDir: mkdtempSync(`${tmpdir()}/x-`) });
    try {
      const handler: ToolHandler = {
        name: 'gated',
        description: 'gated',
        parameters: { type: 'object' },
        available: (caps) => Boolean((caps as unknown as { flag: boolean }).flag),
        async execute() {
          return { ok: true, summary: '' };
        },
      };
      const wrapped = wrapMutating(handler, {
        log,
        sessionId: 's',
        target: () => ({ kind: 'workspace', path: 'x' }),
      });
      expect(wrapped.available?.({ flag: true } as never)).toBe(true);
      expect(wrapped.available?.({ flag: false } as never)).toBe(false);
    } finally {
      log.close();
    }
  });
});
