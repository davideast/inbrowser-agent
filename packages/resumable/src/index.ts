/**
 * `@inbrowser/resumable` — resumable streaming-job engine.
 *
 * Root export carries the engine + types + the `JobStore` contract.
 * Store implementations live at subpaths:
 *   - `@inbrowser/resumable/memory`   — in-process, zero-dep
 *   - `@inbrowser/resumable/rtdb`     — Firebase RTDB (Phase 2)
 *   - `@inbrowser/resumable/testing`  — shared conformance suite + probes
 *
 * See `plans/resumable-and-llm-relay-extraction.md` for the design.
 */
export {
  createJobEngine,
  type CreateJobEngineOpts,
  type JobEngine,
  type SubscribeOpts,
  type SweepSchedule,
} from './engine.js';

export {
  silentLogger,
  type JobEvent,
  type JobMeta,
  type JobSnapshot,
  type JobStatus,
  type Logger,
  type Producer,
  type ProducerCtx,
  type TerminalStatus,
} from './types.js';

export type {
  JobStore,
  SweepOpts,
  SweepResult,
} from './store/contract.js';

export type { IdGenerator } from './ids.js';
