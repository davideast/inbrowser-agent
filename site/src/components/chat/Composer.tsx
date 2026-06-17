import { type RefObject, useEffect, useRef } from 'react';

interface ComposerProps {
  value: string;
  onChange(v: string): void;
  onSend(): void;
  onStop(): void;
  busy: boolean;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** Placeholder override (e.g. for the empty-state hero). */
  placeholder?: string;
}

/**
 * In-flow chat input (Terminal Modernism bottom-border treatment). Not
 * pinned to the viewport — it lives in the document flow, centered when
 * empty and trailing the conversation otherwise. Enter sends; Shift+Enter
 * adds a newline.
 */
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  inputRef,
  placeholder = 'Ask about the inbrowser packages…',
}: ComposerProps) {
  const internal = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? internal;

  // Auto-grow up to a cap. Re-measure whenever the text changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: value drives the re-measure
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  return (
    <div>
      <div className="flex items-end gap-3 border-b-2 border-border-strong focus-within:border-primary py-2 transition-colors">
        <span className="text-dim-text select-none pb-1" aria-hidden="true">
          &gt;
        </span>
        <label htmlFor="chat-input" className="sr-only">
          Message the docs assistant
        </label>
        <textarea
          id="chat-input"
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (!busy) onSend();
            }
          }}
          placeholder={placeholder}
          aria-describedby="chat-hint"
          className="flex-1 bg-transparent text-primary placeholder:text-dim-text outline-none text-[16px] leading-[1.6] resize-none"
        />
        {busy ? (
          <button
            type="button"
            onClick={onStop}
            className="text-[11px] font-medium uppercase tracking-widest text-secondary hover:text-primary pb-1"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={onSend}
            disabled={!value.trim()}
            className="text-[11px] font-medium uppercase tracking-widest text-secondary hover:text-primary disabled:opacity-40 disabled:hover:text-secondary pb-1"
          >
            Send
          </button>
        )}
      </div>
      <div id="chat-hint" className="text-[10px] text-dim-text mt-2">
        Enter to send · Shift+Enter for a new line
      </div>
    </div>
  );
}
