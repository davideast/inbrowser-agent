import type { DiagnosticsDelta, NetworkFailure } from '../types.js';
import {
  DRIVER_UI_ATTRIBUTE,
  El,
  HostErrorEvent,
  HostPromiseRejectionEvent,
  HostSet,
  HostWeakMap,
  MediaEl,
  ReqCtor,
  XhrCtor,
  doc,
  getComposedChildNodes,
  has,
  is,
  onEvent,
  origAlert,
  origConfirm,
  origConsoleError,
  origFetch,
  origPrompt,
  origXhrOpen,
  origXhrSend,
  rawAttr,
  reflectApply,
  reflectGet,
  reflectSet,
  tag,
  win,
  wordSet,
} from './intrinsics.js';
import { isElementHidden } from './observe.js';

export const DEFAULT_DIAGNOSTICS_RING_CAPACITY = 50;
const RES_TAGS = /* @__PURE__ */ wordSet('script img video audio source link');

export interface RingBuffer<T> {
  push(item: T): void;
  drain(): readonly T[];
}

export function createRingBuffer<T>(
  capacity: number = DEFAULT_DIAGNOSTICS_RING_CAPACITY,
): RingBuffer<T> {
  const max = capacity >= 1 ? capacity : DEFAULT_DIAGNOSTICS_RING_CAPACITY;
  let buf: T[] = [];
  return {
    push(item: T): void {
      if (buf.length >= max) buf.shift();
      buf.push(item);
    },
    drain(): readonly T[] {
      const out = buf;
      buf = [];
      return out;
    },
  };
}

const clip = (s: string, max = 1_000): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

function fmt(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
  if (typeof v === 'object' && v !== null) {
    try {
      const s = JSON.stringify(v);
      if (typeof s === 'string') return s;
    } catch {
      // circular
    }
  }
  return String(v);
}

function overlayText(n: Node): string {
  if (n.nodeType === 3) return n.nodeValue?.trim() ?? '';
  if (is(n, El) && (tag(n) === 'svg' || isElementHidden(n))) return '';
  const out = getComposedChildNodes(n).map(overlayText).filter(Boolean).join('\n');
  return out ? clip(out.replace(/[ \t]+/g, ' ').trim(), 2_000) : '';
}

export function readCompileOverlayFromDocument(): string | null {
  if (!doc?.documentElement) return null;
  function scan(n: Node): string | null {
    if (is(n, El)) {
      if (has(n, DRIVER_UI_ATTRIBUTE) || has(n, 'hidden')) return null;
      const t = tag(n);
      if (t === 'vite-error-overlay' || t === 'nextjs-portal' || has(n, 'data-nextjs-dialog')) {
        const txt = overlayText(n);
        if (txt) return txt;
      }
    }
    for (const c of getComposedChildNodes(n)) {
      const hit = scan(c);
      if (hit) return hit;
    }
    return null;
  }
  return scan(doc.documentElement);
}

let installed = false;
const consoleErrors = /* @__PURE__ */ createRingBuffer<string>();
const pageErrors = /* @__PURE__ */ createRingBuffer<string>();
const networkFailures = /* @__PURE__ */ createRingBuffer<NetworkFailure>();
const pageErrorListeners = /* @__PURE__ */ new HostSet<(message: string) => void>();
const nativeDialogListeners = /* @__PURE__ */ new HostSet<
  (kind: 'alert' | 'confirm' | 'prompt', message: string) => void
>();
let inFlight = 0;

export function ensureDiagnosticsInstalled(): void {
  if (installed) return;
  installed = true;

  const pushPageError = (msg: string, notifyRuntime: boolean): void => {
    const clipped = clip(msg);
    pageErrors.push(clipped);
    if (notifyRuntime) {
      for (const fn of pageErrorListeners) fn(clipped);
    }
  };

  const recNet = (method: string, url: string, status: number, statusText: string): void => {
    networkFailures.push({ method, url, status, statusText });
  };
  const decFlight = (): void => {
    if (inFlight > 0) inFlight -= 1;
  };

  if (win) {
    if (origConsoleError) {
      const nativeErr = origConsoleError;
      console.error = function (...args: unknown[]): void {
        try {
          const t = clip(args.map(fmt).join(' ').trim());
          if (t) consoleErrors.push(t);
        } catch {
          // ignore
        }
        reflectApply(nativeErr, this, args);
      };
    }

    onEvent(
      win,
      'error',
      (ev: Event): void => {
        const t = ev.target;
        if (is(t, El)) {
          const tg = tag(t);
          if (RES_TAGS.has(tg)) {
            const src =
              (is(t, MediaEl) ? t.currentSrc : '') || rawAttr(t, 'src') || rawAttr(t, 'href') || '';
            pushPageError(`Resource error: <${tg}${src ? ` src="${src}"` : ''}>`, false);
          }
          return;
        }
        if (is(ev, HostErrorEvent)) {
          const err: unknown = ev.error;
          pushPageError(err instanceof Error ? fmt(err) : ev.message || 'Page error', true);
        }
      },
      true,
    );

    onEvent(win, 'unhandledrejection', (ev: Event): void => {
      const r: unknown = is(ev, HostPromiseRejectionEvent) ? ev.reason : reflectGet(ev, 'reason');
      pushPageError(`Unhandled rejection: ${fmt(r)}`, true);
    });

    const handleDialog = (kind: 'alert' | 'confirm' | 'prompt', rawMsg: unknown): boolean => {
      if (nativeDialogListeners.size === 0) return false;
      const text = rawMsg !== undefined ? String(rawMsg) : '';
      const formatted = clip(text ? `[dialog:${kind}] ${text}` : `[dialog:${kind}]`);
      consoleErrors.push(formatted);
      for (const fn of nativeDialogListeners) fn(kind, formatted);
      return true;
    };

    for (const [k, orig, ret] of [
      ['alert', origAlert, undefined],
      ['confirm', origConfirm, false],
      ['prompt', origPrompt, null],
    ] as const) {
      if (orig) {
        reflectSet(win, k, (...a: [string?, string?]) =>
          handleDialog(k, a[0]) ? ret : reflectApply(orig, win, a),
        );
      }
    }

    if (origFetch) {
      const nativeFetch = origFetch;
      win.fetch = function (...args: [RequestInfo | URL, RequestInit?]): Promise<Response> {
        const [input, init] = args;
        const u = is(input, ReqCtor) ? input.url : String(input);
        const m = (init?.method || (is(input, ReqCtor) ? input.method : 'GET')).toUpperCase();
        inFlight += 1;
        return reflectApply(nativeFetch, this, args).then(
          (res: Response): Response => {
            decFlight();
            if (res.status >= 400) recNet(m, res.url || u, res.status, res.statusText);
            return res;
          },
          (err: unknown): never => {
            decFlight();
            if (!(err instanceof Error && err.name === 'AbortError')) {
              recNet(m, u, 0, err instanceof Error ? err.message : String(err));
            }
            throw err;
          },
        );
      };
    }

    if (XhrCtor && origXhrOpen && origXhrSend) {
      const nativeOpen = origXhrOpen;
      const nativeSend = origXhrSend;
      const metaMap = new HostWeakMap<XMLHttpRequest, [method: string, url: string]>();

      XhrCtor.prototype.open = function (
        this: XMLHttpRequest,
        method: string,
        url: string | URL,
        ...rest: unknown[]
      ): void {
        metaMap.set(this, [String(method).toUpperCase(), String(url)]);
        reflectApply(nativeOpen, this, [method, url, ...rest]);
      } as typeof XMLHttpRequest.prototype.open; // Invariant: forwards exact XHR.open overloads

      XhrCtor.prototype.send = function (
        ...a: [Document | XMLHttpRequestBodyInit | null | undefined] | []
      ): void {
        let ab = false;
        inFlight += 1;
        onEvent(
          this,
          'abort',
          () => {
            ab = true;
          },
          { once: true },
        );
        onEvent(
          this,
          'loadend',
          () => {
            decFlight();
            const cur = metaMap.get(this);
            const s = this.status;
            if (!ab && cur && (!s || s >= 400)) {
              recNet(
                cur[0],
                this.responseURL || cur[1],
                s,
                this.statusText || (!s ? 'Network Error' : ''),
              );
            }
          },
          { once: true },
        );
        reflectApply(nativeSend, this, a);
      };
    }
  }
}

export const inFlightRequests = (): number => inFlight;

const sub = <T>(set: Set<T>, fn: T): (() => void) => (
  ensureDiagnosticsInstalled(),
  set.add(fn),
  () => {
    set.delete(fn);
  }
);

export const onRuntimePageError = (fn: (message: string) => void): (() => void) =>
  sub(pageErrorListeners, fn);

export const onNativeDialog = (
  fn: (kind: 'alert' | 'confirm' | 'prompt', message: string) => void,
): (() => void) => sub(nativeDialogListeners, fn);

export function drainDiagnostics(passive = false): DiagnosticsDelta {
  if (!passive) ensureDiagnosticsInstalled();
  return {
    compileOverlay: passive ? null : readCompileOverlayFromDocument(),
    consoleErrors: passive ? [] : consoleErrors.drain(),
    pageErrors: passive ? [] : pageErrors.drain(),
    networkFailures: passive ? [] : networkFailures.drain(),
  };
}
