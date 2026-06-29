import { describe, expect, test } from 'bun:test';
import {
  createSandboxScenario,
  runBasicSandboxFlow,
} from '@inbrowser/example-shared/sandbox-scenario';

describe('sandbox-basic scenario', () => {
  test('restores the file content captured by the checkpoint', async () => {
    const scenario = await createSandboxScenario({ id: 'sandbox-basic-test', storage: 'memory' });
    try {
      const result = await runBasicSandboxFlow(scenario.sandbox);

      expect(result.initialContent).toContain('Hello sandbox');
      expect(result.editedContent).toContain('Hello checkpoints');
      expect(result.restoredContent).toContain('Hello sandbox');
      expect(result.restoredContent).not.toContain('Hello checkpoints');
      expect(result.listedPaths).toContain('/work/src/App.tsx');
      expect(scenario.recorder.events.map((event) => event.type)).toContain('checkpoint:restore');
    } finally {
      scenario.dispose();
    }
  });
});
