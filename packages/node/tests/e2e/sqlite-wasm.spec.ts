import { expect, test } from '@playwright/test';
import type * as RuntimeModule from '../../src/index';

test('executes node:sqlite DatabaseSync over WASM with VFS file persistence, UDFs, aggregates, and backup', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const runtimeUrl = '/runtime.js';
    const { BrowserContainer } = (await import(runtimeUrl)) as typeof RuntimeModule;
    const container = await BrowserContainer.boot();
    try {
      await container.mount({
        '/writer.mjs': `
          import { DatabaseSync, backup } from 'node:sqlite';

          const db = new DatabaseSync('/data/app.db');
          db.exec('CREATE TABLE scores (name TEXT NOT NULL, pts INTEGER NOT NULL);');
          const insert = db.prepare('INSERT INTO scores (name, pts) VALUES (?, ?)');
          db.exec('BEGIN');
          insert.run('alice', 10);
          insert.run('bob', 25);
          insert.run('carol', 15);
          db.exec('COMMIT');

          await backup(db, '/data/backup.db');
          db.close();
          console.log('WRITTEN');
        `,
        '/reader.mjs': `
          import { DatabaseSync } from 'node:sqlite';

          const db = new DatabaseSync('/data/backup.db');
          db.function('doublePts', (x) => Number(x) * 2);
          db.aggregate('sumPts', {
            start: 0,
            step: (acc, val) => acc + Number(val),
          });
          const rows = db.prepare('SELECT name, doublePts(pts) AS doubled FROM scores ORDER BY pts DESC').all();
          const summary = db.prepare('SELECT sumPts(pts) AS total FROM scores').get();
          db.close();
          console.log(JSON.stringify({ rows, summary }));
        `,
      });
      await container.fs.mkdir('/data', { recursive: true });

      const writer = await container.spawn('node', ['/writer.mjs']);
      const writerExit = await writer.exit;

      const reader = await container.spawn('node', ['/reader.mjs']);
      const readerExit = await reader.exit;

      return {
        writerExit,
        writerStderr: writer.stderrText,
        readerExit,
        readerStderr: reader.stderrText,
        out: JSON.parse(reader.stdoutText.trim()),
      };
    } finally {
      await container.teardown();
    }
  });

  expect(result.writerStderr).toContain('ExperimentalWarning: SQLite is an experimental feature');
  expect(result.writerExit).toBe(0);
  expect(result.readerStderr).toContain('ExperimentalWarning: SQLite is an experimental feature');
  expect(result.readerExit).toBe(0);
  expect(result.out).toEqual({
    rows: [
      { name: 'bob', doubled: 50 },
      { name: 'carol', doubled: 30 },
      { name: 'alice', doubled: 20 },
    ],
    summary: { total: 50 },
  });
});
