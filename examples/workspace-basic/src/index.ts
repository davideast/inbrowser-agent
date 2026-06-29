import {
  createWorkspaceScenario,
  formatWorkspaceEvent,
  recordPreviewCompile,
  runBasicWorkspaceFlow,
} from '@inbrowser/example-shared/workspace-scenario';

const scenario = await createWorkspaceScenario({
  id: 'workspace-basic',
  storage: 'memory',
});

try {
  const result = await runBasicWorkspaceFlow(scenario);

  console.log('\nWorkspace event log');
  for (const event of scenario.recorder.events.filter((event) => {
    return event.type !== 'file' || !event.event.path.startsWith('/work/.git/');
  })) {
    console.log(`- ${formatWorkspaceEvent(event)}`);
  }

  console.log('\nListed paths');
  for (const path of result.listedPaths) console.log(`- ${path}`);

  console.log('\nShell output');
  console.log(result.shell.stdout.trim());

  console.log('\nSnapshot');
  console.log(`${result.snapshot.label}: ${result.snapshot.entryCount} entries`);

  console.log('\nEdited content contains');
  console.log(
    result.editedContent.includes('Hello restored workspace')
      ? 'Hello restored workspace'
      : 'missing',
  );

  console.log('\nRestored file content');
  console.log(result.restoredContent.trim());

  console.log('\nGit log');
  for (const entry of result.gitLog) {
    console.log(`- ${entry.oid.slice(0, 8)} ${entry.message.trim()}`);
  }

  console.log('\nPreview compile');
  const preview = await scenario.workspace.createReactPreview({
    entry: '/work/src/App.tsx',
    react: {},
    jsxRuntime: {},
    jsxDevRuntime: {},
    esbuildOptions: { worker: false },
  });
  const previewResult = await preview.compile();
  recordPreviewCompile(scenario, previewResult);
  if (previewResult.ok) {
    console.log(`compiled ${previewResult.code.length} bytes`);
  } else {
    for (const diagnostic of previewResult.diagnostics) console.log(`- ${diagnostic.message}`);
  }
} finally {
  scenario.dispose();
}
