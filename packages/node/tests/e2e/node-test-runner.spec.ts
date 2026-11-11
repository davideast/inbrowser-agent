import { expect, test } from '@playwright/test';
import type * as RuntimeModule from '../../src/index';

test('executes node:test suites, lifecycle hooks, subtests, mocks, timers, and TAP output', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const runtimeUrl = '/runtime.js';
    const { BrowserContainer } = (await import(runtimeUrl)) as typeof RuntimeModule;
    const container = await BrowserContainer.boot();
    try {
      await container.mount({
        '/sample.test.mjs': `
          import { describe, it, before, after, beforeEach } from 'node:test';
          import assert from 'node:assert/strict';

          const log = [];
          describe('math suite', () => {
            before(() => log.push('before'));
            beforeEach(() => log.push('each'));
            after(() => log.push('after'));

            it('supports mocks and subtests', async (t) => {
              const fn = t.mock.fn((a, b) => a + b);
              assert.equal(fn(2, 3), 5);
              assert.equal(fn.mock.callCount(), 1);
              await t.test('nested check', () => {
                assert.deepEqual(log.slice(0, 2), ['before', 'each']);
              });
            });

            it('supports virtualized timers', (t) => {
              t.mock.timers.enable({ apis: ['setTimeout'] });
              let fired = false;
              setTimeout(() => { fired = true; }, 5000);
              assert.equal(fired, false);
              t.mock.timers.tick(5000);
              assert.equal(fired, true);
            });
          });
        `,
        '/runner.mjs': `
          import { run } from 'node:test';
          import { tap } from 'node:test/reporters';

          let tapText = '';
          const stream = run({ files: ['/sample.test.mjs'] }).compose(tap);
          for await (const chunk of stream) {
            tapText += String(chunk);
          }
          console.log(tapText);
        `,
      });

      const proc = await container.spawn('node', ['/runner.mjs']);
      return {
        exit: await proc.exit,
        stderr: proc.stderrText,
        stdout: proc.stdoutText,
      };
    } finally {
      await container.teardown();
    }
  });

  expect(result.stderr).toBe('');
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain('TAP version 13');
  expect(result.stdout).toContain('ok 1 - math suite');
  expect(result.stdout).toContain('# fail 0');
});
