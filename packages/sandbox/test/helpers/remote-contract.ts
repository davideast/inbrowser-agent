import { expect } from 'bun:test';
import type { Sandbox } from '../../src/types.js';

/** The same public sandbox behavior must survive either transport. */
export async function remoteContract(sandbox: Sandbox) {
  await sandbox.fs.promises.writeFile(`${sandbox.cwd}/contract.txt`, 'before');
  expect(await sandbox.fs.promises.readFile(`${sandbox.cwd}/contract.txt`, 'utf8')).toBe('before');
  const checkpoint = await sandbox.checkpoints.create('transport contract');
  await sandbox.fs.promises.writeFile(`${sandbox.cwd}/contract.txt`, 'after');
  await sandbox.checkpoints.restore(checkpoint.id);
  expect(await sandbox.fs.promises.readFile(`${sandbox.cwd}/contract.txt`, 'utf8')).toBe('before');
  const chunks: string[] = [];
  const unsubscribe = sandbox.on((event) => {
    if (event.type === 'artifact' && event.artifact.kind === 'run.output')
      chunks.push(String(event.artifact.chunk));
  });
  try {
    expect((await sandbox.runtime.run('contract')).exitCode).toBe(0);
    expect(chunks.join('')).not.toBe('');
  } finally {
    unsubscribe();
  }
}
