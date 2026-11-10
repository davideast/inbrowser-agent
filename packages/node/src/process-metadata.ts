// Guest `process` metadata members whose values describe this runtime rather than
// a native Node build. Each value's source is stated where it is defined; see
// docs/reference/architecture.md, "process metadata".

/** process.md "process.release": identity of the release this runtime reports (v22.18.0). */
export const release = {
  name: 'node',
  lts: 'Jod',
  sourceUrl: 'https://nodejs.org/download/release/v22.18.0/node-v22.18.0.tar.gz',
  headersUrl: 'https://nodejs.org/download/release/v22.18.0/node-v22.18.0-headers.tar.gz',
};

/**
 * process.md "process.config": the configure options the executable was compiled
 * with. No Node executable was compiled for this runtime, so both documented
 * sections are empty, frozen as Node freezes them.
 */
export function buildConfig() {
  return Object.freeze({
    target_defaults: Object.freeze({}),
    variables: Object.freeze({}),
  });
}

/**
 * process.md "process.allowedNodeEnvironmentFlags", after Node 22.18's
 * NodeEnvironmentFlagsSet (per_thread.js): a frozen, read-only Set whose `has`
 * accepts missing dashes, underscores and `=value` suffixes. `flags` are the
 * NODE_OPTIONS flags this runtime honors.
 */
export function allowedFlags(flags: readonly string[]): Set<string> {
  const array = [...flags];
  const bare = array.map((flag) => flag.replace(/^--?/, ''));
  const members = new Set(array);
  class NodeEnvironmentFlagsSet extends Set<string> {
    add() {
      return this;
    }
    delete() {
      return false;
    }
    clear() {}
    has(key: unknown) {
      if (typeof key !== 'string') return false;
      const flag = key.replace(/_/g, '-');
      if (/^--?/.test(flag)) return array.includes(flag.replace(/=.*$/, ''));
      return bare.includes(flag);
    }
    entries() {
      return members.entries();
    }
    forEach(callback: (value: string, key: string, set: Set<string>) => void, thisArg?: unknown) {
      for (const flag of array) Reflect.apply(callback, thisArg, [flag, flag, this]);
    }
    get size() {
      return array.length;
    }
    values() {
      return members.values();
    }
  }
  const values = NodeEnvironmentFlagsSet.prototype.values;
  Object.defineProperty(NodeEnvironmentFlagsSet.prototype, Symbol.iterator, { value: values });
  Object.defineProperty(NodeEnvironmentFlagsSet.prototype, 'keys', { value: values });
  Object.freeze(NodeEnvironmentFlagsSet);
  Object.freeze(NodeEnvironmentFlagsSet.prototype);
  return Object.freeze(new NodeEnvironmentFlagsSet());
}

/**
 * Installs `title` and `debugPort` with Node's coercions. `title` starts as the
 * runtime's program path and has no `ps` entry to rename. `debugPort` starts at
 * the documented default inspector port (cli.md `--inspect-port`, 9229) and is a
 * setting only: this runtime cannot enable an inspector.
 */
export function installIdentity(process: object, title: string): void {
  let currentTitle = title;
  let port = 9229;
  Object.defineProperties(process, {
    title: {
      enumerable: true,
      configurable: true,
      get: () => currentTitle,
      set(value: unknown) {
        currentTitle = String(value);
      },
    },
    debugPort: {
      enumerable: true,
      configurable: true,
      get: () => port,
      set(value: unknown) {
        // V8's Int32Value, as Node's setter reads it.
        const next = Number(value) | 0;
        if ((next !== 0 && next < 1024) || next > 65535)
          throw Object.assign(
            new RangeError('process.debugPort must be 0 or in range 1024 to 65535'),
            { code: 'ERR_OUT_OF_RANGE' },
          );
        port = next;
      },
    },
  });
}
