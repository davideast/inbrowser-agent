import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { forkStdio, markHandleStream, normalizeStdio } from '../../src/child-stdio';

const failure = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    const { name, code, message } = error as Error & { code?: string };
    return { name, code, message };
  }
  return undefined;
};

describe('forkStdio', () => {
  it('appends the channel to each string shorthand', () => {
    expect(forkStdio('inherit', undefined, inspect)).toEqual([0, 1, 2, 'ipc']);
    expect(forkStdio('pipe', undefined, inspect)).toEqual(['pipe', 'pipe', 'pipe', 'ipc']);
    expect(forkStdio('ignore', true, inspect)).toEqual(['ignore', 'ignore', 'ignore', 'ipc']);
    expect(forkStdio('overlapped', undefined, inspect)).toEqual([
      'overlapped',
      'overlapped',
      'overlapped',
      'ipc',
    ]);
  });

  it('reads silent for truthiness only when stdio is neither a string nor an array', () => {
    for (const stdio of [undefined, null, 42, {}, true]) {
      expect(forkStdio(stdio, undefined, inspect)).toEqual([0, 1, 2, 'ipc']);
      expect(forkStdio(stdio, 0, inspect)).toEqual([0, 1, 2, 'ipc']);
      expect(forkStdio(stdio, 'yes', inspect)).toEqual(['pipe', 'pipe', 'pipe', 'ipc']);
    }
  });

  it('rejects an unknown string and an array without the channel as Node does', () => {
    expect(failure(() => forkStdio('', undefined, inspect))).toEqual({
      name: 'TypeError',
      code: 'ERR_INVALID_ARG_VALUE',
      message: "The argument 'stdio' is invalid. Received ''",
    });
    expect(failure(() => forkStdio(['pipe', 'pipe', 'pipe'], true, inspect))).toEqual({
      name: 'Error',
      code: 'ERR_CHILD_PROCESS_IPC_REQUIRED',
      message: "Forked processes must have an IPC channel, missing value 'ipc' in options.stdio",
    });
  });

  it('copies the array so later caller mutation cannot change the child', () => {
    const stdio = ['pipe', 'pipe', 'pipe', 'ipc'];
    const copy = forkStdio(stdio, undefined, inspect);
    stdio[0] = 'inherit';
    expect(copy).toEqual(['pipe', 'pipe', 'pipe', 'ipc']);
  });
});

describe('normalizeStdio', () => {
  it('expands the string shorthands', () => {
    expect(normalizeStdio('inherit', inspect)).toEqual({
      slots: [0, 1, 2],
      ipc: false,
      entries: 3,
    });
    expect(normalizeStdio('overlapped', inspect).slots).toEqual(['pipe', 'pipe', 'pipe']);
    expect(normalizeStdio('ignore', inspect).slots).toEqual(['ignore', 'ignore', 'ignore']);
  });

  it('pads short arrays with pipes and defaults extra entries to ignore', () => {
    expect(normalizeStdio([], inspect)).toEqual({
      slots: ['pipe', 'pipe', 'pipe'],
      ipc: false,
      entries: 3,
    });
    expect(normalizeStdio(['ignore'], inspect).slots).toEqual(['ignore', 'pipe', 'pipe']);
    // A hole reads as undefined.
    expect(normalizeStdio(['inherit', , null, undefined, null, 'ipc'], inspect)).toEqual({
      slots: ['inherit', 'pipe', 'pipe'],
      ipc: true,
      entries: 6,
    });
  });

  it('maps negative numbers to pipes and descriptors, or objects carrying one, to numbers', () => {
    expect(normalizeStdio([-1, { fd: 2 }, 7], inspect).slots).toEqual(['pipe', 2, 7]);
  });

  it('reports invalid entries with Node codes and names', () => {
    expect(failure(() => normalizeStdio(42, inspect))).toMatchObject({
      name: 'TypeError',
      code: 'ERR_INVALID_ARG_VALUE',
      message: "The argument 'stdio' is invalid. Received 42",
    });
    expect(failure(() => normalizeStdio(['pipe', 'bogus'], inspect))).toMatchObject({
      name: 'TypeError',
      code: 'ERR_INVALID_SYNC_FORK_INPUT',
    });
    expect(failure(() => normalizeStdio([new Uint8Array(1)], inspect))).toMatchObject({
      code: 'ERR_INVALID_SYNC_FORK_INPUT',
    });
    expect(failure(() => normalizeStdio(['pipe', {}], inspect))).toMatchObject({
      name: 'TypeError',
      code: 'ERR_INVALID_ARG_VALUE',
      message: "The argument 'stdio' is invalid. Received {}",
    });
    expect(
      failure(() => normalizeStdio(['pipe', 'pipe', 'pipe', 'ipc', 'ipc'], inspect)),
    ).toMatchObject({ name: 'Error', code: 'ERR_IPC_ONE_PIPE' });
    expect(failure(() => normalizeStdio(['pipe', { fd: -1 }], inspect))).toMatchObject({
      name: 'Error',
      code: 'EINVAL',
      message: 'spawn EINVAL',
    });
  });

  it('rejects shapes the transport cannot carry with ENOSYS, after Node-level errors', () => {
    for (const stdio of [
      ['ipc'],
      ['pipe', 'ipc', 'pipe'],
      ['pipe', 'pipe', 'pipe', 'pipe', 'ipc'],
      ['pipe', 'pipe', 'pipe', 'inherit'],
      ['pipe', 'pipe', 'pipe', 5],
      [markHandleStream({}), 'pipe', 'pipe'],
    ])
      expect(failure(() => normalizeStdio(stdio, inspect))).toMatchObject({ code: 'ENOSYS' });
    expect(failure(() => normalizeStdio(['ipc', 'pipe', 'pipe', 'ipc'], inspect))).toMatchObject({
      code: 'ERR_IPC_ONE_PIPE',
    });
    expect(failure(() => normalizeStdio(['ipc', 'pipe', true], inspect))).toMatchObject({
      code: 'ERR_INVALID_ARG_VALUE',
    });
  });

  it('rejects descriptors Node would abort on', () => {
    for (const fd of [1.5, Number.NaN, 2 ** 31, { fd: 1.5 }])
      expect(failure(() => normalizeStdio(['pipe', 'pipe', fd], inspect))).toMatchObject({
        code: 'EINVAL',
        message: 'Child stdio descriptors must be 32-bit integers',
      });
  });
});
