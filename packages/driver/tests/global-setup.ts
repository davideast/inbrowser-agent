import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const buildScript = fileURLToPath(new URL('../scripts/build.mjs', import.meta.url));

export default function globalSetup(): void {
  execFileSync(process.execPath, [buildScript, '--bundles-only'], {
    stdio: 'inherit',
  });
}
