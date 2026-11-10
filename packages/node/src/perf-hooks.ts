// perf_hooks for Node 22.18.0: PerformanceObserver, PerformanceObserverEntryList,
// performance.timerify, perf_hooks.constants, and createHistogram / Histogram /
// RecordableHistogram.
//
// Derivative work of Node.js lib/perf_hooks.js, lib/internal/perf/observe.js,
// lib/internal/perf/timerify.js, lib/internal/perf/performance_entry.js, and
// lib/internal/histogram.js, and HdrHistogram's bucket/percentile indexing
// (deps/histogram), retained under their respective licenses
// (also vendor/node-v22.18.0/LICENSE):
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
// HdrHistogram (public domain under CC0-1.0, and additionally BSD-2-Clause):
//
//   Copyright (c) 2012, 2013, 2014 Gil Tene
//   Copyright (c) 2014 Michael Barker
//   Copyright (c) 2014 Matt Warren
//   All rights reserved.
//
//   Redistribution and use in source and binary forms, with or without
//   modification, are permitted provided that the following conditions are met:
//
//   1. Redistributions of source code must retain the above copyright notice,
//      this list of conditions and the following disclaimer.
//   2. Redistributions in binary form must reproduce the above copyright notice,
//      this list of conditions and the following disclaimer in the documentation
//      and/or other materials provided with the distribution.
//
//   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
//   AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
//   IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
//   ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
//   LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
//   CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
//   SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
//   INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
//   CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
//   ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
//   POSSIBILITY OF SUCH DAMAGE.
import {
  invalidArgType,
  invalidArgValue,
  nodeError,
  outOfRange,
  validateInteger,
  validateNumber,
  validateObject,
} from './node-errors';
import { fault, record } from './protocol';

// Entry types Node produces that the runtime cannot: it has no garbage-collector,
// net, dns, http or resource-timing source. Observing one fails explicitly
// instead of accepting an observer that would never be called.
const UNPRODUCIBLE = new Set(['dns', 'gc', 'http', 'http2', 'net', 'resource']);
const SUPPORTED = Object.freeze(['function', 'mark', 'measure']);

const INT64_MAX = 9223372036854775807n;

const typeError = (code: string, message: string) => nodeError(TypeError, code, message);

const byStartTime = (first: PerformanceEntry, second: PerformanceEntry) =>
  first.startTime - second.startTime;

function bitLength(value: bigint): number {
  let remaining = value;
  let bits = 0;
  while (remaining > 0n) {
    remaining >>= 1n;
    bits++;
  }
  return bits;
}

interface HdrState {
  readonly unitMagnitude: number;
  readonly subBucketHalfCountMagnitude: number;
  readonly subBucketCount: number;
  readonly subBucketHalfCount: number;
  readonly countsLen: number;
  counts: BigInt64Array;
  hdrTotalCount: bigint;
  count: bigint;
  exceeds: bigint;
  minValue: bigint;
  maxValue: bigint;
  lastDeltaNs: bigint | undefined;
}

function createHdrState(lowest: bigint, highest: bigint, figures: number): HdrState {
  const unitMagnitude = Math.max(0, bitLength(lowest) - 1);
  const largestSingleUnit = 2n * 10n ** BigInt(figures);
  const subBucketCountMagnitude = Math.max(1, bitLength(largestSingleUnit - 1n));
  const subBucketHalfCountMagnitude = subBucketCountMagnitude - 1;
  const subBucketCount = 1 << subBucketCountMagnitude;
  const subBucketHalfCount = subBucketCount >> 1;

  let smallestUntrackable = BigInt(subBucketCount) << BigInt(unitMagnitude);
  let bucketsNeeded = 1;
  while (smallestUntrackable <= highest) {
    smallestUntrackable <<= 1n;
    bucketsNeeded++;
  }
  const countsLen = (bucketsNeeded + 1) * subBucketHalfCount;

  return {
    unitMagnitude,
    subBucketHalfCountMagnitude,
    subBucketCount,
    subBucketHalfCount,
    countsLen,
    counts: new BigInt64Array(countsLen),
    hdrTotalCount: 0n,
    count: 0n,
    exceeds: 0n,
    minValue: INT64_MAX,
    maxValue: 0n,
    lastDeltaNs: undefined,
  };
}

function hdrCountsIndex(state: HdrState, value: bigint): number {
  const singleBucketLimit = BigInt(state.subBucketCount) << BigInt(state.unitMagnitude);
  const bucketIndex =
    value < singleBucketLimit
      ? 0
      : bitLength(value) - state.unitMagnitude - state.subBucketHalfCountMagnitude - 1;
  const subBucketIndex = Number(value >> BigInt(bucketIndex + state.unitMagnitude));
  return (
    ((bucketIndex + 1) << state.subBucketHalfCountMagnitude) +
    subBucketIndex -
    state.subBucketHalfCount
  );
}

function hdrRangeAtIndex(state: HdrState, index: number): { lowest: bigint; size: bigint } {
  let bucketIdx: number;
  let subBucketIdx: number;
  if (index < state.subBucketCount) {
    bucketIdx = 0;
    subBucketIdx = index;
  } else {
    bucketIdx = (index >> state.subBucketHalfCountMagnitude) - 1;
    subBucketIdx = (index & (state.subBucketHalfCount - 1)) + state.subBucketHalfCount;
  }
  const shift = BigInt(bucketIdx + state.unitMagnitude);
  return {
    lowest: BigInt(subBucketIdx) << shift,
    size: 1n << shift,
  };
}

function hdrLowestEquivalent(state: HdrState, value: bigint): bigint {
  return hdrRangeAtIndex(state, hdrCountsIndex(state, value)).lowest;
}

function hdrHighestEquivalent(state: HdrState, value: bigint): bigint {
  const { lowest, size } = hdrRangeAtIndex(state, hdrCountsIndex(state, value));
  return lowest + size - 1n;
}

function hdrRecordValues(state: HdrState, value: bigint, count: bigint): boolean {
  if (value < 0n || value > INT64_MAX) return false;
  const index = hdrCountsIndex(state, value);
  if (index < 0 || index >= state.countsLen) return false;
  state.counts[index] += count;
  state.hdrTotalCount += count;
  if (value < state.minValue) state.minValue = value;
  if (value > state.maxValue) state.maxValue = value;
  return true;
}

function hdrMean(state: HdrState): number {
  if (state.hdrTotalCount === 0n) return Number.NaN;
  let total = 0;
  for (let i = 0; i < state.countsLen; i++) {
    const c = state.counts[i];
    if (c === 0n) continue;
    const { lowest, size } = hdrRangeAtIndex(state, i);
    const median = lowest + (size >> 1n);
    total += Number(c) * Number(median);
  }
  return total / Number(state.hdrTotalCount);
}

function hdrStddev(state: HdrState): number {
  if (state.hdrTotalCount === 0n) return Number.NaN;
  const mean = hdrMean(state);
  let geometricDevTotal = 0;
  for (let i = 0; i < state.countsLen; i++) {
    const c = state.counts[i];
    if (c === 0n) continue;
    const { lowest, size } = hdrRangeAtIndex(state, i);
    const dev = Number(lowest + (size >> 1n)) - mean;
    geometricDevTotal += dev * dev * Number(c);
  }
  return Math.sqrt(geometricDevTotal / Number(state.hdrTotalCount));
}

function hdrValueAtPercentile(state: HdrState, percentile: number): bigint {
  if (state.hdrTotalCount === 0n) return 0n;
  const target = BigInt(
    Math.max(1, Math.floor((percentile / 100) * Number(state.hdrTotalCount) + 0.5)),
  );
  let cumulative = 0n;
  for (let i = 0; i < state.countsLen; i++) {
    const c = state.counts[i];
    if (c === 0n) continue;
    cumulative += c;
    if (cumulative >= target) {
      const { lowest, size } = hdrRangeAtIndex(state, i);
      return lowest + size - 1n;
    }
  }
  return 0n;
}

function hdrFillPercentiles<V extends number | bigint>(
  state: HdrState,
  map: Map<number, V>,
  convert: (value: bigint) => V,
): void {
  map.clear();
  if (state.hdrTotalCount === 0n) {
    map.set(100, convert(0n));
    return;
  }
  const nonZero: { index: number; count: bigint }[] = [];
  for (let i = 0; i < state.countsLen; i++) {
    const c = state.counts[i];
    if (c > 0n) nonZero.push({ index: i, count: c });
  }
  let cursor = 0;
  let cumulative = nonZero[0].count;
  let percentileToIterateTo = 0;
  const total = Number(state.hdrTotalCount);

  for (;;) {
    const required = BigInt(Math.max(1, Math.ceil((percentileToIterateTo / 100) * total)));
    while (cumulative < required && cursor + 1 < nonZero.length) {
      cursor++;
      cumulative += nonZero[cursor].count;
    }
    const bucketLowest = hdrRangeAtIndex(state, nonZero[cursor].index).lowest;
    const key = Math.min(percentileToIterateTo, 100);
    map.set(key, convert(bucketLowest));
    if (cumulative >= state.hdrTotalCount) {
      if (key < 100) map.set(100, convert(bucketLowest));
      break;
    }
    const halfDistance = 2 ** (Math.floor(Math.log2(100 / (100 - percentileToIterateTo))) + 1);
    percentileToIterateTo += 100 / halfDistance;
  }
}

function buildPerfConstants(): Record<string, number> {
  const entries: [string, number][] = [
    ['NODE_PERFORMANCE_GC_MAJOR', 4],
    ['NODE_PERFORMANCE_GC_MINOR', 1],
    ['NODE_PERFORMANCE_GC_INCREMENTAL', 8],
    ['NODE_PERFORMANCE_GC_WEAKCB', 16],
    ['NODE_PERFORMANCE_GC_FLAGS_NO', 0],
    ['NODE_PERFORMANCE_GC_FLAGS_CONSTRUCT_RETAINED', 2],
    ['NODE_PERFORMANCE_GC_FLAGS_FORCED', 4],
    ['NODE_PERFORMANCE_GC_FLAGS_SYNCHRONOUS_PHANTOM_PROCESSING', 8],
    ['NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE', 16],
    ['NODE_PERFORMANCE_GC_FLAGS_ALL_EXTERNAL_MEMORY', 32],
    ['NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE', 64],
  ];
  // Node's perf_hooks.constants inherits from a null-prototype object and defines numeric flags.
  const target = Object.create(Object.create(null)) as Record<string, number>;
  for (const [key, value] of entries) {
    Object.defineProperty(target, key, {
      value,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
  return target;
}

const kHistogramToken = Symbol('kHistogramToken');
const histogramStates = new WeakMap<
  object,
  {
    hdr: HdrState;
    recordable: boolean;
    numberMap: Map<number, number>;
    bigintMap: Map<number, bigint>;
  }
>();

function requireHistogram(self: unknown) {
  const slot = typeof self === 'object' && self !== null ? histogramStates.get(self) : undefined;
  if (!slot) throw typeError('ERR_INVALID_THIS', 'Value of "this" must be of type Histogram');
  return slot;
}

function requireRecordableHistogram(self: unknown) {
  const slot = typeof self === 'object' && self !== null ? histogramStates.get(self) : undefined;
  if (!slot || !slot.recordable)
    throw typeError('ERR_INVALID_THIS', 'Value of "this" must be of type RecordableHistogram');
  return slot;
}

class Histogram {
  constructor(token?: unknown) {
    if (token !== kHistogramToken)
      throw typeError('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor');
  }

  get count(): number {
    return Number(requireHistogram(this).hdr.count);
  }

  get countBigInt(): bigint {
    return requireHistogram(this).hdr.count;
  }

  get min(): number {
    const { hdr } = requireHistogram(this);
    return hdr.hdrTotalCount === 0n
      ? Number(INT64_MAX)
      : Number(hdrLowestEquivalent(hdr, hdr.minValue));
  }

  get minBigInt(): bigint {
    const { hdr } = requireHistogram(this);
    return hdr.hdrTotalCount === 0n ? INT64_MAX : hdrLowestEquivalent(hdr, hdr.minValue);
  }

  get max(): number {
    const { hdr } = requireHistogram(this);
    return hdr.hdrTotalCount === 0n ? 0 : Number(hdrHighestEquivalent(hdr, hdr.maxValue));
  }

  get maxBigInt(): bigint {
    const { hdr } = requireHistogram(this);
    return hdr.hdrTotalCount === 0n ? 0n : hdrHighestEquivalent(hdr, hdr.maxValue);
  }

  get mean(): number {
    return hdrMean(requireHistogram(this).hdr);
  }

  get exceeds(): number {
    return Number(requireHistogram(this).hdr.exceeds);
  }

  get exceedsBigInt(): bigint {
    return requireHistogram(this).hdr.exceeds;
  }

  get stddev(): number {
    return hdrStddev(requireHistogram(this).hdr);
  }

  percentile(percentile: unknown): number {
    const { hdr } = requireHistogram(this);
    validateNumber(percentile, 'percentile');
    // validateNumber narrowed `percentile` to number.
    const p = percentile as number;
    if (Number.isNaN(p) || p <= 0 || p > 100) throw outOfRange('percentile', '> 0 && <= 100', p);
    return Number(hdrValueAtPercentile(hdr, p));
  }

  percentileBigInt(percentile: unknown): bigint {
    const { hdr } = requireHistogram(this);
    validateNumber(percentile, 'percentile');
    // validateNumber narrowed `percentile` to number.
    const p = percentile as number;
    if (Number.isNaN(p) || p <= 0 || p > 100) throw outOfRange('percentile', '> 0 && <= 100', p);
    return hdrValueAtPercentile(hdr, p);
  }

  get percentiles(): Map<number, number> {
    const slot = requireHistogram(this);
    hdrFillPercentiles(slot.hdr, slot.numberMap, (value) => Number(value));
    return slot.numberMap;
  }

  get percentilesBigInt(): Map<number, bigint> {
    const slot = requireHistogram(this);
    hdrFillPercentiles(slot.hdr, slot.bigintMap, (value) => value);
    return slot.bigintMap;
  }

  reset(): void {
    const { hdr } = requireHistogram(this);
    hdr.counts.fill(0n);
    hdr.hdrTotalCount = 0n;
    hdr.count = 0n;
    hdr.exceeds = 0n;
    hdr.minValue = INT64_MAX;
    hdr.maxValue = 0n;
    hdr.lastDeltaNs = undefined;
  }

  toJSON() {
    return {
      count: this.count,
      min: this.min,
      max: this.max,
      mean: this.mean,
      exceeds: this.exceeds,
      stddev: this.stddev,
      percentiles: Object.fromEntries(this.percentiles.entries()),
    };
  }
}

class RecordableHistogram extends Histogram {
  constructor(token?: unknown) {
    if (token !== kHistogramToken)
      throw typeError('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor');
    super(token);
  }

  record(val: unknown): void {
    const { hdr } = requireRecordableHistogram(this);
    let amount: bigint;
    if (typeof val === 'bigint') {
      if (val < 1n || val > INT64_MAX)
        throw nodeError(RangeError, 'ERR_OUT_OF_RANGE', 'value is out of range');
      amount = val;
    } else {
      validateInteger(val, 'val', 1, Number.MAX_SAFE_INTEGER);
      // validateInteger narrowed `val` to a safe positive integer.
      amount = BigInt(val as number);
    }
    if (hdrRecordValues(hdr, amount, 1n)) hdr.count += 1n;
    else hdr.exceeds += 1n;
  }

  recordDelta(): void {
    const { hdr } = requireRecordableHistogram(this);
    const nowNs = BigInt(Math.round(globalThis.performance.now() * 1e6));
    const prev = hdr.lastDeltaNs;
    hdr.lastDeltaNs = nowNs;
    if (prev === undefined) return;
    const rawDelta = nowNs - prev;
    // Browser performance.now() is coarsened; clamp consecutive samples to >= 1 ns.
    const delta = rawDelta >= 1n ? rawDelta : 1n;
    if (hdrRecordValues(hdr, delta, 1n)) hdr.count += 1n;
    else hdr.exceeds += 1n;
  }

  add(other: unknown): void {
    const dest = requireRecordableHistogram(this);
    const src =
      typeof other === 'object' && other !== null ? histogramStates.get(other) : undefined;
    if (!src || !src.recordable) throw invalidArgType('other', 'RecordableHistogram', other);
    for (let i = 0; i < src.hdr.countsLen; i++) {
      const c = src.hdr.counts[i];
      if (c === 0n) continue;
      const { lowest } = hdrRangeAtIndex(src.hdr, i);
      hdrRecordValues(dest.hdr, lowest, c);
    }
    dest.hdr.count += src.hdr.count;
    dest.hdr.exceeds += src.hdr.exceeds;
  }
}

export function createHistogram(options: unknown = {}): RecordableHistogram {
  validateObject(options, 'options');
  const { lowest = 1, highest = Number.MAX_SAFE_INTEGER, figures = 3 } = options;

  let lowestBig: bigint;
  if (typeof lowest === 'bigint') {
    if (lowest < 1n || lowest > INT64_MAX) throw invalidArgValue('options.lowest', lowest);
    lowestBig = lowest;
  } else {
    validateInteger(lowest, 'options.lowest', 1, Number.MAX_SAFE_INTEGER);
    // validateInteger narrowed `lowest` to a safe integer.
    lowestBig = BigInt(lowest as number);
  }

  let highestBig: bigint;
  if (typeof highest === 'bigint') {
    if (highest < 2n * lowestBig || highest > INT64_MAX) {
      throw Object.assign(
        new RangeError(`The property 'options.highest' is invalid. Received ${highest}n`),
        { code: 'ERR_INVALID_ARG_VALUE' },
      );
    }
    highestBig = highest;
  } else {
    validateInteger(highest, 'options.highest', 2 * Number(lowestBig), Number.MAX_SAFE_INTEGER);
    // validateInteger narrowed `highest` to a safe integer.
    highestBig = BigInt(highest as number);
  }

  validateInteger(figures, 'options.figures', 1, 5);
  const instance = new RecordableHistogram(kHistogramToken);
  histogramStates.set(instance, {
    // validateInteger narrowed `figures` to an integer in [1, 5].
    hdr: createHdrState(lowestBig, highestBig, figures as number),
    recordable: true,
    numberMap: new Map(),
    bigintMap: new Map(),
  });
  return instance;
}

const kNodeEntryFields = new WeakMap<
  object,
  { name: string; entryType: string; startTime: number; duration: number; detail: unknown }
>();

function requireNodeEntry(self: unknown, typeName: string) {
  const fields = typeof self === 'object' && self !== null ? kNodeEntryFields.get(self) : undefined;
  if (!fields) throw typeError('ERR_INVALID_THIS', `Value of "this" must be of type ${typeName}`);
  return fields;
}

// Non-constructible subclass prototype carrier linked to globalThis.PerformanceEntry below.
const PerformanceNodeEntry = function PerformanceNodeEntry() {
  throw typeError('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor');
} as unknown as { new (): PerformanceEntry; prototype: Record<string | symbol, unknown> };
Object.defineProperty(PerformanceNodeEntry, 'name', {
  value: 'PerformanceNodeEntry',
  configurable: true,
});
Object.defineProperty(Histogram, 'name', { value: 'Histogram', configurable: true });
Object.defineProperty(RecordableHistogram, 'name', {
  value: 'RecordableHistogram',
  configurable: true,
});
Object.setPrototypeOf(PerformanceNodeEntry.prototype, globalThis.PerformanceEntry.prototype);
Object.setPrototypeOf(PerformanceNodeEntry, globalThis.PerformanceEntry);
Object.defineProperties(PerformanceNodeEntry.prototype, {
  [Symbol.toStringTag]: { value: undefined, configurable: true },
  name: {
    enumerable: true,
    configurable: true,
    get() {
      return requireNodeEntry(this, 'PerformanceEntry').name;
    },
  },
  entryType: {
    enumerable: true,
    configurable: true,
    get() {
      return requireNodeEntry(this, 'PerformanceEntry').entryType;
    },
  },
  startTime: {
    enumerable: true,
    configurable: true,
    get() {
      return requireNodeEntry(this, 'PerformanceEntry').startTime;
    },
  },
  duration: {
    enumerable: true,
    configurable: true,
    get() {
      return requireNodeEntry(this, 'PerformanceEntry').duration;
    },
  },
  detail: {
    enumerable: false,
    configurable: true,
    get() {
      return requireNodeEntry(this, 'NodePerformanceEntry').detail;
    },
  },
  toJSON: {
    enumerable: true,
    writable: true,
    configurable: true,
    value: function toJSON(this: unknown) {
      const fields = requireNodeEntry(this, 'PerformanceEntry');
      return {
        name: fields.name,
        entryType: fields.entryType,
        startTime: fields.startTime,
        duration: fields.duration,
        detail: fields.detail,
      };
    },
  },
});

function createPerformanceNodeEntry(
  name: string,
  entryType: string,
  startTime: number,
  duration: number,
  detail: unknown[],
): PerformanceEntry {
  // Inherits from globalThis.PerformanceEntry.prototype without invoking the illegal native constructor.
  const entry = Object.create(PerformanceNodeEntry.prototype) as PerformanceEntry &
    Record<number, unknown>;
  kNodeEntryFields.set(entry, { name, entryType, startTime, duration, detail });
  for (let i = 0; i < detail.length; i++) {
    entry[i] = detail[i];
  }
  return entry;
}

export interface PerfHooksRuntimeDeps {
  hrtimeNs?: () => bigint;
  setInterval?: (fn: (...args: unknown[]) => void, delay?: unknown, ...args: unknown[]) => unknown;
  clearInterval?: (timer: unknown) => void;
  getLoopExit?: () => number;
}

const PerformanceNodeTiming = function PerformanceNodeTiming() {
  throw typeError('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor');
} as unknown as { new (): PerformanceEntry; prototype: Record<string | symbol, unknown> };
Object.defineProperty(PerformanceNodeTiming, 'name', {
  value: 'PerformanceNodeTiming',
  configurable: true,
});
Object.setPrototypeOf(PerformanceNodeTiming.prototype, globalThis.PerformanceEntry.prototype);
Object.setPrototypeOf(PerformanceNodeTiming, globalThis.PerformanceEntry);
Object.defineProperties(PerformanceNodeTiming.prototype, {
  [Symbol.toStringTag]: { value: 'PerformanceNodeTiming', configurable: true },
  toJSON: {
    enumerable: false,
    writable: true,
    configurable: true,
    value: function toJSON(this: Record<string, unknown>) {
      return {
        name: this.name,
        entryType: this.entryType,
        startTime: this.startTime,
        duration: this.duration,
        nodeStart: this.nodeStart,
        v8Start: this.v8Start,
        bootstrapComplete: this.bootstrapComplete,
        environment: this.environment,
        loopStart: this.loopStart,
        loopExit: this.loopExit,
        idleTime: this.idleTime,
      };
    },
  },
});

interface EluSnapshot {
  idle: number;
  active: number;
  utilization: number;
}

function isEluObject(val: unknown): val is { idle: number; active: number } {
  return record(val) && typeof val.idle === 'number' && typeof val.active === 'number';
}

/**
 * perf_hooks' PerformanceObserver, timerify, constants, createHistogram,
 * monitorEventLoopDelay, eventLoopUtilization, nodeTiming, and markResourceTiming,
 * after Node's lib/perf_hooks.js, lib/internal/perf/observe.js,
 * lib/internal/perf/timerify.js, and lib/internal/histogram.js.
 */
export function createPerfHooks(
  setImmediate: (callback: () => void) => unknown,
  runtimeDeps: PerfHooksRuntimeDeps = {},
) {
  const timeline = globalThis.performance;
  const bootNow = timeline.now();
  let loopTurns = 0;
  const sampleHrNs = runtimeDeps.hrtimeNs ?? (() => BigInt(Math.round(timeline.now() * 1_000_000)));
  const startInterval =
    runtimeDeps.setInterval ?? ((fn, delay) => globalThis.setInterval(fn, Number(delay)));
  const stopInterval =
    runtimeDeps.clearInterval ??
    ((timer) => globalThis.clearInterval(timer as ReturnType<typeof setInterval>));

  const observers = new Set<PerformanceObserver>();
  const pending = new Set<PerformanceObserver>();
  let scheduled = false;
  const dispatchers = new WeakMap<PerformanceObserver, () => void>();
  const buffers = new WeakMap<PerformanceObserver, (entry: PerformanceEntry) => void>();

  function queuePending() {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      loopTurns++;
      scheduled = false;
      const ready = [...pending];
      pending.clear();
      for (const observer of ready) dispatchers.get(observer)?.();
    });
  }

  function enqueue(entry: PerformanceEntry) {
    for (const observer of observers) buffers.get(observer)?.(entry);
  }

  // Interpose on this Worker's own timeline, which is also the guest's global
  // `performance`, so entries from either reach observers. The browser methods
  // keep their own receiver checks.
  for (const name of ['mark', 'measure'] as const) {
    // Browser Performance#mark and Performance#measure return the created PerformanceEntry.
    const create = timeline[name] as (...args: unknown[]) => PerformanceEntry;
    Object.defineProperty(timeline, name, {
      configurable: true,
      writable: true,
      enumerable: true,
      value: {
        [name](this: unknown, ...args: unknown[]) {
          // Delegated call returns the native PerformanceMark / PerformanceMeasure entry.
          const entry = Reflect.apply(create, this, args) as PerformanceEntry;
          enqueue(entry);
          return entry;
        },
      }[name],
    });
  }

  function processComplete(
    name: string,
    start: number,
    args: unknown[],
    histogram: RecordableHistogram | undefined,
  ): void {
    const duration = timeline.now() - start;
    if (histogram !== undefined) {
      // Coarsened browser clocks can report duration === 0 for sub-microsecond calls; clamp >= 1 ns.
      const ns = Math.ceil(duration * 1e6);
      histogram.record(ns >= 1 ? ns : 1);
    }
    const entry = createPerformanceNodeEntry(name, 'function', start, duration, args);
    enqueue(entry);
  }

  function timerify<Fn extends (...args: never[]) => unknown>(
    fn: unknown,
    options: unknown = {},
  ): Fn {
    if (typeof fn !== 'function') throw invalidArgType('fn', 'function', fn);
    validateObject(options, 'options');
    const { histogram } = options;
    if (histogram !== undefined) {
      const slot =
        typeof histogram === 'object' && histogram !== null
          ? histogramStates.get(histogram)
          : undefined;
      if (
        !slot ||
        !slot.recordable ||
        // histogram was narrowed to non-null object via `slot` lookup above.
        typeof (histogram as { record?: unknown }).record !== 'function'
      ) {
        throw invalidArgType('options.histogram', 'RecordableHistogram', histogram);
      }
    }
    // Validated above as either undefined or a RecordableHistogram registered in histogramStates.
    const recordable = histogram as RecordableHistogram | undefined;
    // Checked `typeof fn === 'function'` above.
    const callable = fn as (...args: unknown[]) => unknown;

    function timerified(this: unknown, ...args: unknown[]): unknown {
      const isConstructorCall = new.target !== undefined;
      const start = timeline.now();
      const result: unknown = isConstructorCall
        ? // Invoked with `new`, so Reflect.construct delegates construction (or throws if non-constructor).
          Reflect.construct(callable as unknown as new (...a: unknown[]) => object, args, callable)
        : Reflect.apply(callable, this, args);
      if (
        !isConstructorCall &&
        result !== null &&
        (typeof result === 'object' || typeof result === 'function') &&
        // Narrowed `result` to non-null object/function before probing `.finally`.
        typeof (result as { finally?: unknown }).finally === 'function'
      ) {
        return Reflect.apply(
          // Verified `result.finally` is a function just above.
          (result as { finally: (...a: unknown[]) => unknown }).finally,
          result,
          [() => processComplete(callable.name, start, args, recordable)],
        );
      }
      processComplete(callable.name, start, args, recordable);
      return result;
    }

    Object.defineProperties(timerified, {
      length: {
        configurable: false,
        enumerable: true,
        writable: false,
        value: callable.length,
      },
      name: {
        configurable: false,
        enumerable: true,
        writable: false,
        value: `timerified ${callable.name}`,
      },
    });
    // `timerified` forwards construct/apply with identical arguments and return value.
    return timerified as unknown as Fn;
  }

  function eventLoopUtilization(util1?: unknown, util2?: unknown): EluSnapshot {
    if (util2 !== undefined) {
      if (!isEluObject(util1)) throw invalidArgType('utilization1', 'Object', util1);
      if (!isEluObject(util2)) throw invalidArgType('utilization2', 'Object', util2);
      const idle = util1.idle - util2.idle;
      const active = util1.active - util2.active;
      if (active <= 0) return { idle: 0, active: 0, utilization: 0 };
      const total = idle + active;
      return { idle, active, utilization: total <= 0 ? 0 : active / total };
    }
    const active = Math.max(0, timeline.now() - bootNow);
    const idle = 0;
    const current: EluSnapshot = {
      idle,
      active,
      utilization: active > 0 ? active / (idle + active) : 0,
    };
    if (util1 !== undefined) {
      if (!isEluObject(util1)) throw invalidArgType('utilization1', 'Object', util1);
      const dIdle = current.idle - util1.idle;
      const dActive = current.active - util1.active;
      if (dActive <= 0) return { idle: 0, active: 0, utilization: 0 };
      const total = dIdle + dActive;
      return { idle: dIdle, active: dActive, utilization: total <= 0 ? 0 : dActive / total };
    }
    return current;
  }

  const nodeTiming = Object.create(PerformanceNodeTiming.prototype) as PerformanceEntry;
  Object.defineProperties(nodeTiming, {
    name: { value: 'node', enumerable: true, configurable: true, writable: false },
    entryType: { value: 'node', enumerable: true, configurable: true, writable: false },
    startTime: { value: 0, enumerable: true, configurable: true, writable: false },
    duration: {
      enumerable: true,
      configurable: true,
      get: () => timeline.now(),
    },
    nodeStart: {
      enumerable: true,
      configurable: true,
      get: () => 0,
    },
    v8Start: {
      enumerable: true,
      configurable: true,
      get: () => 0,
    },
    environment: {
      enumerable: true,
      configurable: true,
      get: () => bootNow,
    },
    loopStart: {
      enumerable: true,
      configurable: true,
      get: () => bootNow,
    },
    bootstrapComplete: {
      enumerable: true,
      configurable: true,
      get: () => bootNow,
    },
    loopExit: {
      enumerable: true,
      configurable: true,
      get: () => runtimeDeps.getLoopExit?.() ?? -1,
    },
    idleTime: {
      enumerable: true,
      configurable: true,
      get: () => 0,
    },
    uvMetricsInfo: {
      enumerable: true,
      configurable: true,
      get: () => ({ loopCount: loopTurns, events: loopTurns, eventsWaiting: 0 }),
    },
  });

  function markResourceTiming(
    timingInfo: unknown,
    requestedUrl: unknown,
    initiatorType: unknown,
    _global: unknown,
    cacheMode: unknown,
    bodyInfo: unknown,
    responseStatus: unknown,
    deliveryType: unknown = '',
  ): PerformanceResourceTiming {
    validateObject(timingInfo, 'timingInfo');
    const name = String(requestedUrl);
    const initType = String(initiatorType);
    const startTime = typeof timingInfo.startTime === 'number' ? timingInfo.startTime : 0;
    const endTime = typeof timingInfo.endTime === 'number' ? timingInfo.endTime : startTime;
    const duration = endTime - startTime;
    const redirectStart =
      typeof timingInfo.redirectStartTime === 'number' ? timingInfo.redirectStartTime : 0;
    const redirectEnd =
      typeof timingInfo.redirectEndTime === 'number' ? timingInfo.redirectEndTime : 0;
    const fetchStart =
      typeof timingInfo.postRedirectStartTime === 'number'
        ? timingInfo.postRedirectStartTime
        : startTime;
    const workerStart =
      typeof timingInfo.finalServiceWorkerStartTime === 'number'
        ? timingInfo.finalServiceWorkerStartTime
        : 0;
    const requestStart =
      typeof timingInfo.finalNetworkRequestStartTime === 'number'
        ? timingInfo.finalNetworkRequestStartTime
        : fetchStart;
    const responseStart =
      typeof timingInfo.finalNetworkResponseStartTime === 'number'
        ? timingInfo.finalNetworkResponseStartTime
        : requestStart;
    const conn = record(timingInfo.finalConnectionTimingInfo)
      ? timingInfo.finalConnectionTimingInfo
      : undefined;
    const domainLookupStart =
      conn && typeof conn.domainLookupStartTime === 'number'
        ? conn.domainLookupStartTime
        : fetchStart;
    const domainLookupEnd =
      conn && typeof conn.domainLookupEndTime === 'number'
        ? conn.domainLookupEndTime
        : domainLookupStart;
    const connectStart =
      conn && typeof conn.connectionStartTime === 'number'
        ? conn.connectionStartTime
        : domainLookupEnd;
    const connectEnd =
      conn && typeof conn.connectionEndTime === 'number' ? conn.connectionEndTime : connectStart;
    const secureConnectionStart =
      conn && typeof conn.secureConnectionStartTime === 'number'
        ? conn.secureConnectionStartTime
        : 0;
    const nextHopProtocol =
      conn && typeof conn.alpnNegotiatedProtocol === 'string' ? conn.alpnNegotiatedProtocol : '';

    const body = record(bodyInfo) ? bodyInfo : undefined;
    const encodedBodySize =
      body && typeof body.encodedSize === 'number'
        ? body.encodedSize
        : typeof timingInfo.encodedBodySize === 'number'
          ? timingInfo.encodedBodySize
          : 0;
    const decodedBodySize =
      body && typeof body.decodedSize === 'number'
        ? body.decodedSize
        : typeof timingInfo.decodedBodySize === 'number'
          ? timingInfo.decodedBodySize
          : 0;
    const transferSize =
      cacheMode === 'local' ? 0 : cacheMode === 'validated' ? 300 : encodedBodySize + 300;
    const status = typeof responseStatus === 'number' ? responseStatus : 0;
    const delivery = typeof deliveryType === 'string' ? deliveryType : '';

    // Inherits from native PerformanceResourceTiming.prototype without invoking the illegal native constructor.
    const entry = Object.create(
      globalThis.PerformanceResourceTiming.prototype,
    ) as PerformanceResourceTiming;
    const fields: Record<string, unknown> = {
      name,
      entryType: 'resource',
      startTime,
      duration,
      initiatorType: initType,
      nextHopProtocol,
      workerStart,
      redirectStart,
      redirectEnd,
      fetchStart,
      domainLookupStart,
      domainLookupEnd,
      connectStart,
      connectEnd,
      secureConnectionStart,
      requestStart,
      responseStart,
      responseEnd: endTime,
      transferSize,
      encodedBodySize,
      decodedBodySize,
      responseStatus: status,
      deliveryType: delivery,
    };
    for (const [k, v] of Object.entries(fields)) {
      Object.defineProperty(entry, k, {
        enumerable: true,
        configurable: true,
        get: () => v,
      });
    }
    Object.defineProperty(entry, 'toJSON', {
      enumerable: true,
      writable: true,
      configurable: true,
      value: () => ({ ...fields }),
    });
    return entry;
  }

  class IntervalHistogram extends Histogram {
    #resolutionMs: number;
    #enabled = false;
    #timer: unknown = undefined;
    #lastNs = 0n;

    constructor(token: unknown, resolutionMs: number) {
      if (token !== kHistogramToken)
        throw typeError('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor');
      super(token);
      this.#resolutionMs = resolutionMs;
    }

    enable(): boolean {
      if (this.#enabled) return false;
      this.#enabled = true;
      this.#lastNs = sampleHrNs();
      const expectedNs = BigInt(this.#resolutionMs) * 1_000_000n;
      const slot = requireHistogram(this);
      const timer = startInterval(() => {
        if (!this.#enabled) return;
        const nowNs = sampleHrNs();
        const rawElapsed = nowNs - this.#lastNs;
        this.#lastNs = nowNs;
        const sample = rawElapsed >= expectedNs ? rawElapsed : expectedNs;
        if (hdrRecordValues(slot.hdr, sample, 1n)) slot.hdr.count += 1n;
        else slot.hdr.exceeds += 1n;
      }, this.#resolutionMs);
      if (record(timer) && typeof timer.unref === 'function') {
        timer.unref();
      }
      this.#timer = timer;
      return true;
    }

    disable(): boolean {
      if (!this.#enabled) return false;
      this.#enabled = false;
      if (this.#timer !== undefined) {
        stopInterval(this.#timer);
        this.#timer = undefined;
      }
      return true;
    }
  }

  function monitorEventLoopDelay(options: unknown = {}): IntervalHistogram {
    validateObject(options, 'options');
    const { resolution = 10 } = options;
    validateInteger(resolution, 'options.resolution', 1, Number.MAX_SAFE_INTEGER);
    // validateInteger narrowed `resolution` to a positive safe integer.
    const resMs = resolution as number;
    const instance = new IntervalHistogram(kHistogramToken, resMs);
    histogramStates.set(instance, {
      hdr: createHdrState(1n, 3_600_000_000_000n, 3),
      recordable: false,
      numberMap: new Map(),
      bigintMap: new Map(),
    });
    return instance;
  }

  const perfProto: unknown = Object.getPrototypeOf(timeline);
  if (typeof perfProto === 'object' && perfProto !== null) {
    Object.defineProperties(perfProto, {
      timerify: {
        value: timerify,
        writable: true,
        enumerable: false,
        configurable: true,
      },
      eventLoopUtilization: {
        value: eventLoopUtilization,
        writable: true,
        enumerable: false,
        configurable: true,
      },
      markResourceTiming: {
        value: markResourceTiming,
        writable: true,
        enumerable: false,
        configurable: true,
      },
      nodeTiming: {
        value: nodeTiming,
        writable: true,
        enumerable: false,
        configurable: true,
      },
    });
  }

  const listToken = Symbol('PerformanceObserverEntryList');
  const listEntries = new WeakMap<object, PerformanceEntry[]>();
  const entriesOf = (list: unknown) => {
    const entries = typeof list === 'object' && list !== null ? listEntries.get(list) : undefined;
    if (!entries)
      throw typeError(
        'ERR_INVALID_THIS',
        'Value of "this" must be of type PerformanceObserverEntryList',
      );
    return entries;
  };

  class PerformanceObserverEntryList {
    constructor(token?: unknown, entries: PerformanceEntry[] = []) {
      if (token !== listToken) throw typeError('ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor');
      listEntries.set(this, entries.sort(byStartTime));
    }

    getEntries() {
      return entriesOf(this).slice();
    }

    getEntriesByType(type: unknown) {
      const entries = entriesOf(this);
      if (arguments.length === 0)
        throw typeError('ERR_MISSING_ARGS', 'The "type" argument must be specified');
      const wanted = `${String(type)}`;
      return entries.filter((entry) => entry.entryType === wanted);
    }

    getEntriesByName(name: unknown, type?: unknown) {
      const entries = entriesOf(this);
      if (arguments.length === 0)
        throw typeError('ERR_MISSING_ARGS', 'The "name" argument must be specified');
      const wanted = `${String(name)}`;
      return entries.filter(
        (entry) => entry.name === wanted && (type == null || entry.entryType === type),
      );
    }
  }

  type ObserverCallback = (
    list: PerformanceObserverEntryList,
    observer: PerformanceObserver,
  ) => void;

  class PerformanceObserver {
    #buffer: PerformanceEntry[] = [];
    #entryTypes = new Set<string>();
    #mode: 'single' | 'multiple' | undefined;
    #callback: ObserverCallback;

    constructor(callback: unknown) {
      if (typeof callback !== 'function')
        throw typeError(
          'ERR_INVALID_ARG_TYPE',
          `The "callback" argument must be of type function. Received ${describe(callback)}`,
        );
      // Checked to be a function just above.
      this.#callback = callback as ObserverCallback;
      dispatchers.set(this, () => {
        const list = new PerformanceObserverEntryList(listToken, this.takeRecords());
        Reflect.apply(this.#callback, undefined, [list, this]);
      });
      buffers.set(this, (entry) => {
        if (!this.#entryTypes.has(entry.entryType)) return;
        this.#buffer.push(entry);
        pending.add(this);
        queuePending();
      });
    }

    observe(options: unknown = {}) {
      if (!record(options) || Array.isArray(options))
        throw typeError(
          'ERR_INVALID_ARG_TYPE',
          `The "options" argument must be of type object. Received ${describe(options)}`,
        );
      const { entryTypes, type, buffered } = { ...options };
      if (entryTypes === undefined && type === undefined)
        throw typeError(
          'ERR_MISSING_ARGS',
          'The "options.entryTypes" and "options.type" arguments must be specified',
        );
      if (entryTypes != null && type != null)
        throw typeError(
          'ERR_INVALID_ARG_VALUE',
          "The property 'options.entryTypes' options.entryTypes can not set with options.type together.",
        );
      if (this.#mode === 'single' && entryTypes !== undefined)
        throw new DOMException(
          'PerformanceObserver can not change to multiple observations',
          'InvalidModificationError',
        );
      if (this.#mode === 'multiple' && type !== undefined)
        throw new DOMException(
          'PerformanceObserver can not change to single observation',
          'InvalidModificationError',
        );
      // As in Node, the mode is fixed before the remaining options are validated.
      if (this.#mode === undefined) {
        if (entryTypes !== undefined) this.#mode = 'multiple';
        if (type !== undefined) this.#mode = 'single';
      }
      if (this.#mode === 'multiple') {
        if (!Array.isArray(entryTypes))
          throw typeError(
            'ERR_INVALID_ARG_TYPE',
            `The "options.entryTypes" property must be string[]. Received ${describe(entryTypes)}`,
          );
        for (const entryType of entryTypes) unproducible(entryType);
        this.#entryTypes.clear();
        for (const entryType of entryTypes) {
          if (typeof entryType === 'string' && SUPPORTED.includes(entryType)) {
            this.#entryTypes.add(entryType);
          }
        }
      } else {
        unproducible(type);
        // Node ignores a type it does not know.
        if (typeof type !== 'string' || !SUPPORTED.includes(type)) return;
        this.#entryTypes.add(type);
        if (buffered) {
          const past = type === 'function' ? [] : timeline.getEntriesByType(type).sort(byStartTime);
          if (past.length > 0) this.#buffer.push(...past);
          // Node 22.18 observe.js unconditionally queues an observer notification when buffered: true.
          pending.add(this);
          queuePending();
        }
      }
      if (this.#entryTypes.size) observers.add(this);
      else this.disconnect();
    }

    disconnect() {
      observers.delete(this);
      pending.delete(this);
      this.#buffer = [];
      this.#entryTypes.clear();
      this.#mode = undefined;
    }

    takeRecords() {
      const list = this.#buffer;
      this.#buffer = [];
      return list;
    }

    static get supportedEntryTypes() {
      return SUPPORTED;
    }
  }

  for (const [target, tag, methods] of [
    [
      PerformanceObserver.prototype,
      'PerformanceObserver',
      ['observe', 'disconnect', 'takeRecords'],
    ],
    [
      PerformanceObserverEntryList.prototype,
      'PerformanceObserverEntryList',
      ['getEntries', 'getEntriesByType', 'getEntriesByName'],
    ],
  ] as const) {
    for (const method of methods) Object.defineProperty(target, method, { enumerable: true });
    Object.defineProperty(target, Symbol.toStringTag, {
      configurable: true,
      enumerable: false,
      writable: false,
      value: tag,
    });
  }

  const moduleExports = {
    Performance: globalThis.Performance,
    PerformanceEntry: globalThis.PerformanceEntry,
    PerformanceMark: globalThis.PerformanceMark,
    PerformanceMeasure: globalThis.PerformanceMeasure,
    PerformanceObserver,
    PerformanceObserverEntryList,
    PerformanceResourceTiming: globalThis.PerformanceResourceTiming,
    monitorEventLoopDelay,
    createHistogram,
    performance: timeline,
  };
  Object.defineProperty(moduleExports, 'constants', {
    value: buildPerfConstants(),
    writable: false,
    enumerable: true,
    configurable: false,
  });
  return moduleExports;
}

function unproducible(type: unknown) {
  if (typeof type === 'string' && UNPRODUCIBLE.has(type))
    throw fault(
      'ENOSYS',
      `PerformanceObserver entry type ${type} is not supported in the browser runtime`,
    );
}

/** The "Received ..." suffix of Node's argument errors, for the common cases. */
function describe(value: unknown) {
  if (value == null) return String(value);
  if (typeof value === 'function') return `function ${value.name}`;
  if (typeof value === 'object') return 'an instance of ' + (value.constructor?.name ?? 'Object');
  const shown = typeof value === 'string' ? `'${value}'` : String(value);
  return `type ${typeof value} (${shown})`;
}
