import { afterEach, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import {
  WorkspaceBrowserApp,
  buildIdeEventRows,
  buildWorkspaceTree,
  flattenWorkspaceTree,
} from '../src/App.js';

describe('workspace-browser tree helpers', () => {
  test('builds an IDE-style tree from flat workspace records', () => {
    const tree = buildWorkspaceTree([
      { path: '/work/src/App.tsx', type: 'file', content: 'export default null;' },
      { path: '/work/src/theme.ts', type: 'file', content: 'export const theme = {};' },
      { path: '/work/package.json', type: 'file', content: '{}' },
    ]);

    expect(tree.map((node) => node.name)).toEqual(['src', 'package.json']);
    expect(tree[0]?.children.map((node) => node.name)).toEqual(['App.tsx', 'theme.ts']);

    const flat = flattenWorkspaceTree(tree, new Set(['/work/src']));
    expect(flat.map((row) => `${row.depth}:${row.node.name}`)).toEqual([
      '0:src',
      '1:App.tsx',
      '1:theme.ts',
      '0:package.json',
    ]);
  });

  test('summarizes event details without rendering raw JSON first', () => {
    const rows = buildIdeEventRows([
      {
        id: 'event-1',
        kind: 'file',
        status: 'ok',
        title: 'file write',
        body: '/work/src/App.tsx',
        timestamp: 1,
        detail: JSON.stringify({
          type: 'file',
          event: { type: 'write', path: '/work/src/App.tsx' },
          timestamp: 1,
        }),
      },
    ]);

    expect(rows[0]?.fields).toContainEqual({ label: 'type', value: 'file' });
    expect(rows[0]?.fields.find((field) => field.label === 'event')?.value).toBe(
      '/work/src/App.tsx',
    );
  });
});

describe('workspace-browser app', () => {
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    document.body.innerHTML = '';
    root = undefined;
  });

  test('renders a compact IDE shell and opens seeded files in Explorer and Editor', async () => {
    installDom();
    const container = document.createElement('div');
    document.body.append(container);

    root = createRoot(container);
    await act(async () => {
      root?.render(<WorkspaceBrowserApp />);
    });

    await waitForText('ready');
    expect(document.querySelector('.ide-status')?.textContent).toBe('ready');
    expect(document.body.textContent).not.toContain('best-effort');
    expect(buttonByLabel('Explorer')).toBeTruthy();
    expect(buttonByLabel('Packages')).toBeTruthy();
    expect(buttonByLabel('Git')).toBeTruthy();
    expect(buttonByLabel('Snapshots')).toBeTruthy();
    expect(buttonByLabel('Events')).toBeTruthy();
    expect(document.querySelector('[role="tab"]')?.textContent).toContain('Editor');

    await clickButton('Seed');
    await waitForText('App.tsx');
    await waitForText('/work/src/App.tsx');
    expect(document.querySelector('.ide-tree-icon')).toBeNull();
    expect(document.querySelector('[data-testid="codemirror-editor"]')).toBeTruthy();
    expect(document.body.textContent).toContain('Hello workspace');
  });

  test('keeps Preview and Terminal as workbench tabs with real controls', async () => {
    installDom();
    const container = document.createElement('div');
    document.body.append(container);

    root = createRoot(container);
    await act(async () => {
      root?.render(<WorkspaceBrowserApp />);
    });

    await waitForText('ready');
    await clickButton('Preview');
    expect(buttonByLabel('Compile preview')).toBeTruthy();
    expect(document.body.textContent).toContain('No preview compiled yet');

    await clickButton('Terminal');
    expect(document.querySelector('[data-testid="xterm-terminal"]')).toBeTruthy();
  });

  test('uses side activities for packages, git, snapshots, and events', async () => {
    installDom();
    const container = document.createElement('div');
    document.body.append(container);

    root = createRoot(container);
    await act(async () => {
      root?.render(<WorkspaceBrowserApp />);
    });

    await waitForText('ready');
    await clickButton('Seed');

    await clickButtonByLabel('Snapshots');
    expect(buttonByLabel('Create snapshot')?.disabled).toBe(false);
    await clickButton('Create');
    await waitForText('workspace snapshot 1');
    await clickButton('Edit sample');
    await clickButton('Restore');
    await waitForText('Hello workspace');
    expect(document.body.textContent).not.toContain('Hello edited workspace');

    await clickButtonByLabel('Packages');
    expect(document.body.textContent).toContain('No packages installed.');
    expect(document.body.textContent).not.toContain('"imports"');
    expect(buttonByLabel('Install package')?.disabled).toBe(false);

    await clickButtonByLabel('Git');
    expect(document.body.textContent).toContain('Changes');
    expect(document.body.textContent).toContain('History');
    expect(buttonByLabel('Create commit')?.disabled).toBe(false);

    await clickButtonByLabel('Events');
    expect(document.body.textContent).toContain('workspace ready');
    expect(document.body.textContent).not.toContain('"timestamp"');
  });
});

function installDom(): void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  class TestResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Window: dom.window.Window,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    DOMRect: dom.window.DOMRect,
    MutationObserver: dom.window.MutationObserver,
    ResizeObserver: TestResizeObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  });
}

async function clickButton(label: string): Promise<void> {
  const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => {
    (button as HTMLButtonElement).click();
  });
}

async function clickButtonByLabel(label: string): Promise<void> {
  const button = buttonByLabel(label);
  if (!button) throw new Error(`Missing labeled button: ${label}`);
  await act(async () => {
    button.click();
  });
}

function buttonByLabel(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.getAttribute('aria-label') === label,
  ) as HTMLButtonElement | undefined;
}

async function waitForText(text: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 3_000) {
    if (document.body.textContent?.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for text: ${text}\n\n${document.body.textContent ?? ''}`);
}
