import { describe, expect, test } from 'bun:test';
import {
  EMPTY_RUNTIME,
  EMPTY_WORKSPACE,
  type ToolContext,
  type ToolHandler,
  createDispatch,
  createToolRegistry,
  isParallelSafe,
  isPure,
} from '../src/index.js';

function fakeCtx(): ToolContext {
  return {
    workspace: EMPTY_WORKSPACE,
    runtime: EMPTY_RUNTIME,
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
      reseed() {
        /* no-op */
      },
      dispose() {
        /* no-op */
      },
    },
    lint: () => ({ warnings: [] }),
    signal: new AbortController().signal,
  };
}

const echoTool: ToolHandler<{ msg: string }, { msg: string }> = {
  name: 'echo',
  description: 'echo the arg',
  parameters: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
  async execute({ msg }) {
    return { ok: true, summary: msg, data: { msg } };
  },
};

const stitchOnlyTool: ToolHandler = {
  name: 'create_project',
  description: 'stitch-gated',
  parameters: { type: 'object' },
  available(caps) {
    return caps.stitchAvailable;
  },
  async execute() {
    return { ok: true, summary: 'ok' };
  },
};

const throwerTool: ToolHandler = {
  name: 'thrower',
  description: 'always throws',
  parameters: { type: 'object' },
  async execute() {
    throw new Error('boom');
  },
};

describe('ToolRegistry', () => {
  test('register + has + list', () => {
    const r = createToolRegistry();
    r.register(echoTool);
    expect(r.has('echo')).toBe(true);
    expect(r.list()).toHaveLength(1);
  });

  test('unregister drops the handler', () => {
    const r = createToolRegistry();
    r.register(echoTool);
    expect(r.unregister('echo')).toBe(true);
    expect(r.has('echo')).toBe(false);
    expect(r.unregister('echo')).toBe(false);
  });

  test('list with no opts returns every handler regardless of `available`', () => {
    const r = createToolRegistry();
    r.register(echoTool);
    r.register(stitchOnlyTool);
    expect(r.list()).toHaveLength(2);
  });

  test('list filters by capabilities when supplied', () => {
    const r = createToolRegistry();
    r.register(echoTool);
    r.register(stitchOnlyTool);
    const withStitch = r.list({
      capabilities: { llmSupportsTools: true, stitchAvailable: true, sandboxReady: false },
    });
    expect(withStitch).toHaveLength(2);
    const noStitch = r.list({
      capabilities: { llmSupportsTools: true, stitchAvailable: false, sandboxReady: false },
    });
    expect(noStitch.map((h) => h.name)).toEqual(['echo']);
  });

  test('fork yields a copy-on-write registry', () => {
    const parent = createToolRegistry();
    parent.register(echoTool);
    const child = parent.fork();
    expect(child.has('echo')).toBe(true);
    child.register(stitchOnlyTool);
    expect(parent.has('create_project')).toBe(false);
    expect(child.has('create_project')).toBe(true);
  });

  test('register throws on name conflict (F6)', () => {
    const r = createToolRegistry();
    r.register(echoTool);
    expect(() => r.register(echoTool)).toThrow(/already registered/);
    expect(() => r.register({ ...echoTool, description: 'different' })).toThrow(
      /'echo' is already registered/,
    );
  });

  test('register conflict error names both prior + new descriptions (L13)', () => {
    const r = createToolRegistry();
    r.register({ ...echoTool, description: 'first echo' });
    let err: unknown;
    try {
      r.register({ ...echoTool, description: 'second echo' });
    } catch (e) {
      err = e;
    }
    expect(String(err)).toContain('first echo');
    expect(String(err)).toContain('second echo');
  });

  test('replace is idempotent (overlay + decoration pattern)', () => {
    const r = createToolRegistry();
    r.register(echoTool);
    const decorated = { ...echoTool, description: 'wrapped echo' };
    r.replace(decorated);
    expect(r.list()).toHaveLength(1);
    expect(r.list()[0].description).toBe('wrapped echo');
    // Replacing without prior register also works.
    r.replace(stitchOnlyTool);
    expect(r.has('create_project')).toBe(true);
  });
});

describe('createDispatch', () => {
  test('routes to the named handler', async () => {
    const r = createToolRegistry();
    r.register(echoTool);
    const dispatch = createDispatch(r);
    const result = await dispatch.execute(
      { id: '1', name: 'echo', args: { msg: 'hi' } },
      fakeCtx(),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('hi');
    expect(result.data).toEqual({ msg: 'hi' });
  });

  test('returns ok: false with "Unknown tool" for unregistered names', async () => {
    const dispatch = createDispatch(createToolRegistry());
    const result = await dispatch.execute({ id: '1', name: 'missing', args: {} }, fakeCtx());
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Unknown tool');
  });

  test('turns thrown handler errors into ok: false results', async () => {
    const r = createToolRegistry();
    r.register(throwerTool);
    const dispatch = createDispatch(r);
    const result = await dispatch.execute({ id: '1', name: 'thrower', args: {} }, fakeCtx());
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('threw');
    expect(result.summary).toContain('boom');
  });
});

describe('capability tags', () => {
  test('isParallelSafe defaults to false when the tag is absent', () => {
    expect(isParallelSafe(echoTool)).toBe(false);
  });

  test('isParallelSafe is false when explicitly set to false', () => {
    const tagged: ToolHandler = { ...echoTool, parallelSafe: false };
    expect(isParallelSafe(tagged)).toBe(false);
  });

  test('isParallelSafe is true when explicitly set to true', () => {
    const tagged: ToolHandler = { ...echoTool, parallelSafe: true };
    expect(isParallelSafe(tagged)).toBe(true);
  });

  test('isPure defaults to false when the tag is absent', () => {
    expect(isPure(echoTool)).toBe(false);
  });

  test('isPure is false when explicitly set to false', () => {
    const tagged: ToolHandler = { ...echoTool, pure: false };
    expect(isPure(tagged)).toBe(false);
  });

  test('isPure is true when explicitly set to true', () => {
    const tagged: ToolHandler = { ...echoTool, pure: true };
    expect(isPure(tagged)).toBe(true);
  });

  test('the two tags are independent', () => {
    const parallelOnly: ToolHandler = { ...echoTool, parallelSafe: true };
    expect(isParallelSafe(parallelOnly)).toBe(true);
    expect(isPure(parallelOnly)).toBe(false);

    const pureOnly: ToolHandler = { ...echoTool, pure: true };
    expect(isParallelSafe(pureOnly)).toBe(false);
    expect(isPure(pureOnly)).toBe(true);
  });

  test('tags survive registration and round-trip through list()', () => {
    const r = createToolRegistry();
    const tagged: ToolHandler = { ...echoTool, parallelSafe: true, pure: true };
    r.register(tagged);
    const [retrieved] = r.list();
    expect(isParallelSafe(retrieved)).toBe(true);
    expect(isPure(retrieved)).toBe(true);
  });
});
