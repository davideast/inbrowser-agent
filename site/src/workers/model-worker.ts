/// <reference lib="webworker" />
/**
 * On-device model worker. Runs the `@inbrowser/model` engine off the main
 * thread so downloading + compiling + decoding never freezes the chat UI.
 * The main thread talks to it via `connectWorkerEngine` (see
 * `../lib/on-device-agent.ts`). `hostEngineInWorker` defaults its factory to
 * `createEngine`, so this is the whole worker entry.
 */
import { hostEngineInWorker } from '@inbrowser/model';

hostEngineInWorker(self as unknown as DedicatedWorkerGlobalScope);
