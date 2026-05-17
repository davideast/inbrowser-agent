import { afterEach, describe, expect, test } from 'bun:test';
import { createLocalStorageAdapter } from '../src/storage.js';

function installFakeLs() {
  const store = new Map<string, string>();
  const fake = {
    get length() { return store.size; },
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    clear: () => { store.clear(); },
  };
  // @ts-expect-error — overriding global for the test
  globalThis.localStorage = fake;
  return fake;
}

afterEach(() => {
  // @ts-expect-error — clean up the override
  delete globalThis.localStorage;
});

describe('createLocalStorageAdapter', () => {
  test('round-trips set/get/remove against a fake localStorage', () => {
    installFakeLs();
    const s = createLocalStorageAdapter();
    s.set('k', 'v');
    expect(s.get('k')).toBe('v');
    s.remove('k');
    expect(s.get('k')).toBeNull();
  });

  test('keys filters by prefix', () => {
    const fake = installFakeLs();
    fake.setItem('llm:gemini:key', 'X');
    fake.setItem('llm:openrouter:key', 'Y');
    fake.setItem('ide:layout', 'Z');
    const s = createLocalStorageAdapter();
    expect(s.keys('llm:').sort()).toEqual(['llm:gemini:key', 'llm:openrouter:key']);
    expect(s.keys()).toHaveLength(3);
  });

  test('survives a missing localStorage (Node)', () => {
    // @ts-expect-error — globalThis.localStorage is undefined here
    delete globalThis.localStorage;
    const s = createLocalStorageAdapter();
    expect(s.get('any')).toBeNull();
    expect(() => s.set('any', 'value')).not.toThrow();
    expect(s.keys()).toEqual([]);
  });

  test('swallows getItem errors (private mode)', () => {
    // @ts-expect-error — overriding global
    globalThis.localStorage = {
      getItem: () => { throw new Error('private mode'); },
      setItem: () => { throw new Error('quota'); },
      removeItem: () => { throw new Error('locked'); },
      key: () => { throw new Error('x'); },
      length: 0,
    };
    const s = createLocalStorageAdapter();
    expect(s.get('any')).toBeNull();
    expect(() => s.set('any', 'value')).not.toThrow();
    expect(() => s.remove('any')).not.toThrow();
    expect(s.keys()).toEqual([]);
  });
});
