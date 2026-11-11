import { createInterface } from './readline-interface';
import { ShellError } from './shell';

/** Owns prompt input only while no command is running. */
export async function runInteractiveShell(
  input: unknown,
  output: unknown,
  prompt: string,
  run: (source: string) => Promise<number>,
  diagnostic: (text: string) => void,
  beforePrompt: () => void,
): Promise<number> {
  let status = 0;
  for (;;) {
    beforePrompt();
    const source = await new Promise<string | null>((resolve, reject) => {
      const line = createInterface({ input, output, terminal: true, prompt });
      line.once('line', (source: string) => {
        resolve(source);
        line.close();
      });
      line.once('SIGINT', () => {
        resolve('');
        line.close();
      });
      line.once('close', () => resolve(null));
      line.once('error', reject);
      line.prompt();
    });
    if (source === null) return status;
    if (!source.trim()) continue;
    const exit = /^\s*exit(?:\s+(\d{1,3}))?\s*$/.exec(source);
    if (exit && (exit[1] === undefined || Number(exit[1]) <= 255))
      return exit[1] === undefined ? status : Number(exit[1]);
    try {
      status = await run(source);
    } catch (error) {
      if (!(error instanceof ShellError)) throw error;
      diagnostic(`sh: ${error.code}: ${error.message}\n`);
      status = error.status;
    }
  }
}
