import { describe, expect, it } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BriefcastDetail,
  BriefcastList,
} from '../src/client/App';
import { Markdown } from '../src/client/Markdown';
import { createEmptyBriefcastView } from '../src/shared/reducer';

describe('briefcast UI', () => {
  it('renders sidebar skeletons before list data', () => {
    const { container } = render(
      <BriefcastList items={null} selectedId="" onSelect={() => {}} />,
    );
    expect(container.querySelectorAll('.skeleton-row')).toHaveLength(3);
  });

  it('replaces write-up and audio skeletons when content is available', () => {
    const view = {
      ...createEmptyBriefcastView('job', 'https://youtube.com/watch?v=x', 100),
      status: 'narrating' as const,
      writeupMarkdown: 'A generated write-up.',
      audioSegments: [
        {
          index: 0,
          text: 'A generated write-up.',
          audioUrl: '/audio/job/0.wav',
          mimeType: 'audio/wav' as const,
          elapsedMs: 1000,
        },
      ],
    };

    const { container } = render(<BriefcastDetail briefcast={view} />);
    expect(container.querySelector('.markdown')?.textContent).toContain(
      'A generated write-up.',
    );
    expect(container.querySelector('audio')).not.toBeNull();
    expect(container.querySelector('.audio-skeleton')).toBeNull();
  });

  it('renders generated markdown as structured content', () => {
    const { container } = render(
      <Markdown
        source={[
          '# Briefcast Title',
          '',
          'A paragraph with **bold** text.',
          '',
          '- First point',
          '- Second point',
        ].join('\n')}
      />,
    );

    expect(container.querySelector('h2')?.textContent).toBe('Briefcast Title');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });
});

function render(element: JSX.Element): { container: HTMLElement } {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost',
  });
  const globals = globalThis as unknown as {
    window: Window;
    document: Document;
    navigator: Navigator;
    IS_REACT_ACT_ENVIRONMENT: boolean;
  };
  globals.window = dom.window as unknown as Window;
  globals.document = dom.window.document;
  globals.navigator = dom.window.navigator;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(dom.window.HTMLMediaElement.prototype, 'load', {
    configurable: true,
    value() {},
  });
  const container = dom.window.document.getElementById('root')!;
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container };
}
