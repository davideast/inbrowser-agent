import {
  createSandboxScenario,
  formatSandboxEvent,
  runBasicSandboxFlow,
} from '@inbrowser/example-shared/sandbox-scenario';

const scenario = await createSandboxScenario({
  id: 'sandbox-basic',
  storage: 'memory',
});

try {
  const result = await runBasicSandboxFlow(scenario.sandbox);

  console.log('\nSandbox event log');
  for (const event of scenario.recorder.events) {
    console.log(`- ${formatSandboxEvent(event)}`);
  }

  console.log('\nCheckpoint');
  console.log(result.checkpointId);

  console.log('\nListed paths');
  for (const path of result.listedPaths) console.log(`- ${path}`);

  console.log('\nEdited content contains');
  console.log(result.editedContent.includes('Hello checkpoints') ? 'Hello checkpoints' : 'missing');

  console.log('\nRestored file content');
  console.log(result.restoredContent.trim());
} finally {
  scenario.dispose();
}
