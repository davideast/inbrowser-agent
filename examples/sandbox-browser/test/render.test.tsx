import { afterEach, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { SandboxBrowserApp } from '../src/App.js';

describe('sandbox-browser app', () => {
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = undefined;
  });

  test('renders actions and updates visible files after checkpoint restore', async () => {
    installDom();
    const container = document.createElement('div');
    document.body.append(container);

    root = createRoot(container);
    await act(async () => {
      root?.render(<SandboxBrowserApp />);
    });

    await waitForText('ready ·');
    await clickButton('Write app');
    await waitForText('wrote /work/src/App.tsx');
    await clickButton('Capture checkpoint');
    await waitForText('checkpoint created');
    await clickButton('Edit app');
    await waitForText('edited /work/src/App.tsx');
    await clickButton('Restore latest');
    await waitForText('checkpoint restored');
    await clickButton('Files');
    await waitForText('Hello sandbox');

    const filesPanelText = document.querySelector('.demo-inspector-body')?.textContent ?? '';
    expect(filesPanelText).toContain('/work/src/App.tsx');
    expect(filesPanelText).toContain('Hello sandbox');
    expect(filesPanelText).not.toContain('Hello checkpoints');
  });

  test('managed turn updates files and checkpoints as visible app state', async () => {
    installDom();
    const container = document.createElement('div');
    document.body.append(container);

    root = createRoot(container);
    await act(async () => {
      root?.render(<SandboxBrowserApp />);
    });

    await waitForText('ready ·');
    await clickButton('Run managed turn');
    await waitForText('Files1');
    await clickButton('Files');
    await waitForText('/work/src/App.tsx');
    await clickButton('Checkpoints');
    await waitForText('before copy edit');
  });
});

function installDom(): void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
  });
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
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

async function waitForText(text: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 3_000) {
    if (document.body.textContent?.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for text: ${text}\n\n${document.body.textContent ?? ''}`);
}
