import { createMemoryJobStore } from '../src/store/memory';
/**
 * Run the shared `JobStore` conformance suite against every store
 * implementation that ships in this package. New stores are added
 * as additional `runJobStoreConformance(…)` calls here (or in their
 * own file importing the same suite).
 */
import { runJobStoreConformance } from './conformance';

runJobStoreConformance('createMemoryJobStore (no default TTL)', () =>
  createMemoryJobStore<string>(),
);

runJobStoreConformance('createMemoryJobStore (with defaultTtlMs)', () =>
  createMemoryJobStore<string>({ defaultTtlMs: 1000 }),
);
