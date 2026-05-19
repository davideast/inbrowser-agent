/**
 * Surface smoke tests — verify shape + lifecycle invariants without
 * loading a real model. The actual @huggingface/transformers load
 * path is exercised end-to-end by the browser example's verify
 * script (examples/local-llm-poc/scripts/verify.ts), which needs a
 * dev server + network to HuggingFace Hub and is therefore not a
 * unit test.
 */

import { describe, expect, test } from 'bun:test';
import { createEngine, definePreset } from '../src/engine.js';
import { smollm2_360m } from '../src/presets.js';
import type { ModelPreset } from '../src/types.js';

describe('createEngine', () => {
  test('exposes the preset metadata pre-load', () => {
    const engine = createEngine(smollm2_360m);
    expect(engine.state).toBe('idle');
    expect(engine.model.modelId).toBe(smollm2_360m.model.modelId);
    expect(engine.capabilities).toEqual(smollm2_360m.capabilities);
  });

  test('on() returns an unsubscribe function', () => {
    const engine = createEngine(smollm2_360m);
    let stateEvents = 0;
    const off = engine.on('state', () => {
      stateEvents++;
    });
    expect(typeof off).toBe('function');
    off();
    // No assertion on stateEvents value — just confirms the
    // subscriber API is wired and returns a callable detach.
  });

  test('dispose() transitions state to disposed', async () => {
    const engine = createEngine(smollm2_360m);
    await engine.dispose();
    expect(engine.state).toBe('disposed');
  });

  test('ensureReady() after dispose rejects', async () => {
    const engine = createEngine(smollm2_360m);
    await engine.dispose();
    await expect(engine.ensureReady()).rejects.toThrow(/disposed/);
  });
});

describe('definePreset', () => {
  test('returns the preset unchanged at runtime', () => {
    const p: ModelPreset = {
      model: { modelId: 'test/dummy' },
      dtype: 'q4f16',
      backend: 'auto',
      capabilities: {
        supportsTools: false,
        supportsVision: false,
        supportsAudio: false,
        contextWindow: 1024,
        supportsThinking: false,
      },
    };
    expect(definePreset(p)).toBe(p);
  });
});
