import { homedir } from 'node:os';
import { join } from 'node:path';
import { type ConsoleMessage, chromium } from 'playwright';

interface Options {
  action: 'load' | 'commit' | 'snapshot' | 'snapshot-persist' | 'terminal-git';
  url: string;
  timeoutMs: number;
  userDataDir: string;
}

interface BrowserIssue {
  kind: 'console' | 'pageerror';
  text: string;
  location?: string;
  stack?: string;
}

function parseArgs(): Options {
  const argv = process.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] ? (argv[index + 1] as string) : fallback;
  };
  const action = get('--action', 'load');
  const knownActions = new Set(['load', 'commit', 'snapshot', 'snapshot-persist', 'terminal-git']);
  return {
    action: knownActions.has(action) ? (action as Options['action']) : 'load',
    url: get('--url', 'http://localhost:5178/'),
    timeoutMs: Number.parseInt(get('--timeout', '10000'), 10),
    userDataDir: get('--user-data-dir', join(homedir(), '.cache', 'inbrowser-workspace-e2e')),
  };
}

function consoleText(message: ConsoleMessage): string {
  const text = message.text();
  const location = message.location();
  const suffix = location.url ? ` (${location.url}:${location.lineNumber})` : '';
  return `${text}${suffix}`;
}

function isIgnorableConsole(message: ConsoleMessage): boolean {
  const text = message.text();
  return (
    message.type() === 'info' &&
    text.includes('Download the React DevTools for a better development experience')
  );
}

async function main(): Promise<void> {
  const options = parseArgs();
  const issues: BrowserIssue[] = [];
  const logs: string[] = [];

  const context = await chromium.launchPersistentContext(options.userDataDir, {
    headless: true,
    viewport: { width: 1280, height: 800 },
  });
  const page = context.pages()[0] ?? (await context.newPage());

  page.on('console', (message) => {
    const line = consoleText(message);
    logs.push(`${message.type().padEnd(8)} ${line}`);
    if ((message.type() === 'error' || message.type() === 'warning') && !isIgnorableConsole(message)) {
      issues.push({
        kind: 'console',
        text: message.text(),
        location: line,
      });
    }
  });
  page.on('pageerror', (error) => {
    issues.push({
      kind: 'pageerror',
      text: error.message,
      stack: error.stack,
    });
  });

  try {
    await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
    await page.waitForSelector('.workspace-ide', { timeout: options.timeoutMs });
    if (options.action === 'commit') {
      await page.getByRole('button', { name: 'Git' }).click();
      await page.getByRole('button', { name: 'Create commit' }).click();
      try {
        await page.waitForFunction(
          () => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const commit = buttons.find((button) =>
              button.getAttribute('aria-label') === 'Create commit',
            );
            const gitPanel = document.querySelector('.ide-side-pane[aria-label="Git"]');
            const history =
              gitPanel?.textContent?.includes('History') &&
              !gitPanel.textContent.includes('No commits yet.');
            return Boolean(commit && !commit.disabled && history);
          },
          { timeout: options.timeoutMs },
        );
      } catch (err) {
        issues.push({
          kind: 'pageerror',
          text: `Timed out waiting for commit action to complete: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    }
    if (options.action === 'snapshot') {
      await page.getByRole('button', { name: 'Seed workspace' }).first().click();
      await page.waitForFunction(() => document.body.textContent?.includes('src/App.tsx'), {
        timeout: options.timeoutMs,
      });
      await page.getByRole('button', { name: 'Snapshots' }).click();
      await page.getByRole('button', { name: 'Create snapshot' }).click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('.ide-side-pane[aria-label="Snapshots"]')
            ?.textContent?.includes('workspace snapshot 1'),
        { timeout: options.timeoutMs },
      );
      await page.getByRole('button', { name: 'Edit sample app' }).click();
      await page.waitForFunction(
        () => document.body.textContent?.includes('Hello edited workspace'),
        { timeout: options.timeoutMs },
      );
      await page.getByRole('button', { name: 'Restore' }).first().click();
      try {
        await page.waitForFunction(
          () => {
            const text = document.body.textContent ?? '';
            return text.includes('Hello workspace') && !text.includes('Hello edited workspace');
          },
          { timeout: options.timeoutMs },
        );
      } catch (err) {
        issues.push({
          kind: 'pageerror',
          text: `Timed out waiting for snapshot restore to complete: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    }
    if (options.action === 'snapshot-persist') {
      await page.getByRole('button', { name: 'Seed workspace' }).first().click();
      await page.waitForFunction(() => document.body.textContent?.includes('src/App.tsx'), {
        timeout: options.timeoutMs,
      });
      await page.getByRole('button', { name: 'Snapshots' }).click();
      const beforeCount = await page
        .locator('.ide-side-pane[aria-label="Snapshots"] .ide-list-row')
        .count();
      await page.getByRole('button', { name: 'Create snapshot' }).click();
      await page.waitForFunction(
        (count) =>
          document.querySelectorAll('.ide-side-pane[aria-label="Snapshots"] .ide-list-row')
            .length > count,
        beforeCount,
        { timeout: options.timeoutMs },
      );
      const snapshotLabel = await page
        .locator('.ide-side-pane[aria-label="Snapshots"] .ide-list-row strong')
        .last()
        .textContent();
      if (!snapshotLabel) {
        issues.push({ kind: 'pageerror', text: 'Snapshot was created without a visible label.' });
      }
      await page.reload({ waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
      await page.waitForSelector('.workspace-ide', { timeout: options.timeoutMs });
      await page.getByRole('button', { name: 'Snapshots' }).click();
      await page.waitForFunction(
        (label) => Boolean(label) && document.body.textContent?.includes(label),
        snapshotLabel,
        { timeout: options.timeoutMs },
      );
      await page.getByRole('button', { name: 'Edit sample app' }).click();
      await page.waitForFunction(
        () => document.body.textContent?.includes('Hello edited workspace'),
        { timeout: options.timeoutMs },
      );
      const restoreButton = page
        .locator('.ide-side-pane[aria-label="Snapshots"] .ide-list-row')
        .filter({ hasText: snapshotLabel ?? '' })
        .getByRole('button', { name: 'Restore' })
        .first();
      await restoreButton.click();
      await page.waitForFunction(
        () => {
          const text = document.body.textContent ?? '';
          return text.includes('Hello workspace') && !text.includes('Hello edited workspace');
        },
        { timeout: options.timeoutMs },
      );
    }
    if (options.action === 'terminal-git') {
      await page.getByRole('button', { name: 'Seed workspace' }).first().click();
      await page.waitForFunction(() => document.body.textContent?.includes('src/App.tsx'), {
        timeout: options.timeoutMs,
      });
      await page.getByRole('tab', { name: 'Terminal' }).click();
      await page.getByTestId('xterm-terminal').click();
      for (const [command, expected] of [
        ['git init', 'Initialized empty Git repository'],
        ['git status', 'On branch main'],
        ['git add .', 'staged'],
        ['git commit -m "Terminal commit"', '[main '],
        ['git log --oneline', ' Terminal commit'],
      ] as const) {
        await page.keyboard.type(command, { delay: 5 });
        await page.keyboard.press('Enter');
        await page.waitForFunction(
          (needle) => {
            const text = Array.from(
              document.querySelectorAll('[data-testid="xterm-terminal"] .xterm-rows > div'),
            )
              .map((row) => row.textContent ?? '')
              .join('\n');
            return text.includes(needle);
          },
          expected,
          { timeout: options.timeoutMs },
        );
        await page.waitForTimeout(100);
      }
      try {
        await page.waitForFunction(
          () => {
            const text = Array.from(
              document.querySelectorAll('[data-testid="xterm-terminal"] .xterm-rows > div'),
            )
              .map((row) => row.textContent ?? '')
              .join('\n');
            return /\b[0-9a-f]{7}\s+Terminal commit\b/.test(text) && !text.includes('command not found');
          },
          { timeout: options.timeoutMs },
        );
      } catch (err) {
        issues.push({
          kind: 'pageerror',
          text: `Timed out waiting for terminal git flow to complete: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    }
    await page.waitForTimeout(1500);

    const snapshot = await page.evaluate(
      async (action) => {
        async function listOpfs(pathPrefix: string): Promise<string[]> {
          const storage = navigator.storage as StorageManager & {
            getDirectory?: () => Promise<FileSystemDirectoryHandle>;
          };
          if (!storage.getDirectory) return [];
          const root = await storage.getDirectory();
          const output: string[] = [];
          async function visit(handle: FileSystemDirectoryHandle, path: string): Promise<void> {
            const values = (
              handle as FileSystemDirectoryHandle & {
                values?: () => AsyncIterable<FileSystemDirectoryHandle | FileSystemFileHandle>;
              }
            ).values?.();
            if (!values) return;
            for await (const child of values) {
              const nextPath = `${path}/${child.name}`;
              if (nextPath.startsWith(pathPrefix)) output.push(`${child.kind}:${nextPath}`);
              if (child.kind === 'directory') await visit(child, nextPath);
            }
          }
          await visit(root, '');
          return output.sort();
        }

        function terminalRowsText(): string {
          return Array.from(
            document.querySelectorAll('[data-testid="xterm-terminal"] .xterm-rows > div'),
          )
            .map((row) => row.textContent ?? '')
            .join('\n');
        }

        return {
          action,
          title: document.title,
          bodyText: document.body.textContent?.slice(0, 1200) ?? '',
          gitPanelText: document.querySelector('.ide-side-pane[aria-label="Git"]')?.textContent ?? '',
          snapshotsPanelText:
            document.querySelector('.ide-side-pane[aria-label="Snapshots"]')?.textContent ?? '',
          buttons: Array.from(document.querySelectorAll('button')).map((button) => ({
            label: button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '',
            text: button.textContent?.trim() ?? '',
            disabled: button.disabled,
            title: button.title,
          })),
          opfsGitEntries:
            action === 'commit'
              ? await listOpfs('/.inbrowser/workspaces/workspace-browser/work/.git')
              : [],
          opfsWorkspaceEntries:
            action === 'snapshot' || action === 'snapshot-persist'
              ? await listOpfs('/.inbrowser/workspaces/workspace-browser/work')
              : [],
          hasIde: Boolean(document.querySelector('.workspace-ide')),
          hasTerminal: Boolean(document.querySelector('.xterm')),
          terminalText: terminalRowsText(),
        };
      },
      options.action,
    );

    console.log('workspace-browser e2e snapshot');
    console.log(JSON.stringify(snapshot, null, 2));
    if (logs.length > 0) {
      console.log('\nbrowser console');
      for (const line of logs) console.log(line);
    }
    if (issues.length > 0) {
      console.error('\nbrowser issues');
      for (const issue of issues) {
        console.error(`[${issue.kind}] ${issue.text}`);
        if (issue.location) console.error(issue.location);
        if (issue.stack) console.error(issue.stack);
      }
      process.exitCode = 1;
    }
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
