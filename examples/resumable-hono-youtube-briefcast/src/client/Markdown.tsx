import type { ReactNode } from 'react';

type MarkdownBlock =
  | { type: 'heading'; depth: number; content: string }
  | { type: 'paragraph'; content: string }
  | { type: 'ul' | 'ol'; items: string[] }
  | { type: 'blockquote'; content: string }
  | { type: 'code'; language?: string; content: string }
  | { type: 'hr' };

export function Markdown({ source }: { source: string }) {
  return (
    <div className="markdown">
      {parseMarkdown(source).map((block, index) => renderBlock(block, index))}
    </div>
  );
}

function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const paragraph: string[] = [];
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null;
  let code: { language?: string; lines: string[] } | null = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: 'paragraph', content: paragraph.join(' ') });
    paragraph.length = 0;
  };
  const flushList = () => {
    if (!list) return;
    blocks.push(list);
    list = null;
  };

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (code) {
      if (trimmed.startsWith('```')) {
        blocks.push({
          type: 'code',
          language: code.language,
          content: code.lines.join('\n'),
        });
        code = null;
      } else {
        code.lines.push(rawLine);
      }
      continue;
    }

    const fence = trimmed.match(/^```(\w+)?/);
    if (fence) {
      flushParagraph();
      flushList();
      code = { language: fence[1], lines: [] };
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    if (/^[-*_]{3,}$/.test(trimmed)) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'hr' });
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        type: 'heading',
        depth: heading[1]!.length,
        content: heading[2]!,
      });
      continue;
    }

    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      if (list?.type !== 'ul') flushList();
      list ??= { type: 'ul', items: [] };
      list.items.push(unordered[1]!);
      continue;
    }

    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      if (list?.type !== 'ol') flushList();
      list ??= { type: 'ol', items: [] };
      list.items.push(ordered[1]!);
      continue;
    }

    const quote = trimmed.match(/^>\s?(.+)$/);
    if (quote) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'blockquote', content: quote[1]! });
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  return blocks;
}

function renderBlock(block: MarkdownBlock, index: number): ReactNode {
  switch (block.type) {
    case 'heading': {
      const Tag = block.depth === 1 ? 'h2' : block.depth === 2 ? 'h3' : 'h4';
      return <Tag key={index}>{renderInline(block.content)}</Tag>;
    }
    case 'paragraph':
      return <p key={index}>{renderInline(block.content)}</p>;
    case 'ul':
      return (
        <ul key={index}>
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item)}</li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol key={index}>
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item)}</li>
          ))}
        </ol>
      );
    case 'blockquote':
      return <blockquote key={index}>{renderInline(block.content)}</blockquote>;
    case 'code':
      return (
        <pre key={index}>
          <code>{block.content}</code>
        </pre>
      );
    case 'hr':
      return <hr key={index} />;
  }
}

function renderInline(source: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenPattern =
    /(\[[^\]]+\]\(https?:\/\/[^)\s]+\)|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(source))) {
    if (match.index > cursor) nodes.push(source.slice(cursor, match.index));
    const token = match[0];
    const key = nodes.length;

    if (token.startsWith('[')) {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      if (link) {
        nodes.push(
          <a key={key} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    } else if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }

    cursor = match.index + token.length;
  }

  if (cursor < source.length) nodes.push(source.slice(cursor));
  return nodes;
}
