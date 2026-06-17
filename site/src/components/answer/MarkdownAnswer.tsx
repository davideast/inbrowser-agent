import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useMemo } from 'react';

/**
 * Renders a streamed markdown answer to sanitized HTML in the site's
 * `.docs-prose` style. The answer is untrusted model output, so it is
 * ALWAYS sanitized. Parsing the full accumulated string each render keeps
 * half-open markdown (e.g. an unclosed `**`) resolving as more arrives.
 */
export function MarkdownAnswer({ answer, className = '' }: { answer: string; className?: string }) {
  const html = useMemo(() => {
    if (!answer) return '';
    const raw = marked.parse(answer, { async: false }) as string;
    // Restrict link protocols (no javascript:/data:) as defense in depth.
    return DOMPurify.sanitize(raw, {
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|\/)/i,
    });
  }, [answer]);

  if (!html) return null;
  return (
    <div
      className={`docs-prose ${className}`}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via DOMPurify above
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
