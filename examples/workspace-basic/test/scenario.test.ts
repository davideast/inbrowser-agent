import { describe, expect, test } from 'bun:test';
import {
  createWorkspaceScenario,
  runBasicWorkspaceFlow,
} from '@inbrowser/example-shared/workspace-scenario';

describe('workspace-basic scenario', () => {
  test('runs files, shell, snapshots, and git against one workspace', async () => {
    const scenario = await createWorkspaceScenario({
      id: 'workspace-basic-test',
      storage: 'memory',
    });
    try {
      const result = await runBasicWorkspaceFlow(scenario);

      expect(result.initialContent).toContain('Hello workspace');
      expect(result.editedContent).toContain('Hello restored workspace');
      expect(result.restoredContent).toContain('Hello workspace');
      expect(result.restoredContent).not.toContain('Hello restored workspace');
      expect(result.listedPaths).toContain('/work/src/App.tsx');
      expect(result.shell.stdout).toContain('/work');
      expect(result.shell.stdout).toContain('App.tsx');
      expect(result.snapshot.entryCount).toBeGreaterThan(0);
      expect(result.gitLog[0]?.message).toContain('Create workspace demo app');
      expect(scenario.recorder.events.map((event) => event.type)).toContain('snapshot:restore');
    } finally {
      scenario.dispose();
    }
  });
});
