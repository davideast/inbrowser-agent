import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FixtureLoadError, loadFixture, loadFixtures } from '../../src/node.js';

const validFixture = {
  id: 'firestore-rules-audit/seed-open-write-01',
  skill: 'firestore-rules-audit',
  description: 'Detects open-write vulnerability',
  prompt: 'Audit my rules.',
  successSpec: { name: 'firestore-rules-audit/seed-spec' },
};

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'fixture-load-test-'));
}

describe('loadFixture', () => {
  test('loads and validates a single fixture file', () => {
    const dir = makeTempDir();
    const file = join(dir, 'sample.fixture.json');
    writeFileSync(file, JSON.stringify(validFixture));
    const loaded = loadFixture(file);
    expect(loaded.id).toBe(validFixture.id);
  });

  test('throws FixtureLoadError on invalid fixture with structured error list', () => {
    const dir = makeTempDir();
    const file = join(dir, 'bad.fixture.json');
    writeFileSync(file, JSON.stringify({ id: 'oops' }));
    let caught: FixtureLoadError | undefined;
    try {
      loadFixture(file);
    } catch (err) {
      caught = err as FixtureLoadError;
    }
    expect(caught).toBeInstanceOf(FixtureLoadError);
    expect(caught?.file).toBe(file);
    expect(caught && caught.errors.length > 0).toBe(true);
  });

  test('throws on malformed JSON', () => {
    const dir = makeTempDir();
    const file = join(dir, 'bad-json.fixture.json');
    writeFileSync(file, '{ not valid json');
    expect(() => loadFixture(file)).toThrow();
  });
});

describe('loadFixtures', () => {
  test('loads multiple fixtures from a directory, sorted by id', () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'b.fixture.json'),
      JSON.stringify({ ...validFixture, id: 'firestore-rules-audit/b-01' }),
    );
    writeFileSync(
      join(dir, 'a.fixture.json'),
      JSON.stringify({ ...validFixture, id: 'firestore-rules-audit/a-01' }),
    );
    writeFileSync(join(dir, 'README.md'), 'not a fixture');
    const loaded = loadFixtures(dir);
    expect(loaded.map((f) => f.id)).toEqual([
      'firestore-rules-audit/a-01',
      'firestore-rules-audit/b-01',
    ]);
  });

  test('skips non-fixture files in the directory', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'good.fixture.json'), JSON.stringify(validFixture));
    writeFileSync(join(dir, 'notes.txt'), 'ignore me');
    writeFileSync(join(dir, 'config.json'), '{"unrelated":true}');
    const loaded = loadFixtures(dir);
    expect(loaded.length).toBe(1);
  });

  test('throws when any fixture in the directory is invalid', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'good.fixture.json'), JSON.stringify(validFixture));
    writeFileSync(
      join(dir, 'bad.fixture.json'),
      JSON.stringify({ id: 'oops', skill: 'firestore-rules-audit' }),
    );
    expect(() => loadFixtures(dir)).toThrow();
  });

  test('returns empty array for directory with no fixture files', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'README.md'), 'docs');
    const loaded = loadFixtures(dir);
    expect(loaded).toEqual([]);
  });
});
