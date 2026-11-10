// fs.globSync, fs.glob and fs.promises.glob for Node 22.18.0.
//
// A port of lib/internal/fs/glob.js onto the guest fs primitives, with the pattern
// engine in glob-match.ts standing in for minimatch (see its header). Every directory
// read and stat goes through the kernel's syscalls and its owner-bit permission
// policy. This file is a derivative work of Node.js, retained under the Node.js
// license (also vendor/node-v22.18.0/LICENSE):
//
//   Copyright Node.js contributors. All rights reserved.
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to
//   deal in the Software without restriction, including without limitation the
//   rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
//   sell copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in
//   all copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
//   FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
//   IN THE SOFTWARE.
//
// Node 22.18 has no experimental warning for glob (stable since 22.17). The
// traversal is the original's, including the order it yields results, which follows
// the order the filesystem lists directories; compare results as sets.
import path from 'path-browserify';
import { invalidArgType } from './arg-errors';
import { fileURLToPath } from './file-url';
import { Dirent as SharedDirent } from './fs-stats';
import { GLOBSTAR, Matcher, type Segment } from './glob-match';

type Fs = Record<string, (...args: unknown[]) => unknown>;

/** A Dirent whose `name` is narrowed to `string` for glob traversal. */
class DirentFromStats extends SharedDirent {
  declare name: string;
  constructor(name: string, mode: number, parent: string) {
    super(name, mode, parent);
  }
}

type Entry = SharedDirent & { name: string };
type ExcludeFn = ((value: unknown) => unknown) | undefined;

const toPath = (value: unknown) => (value instanceof URL ? fileURLToPath(value) : value);

class Pattern {
  readonly #pattern: Segment[];
  readonly #globStrings: string[];
  readonly indexes: Set<number>;
  readonly symlinks: Set<number>;
  readonly last: number;

  constructor(
    pattern: Segment[],
    globStrings: string[],
    indexes: Set<number>,
    symlinks: Set<number>,
  ) {
    this.#pattern = pattern;
    this.#globStrings = globStrings;
    this.indexes = indexes;
    this.symlinks = symlinks;
    this.last = pattern.length - 1;
  }
  isLast(isDirectory: boolean) {
    return (
      this.indexes.has(this.last) ||
      (this.at(-1) === '' &&
        isDirectory &&
        this.indexes.has(this.last - 1) &&
        this.at(-2) === GLOBSTAR)
    );
  }
  isFirst() {
    return this.indexes.has(0);
  }
  get hasSeenSymlinks() {
    return Array.from(this.indexes).some((index) => !this.symlinks.has(index));
  }
  at(index: number): Segment | undefined {
    return this.#pattern.at(index);
  }
  child(indexes: Set<number>, symlinks: Set<number> = new Set()) {
    return new Pattern(this.#pattern, this.#globStrings, indexes, symlinks);
  }
  test(index: number, name: string) {
    if (index > this.#pattern.length) return false;
    const pattern = this.#pattern[index];
    if (pattern === GLOBSTAR) return true;
    if (typeof pattern === 'string') return pattern === name;
    if (typeof pattern?.test === 'function') return pattern.test(name);
    return false;
  }
  cacheKey(index: number) {
    let key = '';
    for (let i = index; i < this.#globStrings.length; i++) {
      key += this.#globStrings[i];
      if (i !== this.#globStrings.length - 1) key += '/';
    }
    return key;
  }
}

/** The results in insertion order; a value is refused when the exclusion matches it. */
class ResultSet {
  readonly #values = new Set<string>();
  #root = '.';
  #isExcluded: (value: string) => boolean = () => false;
  resolve: (root: string, value: string) => string = (_root, value) => value;

  setup(root: string, isExcluded: (value: string) => boolean) {
    this.#root = root;
    this.#isExcluded = isExcluded;
  }
  has(value: string) {
    return this.#values.has(value);
  }
  add(value: string) {
    if (this.#isExcluded(this.resolve(this.#root, value))) return false;
    this.#values.add(value);
    return true;
  }
  [Symbol.iterator]() {
    return this.#values.values();
  }
}

interface Queued {
  path: string;
  patterns: Pattern[];
}

export function createGlob(
  fs: Fs,
  cwd: () => string,
  /** Told when a callback operation starts: Node counts it as event loop work. */
  worked: () => void,
) {
  // path.resolve with Node's argument checks, against the guest working directory.
  const resolve = (...parts: unknown[]) => {
    parts.forEach((part, index) => {
      if (typeof part !== 'string') throw invalidArgType(`paths[${index}]`, 'of type string', part);
    });
    return path.resolve(cwd(), ...(parts as string[]));
  };
  const { join, basename, dirname, isAbsolute } = path;

  const getDirentSync = (target: string) => {
    const stat = fs.lstatSync(target, { throwIfNoEntry: false }) as { mode: number } | undefined;
    if (stat === undefined) return null;
    return new DirentFromStats(basename(target), stat.mode, dirname(target));
  };
  const getDirent = async (target: string) => {
    try {
      return getDirentSync(target);
    } catch {
      return null;
    }
  };
  const listing = (target: string): Entry[] => {
    const entries = fs.readdirSync(target, { withFileTypes: true });
    if (!Array.isArray(entries)) throw new TypeError('Invalid directory listing');
    return entries.map((entry: unknown): Entry => {
      if (entry instanceof SharedDirent) {
        entry.name = String(entry.name);
        entry.parentPath = target;
        entry.path = target;
        // Narrowed: entry is a SharedDirent whose `name` was coerced to string above.
        return entry as Entry;
      }
      // Fallback for unit-test stubs returning raw `{ name, mode }` records.
      const raw = entry as { name: string; mode: number };
      return new DirentFromStats(String(raw.name), raw.mode, target);
    });
  };

  class Cache {
    readonly #cache = new Map<string, Set<string>>();
    readonly #statsCache = new Map<string, Entry | null | Promise<Entry | null>>();
    readonly #readdirCache = new Map<string, Entry[] | null | Promise<Entry[] | null>>();

    stat(target: string): Promise<Entry | null> {
      const cached = this.#statsCache.get(target);
      if (cached) return Promise.resolve(cached);
      const promise = getDirent(target);
      this.#statsCache.set(target, promise);
      return promise;
    }
    statSync(target: string): Entry | null {
      const cached = this.#statsCache.get(target);
      // Do not return a promise from a sync function.
      if (cached && !(cached instanceof Promise)) return cached;
      const value = getDirentSync(target);
      this.#statsCache.set(target, value);
      return value;
    }
    addToStatCache(target: string, value: Entry) {
      this.#statsCache.set(target, value);
    }
    async readdir(target: string): Promise<Entry[] | null> {
      const cached = this.#readdirCache.get(target);
      if (cached) return cached;
      const promise = (async () => {
        try {
          return listing(target);
        } catch {
          return null;
        }
      })();
      this.#readdirCache.set(target, promise);
      return promise;
    }
    readdirSync(target: string): Entry[] {
      const cached = this.#readdirCache.get(target);
      if (cached && !(cached instanceof Promise)) return cached;
      let value: Entry[];
      try {
        value = listing(target);
      } catch {
        value = [];
      }
      this.#readdirCache.set(target, value);
      return value;
    }
    add(target: string, pattern: Pattern) {
      let cache = this.#cache.get(target);
      if (!cache) {
        cache = new Set();
        this.#cache.set(target, cache);
      }
      const originalSize = cache.size;
      for (const index of pattern.indexes) {
        cache.add(pattern.cacheKey(index));
      }
      return cache.size !== originalSize + pattern.indexes.size;
    }
    seen(target: string, pattern: Pattern, index: number) {
      return this.#cache.get(target)?.has(pattern.cacheKey(index));
    }
  }

  const validateStringArrayOrFunction = (value: unknown, name: string) => {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; ++i)
        if (typeof value[i] !== 'string')
          throw invalidArgType(`${name}[${i}]`, 'of type string', value[i]);
      return;
    }
    if (typeof value !== 'function')
      throw invalidArgType(name, 'of type function or string[]', value);
  };

  class Glob {
    #root: unknown;
    #exclude: ExcludeFn;
    readonly #cache = new Cache();
    readonly #results = new ResultSet();
    readonly #queue: Queued[] = [];
    readonly #subpatterns = new Map<string, Pattern[]>();
    readonly #patterns: Pattern[];
    readonly #withFileTypes: boolean;
    #isExcluded: (value: string) => boolean = () => false;

    constructor(pattern: unknown, options: unknown = {}) {
      if (options === null || Array.isArray(options) || typeof options !== 'object')
        throw invalidArgType('options', 'of type object', options);
      const { exclude, cwd: directory, withFileTypes } = options as Record<string, unknown>;
      this.#root = toPath(directory) ?? '.';
      this.#withFileTypes = !!withFileTypes;
      this.#results.resolve = (root, value) => resolve(root, value);
      if (exclude != null) {
        validateStringArrayOrFunction(exclude, 'options.exclude');
        if (Array.isArray(exclude)) {
          // Convert the path part of exclude patterns to absolute paths for consistent
          // comparison before instantiating matchers.
          const matchers = exclude
            .map((entry) => resolve(this.#root, entry))
            .map((entry) => new Matcher(entry));
          this.#isExcluded = (value) => matchers.some((matcher) => matcher.match(value));
          this.#results.setup(this.#root as string, this.#isExcluded);
        } else {
          this.#exclude = exclude as ExcludeFn;
        }
      }
      let patterns: string[];
      if (typeof pattern === 'object') {
        if (!Array.isArray(pattern))
          throw invalidArgType('patterns', 'an instance of Array', pattern);
        for (let i = 0; i < pattern.length; i++)
          if (typeof pattern[i] !== 'string')
            throw invalidArgType(`patterns[${i}]`, 'of type string', pattern[i]);
        patterns = pattern as string[];
      } else {
        if (typeof pattern !== 'string')
          throw invalidArgType('patterns', 'of type string', pattern);
        patterns = [pattern];
      }
      this.#patterns = patterns
        .map((entry) => new Matcher(entry))
        .flatMap((matcher) =>
          matcher.set.map(
            (segments, i) =>
              new Pattern(segments, matcher.globParts[i], new Set<number>().add(0), new Set()),
          ),
        );
    }

    globSync(): unknown[] {
      this.#queue.push({ path: '.', patterns: this.#patterns });
      while (this.#queue.length > 0) {
        const item = this.#queue.pop() as Queued;
        for (let i = 0; i < item.patterns.length; i++)
          this.#addSubpatterns(item.path, item.patterns[i]);
        this.#subpatterns.forEach((patterns, target) =>
          this.#queue.push({ path: target, patterns }),
        );
        this.#subpatterns.clear();
      }
      const withFileTypes = this.#withFileTypes;
      return Array.from(this.#results, (target): unknown =>
        withFileTypes
          ? this.#cache.statSync(isAbsolute(target) ? target : join(this.#root as string, target))
          : target,
      );
    }

    #addSubpattern(target: string, pattern: Pattern) {
      if (this.#isExcluded(target)) return;
      const fullpath = resolve(this.#root, target);
      // If path is a directory, add trailing slash and test patterns again.
      if (this.#isExcluded(`${fullpath}/`) && this.#cache.statSync(fullpath)?.isDirectory()) return;
      if (this.#exclude) {
        if (this.#withFileTypes) {
          const stat = this.#cache.statSync(target);
          if (stat !== null) {
            if (this.#exclude(stat)) return;
          }
        } else if (this.#exclude(target)) {
          return;
        }
      }
      const existing = this.#subpatterns.get(target);
      if (!existing) this.#subpatterns.set(target, [pattern]);
      else existing.push(pattern);
    }

    #addSubpatterns(target: string, pattern: Pattern) {
      const seen = this.#cache.add(target, pattern);
      if (seen) return;
      const fullpath = resolve(this.#root, target);
      const stat = this.#cache.statSync(fullpath);
      const last = pattern.last;
      const isDirectory =
        stat?.isDirectory() || (stat?.isSymbolicLink() && pattern.hasSeenSymlinks);
      const isLast = pattern.isLast(!!isDirectory);
      const isFirst = pattern.isFirst();

      if (this.#isExcluded(fullpath)) return;
      if (isFirst && pattern.at(0) === '') {
        // Absolute path, go to root
        this.#addSubpattern('/', pattern.child(new Set<number>().add(1)));
        return;
      }
      if (isFirst && pattern.at(0) === '..') {
        // Start with .., go to parent
        this.#addSubpattern('../', pattern.child(new Set<number>().add(1)));
        return;
      }
      if (isFirst && pattern.at(0) === '.') {
        // Start with ., proceed
        this.#addSubpattern('.', pattern.child(new Set<number>().add(1)));
        return;
      }

      if (isLast && typeof pattern.at(-1) === 'string') {
        // Add result if it exists
        const p = pattern.at(-1) as string;
        const found = this.#cache.statSync(join(fullpath, p));
        if (found && (p || isDirectory)) this.#results.add(join(target, p));
        if (pattern.indexes.size === 1 && pattern.indexes.has(last)) return;
      } else if (
        isLast &&
        pattern.at(-1) === GLOBSTAR &&
        (target !== '.' || pattern.at(0) === '.' || (last === 0 && stat))
      ) {
        // If pattern ends with **, add to results
        // if path is ".", add it only if pattern starts with "." or pattern is exactly "**"
        this.#results.add(target);
      }

      if (!isDirectory) return;

      let children: Entry[];
      const firstPattern =
        pattern.indexes.size === 1 && pattern.at(pattern.indexes.values().next().value as number);
      if (typeof firstPattern === 'string') {
        const found = this.#cache.statSync(join(fullpath, firstPattern));
        if (found) {
          found.name = firstPattern;
          children = [found];
        } else {
          return;
        }
      } else {
        children = this.#cache.readdirSync(fullpath);
      }

      for (let i = 0; i < children.length; i++) {
        const entry = children[i];
        const entryPath = join(target, entry.name);
        this.#cache.addToStatCache(join(fullpath, entry.name), entry);

        const subPatterns = new Set<number>();
        const nSymlinks = new Set<number>();
        for (const index of pattern.indexes) {
          // For each child, check potential patterns
          if (
            this.#cache.seen(entryPath, pattern, index) ||
            this.#cache.seen(entryPath, pattern, index + 1)
          )
            return;
          const current = pattern.at(index);
          const nextIndex = index + 1;
          const next = pattern.at(nextIndex);
          const fromSymlink = pattern.symlinks.has(index);

          if (current === GLOBSTAR) {
            if (
              entry.name[0] === '.' ||
              (this.#exclude && this.#exclude(this.#withFileTypes ? entry : entry.name))
            )
              continue;
            if (!fromSymlink && entry.isDirectory()) {
              // If directory, add ** to its potential patterns
              subPatterns.add(index);
            } else if (!fromSymlink && index === last) {
              // If ** is last, add to results
              this.#results.add(entryPath);
            }

            // Any pattern after ** is also a potential pattern
            // so we can already test it here
            const nextMatches = pattern.test(nextIndex, entry.name);
            if (nextMatches && nextIndex === last && !isLast) {
              // If next pattern is the last one, add to results
              this.#results.add(entryPath);
            } else if (nextMatches && entry.isDirectory()) {
              // Pattern matched, meaning two patterns forward
              // are also potential patterns
              // e.g **/b/c when entry is a/b - add c to potential patterns
              subPatterns.add(index + 2);
            }
            if (
              (nextMatches || pattern.at(0) === '.') &&
              (entry.isDirectory() || entry.isSymbolicLink()) &&
              !fromSymlink
            ) {
              // If pattern after ** matches, or pattern starts with "."
              // and entry is a directory or symlink, add to potential patterns
              subPatterns.add(nextIndex);
            }

            if (entry.isSymbolicLink()) nSymlinks.add(index);

            if (next === '..' && entry.isDirectory()) {
              // In case pattern is "**/..",
              // both parent and current directory should be added to the queue
              // if this is the last pattern, add to results instead
              const parent = join(target, '..');
              if (nextIndex < last) {
                if (
                  !this.#subpatterns.has(target) &&
                  !this.#cache.seen(target, pattern, nextIndex + 1)
                )
                  this.#subpatterns.set(target, [
                    pattern.child(new Set<number>().add(nextIndex + 1)),
                  ]);
                if (
                  !this.#subpatterns.has(parent) &&
                  !this.#cache.seen(parent, pattern, nextIndex + 1)
                )
                  this.#subpatterns.set(parent, [
                    pattern.child(new Set<number>().add(nextIndex + 1)),
                  ]);
              } else {
                if (!this.#cache.seen(target, pattern, nextIndex)) {
                  this.#cache.add(target, pattern.child(new Set<number>().add(nextIndex)));
                  this.#results.add(target);
                }
                if (
                  !this.#cache.seen(target, pattern, nextIndex) ||
                  !this.#cache.seen(parent, pattern, nextIndex)
                ) {
                  this.#cache.add(parent, pattern.child(new Set<number>().add(nextIndex)));
                  this.#results.add(parent);
                }
              }
            }
          }
          if (typeof current === 'string') {
            if (pattern.test(index, entry.name) && index !== last) {
              // If current pattern matches entry name
              // the next pattern is a potential pattern
              subPatterns.add(nextIndex);
            } else if (current === '.' && pattern.test(nextIndex, entry.name)) {
              // If current pattern is ".", proceed to test next pattern
              if (nextIndex === last) this.#results.add(entryPath);
              else subPatterns.add(nextIndex + 1);
            }
          }
          if (typeof current === 'object' && pattern.test(index, entry.name)) {
            // If current pattern is a regex that matches entry name (e.g *.js)
            // add next pattern to potential patterns, or to results if it's the last pattern
            if (index === last) this.#results.add(entryPath);
            else if (entry.isDirectory()) subPatterns.add(nextIndex);
          }
        }
        if (subPatterns.size > 0) {
          // If there are potential patterns, add to queue
          this.#addSubpattern(entryPath, pattern.child(subPatterns, nSymlinks));
        }
      }
    }

    async *glob(): AsyncGenerator<unknown> {
      this.#queue.push({ path: '.', patterns: this.#patterns });
      while (this.#queue.length > 0) {
        const item = this.#queue.pop() as Queued;
        for (let i = 0; i < item.patterns.length; i++)
          yield* this.#iterateSubpatterns(item.path, item.patterns[i]);
        this.#subpatterns.forEach((patterns, target) =>
          this.#queue.push({ path: target, patterns }),
        );
        this.#subpatterns.clear();
      }
    }

    async *#iterateSubpatterns(target: string, pattern: Pattern): AsyncGenerator<unknown> {
      const seen = this.#cache.add(target, pattern);
      if (seen) return;
      const fullpath = resolve(this.#root, target);
      const stat = await this.#cache.stat(fullpath);
      const last = pattern.last;
      const isDirectory =
        stat?.isDirectory() || (stat?.isSymbolicLink() && pattern.hasSeenSymlinks);
      const isLast = pattern.isLast(!!isDirectory);
      const isFirst = pattern.isFirst();

      if (this.#isExcluded(fullpath)) return;
      if (isFirst && pattern.at(0) === '') {
        // Absolute path, go to root
        this.#addSubpattern('/', pattern.child(new Set<number>().add(1)));
        return;
      }
      if (isFirst && pattern.at(0) === '..') {
        // Start with .., go to parent
        this.#addSubpattern('../', pattern.child(new Set<number>().add(1)));
        return;
      }
      if (isFirst && pattern.at(0) === '.') {
        // Start with ., proceed
        this.#addSubpattern('.', pattern.child(new Set<number>().add(1)));
        return;
      }

      if (isLast && typeof pattern.at(-1) === 'string') {
        // Add result if it exists
        const p = pattern.at(-1) as string;
        const found = await this.#cache.stat(join(fullpath, p));
        if (found && (p || isDirectory)) {
          const result = join(target, p);
          if (!this.#results.has(result)) {
            if (this.#results.add(result)) yield this.#withFileTypes ? found : result;
          }
        }
        if (pattern.indexes.size === 1 && pattern.indexes.has(last)) return;
      } else if (
        isLast &&
        pattern.at(-1) === GLOBSTAR &&
        (target !== '.' || pattern.at(0) === '.' || (last === 0 && stat))
      ) {
        // If pattern ends with **, add to results
        // if path is ".", add it only if pattern starts with "." or pattern is exactly "**"
        if (!this.#results.has(target)) {
          if (this.#results.add(target)) yield this.#withFileTypes ? stat : target;
        }
      }

      if (!isDirectory) return;

      let children: Entry[] | null;
      const firstPattern =
        pattern.indexes.size === 1 && pattern.at(pattern.indexes.values().next().value as number);
      if (typeof firstPattern === 'string') {
        const found = await this.#cache.stat(join(fullpath, firstPattern));
        if (found) {
          found.name = firstPattern;
          children = [found];
        } else {
          return;
        }
      } else {
        children = await this.#cache.readdir(fullpath);
      }

      // Node reads `children.length` unguarded: a listing that failed (a symlink to a
      // file is treated as a directory under `**`) is a TypeError in the async forms.
      for (let i = 0; i < (children as Entry[]).length; i++) {
        const entry = (children as Entry[])[i];
        const entryPath = join(target, entry.name);
        this.#cache.addToStatCache(join(fullpath, entry.name), entry);

        const subPatterns = new Set<number>();
        const nSymlinks = new Set<number>();
        for (const index of pattern.indexes) {
          // For each child, check potential patterns
          if (
            this.#cache.seen(entryPath, pattern, index) ||
            this.#cache.seen(entryPath, pattern, index + 1)
          )
            return;
          const current = pattern.at(index);
          const nextIndex = index + 1;
          const next = pattern.at(nextIndex);
          const fromSymlink = pattern.symlinks.has(index);

          if (current === GLOBSTAR) {
            if (
              entry.name[0] === '.' ||
              (this.#exclude && this.#exclude(this.#withFileTypes ? entry : entry.name))
            )
              continue;
            if (!fromSymlink && entry.isDirectory()) {
              // If directory, add ** to its potential patterns
              subPatterns.add(index);
            } else if (!fromSymlink && index === last) {
              // If ** is last, add to results
              if (!this.#results.has(entryPath)) {
                if (this.#results.add(entryPath)) yield this.#withFileTypes ? entry : entryPath;
              }
            }

            // Any pattern after ** is also a potential pattern
            // so we can already test it here
            const nextMatches = pattern.test(nextIndex, entry.name);
            if (nextMatches && nextIndex === last && !isLast) {
              // If next pattern is the last one, add to results
              if (!this.#results.has(entryPath)) {
                if (this.#results.add(entryPath)) yield this.#withFileTypes ? entry : entryPath;
              }
            } else if (nextMatches && entry.isDirectory()) {
              // Pattern matched, meaning two patterns forward
              // are also potential patterns
              // e.g **/b/c when entry is a/b - add c to potential patterns
              subPatterns.add(index + 2);
            }
            if (
              (nextMatches || pattern.at(0) === '.') &&
              (entry.isDirectory() || entry.isSymbolicLink()) &&
              !fromSymlink
            ) {
              // If pattern after ** matches, or pattern starts with "."
              // and entry is a directory or symlink, add to potential patterns
              subPatterns.add(nextIndex);
            }

            if (entry.isSymbolicLink()) nSymlinks.add(index);

            if (next === '..' && entry.isDirectory()) {
              // In case pattern is "**/..",
              // both parent and current directory should be added to the queue
              // if this is the last pattern, add to results instead
              const parent = join(target, '..');
              if (nextIndex < last) {
                if (
                  !this.#subpatterns.has(target) &&
                  !this.#cache.seen(target, pattern, nextIndex + 1)
                )
                  this.#subpatterns.set(target, [
                    pattern.child(new Set<number>().add(nextIndex + 1)),
                  ]);
                if (
                  !this.#subpatterns.has(parent) &&
                  !this.#cache.seen(parent, pattern, nextIndex + 1)
                )
                  this.#subpatterns.set(parent, [
                    pattern.child(new Set<number>().add(nextIndex + 1)),
                  ]);
              } else {
                if (!this.#cache.seen(target, pattern, nextIndex)) {
                  this.#cache.add(target, pattern.child(new Set<number>().add(nextIndex)));
                  if (!this.#results.has(target)) {
                    if (this.#results.add(target))
                      yield this.#withFileTypes ? this.#cache.statSync(fullpath) : target;
                  }
                }
                if (
                  !this.#cache.seen(target, pattern, nextIndex) ||
                  !this.#cache.seen(parent, pattern, nextIndex)
                ) {
                  this.#cache.add(parent, pattern.child(new Set<number>().add(nextIndex)));
                  if (!this.#results.has(parent)) {
                    if (this.#results.add(parent))
                      yield this.#withFileTypes
                        ? this.#cache.statSync(join(this.#root as string, parent))
                        : parent;
                  }
                }
              }
            }
          }
          if (typeof current === 'string') {
            if (pattern.test(index, entry.name) && index !== last) {
              // If current pattern matches entry name
              // the next pattern is a potential pattern
              subPatterns.add(nextIndex);
            } else if (current === '.' && pattern.test(nextIndex, entry.name)) {
              // If current pattern is ".", proceed to test next pattern
              if (nextIndex === last) {
                if (!this.#results.has(entryPath)) {
                  if (this.#results.add(entryPath)) yield this.#withFileTypes ? entry : entryPath;
                }
              } else {
                subPatterns.add(nextIndex + 1);
              }
            }
          }
          if (typeof current === 'object' && pattern.test(index, entry.name)) {
            // If current pattern is a regex that matches entry name (e.g *.js)
            // add next pattern to potential patterns, or to results if it's the last pattern
            if (index === last) {
              if (!this.#results.has(entryPath)) {
                if (this.#results.add(entryPath)) yield this.#withFileTypes ? entry : entryPath;
              }
            } else if (entry.isDirectory()) {
              subPatterns.add(nextIndex);
            }
          }
        }
        if (subPatterns.size > 0) {
          // If there are potential patterns, add to queue
          this.#addSubpattern(entryPath, pattern.child(subPatterns, nSymlinks));
        }
      }
    }
  }

  function globSync(pattern: unknown, options?: unknown): unknown[] {
    return new Glob(pattern, options).globSync();
  }

  function glob(pattern: unknown, options?: unknown, callback?: unknown): void {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    if (typeof callback !== 'function') throw invalidArgType('cb', 'of type function', callback);
    const done = callback as (error: unknown, value?: unknown) => void;
    worked();
    (async () => {
      try {
        const res: unknown[] = [];
        for await (const entry of new Glob(pattern, options).glob()) res.push(entry);
        done(null, res);
      } catch (error) {
        done(error);
      }
    })();
  }

  async function* globPromise(pattern: unknown, options?: unknown): AsyncGenerator<unknown> {
    yield* new Glob(pattern, options).glob();
  }

  return { globSync, glob, globPromise };
}
