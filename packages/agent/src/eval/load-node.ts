/**
 * Node-only fixture file/directory loader.
 *
 * Browser-safe parsing and validation live in `./fixture.ts`. This
 * module wraps those with `node:fs` reads. Imported by consumers via
 * `@inbrowser/agent/node`, not the universal entry.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { type TaskFixture, type ValidationError, parseFixture } from './fixture.js';

export class FixtureLoadError extends Error {
  readonly file: string;
  readonly errors: ValidationError[];

  constructor(file: string, errors: ValidationError[]) {
    const summary = errors.map((e) => `  - ${e.path ? `${e.path}: ` : ''}${e.message}`).join('\n');
    super(`fixture "${file}" failed validation:\n${summary}`);
    this.name = 'FixtureLoadError';
    this.file = file;
    this.errors = errors;
  }
}

export function loadFixture(filePath: string): TaskFixture {
  const json = readFileSync(filePath, 'utf8');
  const result = parseFixture(json);
  if (!result.ok) {
    throw new FixtureLoadError(filePath, result.errors);
  }
  return result.fixture;
}

export function loadFixtures(dirPath: string): TaskFixture[] {
  const fixtures: TaskFixture[] = [];
  const failures: { file: string; errors: ValidationError[] }[] = [];

  for (const entry of readdirSync(dirPath)) {
    if (!entry.endsWith('.fixture.json')) continue;
    const full = join(dirPath, entry);
    if (!statSync(full).isFile()) continue;
    const json = readFileSync(full, 'utf8');
    const result = parseFixture(json);
    if (!result.ok) {
      failures.push({ file: full, errors: result.errors });
    } else {
      fixtures.push(result.fixture);
    }
  }

  if (failures.length > 0) {
    const summary = failures
      .map(
        (f) =>
          `- ${f.file}:\n${f.errors
            .map((e) => `    ${e.path ? `${e.path}: ` : ''}${e.message}`)
            .join('\n')}`,
      )
      .join('\n');
    throw new Error(`one or more fixtures failed validation:\n${summary}`);
  }

  return fixtures.sort((a, b) => a.id.localeCompare(b.id));
}
