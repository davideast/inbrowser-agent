import { describe, expect, test } from 'bun:test';
import * as root from '../src/index.js';
import * as local from '../src/local.js';
import { createFirebaseAiLogicModelClient } from '../src/providers/firebase-ai-logic.js';
import { geminiModelClient } from '../src/providers/gemini.js';

describe('public export seams', () => {
  test('root stays free of on-device and provider factory exports', () => {
    const forbidden = [
      'createEngine',
      'createEngineModelClient',
      'definePreset',
      'parseToolCalls',
      'splitThinking',
      'smollm2_360m',
      'hostEngineInWorker',
      'connectWorkerEngine',
      'geminiModelClient',
      'openrouterModelClient',
      'createFirebaseAiLogicModelClient',
      'anthropicModelClient',
      'ollamaModelClient',
    ];

    for (const name of forbidden) expect(name in root).toBe(false);
    expect(typeof root.withRetry).toBe('function');
    expect(typeof root.normalizeModelUsage).toBe('function');
  });

  test('local exposes the complete on-device runtime', () => {
    expect(local.createEngine).toBeFunction();
    expect(local.createEngineModelClient).toBeFunction();
    expect(local.definePreset).toBeFunction();
    expect(local.parseToolCalls).toBeFunction();
    expect(local.splitThinking).toBeFunction();
    expect(local.hostEngineInWorker).toBeFunction();
    expect(local.connectWorkerEngine).toBeFunction();
    expect(local.smollm2_360m.model.modelId).toBe('HuggingFaceTB/SmolLM2-360M-Instruct');
  });

  test('provider modules resolve as dedicated entrypoints', () => {
    expect(geminiModelClient).toBeFunction();
    expect(createFirebaseAiLogicModelClient).toBeFunction();
    const client = geminiModelClient({ apiKey: 'sk-test', model: 'gemini-3-flash-preview' });
    expect(client.id).toBe('gemini:gemini-3-flash-preview');
  });
});
