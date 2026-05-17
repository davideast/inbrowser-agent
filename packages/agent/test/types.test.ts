/**
 * Smoke tests — the pure-function helpers shipped alongside the
 * type definitions. The types themselves are checked by `tsc`; the
 * runtime helpers need explicit tests.
 */
import { describe, expect, test } from 'bun:test';
import {
  EMPTY_RUNTIME,
  EMPTY_WORKSPACE,
  type SandboxEvent,
  combineObservers,
  createMemoryStorage,
  noopObserver,
  noopStorage,
} from '../src/index.js';

describe('EMPTY_WORKSPACE', () => {
  test('returns a frozen, empty-shaped workspace', () => {
    expect(EMPTY_WORKSPACE.presetId).toBe('');
    expect(EMPTY_WORKSPACE.rules).toBe('');
    expect(EMPTY_WORKSPACE.code).toBe('');
    expect(EMPTY_WORKSPACE.appSource).toBe('');
    expect(EMPTY_WORKSPACE.stitch.projectId).toBeNull();
    expect(Object.isFrozen(EMPTY_WORKSPACE)).toBe(true);
  });
});

describe('EMPTY_RUNTIME', () => {
  test('returns a frozen, empty-shaped runtime', () => {
    expect(EMPTY_RUNTIME.terminal).toHaveLength(0);
    expect(EMPTY_RUNTIME.runSummary).toBeNull();
    expect(EMPTY_RUNTIME.deploy).toBeNull();
    expect(EMPTY_RUNTIME.parseError).toBeNull();
    expect(EMPTY_RUNTIME.uiErrors).toHaveLength(0);
    expect(EMPTY_RUNTIME.sandboxVersion).toBe(0);
    expect(Object.isFrozen(EMPTY_RUNTIME)).toBe(true);
  });
});

describe('Storage helpers', () => {
  test('noopStorage returns null and accepts writes', () => {
    expect(noopStorage.get('any')).toBeNull();
    noopStorage.set('any', 'value');
    expect(noopStorage.get('any')).toBeNull();
    expect(noopStorage.keys()).toEqual([]);
  });

  test('createMemoryStorage round-trips set/get/remove', () => {
    const s = createMemoryStorage({ seed: 'value' });
    expect(s.get('seed')).toBe('value');
    s.set('k', 'v');
    expect(s.get('k')).toBe('v');
    s.remove('seed');
    expect(s.get('seed')).toBeNull();
  });

  test('createMemoryStorage keys filters by prefix', () => {
    const s = createMemoryStorage({ 'a:1': '1', 'a:2': '2', 'b:1': '3' });
    expect(s.keys('a:').sort()).toEqual(['a:1', 'a:2']);
    expect(s.keys()).toHaveLength(3);
  });
});

describe('SandboxObserver helpers', () => {
  test('noopObserver swallows events', () => {
    expect(() =>
      noopObserver.onEvent({
        kind: 'denial',
        timestamp: Date.now(),
        detail: 'test',
      }),
    ).not.toThrow();
  });

  test('combineObservers fans out to all', () => {
    const received: SandboxEvent[][] = [[], [], []];
    const composed = combineObservers(
      {
        onEvent: (e) => {
          received[0]!.push(e);
        },
      },
      {
        onEvent: (e) => {
          received[1]!.push(e);
        },
      },
      {
        onEvent: (e) => {
          received[2]!.push(e);
        },
      },
    );
    composed.onEvent({ kind: 'denial', timestamp: 1, detail: 'x' });
    expect(received.every((r) => r.length === 1)).toBe(true);
    expect(received.every((r) => r[0]!.detail === 'x')).toBe(true);
  });

  test('combineObservers continues when one observer throws', () => {
    const received: SandboxEvent[] = [];
    const composed = combineObservers(
      {
        onEvent: () => {
          throw new Error('bad');
        },
      },
      {
        onEvent: (e) => {
          received.push(e);
        },
      },
    );
    expect(() =>
      composed.onEvent({
        kind: 'denial',
        timestamp: 1,
        detail: 'y',
      }),
    ).not.toThrow();
    expect(received).toHaveLength(1);
  });
});
