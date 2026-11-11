import {
  type Browser,
  type CDPSession,
  type ConnectOptions,
  type ConnectionTransport,
  type ConsoleMessage,
  type Dialog,
  type KeyInput,
  type MouseButton,
  type Page,
  connect,
} from 'puppeteer-core';
// @ts-expect-error -- dist/preload.js is generated prior to puppeteer bundling and untyped before d.ts emit
import { DRIVER_PRELOAD_SOURCE } from '../../dist/preload.js';
import { diffSnapshots, originAndPathname } from '../preload/diff.js';
import {
  type ObserveRpcParams,
  PROTOCOL_VERSION,
  type SerializedDriverError,
  isEvalResult,
  isObservationSnapshot,
  isRecord,
} from '../protocol.js';
import {
  type ActInterruptionReason,
  type ActOptions,
  type ActResult,
  type CaptureOptions,
  type CaptureResult,
  type DiagnosticsDelta,
  type DriverCapabilities,
  DriverError,
  type DriverStep,
  type EvalOptions,
  type EvalResult,
  type ObservationOptions,
  type ObservationSnapshot,
  type PageDriver,
  type SemanticFingerprint,
  type TargetSpec,
} from '../types.js';

export interface PuppeteerDriverOptions {
  readonly browserWSEndpoint?: string;
  readonly transport?: ConnectionTransport;
  readonly targetUrl?: string;
  readonly allowEval?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ACT_TIMEOUT_MS = 5_000;

let nextCdpSessionSeq = 1;

function getPreloadSource(): string {
  const raw: unknown = DRIVER_PRELOAD_SOURCE;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new DriverError(
      'DRIVER_PROTOCOL',
      'Preload source bundle is unavailable; build @inbrowser/driver before connecting.',
    );
  }
  return raw;
}

function toDriverError(err: unknown, fallbackMessage: string): DriverError {
  if (err instanceof DriverError) {
    return err;
  }
  const message = err instanceof Error ? err.message : fallbackMessage;
  if (/timed?\s*out|timeout/i.test(message)) {
    return new DriverError('DRIVER_TIMEOUT', message, { cause: err });
  }
  return new DriverError('DRIVER_PROTOCOL', message || fallbackMessage, { cause: err });
}

function formatStepError(err: unknown): string {
  if (err instanceof DriverError) {
    const cands = err.candidates?.length
      ? ` (candidates: ${err.candidates
          .slice(0, 5)
          .map((c) => `${c.role}${c.name ? ` "${c.name}"` : ''}`)
          .join(', ')})`
      : '';
    return `${err.code}: ${err.message}${cands}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function isExecutionContextDestroyed(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Execution context was destroyed|Cannot find context with specified id|Target closed|Session closed|Inspected target navigated/i.test(
    msg,
  );
}

function raceWithAbortAndTimeout<T>(
  work: () => Promise<T>,
  timeoutMs: number,
  operationLabel: string,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(
      new DriverError('DRIVER_TIMEOUT', `Driver '${operationLabel}' operation aborted by signal.`, {
        cause: signal.reason,
      }),
    );
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new DriverError(
          'DRIVER_TIMEOUT',
          `Driver '${operationLabel}' operation aborted by signal.`,
          { cause: signal?.reason },
        ),
      );
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new DriverError(
          'DRIVER_TIMEOUT',
          `Driver '${operationLabel}' timed out after ${String(timeoutMs)}ms.`,
        ),
      );
    }, timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });

    work().then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(toDriverError(err, `Driver '${operationLabel}' failed.`));
      },
    );
  });
}

function isNavigableUrl(candidate: string): boolean {
  return (
    /^https?:\/\//i.test(candidate) || candidate.startsWith('data:') || candidate === 'about:blank'
  );
}

interface ResolvedPageTarget {
  readonly page: Page;
  readonly preloadRegisteredOnNewDoc: boolean;
}

async function resolveTargetPage(
  browser: Browser,
  targetUrl: string | undefined,
  preloadSource: string,
  timeoutMs: number,
): Promise<ResolvedPageTarget> {
  const pages = await browser.pages();

  if (targetUrl !== undefined) {
    const matched = pages.find((p) => {
      const currentUrl = p.url();
      return currentUrl === targetUrl || currentUrl.startsWith(targetUrl);
    });
    if (matched !== undefined) {
      return { page: matched, preloadRegisteredOnNewDoc: false };
    }

    if (!isNavigableUrl(targetUrl)) {
      throw new DriverError(
        'DRIVER_TARGET_NOT_FOUND',
        `No open page matched targetUrl "${targetUrl}".`,
      );
    }

    const blankPage = pages.find((p) => p.url() === '' || p.url() === 'about:blank');
    const page = blankPage ?? (await browser.newPage());
    await page.evaluateOnNewDocument(preloadSource);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    return { page, preloadRegisteredOnNewDoc: true };
  }

  const preferred = pages.find((p) => p.url() !== '' && p.url() !== 'about:blank') ?? pages[0];
  if (preferred === undefined) {
    throw new DriverError(
      'DRIVER_TARGET_NOT_FOUND',
      'No open page targets available in connected browser.',
    );
  }
  return { page: preferred, preloadRegisteredOnNewDoc: false };
}

interface BridgeErrorShape {
  readonly code: SerializedDriverError['code'];
  readonly message: string;
  readonly candidates?: readonly SemanticFingerprint[];
}

function isBridgeError(v: unknown): v is BridgeErrorShape {
  return (
    isRecord(v) &&
    typeof v['code'] === 'string' &&
    typeof v['message'] === 'string' &&
    (v['code'] === 'DRIVER_TIMEOUT' ||
      v['code'] === 'DRIVER_DISPOSED' ||
      v['code'] === 'DRIVER_PROTOCOL' ||
      v['code'] === 'DRIVER_UNSUPPORTED' ||
      v['code'] === 'DRIVER_TARGET_NOT_FOUND' ||
      v['code'] === 'DRIVER_TARGET_AMBIGUOUS' ||
      v['code'] === 'DRIVER_EVAL_DISABLED')
  );
}

function unwrapBridgeEnvelope<T>(rawOutcome: unknown): T {
  if (!isRecord(rawOutcome)) {
    throw new DriverError('DRIVER_PROTOCOL', 'Malformed response from in-page CDP bridge.');
  }
  if (rawOutcome['ok'] === true) {
    return rawOutcome['result'] as T; // Invariant: caller validates or types concrete bridge command result
  }
  if (rawOutcome['ok'] === false && isBridgeError(rawOutcome['error'])) {
    const errInfo = rawOutcome['error'];
    throw new DriverError(errInfo.code, errInfo.message, {
      ...(errInfo.candidates !== undefined ? { candidates: errInfo.candidates } : {}),
    });
  }
  throw new DriverError('DRIVER_PROTOCOL', 'Unexpected bridge response envelope.');
}

interface ResolvedActionTarget {
  readonly cx: number;
  readonly cy: number;
  readonly docX: number;
  readonly docY: number;
  readonly width: number;
  readonly height: number;
  readonly tagName: string;
  readonly role: string;
  readonly isCustomCombobox: boolean;
  readonly ariaExpanded: boolean;
}

interface FillPreparation {
  readonly cx: number;
  readonly cy: number;
  readonly hadContent: boolean;
}

interface SelectResolution {
  readonly kind: 'native' | 'custom';
  readonly needsOpenClick: boolean;
  readonly comboCx: number;
  readonly comboCy: number;
  readonly optionPoints: readonly { readonly cx: number; readonly cy: number }[];
}

interface PostStepInspection {
  readonly pendingUnload: boolean;
  readonly compileOverlay: string | null;
  readonly newDomDialogOpened: boolean;
}

interface ScreenshotClipInfo {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly clip: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
}

function readImageDimensions(
  bytes: Uint8Array,
  format: 'png' | 'webp',
  fallbackWidth: number,
  fallbackHeight: number,
): { readonly width: number; readonly height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    format === 'png' &&
    bytes.byteLength >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const w = view.getUint32(16, false);
    const h = view.getUint32(20, false);
    if (w > 0 && h > 0) {
      return { width: w, height: h };
    }
  }

  if (
    format === 'webp' &&
    bytes.byteLength >= 30 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const chunk = String.fromCharCode(
      bytes[12] ?? 0,
      bytes[13] ?? 0,
      bytes[14] ?? 0,
      bytes[15] ?? 0,
    );
    if (chunk === 'VP8X') {
      const w = 1 + ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16));
      const h = 1 + ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16));
      if (w > 0 && h > 0) {
        return { width: w, height: h };
      }
    } else if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      const w = view.getUint16(26, true) & 0x3fff;
      const h = view.getUint16(28, true) & 0x3fff;
      if (w > 0 && h > 0) {
        return { width: w, height: h };
      }
    } else if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      const w = (bits & 0x3fff) + 1;
      const h = ((bits >>> 14) & 0x3fff) + 1;
      if (w > 0 && h > 0) {
        return { width: w, height: h };
      }
    }
  }

  return {
    width: Math.max(1, Math.round(fallbackWidth)),
    height: Math.max(1, Math.round(fallbackHeight)),
  };
}

interface EncodedWebmPayload {
  readonly mimeType: string;
  readonly bytesArray: readonly number[];
  readonly width: number;
  readonly height: number;
}

async function encodeFramesToWebmInPage(arg: {
  readonly frames: readonly string[];
  readonly fallbackWidth: number;
  readonly fallbackHeight: number;
}): Promise<EncodedWebmPayload> {
  const decodeImage = (b64: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = (): void => resolve(img);
      img.onerror = (): void => reject(new Error('Failed to decode recorded frame'));
      img.src = `data:image/jpeg;base64,${b64}`;
    });

  const decoded: HTMLImageElement[] = [];
  for (const frame of arg.frames) {
    try {
      decoded.push(await decodeImage(frame));
    } catch {
      // Skip malformed frame if encountered
    }
  }

  const first = decoded[0];
  const width = Math.max(2, Math.round(first?.naturalWidth || arg.fallbackWidth || 640));
  const height = Math.max(2, Math.round(first?.naturalHeight || arg.fallbackHeight || 480));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D canvas context unavailable for WebM encoding.');
  }

  const preferredMime =
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
      ? 'video/webm;codecs=vp8'
      : 'video/webm';

  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const requestFrame = (): void => {
    if (track && 'requestFrame' in track) {
      const fn: unknown = Reflect.get(track, 'requestFrame');
      if (typeof fn === 'function') {
        fn.call(track);
      }
    }
  };

  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(stream, { mimeType: preferredMime });
  const stoppedPromise = new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = (ev: BlobEvent): void => {
      if (ev.data.size > 0) {
        chunks.push(ev.data);
      }
    };
    recorder.onerror = (): void => reject(new Error('MediaRecorder encoding failed.'));
    recorder.onstop = (): void => resolve(new Blob(chunks, { type: 'video/webm' }));
  });

  recorder.start();

  const framesToRender = decoded.length > 0 ? decoded : [null];
  // Render at least 2 frame intervals so VP8 emits complete EBML + Cluster data
  const sequence =
    framesToRender.length === 1 ? [framesToRender[0], framesToRender[0]] : framesToRender;

  for (const img of sequence) {
    if (img) {
      ctx.drawImage(img, 0, 0, width, height);
    } else {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, width, height);
    }
    requestFrame();
    await new Promise<void>((r) => setTimeout(r, 25));
  }

  recorder.stop();
  const blob = await stoppedPromise;
  for (const t of stream.getTracks()) {
    t.stop();
  }
  const buf = await blob.arrayBuffer();
  return {
    mimeType: 'video/webm',
    bytesArray: Array.from(new Uint8Array(buf)),
    width,
    height,
  };
}

type BridgeCommand =
  | {
      readonly op: 'rpc';
      readonly sessionId: string;
      readonly allowEval: boolean;
      readonly minRev: number;
      readonly method: 'observe' | 'eval';
      readonly params?: unknown;
    }
  | {
      readonly op: 'prepareActionTarget';
      readonly target: TargetSpec;
      readonly timeoutMs: number;
      readonly allowZeroSizeAudio: boolean;
      readonly armNavTracker: boolean;
      readonly recordDialogsBefore: boolean;
    }
  | {
      readonly op: 'prepareFill';
      readonly target: TargetSpec;
      readonly timeoutMs: number;
      readonly recordDialogsBefore: boolean;
    }
  | {
      readonly op: 'finalizeFill';
      readonly value: string;
      readonly submit: boolean;
    }
  | {
      readonly op: 'executeSetValue';
      readonly target: TargetSpec;
      readonly value: string | number;
      readonly timeoutMs: number;
      readonly recordDialogsBefore: boolean;
    }
  | {
      readonly op: 'prepareSelect';
      readonly target: TargetSpec;
      readonly values: readonly string[];
      readonly timeoutMs: number;
      readonly phase: 'initial' | 'options';
      readonly recordDialogsBefore: boolean;
    }
  | {
      readonly op: 'preparePress';
      readonly target?: TargetSpec;
      readonly timeoutMs: number;
      readonly recordDialogsBefore: boolean;
    }
  | {
      readonly op: 'executeWaitFor';
      readonly target?: TargetSpec;
      readonly text?: string;
      readonly state?: 'attached' | 'visible' | 'hidden' | 'detached';
      readonly idleMs?: number;
      readonly timeoutMs: number;
      readonly recordDialogsBefore: boolean;
    }
  | {
      readonly op: 'recordDialogsBefore';
    }
  | {
      readonly op: 'settleAndInspect';
      readonly timeoutMs: number;
    }
  | {
      readonly op: 'resolveScreenshotClip';
      readonly target?: TargetSpec;
      readonly timeoutMs: number;
    };

/**
 * Self-contained browser-side bridge installed under `window[Symbol.for('@inbrowser/driver:cdp-bridge:v1')]`.
 * Must not reference outer module bindings because `page.evaluate` serializes this function via `toString()`.
 */
async function executeInPageBridgeCommand(cmd: BridgeCommand): Promise<unknown> {
  const CHANNEL = '@inbrowser/driver:v1';
  const BRIDGE_KEY = Symbol.for('@inbrowser/driver:cdp-bridge:v1');
  const DRIVER_UI_ATTR = 'data-inbrowser-driver-ui';

  interface Fingerprint {
    readonly role: string;
    readonly name: string;
    readonly landmark?: string;
    readonly driverId?: string;
    readonly nth: number;
  }

  interface StoredRef {
    weakEl: WeakRef<Element>;
    fingerprint: Fingerprint;
    cohortSize: number;
  }

  interface Candidate {
    readonly target: Element;
    readonly text: string;
    readonly fingerprint: Fingerprint;
  }

  interface BridgeState {
    sessionId: string;
    allowEval: boolean;
    nextId: number;
    port: MessagePort | null;
    refs: Map<string, StoredRef>;
    lastTargetEl: Element | null;
    dialogsBefore: Set<Element>;
    pendingUnload: boolean;
    detachNavTrackers: (() => void) | null;
    ensurePort(sessionId: string, allowEval: boolean, minRev: number): Promise<MessagePort>;
    callRpc(
      sessionId: string,
      allowEval: boolean,
      minRev: number,
      method: string,
      params: unknown,
    ): Promise<unknown>;
    indexSnapshot(snap: unknown): void;
  }

  class CodedBridgeError extends Error {
    readonly code: string;
    readonly candidates: readonly Fingerprint[] | undefined;
    constructor(code: string, message: string, candidates?: readonly Fingerprint[]) {
      super(message);
      this.code = code;
      this.candidates = candidates;
    }
  }

  const normSpace = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const tag = (el: Element): string => el.tagName.toLowerCase();
  const attr = (el: Element, name: string): string => normSpace(el.getAttribute(name) ?? '');

  const IGNORED_TAGS = new Set([
    'script',
    'style',
    'noscript',
    'template',
    'head',
    'meta',
    'link',
    'base',
    'title',
    'param',
    'track',
    'source',
    'wbr',
    'br',
  ]);
  const SECTION_TAGS = new Set(['article', 'aside', 'main', 'nav', 'section']);
  const LANDMARK_ROLES = new Set([
    'main',
    'navigation',
    'banner',
    'contentinfo',
    'region',
    'form',
    'toolbar',
    'dialog',
    'complementary',
  ]);
  const TOGGLE_ROLES = new Set([
    'checkbox',
    'switch',
    'radio',
    'menuitemcheckbox',
    'menuitemradio',
  ]);
  const VALUE_ROLES = new Set([
    'textbox',
    'searchbox',
    'combobox',
    'listbox',
    'slider',
    'spinbutton',
  ]);
  const INTERACTIVE_ROLES = new Set([
    ...TOGGLE_ROLES,
    ...VALUE_ROLES,
    'button',
    'link',
    'option',
    'tab',
    'menuitem',
  ]);
  const DIRECT_ROLES: Record<string, string> = {
    main: 'main',
    form: 'form',
    dialog: 'dialog',
    button: 'button',
    option: 'option',
    nav: 'navigation',
    aside: 'complementary',
    output: 'status',
    ul: 'list',
    ol: 'list',
    menu: 'list',
    li: 'listitem',
    summary: 'button',
    textarea: 'textbox',
    h1: 'heading',
    h2: 'heading',
    h3: 'heading',
    h4: 'heading',
    h5: 'heading',
    h6: 'heading',
  };
  const INPUT_ROLES: Record<string, string> = {
    button: 'button',
    checkbox: 'checkbox',
    radio: 'radio',
    submit: 'button',
    reset: 'button',
    image: 'button',
    range: 'slider',
    number: 'spinbutton',
  };

  function getComposedChildren(node: Node): Node[] {
    if (node instanceof Element) {
      if (node instanceof HTMLSlotElement) {
        const assigned = node.assignedNodes({ flatten: false });
        if (assigned.length > 0) return [...assigned];
      }
      if (node.shadowRoot) return Array.from(node.shadowRoot.childNodes);
      if (node instanceof HTMLSelectElement) return Array.from(node.childNodes).slice(0, 50);
    }
    return Array.from(node.childNodes);
  }

  function composedParent(node: Node): Node | null {
    if (node instanceof Element && node.assignedSlot) return node.assignedSlot;
    const p = node.parentNode;
    return p instanceof ShadowRoot ? p.host : p;
  }

  function getComposedParentElement(node: Node): Element | null {
    let cur = composedParent(node);
    while (cur && !(cur instanceof Element)) cur = composedParent(cur);
    return cur;
  }

  function isComposedDescendant(ancestor: Node, candidate: Node): boolean {
    for (let cur: Node | null = candidate; cur; cur = composedParent(cur)) {
      if (cur === ancestor || cur.parentNode === ancestor) return true;
    }
    return false;
  }

  function findComposedAncestor(
    el: Element | null,
    pred: (c: Element) => boolean,
    includeSelf = false,
  ): Element | null {
    for (
      let cur = includeSelf ? el : el ? getComposedParentElement(el) : null;
      cur;
      cur = getComposedParentElement(cur)
    ) {
      if (pred(cur)) return cur;
    }
    return null;
  }

  function isElementHidden(el: Element): boolean {
    if (
      el.hasAttribute(DRIVER_UI_ATTR) ||
      el.hasAttribute('hidden') ||
      attr(el, 'aria-hidden') === 'true'
    ) {
      return true;
    }
    const t = tag(el);
    if (IGNORED_TAGS.has(t)) return true;
    if (el instanceof HTMLInputElement && el.type.toLowerCase() === 'hidden') return true;
    if (t === 'dialog' && !el.hasAttribute('open')) return true;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
    if (style.display === 'none') {
      return (t === 'audio' && !el.hasAttribute('controls')) || t === 'option'
        ? el instanceof HTMLElement && el.style.display === 'none'
        : true;
    }
    return false;
  }

  function isElementDisabled(el: Element): boolean {
    if (attr(el, 'aria-disabled') === 'true') return true;
    if (el instanceof HTMLOptionElement) return el.disabled;
    if ('disabled' in el && typeof el.disabled === 'boolean') {
      return (
        el.disabled ||
        findComposedAncestor(
          el,
          (a) => tag(a) === 'fieldset' && 'disabled' in a && Boolean(a.disabled),
        ) !== null
      );
    }
    return false;
  }

  const DRIVER_ID_RE = /^[A-Za-z0-9_.:/-]{1,80}$/;
  const DRIVER_REGION_RE = /(?:^|\.)(?:panel|section|region|list|nav|group)$/i;
  const NATIVE_CTRL_SEL = 'button,a[href],input:not([type=hidden]),select,textarea,[tabindex]';

  function readDriverId(el: Element): string {
    const v = attr(el, 'data-driver').slice(0, 80);
    return DRIVER_ID_RE.test(v) ? v : '';
  }

  function shouldAssignRef(el: Element, role: string): boolean {
    return (
      Boolean(readDriverId(el)) ||
      LANDMARK_ROLES.has(role) ||
      INTERACTIVE_ROLES.has(role) ||
      role === 'video' ||
      role === 'audio' ||
      role === 'canvas' ||
      (el instanceof HTMLElement && el.hasAttribute('tabindex') && el.tabIndex >= 0)
    );
  }

  function computeBaseRole(el: Element): string | null {
    const t = tag(el);
    if (t === 'video' || t === 'audio' || t === 'canvas') return t;
    const explicit = attr(el, 'role');
    if (explicit) {
      const token = explicit.split(' ')[0]?.toLowerCase() ?? '';
      return token === 'none' || token === 'presentation' ? null : token || null;
    }
    if (DIRECT_ROLES[t]) return DIRECT_ROLES[t]!;
    const drv = readDriverId(el);
    if (t === 'header' || t === 'footer') {
      return findComposedAncestor(el, (a) => SECTION_TAGS.has(tag(a))) !== null
        ? drv
          ? 'region'
          : null
        : t === 'header'
          ? 'banner'
          : 'contentinfo';
    }
    if (t === 'section') {
      return attr(el, 'aria-label') || attr(el, 'aria-labelledby') || attr(el, 'title') || drv
        ? 'region'
        : null;
    }
    if (t === 'a' || t === 'area') return el.hasAttribute('href') ? 'link' : drv ? 'button' : null;
    if (t === 'select') {
      return el instanceof HTMLSelectElement && (el.multiple || el.size > 1)
        ? 'listbox'
        : 'combobox';
    }
    if (t === 'input') {
      const it =
        el instanceof HTMLInputElement
          ? el.type.toLowerCase()
          : attr(el, 'type').toLowerCase() || 'text';
      return it === 'hidden' ? null : (INPUT_ROLES[it] ?? 'textbox');
    }
    if (t === 'img') {
      return attr(el, 'aria-label') ||
        attr(el, 'aria-labelledby') ||
        attr(el, 'title') ||
        attr(el, 'alt') ||
        drv
        ? 'img'
        : null;
    }
    const ce = el.getAttribute('contenteditable');
    if (ce === '' || ce?.toLowerCase() === 'true') return 'textbox';
    if (el.hasAttribute('onclick')) return 'button';

    if (drv) {
      return DRIVER_REGION_RE.test(drv) ||
        (!attr(el, 'data-driver-intent') &&
          !attr(el, 'data-driver-description') &&
          window.getComputedStyle(el).cursor !== 'pointer' &&
          Boolean(el.querySelector(NATIVE_CTRL_SEL)))
        ? 'region'
        : 'button';
    }
    return null;
  }

  function computeElementRole(el: Element): string | null {
    const base = computeBaseRole(el);
    if (base) return base;
    const t = tag(el);
    if (t === 'html' || t === 'body' || t === 'main' || t === 'label') return null;
    if (window.getComputedStyle(el).cursor !== 'pointer') return null;
    const parent = getComposedParentElement(el);
    if (parent && window.getComputedStyle(parent).cursor === 'pointer') return null;
    if (
      el.querySelector(NATIVE_CTRL_SEL) ||
      findComposedAncestor(el, (a) => {
        const r = computeBaseRole(a);
        return Boolean(r && INTERACTIVE_ROLES.has(r));
      }) !== null
    ) {
      return null;
    }
    const txt = normSpace(el.textContent ?? '');
    return txt.length > 0 && txt.length <= 240 ? 'button' : null;
  }

  function extractText(
    root: Node,
    visited: Set<Element>,
    allowHiddenRoot: boolean,
    exclude?: Element,
    skipControls?: boolean,
  ): string {
    const parts: string[] = [];
    function walk(cur: Node, isRoot: boolean): void {
      if (cur.nodeType === 3) {
        if (cur.nodeValue) parts.push(cur.nodeValue);
        return;
      }
      if (!(cur instanceof Element) || cur === exclude || (!isRoot && visited.has(cur))) return;
      const t = tag(cur);
      if (!isRoot || !allowHiddenRoot) {
        if (isElementHidden(cur)) return;
      } else if (IGNORED_TAGS.has(t) || cur.hasAttribute(DRIVER_UI_ATTR)) return;
      if (!isRoot && skipControls) {
        const r = computeElementRole(cur);
        if (r && shouldAssignRef(cur, r)) return;
      }
      if (t === 'img') {
        const alt = cur.getAttribute('alt');
        if (alt) parts.push(alt);
        return;
      }
      if (!isRoot) {
        const aria = attr(cur, 'aria-label');
        if (aria) {
          parts.push(aria);
          return;
        }
      }
      for (const c of getComposedChildren(cur)) walk(c, false);
    }
    walk(root, true);
    return normSpace(parts.join(' '));
  }

  function computeAccessibleName(
    el: Element,
    role: string,
    visited: Set<Element> = new Set<Element>(),
  ): string {
    if (visited.has(el)) return '';
    const next = new Set<Element>(visited);
    next.add(el);

    const lb = attr(el, 'aria-labelledby');
    if (lb) {
      const root = el.getRootNode();
      const parts: string[] = [];
      for (const id of lb.split(' ')) {
        const refEl =
          root instanceof ShadowRoot
            ? (root.getElementById(id) ?? document.getElementById(id))
            : document.getElementById(id);
        if (refEl) {
          const txt = extractText(refEl, next, true);
          if (txt) parts.push(txt);
        }
      }
      const joined = normSpace(parts.join(' '));
      if (joined) return joined;
    }

    const aria = attr(el, 'aria-label');
    if (aria) return aria;

    if (el instanceof HTMLInputElement) {
      const it = el.type.toLowerCase();
      if (it === 'image') return attr(el, 'alt') || normSpace(el.value) || 'Submit';
      if (it === 'submit' || it === 'reset' || it === 'button') {
        return normSpace(el.value) || (it === 'submit' ? 'Submit' : it === 'reset' ? 'Reset' : '');
      }
    }

    const labels =
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
        ? el.labels
        : null;
    if (labels && labels.length > 0) {
      const parts: string[] = [];
      for (const lbl of Array.from(labels)) {
        const txt = extractText(lbl, next, false, el);
        if (txt) parts.push(txt);
      }
      const joined = normSpace(parts.join(' '));
      if (joined) return joined;
    }

    if (el instanceof HTMLOptionElement) {
      const opt = normSpace(el.label || el.text);
      if (opt) return opt;
    }
    if (tag(el) === 'img') {
      const alt = attr(el, 'alt');
      if (alt) return alt;
    }

    const usesContent =
      role === 'heading' || (INTERACTIVE_ROLES.has(role) && !VALUE_ROLES.has(role));
    if (
      usesContent &&
      !((role === 'checkbox' || role === 'radio') && el instanceof HTMLInputElement)
    ) {
      const txt = extractText(el, next, false);
      if (txt) return txt;
    }
    if (role === 'alert' || role === 'status' || role === 'listitem') {
      const txt = extractText(el, next, false, undefined, true);
      if (txt) return txt;
    }

    const placeholder =
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ? normSpace(el.placeholder)
        : attr(el, 'aria-placeholder');
    return placeholder || attr(el, 'title');
  }

  const formatLm = (role: string, name: string): string => (name ? `${role}:${name}` : role);

  function findEnclosingLandmark(el: Element): string | undefined {
    let out: string | undefined;
    findComposedAncestor(el, (cur) => {
      const r = computeElementRole(cur);
      if (r && LANDMARK_ROLES.has(r)) {
        out = formatLm(r, computeAccessibleName(cur, r));
        return true;
      }
      return false;
    });
    return out;
  }

  function scanLiveDom(withText: boolean): {
    readonly items: readonly Candidate[];
    readonly cohortCounts: Map<string, number>;
  } {
    const start = document.body ?? document.documentElement;
    const counts = new Map<string, number>();
    const items: Candidate[] = [];
    if (!start) return { items, cohortCounts: counts };

    function visit(node: Node, landmark: string | undefined): void {
      if (node instanceof Element) {
        if (isElementHidden(node)) return;
        const computedRole = computeElementRole(node);
        const role = computedRole ?? (withText ? tag(node) : null);
        let childLm = landmark;
        if (role) {
          const name = computeAccessibleName(node, role);
          if (LANDMARK_ROLES.has(role)) childLm = formatLm(role, name);
          const text = withText ? extractText(node, new Set<Element>(), false) : '';
          if (computedRole || text || name) {
            const fpName = computedRole ? name : name || text;
            const drv = readDriverId(node);
            const key = `${role}\0${fpName}\0${landmark ?? ''}\0${drv}`;
            const nth = counts.get(key) ?? 0;
            counts.set(key, nth + 1);
            const fingerprint: Fingerprint = {
              role,
              name: fpName,
              nth,
              ...(landmark !== undefined ? { landmark } : {}),
              ...(drv ? { driverId: drv } : {}),
            };
            items.push({ target: node, text, fingerprint });
          }
        }
        for (const c of getComposedChildren(node)) visit(c, childLm);
        return;
      }
      for (const c of getComposedChildren(node)) visit(c, landmark);
    }

    visit(start, start instanceof Element ? findEnclosingLandmark(start) : undefined);
    return { items, cohortCounts: counts };
  }

  function isElementObservable(el: Element): boolean {
    if (!el.isConnected || !isComposedDescendant(document, el)) return false;
    for (let cur: Element | null = el; cur; cur = getComposedParentElement(cur)) {
      if (isElementHidden(cur)) return false;
    }
    return true;
  }

  function rankCandidates(
    pool: readonly Candidate[],
    role: string,
    name: string,
    landmark?: string,
    driverId?: string,
  ): readonly Fingerprint[] {
    if (pool.length === 0) return [];
    const sameRole = role ? pool.filter((c) => c.fingerprint.role === role) : [];
    const activePool = sameRole.length > 0 ? sameRole : pool;
    const qName = name.toLowerCase();
    const qDrv = driverId?.toLowerCase() ?? '';
    return activePool
      .map((item, idx) => {
        const fp = item.fingerprint;
        let s = role && fp.role === role ? 100 : 0;
        if (landmark !== undefined && fp.landmark === landmark) s += 30;
        const cDrv = fp.driverId?.toLowerCase() ?? '';
        if (qDrv && cDrv) {
          if (cDrv === qDrv) s += 80;
          else if (cDrv.includes(qDrv) || qDrv.includes(cDrv)) s += 40;
        }
        const cName = fp.name.toLowerCase();
        if (qName && cName) {
          if (cName === qName) s += 50;
          else if (cName.includes(qName) || qName.includes(cName)) s += 25;
        }
        return { fp, s, idx };
      })
      .sort((a, b) => b.s - a.s || a.idx - b.idx)
      .slice(0, 8)
      .map((x) => x.fp);
  }

  function sameCohort(a: Fingerprint, b: Fingerprint): boolean {
    return (
      a.role === b.role &&
      a.name === b.name &&
      a.landmark === b.landmark &&
      a.driverId === b.driverId
    );
  }

  function resolveTarget(spec: TargetSpec, state: BridgeState): Element {
    if (typeof spec === 'string') {
      if (!/^e\d+$/.test(spec)) {
        const { items } = scanLiveDom(false);
        throw new CodedBridgeError(
          'DRIVER_TARGET_NOT_FOUND',
          `Invalid ref "${spec}".`,
          rankCandidates(items, '', spec),
        );
      }
      const entry = state.refs.get(spec);
      if (!entry) {
        const { items } = scanLiveDom(false);
        throw new CodedBridgeError(
          'DRIVER_TARGET_NOT_FOUND',
          `Unknown ref "${spec}".`,
          rankCandidates(items, '', ''),
        );
      }
      const liveEl = entry.weakEl.deref();
      if (liveEl && isElementObservable(liveEl)) return liveEl;

      const { items } = scanLiveDom(false);
      const cohort = items.filter((c) => sameCohort(c.fingerprint, entry.fingerprint));
      if (cohort.length === 0) {
        throw new CodedBridgeError(
          'DRIVER_TARGET_NOT_FOUND',
          `Detached "${spec}".`,
          rankCandidates(
            items,
            entry.fingerprint.role,
            entry.fingerprint.name,
            entry.fingerprint.landmark,
            entry.fingerprint.driverId,
          ),
        );
      }
      if (cohort.length === entry.cohortSize) {
        const picked = cohort[cohort.length === 1 ? 0 : entry.fingerprint.nth];
        if (picked !== undefined) {
          entry.weakEl = new WeakRef(picked.target);
          return picked.target;
        }
      }
      throw new CodedBridgeError(
        'DRIVER_TARGET_AMBIGUOUS',
        `Ambiguous "${spec}".`,
        cohort.map((c) => c.fingerprint),
      );
    }

    if ('role' in spec) {
      const { items } = scanLiveDom(false);
      const r = spec.role.trim().toLowerCase();
      const n = spec.name !== undefined ? normSpace(spec.name) : undefined;
      const matches = items.filter(
        ({ fingerprint: f }) => f.role === r && (n === undefined || f.name === n),
      );
      if (matches.length === 0) {
        throw new CodedBridgeError(
          'DRIVER_TARGET_NOT_FOUND',
          `No "${spec.role}".`,
          rankCandidates(items, r, n ?? ''),
        );
      }
      if (spec.nth !== undefined) {
        const picked = matches[spec.nth];
        if (!picked) {
          throw new CodedBridgeError(
            'DRIVER_TARGET_NOT_FOUND',
            `nth=${String(spec.nth)} out of range.`,
            matches.map((m) => m.fingerprint),
          );
        }
        return picked.target;
      }
      if (matches.length > 1) {
        throw new CodedBridgeError(
          'DRIVER_TARGET_AMBIGUOUS',
          `Ambiguous "${spec.role}".`,
          matches.map((m) => m.fingerprint),
        );
      }
      return matches[0]!.target;
    }

    if ('driver' in spec) {
      const { items } = scanLiveDom(false);
      const drv = normSpace(spec.driver);
      const matches = drv ? items.filter(({ fingerprint: f }) => f.driverId === drv) : [];
      if (matches.length === 0) {
        throw new CodedBridgeError(
          'DRIVER_TARGET_NOT_FOUND',
          `No driver="${spec.driver}".`,
          rankCandidates(items, '', drv, undefined, drv),
        );
      }
      if (spec.nth !== undefined) {
        const picked = matches[spec.nth];
        if (!picked) {
          throw new CodedBridgeError(
            'DRIVER_TARGET_NOT_FOUND',
            `nth=${String(spec.nth)} out of range.`,
            matches.map((m) => m.fingerprint),
          );
        }
        return picked.target;
      }
      if (matches.length > 1) {
        throw new CodedBridgeError(
          'DRIVER_TARGET_AMBIGUOUS',
          `Ambiguous driver="${drv}".`,
          matches.map((m) => m.fingerprint),
        );
      }
      return matches[0]!.target;
    }

    const query = normSpace(spec.text);
    const exact = spec.exact === true;
    const lq = query.toLowerCase();
    const { items } = scanLiveDom(true);
    const matched = query
      ? items.filter((c) =>
          exact
            ? c.text === query || c.fingerprint.name === query
            : c.text.toLowerCase().includes(lq) || c.fingerprint.name.toLowerCase().includes(lq),
        )
      : [];
    if (matched.length === 0) {
      throw new CodedBridgeError(
        'DRIVER_TARGET_NOT_FOUND',
        `Text "${spec.text}" not found.`,
        rankCandidates(items, '', query),
      );
    }
    const deepest = matched.filter(
      (o) =>
        !matched.some((i) => i.target !== o.target && isComposedDescendant(o.target, i.target)),
    );
    if (deepest.length > 1) {
      throw new CodedBridgeError(
        'DRIVER_TARGET_AMBIGUOUS',
        `Ambiguous text "${spec.text}".`,
        deepest.map((m) => m.fingerprint),
      );
    }
    return deepest[0]!.target;
  }

  function deepElementFromPoint(x: number, y: number): Element | null {
    let hit = document.elementFromPoint(x, y);
    while (hit) {
      const inner = hit.shadowRoot ? hit.shadowRoot.elementFromPoint(x, y) : null;
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }

  const sleepFrame = (ms: number, useRaf: boolean): Promise<void> =>
    new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve();
        }
      };
      const timer = setTimeout(finish, ms);
      if (useRaf) requestAnimationFrame(() => finish());
    });

  async function waitForActionable(
    spec: TargetSpec,
    timeoutMs: number,
    state: BridgeState,
    allowZeroSizeAudio = false,
  ): Promise<ResolvedActionTarget & { readonly el: Element; readonly hitEl: Element }> {
    const deadline = performance.now() + timeoutMs;
    let lastError: unknown = null;
    let lastReason = 'Target not actionable before timeout.';
    let prevRect: DOMRect | null = null;
    let stableFrames = 0;
    let sawAmbiguous = false;

    while (true) {
      let el: Element | null = null;
      try {
        el = resolveTarget(spec, state);
      } catch (err) {
        lastError = err;
        if (err instanceof CodedBridgeError && err.code === 'DRIVER_TARGET_AMBIGUOUS') {
          if (sawAmbiguous) throw err;
          sawAmbiguous = true;
        }
      }

      if (el) {
        sawAmbiguous = false;
        const t = tag(el);
        const skipHit = t === 'audio' || t === 'option';
        if (!el.isConnected || isElementHidden(el)) {
          lastReason = 'Target is hidden or detached.';
          stableFrames = 0;
        } else {
          let rect = el.getBoundingClientRect();
          if (!(allowZeroSizeAudio && t === 'audio') && (rect.width <= 0 || rect.height <= 0)) {
            lastReason = 'Target has zero size.';
            stableFrames = 0;
          } else {
            if (
              !skipHit &&
              (rect.bottom <= 0 ||
                rect.top >= window.innerHeight ||
                rect.right <= 0 ||
                rect.left >= window.innerWidth)
            ) {
              el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
              rect = el.getBoundingClientRect();
            }
            if (
              prevRect &&
              Math.hypot(
                prevRect.left - rect.left,
                prevRect.top - rect.top,
                prevRect.width - rect.width,
                prevRect.height - rect.height,
              ) < 0.5
            ) {
              stableFrames += 1;
            } else {
              prevRect = rect;
              stableFrames = 0;
            }

            if (stableFrames >= 2) {
              if (isElementDisabled(el)) {
                lastReason = 'Target is disabled.';
              } else {
                const pageLeft = window.visualViewport?.pageLeft ?? window.scrollX;
                const pageTop = window.visualViewport?.pageTop ?? window.scrollY;
                const rRole = computeElementRole(el) ?? t;
                if (skipHit) {
                  const cx = rect.left + rect.width / 2;
                  const cy = rect.top + rect.height / 2;
                  return {
                    el,
                    hitEl: el,
                    cx,
                    cy,
                    docX: rect.left + pageLeft,
                    docY: rect.top + pageTop,
                    width: rect.width,
                    height: rect.height,
                    tagName: t,
                    role: rRole,
                    isCustomCombobox: rRole === 'combobox' && !(el instanceof HTMLSelectElement),
                    ariaExpanded: el.getAttribute('aria-expanded') === 'true',
                  };
                }
                const vx0 = Math.max(0, rect.left);
                const vy0 = Math.max(0, rect.top);
                const vx1 = Math.min(window.innerWidth, rect.right);
                const vy1 = Math.min(window.innerHeight, rect.bottom);
                if (vx1 > vx0 && vy1 > vy0) {
                  const cx = (vx0 + vx1) / 2;
                  const cy = (vy0 + vy1) / 2;
                  const hit = deepElementFromPoint(cx, cy);
                  const labelHit =
                    findComposedAncestor(
                      hit,
                      (c) => c instanceof HTMLLabelElement && c.control === el,
                      true,
                    ) !== null;
                  if (hit && (hit === el || isComposedDescendant(el, hit) || labelHit)) {
                    return {
                      el,
                      hitEl: hit,
                      cx,
                      cy,
                      docX: rect.left + pageLeft,
                      docY: rect.top + pageTop,
                      width: rect.width,
                      height: rect.height,
                      tagName: t,
                      role: rRole,
                      isCustomCombobox: rRole === 'combobox' && !(el instanceof HTMLSelectElement),
                      ariaExpanded: el.getAttribute('aria-expanded') === 'true',
                    };
                  }
                  lastReason = `Target obscured at (${Math.round(cx)}, ${Math.round(cy)}).`;
                } else {
                  lastReason = 'Target outside viewport.';
                }
              }
            }
          }
        }
      }

      if (performance.now() >= deadline) {
        if (lastError instanceof CodedBridgeError) throw lastError;
        throw new CodedBridgeError('DRIVER_TIMEOUT', lastReason);
      }
      await sleepFrame(16, true);
    }
  }

  function collectVisibleDialogs(): Set<Element> {
    const out = new Set<Element>();
    const { items } = scanLiveDom(false);
    for (const item of items) {
      if (item.fingerprint.role === 'dialog' || item.fingerprint.role === 'alertdialog') {
        out.add(item.target);
      }
    }
    return out;
  }

  function readCompileOverlay(): string | null {
    if (!document.documentElement) return null;
    const skip = new Set(['style', 'script', 'noscript', 'template', 'svg']);
    function overlayText(n: Node): string {
      if (n.nodeType === 3) return n.nodeValue?.trim() ?? '';
      if (
        n instanceof Element &&
        (n.hasAttribute(DRIVER_UI_ATTR) ||
          n.hasAttribute('hidden') ||
          n.getAttribute('aria-hidden') === 'true' ||
          skip.has(tag(n)))
      ) {
        return '';
      }
      const joined = getComposedChildren(n).map(overlayText).filter(Boolean).join('\n');
      return joined
        ? joined
            .replace(/[ \t]+/g, ' ')
            .trim()
            .slice(0, 2_000)
        : '';
    }
    function scan(n: Node): string | null {
      if (n instanceof Element) {
        if (n.hasAttribute(DRIVER_UI_ATTR) || n.hasAttribute('hidden')) return null;
        const t = tag(n);
        if (
          t === 'vite-error-overlay' ||
          t === 'nextjs-portal' ||
          n.hasAttribute('data-nextjs-dialog')
        ) {
          const txt = overlayText(n);
          if (txt) return txt;
        }
      }
      for (const c of getComposedChildren(n)) {
        const hit = scan(c);
        if (hit) return hit;
      }
      return null;
    }
    return scan(document.documentElement);
  }

  function isCrossDocUrl(rawHref: string): boolean {
    if (!rawHref) return false;
    try {
      const next = new URL(rawHref, window.location.href);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') return false;
      const loc = window.location;
      const sameHashOnly =
        next.origin === loc.origin &&
        next.pathname === loc.pathname &&
        next.search === loc.search &&
        next.hash !== '';
      return !sameHashOnly;
    } catch {
      return false;
    }
  }

  function armNavigationTracker(state: BridgeState): void {
    state.detachNavTrackers?.();
    state.pendingUnload = false;

    const onClick = (ev: MouseEvent): void => {
      if (ev.defaultPrevented || ev.button !== 0) return;
      const targetNode = ev.composedPath()[0];
      const startEl = targetNode instanceof Element ? targetNode : null;
      const anchor = findComposedAncestor(
        startEl,
        (c) => c instanceof HTMLAnchorElement && c.hasAttribute('href'),
        true,
      );
      if (!anchor || anchor.hasAttribute('download')) return;
      const tgt = (anchor.getAttribute('target') ?? '').trim().toLowerCase();
      if (tgt && tgt !== '_self') return;
      if (isCrossDocUrl(anchor.getAttribute('href') ?? '')) {
        state.pendingUnload = true;
      }
    };

    const onSubmit = (ev: SubmitEvent): void => {
      if (!ev.defaultPrevented) {
        state.pendingUnload = true;
      }
    };

    window.addEventListener('click', onClick, false);
    window.addEventListener('submit', onSubmit, false);
    state.detachNavTrackers = (): void => {
      window.removeEventListener('click', onClick, false);
      window.removeEventListener('submit', onSubmit, false);
      state.detachNavTrackers = null;
    };
  }

  function setReactSafeValue(el: Element, value: string): boolean {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      return false;
    }
    const proto =
      el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    const prev: unknown = desc?.get ? desc.get.call(el) : el.value;
    const vt: unknown = Reflect.get(el, '_valueTracker');
    if (typeof vt === 'object' && vt !== null) {
      const setVal: unknown = Reflect.get(vt, 'setValue');
      if (typeof setVal === 'function') {
        try {
          setVal.call(vt, prev);
        } catch {
          // ignore
        }
      }
    }
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
    return true;
  }

  function getOrCreateState(): BridgeState {
    const existingRaw: unknown = Reflect.get(window, BRIDGE_KEY);
    if (typeof existingRaw === 'object' && existingRaw !== null && 'callRpc' in existingRaw) {
      return existingRaw as BridgeState; // Invariant: bridge state stored under private Symbol.for('@inbrowser/driver:cdp-bridge:v1')
    }

    const pending = new Map<number, (msg: unknown) => void>();

    const state: BridgeState = {
      sessionId: '',
      allowEval: false,
      nextId: 1,
      port: null,
      refs: new Map<string, StoredRef>(),
      lastTargetEl: null,
      dialogsBefore: new Set<Element>(),
      pendingUnload: false,
      detachNavTrackers: null,
      async ensurePort(
        sessionId: string,
        allowEval: boolean,
        minRev: number,
      ): Promise<MessagePort> {
        if (this.port !== null && this.sessionId === sessionId && this.allowEval === allowEval) {
          if (minRev > 0) {
            this.port.postMessage({
              channel: CHANNEL,
              kind: 'hello',
              protocolVersion: 1,
              allowEval,
              sessionId,
              minRev,
            });
          }
          return this.port;
        }

        const channel = new MessageChannel();
        const port = channel.port1;
        let ackResolve: (() => void) | null = null;
        const ackPromise = new Promise<void>((resolve) => {
          ackResolve = resolve;
        });

        port.addEventListener('message', (ev: MessageEvent<unknown>) => {
          const d = ev.data;
          if (typeof d !== 'object' || d === null) return;
          const rec = d as Record<string, unknown>; // Invariant: narrowed non-null object above
          if (rec['channel'] !== CHANNEL) return;
          if (rec['kind'] === 'hello_ack') {
            ackResolve?.();
            ackResolve = null;
            return;
          }
          if (rec['kind'] === 'rpc_response' && typeof rec['id'] === 'number') {
            const fn = pending.get(rec['id']);
            if (fn !== undefined) {
              pending.delete(rec['id']);
              fn(rec);
            }
          }
        });
        port.start();

        window.postMessage(
          {
            channel: CHANNEL,
            kind: 'hello',
            protocolVersion: 1,
            allowEval,
            sessionId,
            minRev,
          },
          '*',
          [channel.port2],
        );

        await ackPromise;
        this.port = port;
        this.sessionId = sessionId;
        this.allowEval = allowEval;
        return port;
      },
      async callRpc(
        sessionId: string,
        allowEval: boolean,
        minRev: number,
        method: string,
        params: unknown,
      ): Promise<unknown> {
        const port = await this.ensurePort(sessionId, allowEval, minRev);
        const id = this.nextId;
        this.nextId += 1;
        const response = await new Promise<unknown>((resolve) => {
          pending.set(id, resolve);
          port.postMessage({
            channel: CHANNEL,
            kind: 'rpc_request',
            protocolVersion: 1,
            id,
            method,
            ...(params !== undefined ? { params } : {}),
          });
        });
        if (
          method === 'observe' &&
          typeof response === 'object' &&
          response !== null &&
          (response as Record<string, unknown>)['ok'] === true // Invariant: narrowed non-null object above
        ) {
          this.indexSnapshot((response as Record<string, unknown>)['result']); // Invariant: narrowed non-null object above
        }
        return response;
      },
      indexSnapshot(snap: unknown): void {
        if (typeof snap !== 'object' || snap === null) return;
        const elementsRaw = (snap as Record<string, unknown>)['elements']; // Invariant: narrowed non-null object above
        if (!Array.isArray(elementsRaw)) return;

        const { items, cohortCounts } = scanLiveDom(false);
        const byTuple = new Map<string, Candidate>();
        for (const item of items) {
          const fp = item.fingerprint;
          byTuple.set(
            `${fp.role}\0${fp.name}\0${fp.landmark ?? ''}\0${fp.driverId ?? ''}\0${String(fp.nth)}`,
            item,
          );
        }

        const localCounts = new Map<string, number>();
        const walkSnap = (nodes: readonly unknown[], enclosingLm: string | undefined): void => {
          for (const rawNode of nodes) {
            if (typeof rawNode !== 'object' || rawNode === null) continue;
            const n = rawNode as Record<string, unknown>; // Invariant: narrowed non-null object above
            const role = typeof n['role'] === 'string' ? n['role'] : '';
            const name = typeof n['name'] === 'string' ? n['name'] : '';
            const drv = typeof n['driverId'] === 'string' ? n['driverId'] : '';
            const ref = typeof n['ref'] === 'string' ? n['ref'] : undefined;
            if (ref !== undefined && role) {
              const cKey = `${role}\0${name}\0${enclosingLm ?? ''}\0${drv}`;
              const nth = localCounts.get(cKey) ?? 0;
              localCounts.set(cKey, nth + 1);
              const exactCand =
                byTuple.get(`${cKey}\0${String(nth)}`) ??
                items.find(
                  (it) =>
                    it.fingerprint.role === role &&
                    it.fingerprint.name === name &&
                    (it.fingerprint.driverId ?? '') === drv &&
                    it.fingerprint.nth === nth,
                );
              if (exactCand !== undefined) {
                const fp = exactCand.fingerprint;
                const cohortKey = `${fp.role}\0${fp.name}\0${fp.landmark ?? ''}\0${fp.driverId ?? ''}`;
                this.refs.set(ref, {
                  weakEl: new WeakRef(exactCand.target),
                  fingerprint: fp,
                  cohortSize: cohortCounts.get(cohortKey) ?? 1,
                });
              }
            }
            const nextLm = LANDMARK_ROLES.has(role) ? formatLm(role, name) : enclosingLm;
            if (Array.isArray(n['children'])) {
              walkSnap(n['children'], nextLm);
            }
          }
        };

        walkSnap(elementsRaw, undefined);
      },
    };

    window.addEventListener('pagehide', () => {
      if (state.port !== null) {
        state.port.close();
        state.port = null;
      }
    });

    Reflect.defineProperty(window, BRIDGE_KEY, {
      value: state,
      configurable: true,
      enumerable: false,
      writable: true,
    });
    return state;
  }

  const state = getOrCreateState();

  try {
    switch (cmd.op) {
      case 'rpc': {
        return await state.callRpc(
          cmd.sessionId,
          cmd.allowEval,
          cmd.minRev,
          cmd.method,
          cmd.params,
        );
      }

      case 'recordDialogsBefore': {
        state.dialogsBefore = collectVisibleDialogs();
        return { ok: true, result: null };
      }

      case 'prepareActionTarget': {
        if (cmd.recordDialogsBefore) state.dialogsBefore = collectVisibleDialogs();
        const found = await waitForActionable(
          cmd.target,
          cmd.timeoutMs,
          state,
          cmd.allowZeroSizeAudio,
        );
        state.lastTargetEl = found.el;
        if (cmd.armNavTracker) armNavigationTracker(state);
        const { el: _el, hitEl: _hit, ...clean } = found;
        void _el;
        void _hit;
        return { ok: true, result: clean };
      }

      case 'prepareFill': {
        if (cmd.recordDialogsBefore) state.dialogsBefore = collectVisibleDialogs();
        const found = await waitForActionable(cmd.target, cmd.timeoutMs, state, false);
        const el = found.el;
        const ce = el.getAttribute('contenteditable');
        const isCe =
          ce === '' ||
          ce?.toLowerCase() === 'true' ||
          (el instanceof HTMLElement && el.isContentEditable);
        const nonTextInput =
          el instanceof HTMLInputElement &&
          new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'file', 'image']).has(
            el.type.toLowerCase(),
          );
        const isTextCtrl =
          (el instanceof HTMLInputElement && !nonTextInput) || el instanceof HTMLTextAreaElement;

        if (!isTextCtrl && !isCe) {
          throw new CodedBridgeError('DRIVER_PROTOCOL', `Target <${tag(el)}> is not fillable.`);
        }

        state.lastTargetEl = el;
        if (el instanceof HTMLElement) el.focus({ preventScroll: true });

        let hadContent = false;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          hadContent = el.value.length > 0;
          try {
            el.select();
          } catch {
            // Types like number/email do not support selection ranges; finalizeFill syncs exact value.
          }
          if (hadContent && el.selectionStart === null) {
            setReactSafeValue(el, '');
            hadContent = false;
          }
        } else if (isCe) {
          hadContent = (el.textContent ?? '').length > 0;
          const sel = window.getSelection();
          if (sel) {
            sel.selectAllChildren(el);
          }
        }

        const result: FillPreparation = { cx: found.cx, cy: found.cy, hadContent };
        return { ok: true, result };
      }

      case 'finalizeFill': {
        const el = state.lastTargetEl;
        if (el && el.isConnected) {
          const ce = el.getAttribute('contenteditable');
          const isCe =
            ce === '' ||
            ce?.toLowerCase() === 'true' ||
            (el instanceof HTMLElement && el.isContentEditable);
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            if (el.value !== cmd.value) {
              setReactSafeValue(el, cmd.value);
              el.dispatchEvent(
                new InputEvent('input', {
                  bubbles: true,
                  composed: true,
                  data: cmd.value,
                  inputType: 'insertText',
                }),
              );
            }
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (isCe && (el.textContent ?? '') !== cmd.value) {
            el.textContent = cmd.value;
            el.dispatchEvent(
              new InputEvent('input', {
                bubbles: true,
                composed: true,
                data: cmd.value,
                inputType: 'insertText',
              }),
            );
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          if (cmd.submit) {
            armNavigationTracker(state);
          }
        }
        return { ok: true, result: null };
      }

      case 'executeSetValue': {
        if (cmd.recordDialogsBefore) state.dialogsBefore = collectVisibleDialogs();
        const found = await waitForActionable(cmd.target, cmd.timeoutMs, state, true);
        const el = found.el;
        if (el instanceof HTMLMediaElement) {
          const nextTime = Number(cmd.value);
          if (!Number.isFinite(nextTime) || nextTime < 0) {
            throw new CodedBridgeError(
              'DRIVER_PROTOCOL',
              `Invalid media currentTime '${String(cmd.value)}'.`,
            );
          }
          el.currentTime = nextTime;
          el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          el.dispatchEvent(new Event('timeupdate'));
          el.dispatchEvent(new Event('seeked'));
          return { ok: true, result: null };
        }
        const strVal = String(cmd.value);
        if (el instanceof HTMLElement) el.focus({ preventScroll: true });
        if (!setReactSafeValue(el, strVal)) {
          el.setAttribute('aria-valuenow', strVal);
        }
        el.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            composed: true,
            data: strVal,
            inputType: 'insertReplacementText',
          }),
        );
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, result: null };
      }

      case 'prepareSelect': {
        if (cmd.recordDialogsBefore) state.dialogsBefore = collectVisibleDialogs();
        if (cmd.phase === 'initial') {
          const found = await waitForActionable(cmd.target, cmd.timeoutMs, state, false);
          const el = found.el;
          state.lastTargetEl = el;
          if (el instanceof HTMLSelectElement) {
            el.focus({ preventScroll: true });
            const opts = Array.from(el.options);
            const matched = cmd.values.map((val) => {
              const trimmed = normSpace(val);
              const opt = opts.find(
                (o) => o.value === val || normSpace(o.label || o.text) === trimmed,
              );
              if (!opt) {
                throw new CodedBridgeError('DRIVER_TARGET_NOT_FOUND', `Option "${val}" not found.`);
              }
              if (opt.disabled) {
                throw new CodedBridgeError('DRIVER_PROTOCOL', `Option "${val}" is disabled.`);
              }
              return opt;
            });
            if (el.multiple) {
              const set = new Set(matched);
              for (const o of opts) o.selected = set.has(o);
            } else if (matched[0]) {
              el.value = matched[0].value;
              matched[0].selected = true;
            }
            el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            const res: SelectResolution = {
              kind: 'native',
              needsOpenClick: false,
              comboCx: found.cx,
              comboCy: found.cy,
              optionPoints: [],
            };
            return { ok: true, result: res };
          }

          if (found.isCustomCombobox && !found.ariaExpanded) {
            const res: SelectResolution = {
              kind: 'custom',
              needsOpenClick: true,
              comboCx: found.cx,
              comboCy: found.cy,
              optionPoints: [],
            };
            return { ok: true, result: res };
          }
        }

        await sleepFrame(16, true);
        const { items } = scanLiveDom(true);
        const points: { cx: number; cy: number }[] = [];
        for (const val of cmd.values) {
          const trimmed = normSpace(val);
          const match = items.find(
            (c) =>
              c.fingerprint.role === 'option' &&
              (c.fingerprint.name === trimmed ||
                c.text === trimmed ||
                c.target.getAttribute('data-value') === val ||
                c.target.getAttribute('value') === val),
          );
          if (!match) {
            throw new CodedBridgeError('DRIVER_TARGET_NOT_FOUND', `Option "${val}" not found.`);
          }
          if (isElementDisabled(match.target)) {
            throw new CodedBridgeError('DRIVER_PROTOCOL', `Option "${val}" is disabled.`);
          }
          match.target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          const r = match.target.getBoundingClientRect();
          points.push({ cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
        }
        const res: SelectResolution = {
          kind: 'custom',
          needsOpenClick: false,
          comboCx: 0,
          comboCy: 0,
          optionPoints: points,
        };
        return { ok: true, result: res };
      }

      case 'preparePress': {
        if (cmd.recordDialogsBefore) state.dialogsBefore = collectVisibleDialogs();
        if (cmd.target !== undefined) {
          const found = await waitForActionable(cmd.target, cmd.timeoutMs, state, false);
          if (found.el instanceof HTMLElement) found.el.focus({ preventScroll: true });
          state.lastTargetEl = found.el;
        }
        armNavigationTracker(state);
        return { ok: true, result: null };
      }

      case 'executeWaitFor': {
        if (cmd.recordDialogsBefore) state.dialogsBefore = collectVisibleDialogs();
        const deadline = performance.now() + cmd.timeoutMs;
        const desired = cmd.state ?? 'visible';
        const needle = cmd.text !== undefined ? normSpace(cmd.text).toLowerCase() : undefined;
        let lastActivity = performance.now();
        let observer: MutationObserver | null = null;

        if (cmd.idleMs !== undefined && document.documentElement) {
          observer = new MutationObserver((records) => {
            const onlyDriver = records.every((m) => {
              const el =
                m.target instanceof Element
                  ? m.target
                  : m.target instanceof ShadowRoot
                    ? m.target.host
                    : m.target.parentElement;
              return findComposedAncestor(el, (c) => c.hasAttribute(DRIVER_UI_ATTR), true) !== null;
            });
            if (!onlyDriver) lastActivity = performance.now();
          });
          observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          });
        }

        const checkTarget = (spec: TargetSpec): boolean => {
          let el: Element;
          try {
            el = resolveTarget(spec, state);
          } catch (err) {
            return (
              (desired === 'detached' || desired === 'hidden') &&
              err instanceof CodedBridgeError &&
              err.code === 'DRIVER_TARGET_NOT_FOUND'
            );
          }
          if (desired === 'detached') return false;
          if (desired === 'attached') return el.isConnected;
          const r = el.getBoundingClientRect();
          const vis =
            el.isConnected &&
            !isElementHidden(el) &&
            (tag(el) === 'audio' || (r.width > 0 && r.height > 0));
          return desired === 'visible' ? vis : !vis;
        };

        try {
          while (true) {
            const targetOk = cmd.target === undefined || checkTarget(cmd.target);
            const present =
              needle === undefined ||
              !needle ||
              scanLiveDom(true).items.some(
                (c) =>
                  c.text.toLowerCase().includes(needle) ||
                  c.fingerprint.name.toLowerCase().includes(needle),
              );
            const textOk =
              needle === undefined ||
              (desired === 'hidden' || desired === 'detached' ? !present : present);
            const idleOk =
              cmd.idleMs === undefined || performance.now() - lastActivity >= cmd.idleMs;

            if (targetOk && textOk && idleOk) {
              return { ok: true, result: null };
            }
            if (performance.now() >= deadline) {
              break;
            }
            await sleepFrame(Math.min(20, Math.max(4, deadline - performance.now())), false);
          }
        } finally {
          observer?.disconnect();
        }
        throw new CodedBridgeError('DRIVER_TIMEOUT', 'waitFor condition timed out.');
      }

      case 'settleAndInspect': {
        state.detachNavTrackers?.();
        const pendingUnload = state.pendingUnload;
        state.pendingUnload = false;
        if (!pendingUnload) {
          await sleepFrame(0, false);
          await sleepFrame(16, true);
        }
        const currentDialogs = collectVisibleDialogs();
        let newDomDialogOpened = false;
        for (const d of currentDialogs) {
          if (!state.dialogsBefore.has(d)) {
            newDomDialogOpened = true;
            break;
          }
        }
        const res: PostStepInspection = {
          pendingUnload,
          compileOverlay: readCompileOverlay(),
          newDomDialogOpened,
        };
        return { ok: true, result: res };
      }

      case 'resolveScreenshotClip': {
        const vw = Math.max(1, Math.round(window.innerWidth || 800));
        const vh = Math.max(1, Math.round(window.innerHeight || 600));
        if (cmd.target === undefined) {
          return { ok: true, result: { viewportWidth: vw, viewportHeight: vh, clip: null } };
        }
        const el = resolveTarget(cmd.target, state);
        let rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          throw new CodedBridgeError('DRIVER_PROTOCOL', 'Capture target has zero area.');
        }
        if (
          rect.bottom <= 0 ||
          rect.top >= window.innerHeight ||
          rect.right <= 0 ||
          rect.left >= window.innerWidth
        ) {
          el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          rect = el.getBoundingClientRect();
        }
        const pageLeft = window.visualViewport?.pageLeft ?? window.scrollX;
        const pageTop = window.visualViewport?.pageTop ?? window.scrollY;
        return {
          ok: true,
          result: {
            viewportWidth: vw,
            viewportHeight: vh,
            clip: {
              x: Math.max(0, rect.left + pageLeft),
              y: Math.max(0, rect.top + pageTop),
              width: rect.width,
              height: rect.height,
            },
          },
        };
      }
    }
  } catch (err) {
    if (err instanceof CodedBridgeError) {
      return {
        ok: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.candidates !== undefined ? { candidates: err.candidates } : {}),
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'DRIVER_PROTOCOL',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

async function ensurePreloadInCurrentPage(page: Page, preloadSource: string): Promise<void> {
  const alreadyInstalled = await page.evaluate(() => {
    return Reflect.has(window, Symbol.for('@inbrowser/driver:preload-installed:v1'));
  });
  if (!alreadyInstalled) {
    await page.evaluate(preloadSource);
  }
}

async function runBridgeCommand<T>(
  page: Page,
  preloadSource: string,
  cmd: BridgeCommand,
): Promise<T> {
  await ensurePreloadInCurrentPage(page, preloadSource);
  const raw = await page.evaluate(executeInPageBridgeCommand, cmd);
  return unwrapBridgeEnvelope<T>(raw);
}

const MODIFIER_MAP: Record<string, KeyInput> = {
  control: 'Control',
  ctrl: 'Control',
  shift: 'Shift',
  alt: 'Alt',
  option: 'Alt',
  meta: 'Meta',
  command: 'Meta',
  cmd: 'Meta',
};

const SPECIAL_KEY_MAP: Record<string, KeyInput> = {
  space: 'Space',
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
};

function parseKeyChord(rawKey: string): {
  readonly modifiers: readonly KeyInput[];
  readonly mainKey: KeyInput;
} {
  if (rawKey === ' ') {
    return { modifiers: [], mainKey: 'Space' };
  }
  const parts = rawKey === '+' ? ['+'] : rawKey.split('+').filter(Boolean);
  const modifiers: KeyInput[] = [];
  for (let i = 0; i < parts.length - 1; i += 1) {
    const mod = MODIFIER_MAP[(parts[i] ?? '').trim().toLowerCase()];
    if (mod !== undefined) {
      modifiers.push(mod);
    }
  }
  const last = (parts[parts.length - 1] ?? rawKey).trim();
  const special = SPECIAL_KEY_MAP[last.toLowerCase()];
  if (special !== undefined) {
    return { modifiers, mainKey: special };
  }
  if (last.length === 1 && /^[a-z]$/i.test(last)) {
    const hasShift = modifiers.includes('Shift');
    const charKey = (hasShift ? last.toUpperCase() : last.toLowerCase()) as KeyInput; // Invariant: single ASCII letter is a valid Puppeteer KeyInput literal
    return { modifiers, mainKey: charKey };
  }
  return {
    modifiers,
    mainKey: last as KeyInput, // Invariant: caller-provided DOM key name forwarded to CDP Input.dispatchKeyEvent
  };
}

function mergeDiagnosticsWithHost(
  base: DiagnosticsDelta,
  extraConsoleErrors: readonly string[],
): DiagnosticsDelta {
  if (extraConsoleErrors.length === 0) return base;
  const merged = [...base.consoleErrors];
  for (const msg of extraConsoleErrors) {
    if (!merged.includes(msg)) {
      merged.push(msg);
    }
  }
  return {
    compileOverlay: base.compileOverlay,
    consoleErrors: merged,
    pageErrors: base.pageErrors,
    networkFailures: base.networkFailures,
  };
}

function stripObserveOptions(options?: ObservationOptions): ObserveRpcParams | undefined {
  if (options === undefined) return undefined;
  return {
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    ...(options.includeAllText !== undefined ? { includeAllText: options.includeAllText } : {}),
  };
}

export async function connectPuppeteerDriver(options: PuppeteerDriverOptions): Promise<PageDriver> {
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (options.signal?.aborted) {
    throw new DriverError('DRIVER_TIMEOUT', 'Puppeteer driver connection aborted by signal.', {
      cause: options.signal.reason,
    });
  }

  if (options.browserWSEndpoint === undefined && options.transport === undefined) {
    throw new DriverError(
      'DRIVER_PROTOCOL',
      'connectPuppeteerDriver requires either browserWSEndpoint or transport.',
    );
  }

  const preloadSource = getPreloadSource();
  const connectOptions: ConnectOptions = {
    defaultViewport: null,
    ...(options.browserWSEndpoint !== undefined
      ? { browserWSEndpoint: options.browserWSEndpoint }
      : {}),
    ...(options.transport !== undefined ? { transport: options.transport } : {}),
    ...(options.timeoutMs !== undefined ? { protocolTimeout: options.timeoutMs } : {}),
  };

  let browserInstance: Browser | null = null;
  const browser = await raceWithAbortAndTimeout(
    async () => {
      const connected = await connect(connectOptions);
      browserInstance = connected;
      return connected;
    },
    defaultTimeoutMs,
    'connect',
    options.signal,
  ).catch(async (err: unknown) => {
    if (browserInstance !== null) {
      await (browserInstance as Browser).disconnect().catch(() => {}); // Invariant: assigned Browser instance before timeout/abort race settled
    }
    throw err;
  });

  let page: Page;
  try {
    const resolved = await raceWithAbortAndTimeout(
      () => resolveTargetPage(browser, options.targetUrl, preloadSource, defaultTimeoutMs),
      defaultTimeoutMs,
      'resolveTargetPage',
      options.signal,
    );
    page = resolved.page;
    if (!resolved.preloadRegisteredOnNewDoc) {
      await page.evaluateOnNewDocument(preloadSource);
    }
    await ensurePreloadInCurrentPage(page, preloadSource);
  } catch (err) {
    await browser.disconnect().catch(() => {});
    throw toDriverError(err, 'Failed to initialize target page.');
  }

  const allowEval = Boolean(options.allowEval);
  const sessionId = `cdp-${String(nextCdpSessionSeq)}-${Math.random().toString(36).slice(2, 10)}`;
  nextCdpSessionSeq += 1;
  let highestRev = 0;
  let lastFullSnapshot: ObservationSnapshot | null = null;
  let disposed = false;

  interface ActGuardState {
    dialogOpened: boolean;
    stepPageError: string | null;
    capturingOutgoingConsole: boolean;
    outgoingConsole: string[];
  }

  interface ActiveRecordingState {
    readonly session: CDPSession;
    readonly startedAtMs: number;
    readonly frames: string[];
    readonly detachListener: () => void;
    width: number;
    height: number;
  }

  let pendingHostConsoleErrors: string[] = [];
  let activeActGuard: ActGuardState | null = null;
  let activeRecording: ActiveRecordingState | null = null;

  const drainHostConsoleErrors = (): readonly string[] => {
    const drained = pendingHostConsoleErrors;
    pendingHostConsoleErrors = [];
    return drained;
  };

  const onDialog = (dialog: Dialog): void => {
    const kind = dialog.type();
    const text = dialog.message();
    const formatted = (text ? `[dialog:${kind}] ${text}` : `[dialog:${kind}]`).slice(0, 1_000);
    pendingHostConsoleErrors.push(formatted);
    if (activeActGuard !== null) {
      activeActGuard.dialogOpened = true;
    }
    void dialog.dismiss().catch(() => {});
  };

  const onPageError = (err: unknown): void => {
    if (activeActGuard !== null && activeActGuard.stepPageError === null) {
      activeActGuard.stepPageError =
        err instanceof Error ? (err.stack ?? err.message) : String(err);
    }
  };

  const onConsole = (msg: ConsoleMessage): void => {
    if (msg.type() === 'error' && activeActGuard?.capturingOutgoingConsole) {
      const text = msg.text().trim();
      if (text) activeActGuard.outgoingConsole.push(text);
    }
  };

  page.on('dialog', onDialog);
  page.on('pageerror', onPageError);
  page.on('console', onConsole);

  const trackRev = (rev: number): void => {
    if (rev > highestRev) highestRev = rev;
  };

  const capabilities: DriverCapabilities = {
    protocolVersion: PROTOCOL_VERSION,
    allowEval,
    captureModes: ['viewport-gpu'],
    trustedInput: true,
  };

  const assertActive = (): void => {
    if (disposed) {
      throw new DriverError('DRIVER_DISPOSED', 'Driver has been disposed.');
    }
  };

  const observeCore = async (observeOptions?: ObservationOptions): Promise<ObservationSnapshot> => {
    const params = stripObserveOptions(observeOptions);
    const raw = await runBridgeCommand<unknown>(page, preloadSource, {
      op: 'rpc',
      sessionId,
      allowEval,
      minRev: highestRev,
      method: 'observe',
      ...(params !== undefined ? { params } : {}),
    });
    if (!isObservationSnapshot(raw)) {
      throw new DriverError('DRIVER_PROTOCOL', 'Invalid observe snapshot payload from page.');
    }
    trackRev(raw.rev);
    const mergedDiag = mergeDiagnosticsWithHost(raw.diagnostics, drainHostConsoleErrors());
    const snap: ObservationSnapshot =
      mergedDiag === raw.diagnostics ? raw : { ...raw, diagnostics: mergedDiag };
    if (observeOptions?.scope === undefined && observeOptions?.includeAllText !== true) {
      lastFullSnapshot = snap;
    }
    return snap;
  };

  return {
    capabilities,
    async observe(observeOptions?: ObservationOptions): Promise<ObservationSnapshot> {
      assertActive();
      return raceWithAbortAndTimeout(
        () => observeCore(observeOptions),
        defaultTimeoutMs,
        'observe',
        observeOptions?.signal,
      );
    },
    async act(actOptions: ActOptions): Promise<ActResult> {
      assertActive();
      trackRev(actOptions.rev);
      const batchTimeoutMs = actOptions.timeoutMs ?? DEFAULT_ACT_TIMEOUT_MS;

      return raceWithAbortAndTimeout(
        async () => {
          let preBatchDiag: DiagnosticsDelta | null = null;
          let baseline = lastFullSnapshot;
          if (baseline === null) {
            baseline = await observeCore();
            preBatchDiag = baseline.diagnostics;
          }

          const deadlineMs = Date.now() + batchTimeoutMs;
          const remainingMs = (): number => Math.max(25, deadlineMs - Date.now());

          const totalSteps = actOptions.steps.length;
          let completedSteps = 0;
          let interruptedReason: ActInterruptionReason | undefined;
          let stepErrorMsg: string | undefined;

          const guardState: ActGuardState = {
            dialogOpened: false,
            stepPageError: null,
            capturingOutgoingConsole: true,
            outgoingConsole: [],
          };
          activeActGuard = guardState;

          const armNavigationWait = (): Promise<boolean> =>
            page
              .waitForNavigation({
                waitUntil: 'domcontentloaded',
                timeout: Math.max(500, remainingMs()),
              })
              .then(
                () => true,
                () => false,
              );

          const settleStepAndAwaitUnload = async (
            navPromise?: Promise<boolean>,
          ): Promise<PostStepInspection> => {
            try {
              const post = await runBridgeCommand<PostStepInspection>(page, preloadSource, {
                op: 'settleAndInspect',
                timeoutMs: remainingMs(),
              });
              if (post.pendingUnload && navPromise !== undefined) {
                await navPromise;
              }
              return post;
            } catch (err) {
              if (isExecutionContextDestroyed(err)) {
                if (navPromise !== undefined) {
                  await navPromise;
                }
                return { pendingUnload: true, compileOverlay: null, newDomDialogOpened: false };
              }
              throw err;
            }
          };

          try {
            for (let i = 0; i < totalSteps; i += 1) {
              const step: DriverStep | undefined = actOptions.steps[i];
              if (step === undefined) break;
              if (actOptions.signal?.aborted) {
                throw new DriverError(
                  'DRIVER_TIMEOUT',
                  "Driver 'act' operation aborted by signal.",
                );
              }

              guardState.dialogOpened = false;
              guardState.stepPageError = null;
              const urlBefore = originAndPathname(page.url());
              let postInspection: PostStepInspection | null = null;

              try {
                switch (step.kind) {
                  case 'click': {
                    const targetInfo = await runBridgeCommand<ResolvedActionTarget>(
                      page,
                      preloadSource,
                      {
                        op: 'prepareActionTarget',
                        target: step.target,
                        timeoutMs: remainingMs(),
                        allowZeroSizeAudio: false,
                        armNavTracker: true,
                        recordDialogsBefore: true,
                      },
                    );
                    const navPromise = armNavigationWait();
                    const btn: MouseButton = step.button ?? 'left';
                    const count = step.clickCount ?? 1;
                    await page.mouse.click(targetInfo.cx, targetInfo.cy, {
                      button: btn,
                      count,
                    });
                    postInspection = await settleStepAndAwaitUnload(navPromise);
                    break;
                  }

                  case 'fill': {
                    const prep = await runBridgeCommand<FillPreparation>(page, preloadSource, {
                      op: 'prepareFill',
                      target: step.target,
                      timeoutMs: remainingMs(),
                      recordDialogsBefore: true,
                    });
                    if (prep.hadContent) {
                      await page.keyboard.press('Backspace');
                    }
                    if (step.value.length > 0) {
                      if (step.value.length <= 120) {
                        await page.keyboard.type(step.value);
                      } else {
                        await page.keyboard.sendCharacter(step.value);
                      }
                    }
                    await runBridgeCommand<null>(page, preloadSource, {
                      op: 'finalizeFill',
                      value: step.value,
                      submit: step.submit === true,
                    });
                    if (step.submit === true) {
                      const navPromise = armNavigationWait();
                      await page.keyboard.press('Enter');
                      // Ensure multi-input forms without submit buttons also submit per HTML/driver contract
                      try {
                        await page.evaluate(() => {
                          const active = document.activeElement;
                          if (
                            active instanceof HTMLInputElement ||
                            active instanceof HTMLTextAreaElement
                          ) {
                            const BRIDGE_KEY = Symbol.for('@inbrowser/driver:cdp-bridge:v1');
                            const st: unknown = Reflect.get(window, BRIDGE_KEY);
                            const unloadArmed =
                              typeof st === 'object' &&
                              st !== null &&
                              Reflect.get(st, 'pendingUnload') === true;
                            if (active.form && !unloadArmed) {
                              active.form.requestSubmit();
                            }
                          }
                        });
                      } catch (subErr) {
                        if (!isExecutionContextDestroyed(subErr)) {
                          throw subErr;
                        }
                      }
                      postInspection = await settleStepAndAwaitUnload(navPromise);
                    }
                    break;
                  }

                  case 'setValue': {
                    await runBridgeCommand<null>(page, preloadSource, {
                      op: 'executeSetValue',
                      target: step.target,
                      value: step.value,
                      timeoutMs: remainingMs(),
                      recordDialogsBefore: true,
                    });
                    break;
                  }

                  case 'select': {
                    const wanted = typeof step.value === 'string' ? [step.value] : [...step.value];
                    let selRes = await runBridgeCommand<SelectResolution>(page, preloadSource, {
                      op: 'prepareSelect',
                      target: step.target,
                      values: wanted,
                      timeoutMs: remainingMs(),
                      phase: 'initial',
                      recordDialogsBefore: true,
                    });
                    if (selRes.kind === 'custom') {
                      if (selRes.needsOpenClick) {
                        await page.mouse.click(selRes.comboCx, selRes.comboCy);
                        selRes = await runBridgeCommand<SelectResolution>(page, preloadSource, {
                          op: 'prepareSelect',
                          target: step.target,
                          values: wanted,
                          timeoutMs: remainingMs(),
                          phase: 'options',
                          recordDialogsBefore: false,
                        });
                      }
                      for (const pt of selRes.optionPoints) {
                        await page.mouse.click(pt.cx, pt.cy);
                      }
                    }
                    break;
                  }

                  case 'press': {
                    await runBridgeCommand<null>(page, preloadSource, {
                      op: 'preparePress',
                      ...(step.target !== undefined ? { target: step.target } : {}),
                      timeoutMs: remainingMs(),
                      recordDialogsBefore: true,
                    });
                    const navPromise = armNavigationWait();
                    const chord = parseKeyChord(step.key);
                    for (const mod of chord.modifiers) {
                      await page.keyboard.down(mod);
                    }
                    try {
                      await page.keyboard.press(chord.mainKey);
                    } finally {
                      for (const mod of [...chord.modifiers].reverse()) {
                        await page.keyboard.up(mod);
                      }
                    }
                    postInspection = await settleStepAndAwaitUnload(navPromise);
                    break;
                  }

                  case 'drag': {
                    const fromInfo = await runBridgeCommand<ResolvedActionTarget>(
                      page,
                      preloadSource,
                      {
                        op: 'prepareActionTarget',
                        target: step.from,
                        timeoutMs: remainingMs(),
                        allowZeroSizeAudio: false,
                        armNavTracker: false,
                        recordDialogsBefore: true,
                      },
                    );
                    let toX: number;
                    let toY: number;
                    if ('target' in step.to) {
                      const toInfo = await runBridgeCommand<ResolvedActionTarget>(
                        page,
                        preloadSource,
                        {
                          op: 'prepareActionTarget',
                          target: step.to.target,
                          timeoutMs: remainingMs(),
                          allowZeroSizeAudio: false,
                          armNavTracker: false,
                          recordDialogsBefore: false,
                        },
                      );
                      toX = toInfo.cx;
                      toY = toInfo.cy;
                    } else if ('deltaX' in step.to) {
                      toX = fromInfo.cx + step.to.deltaX;
                      toY = fromInfo.cy + step.to.deltaY;
                    } else {
                      toX = step.to.clientX;
                      toY = step.to.clientY;
                    }

                    const count = Math.max(1, step.steps ?? 5);
                    await page.mouse.move(fromInfo.cx, fromInfo.cy);
                    await page.mouse.down();
                    try {
                      for (let s = 1; s <= count; s += 1) {
                        const nx = fromInfo.cx + ((toX - fromInfo.cx) * s) / count;
                        const ny = fromInfo.cy + ((toY - fromInfo.cy) * s) / count;
                        await page.mouse.move(nx, ny);
                      }
                    } finally {
                      await page.mouse.up();
                    }
                    break;
                  }

                  case 'navigate': {
                    const navTimeout = Math.max(500, remainingMs());
                    if ('url' in step) {
                      const resolvedUrl = new URL(step.url, page.url()).href;
                      await page.goto(resolvedUrl, {
                        waitUntil: 'domcontentloaded',
                        timeout: navTimeout,
                      });
                    } else if (step.action === 'reload') {
                      await page.reload({ waitUntil: 'domcontentloaded', timeout: navTimeout });
                    } else if (step.action === 'back') {
                      await page.goBack({ waitUntil: 'domcontentloaded', timeout: navTimeout });
                    } else {
                      await page.goForward({ waitUntil: 'domcontentloaded', timeout: navTimeout });
                    }
                    postInspection = {
                      pendingUnload: true,
                      compileOverlay: null,
                      newDomDialogOpened: false,
                    };
                    break;
                  }

                  case 'waitFor': {
                    const stepLimit =
                      step.timeoutMs !== undefined
                        ? actOptions.timeoutMs !== undefined
                          ? Math.min(remainingMs(), step.timeoutMs)
                          : step.timeoutMs
                        : remainingMs();
                    await runBridgeCommand<null>(page, preloadSource, {
                      op: 'executeWaitFor',
                      ...(step.target !== undefined ? { target: step.target } : {}),
                      ...(step.text !== undefined ? { text: step.text } : {}),
                      ...(step.state !== undefined ? { state: step.state } : {}),
                      ...(step.idleMs !== undefined ? { idleMs: step.idleMs } : {}),
                      timeoutMs: Math.max(10, stepLimit),
                      recordDialogsBefore: true,
                    });
                    break;
                  }
                }

                completedSteps = i + 1;
                if (postInspection === null) {
                  postInspection = await settleStepAndAwaitUnload();
                }
              } catch (err) {
                interruptedReason = 'step_error';
                stepErrorMsg = formatStepError(toDriverError(err, 'Step execution failed.'));
                break;
              }

              if (guardState.stepPageError !== null) {
                interruptedReason = 'step_error';
                stepErrorMsg = guardState.stepPageError;
                break;
              }

              if (postInspection.compileOverlay !== null) {
                interruptedReason = 'compile_error';
                break;
              }

              if (guardState.dialogOpened) {
                interruptedReason = 'dialog_opened';
                break;
              }

              if (i < totalSteps - 1) {
                if (postInspection.newDomDialogOpened) {
                  interruptedReason = 'dialog_opened';
                  break;
                }
                if (originAndPathname(page.url()) !== urlBefore) {
                  interruptedReason = 'navigation';
                  break;
                }
              }
            }
          } finally {
            activeActGuard = null;
          }

          if (guardState.outgoingConsole.length > 0) {
            pendingHostConsoleErrors.push(...guardState.outgoingConsole);
          }

          const after = await observeCore();
          let finalDiagnostics = after.diagnostics;
          if (preBatchDiag !== null) {
            finalDiagnostics = {
              compileOverlay: after.diagnostics.compileOverlay ?? preBatchDiag.compileOverlay,
              consoleErrors: [
                ...preBatchDiag.consoleErrors,
                ...after.diagnostics.consoleErrors.filter(
                  (m) => !preBatchDiag.consoleErrors.includes(m),
                ),
              ],
              pageErrors: [...preBatchDiag.pageErrors, ...after.diagnostics.pageErrors],
              networkFailures: [
                ...preBatchDiag.networkFailures,
                ...after.diagnostics.networkFailures,
              ],
            };
          }

          return {
            completedSteps,
            totalSteps,
            ...(interruptedReason !== undefined ? { interruptedReason } : {}),
            ...(stepErrorMsg !== undefined ? { error: stepErrorMsg } : {}),
            rev: after.rev,
            url: after.url,
            title: after.title,
            diff: diffSnapshots(baseline, after),
            diagnostics: finalDiagnostics,
          };
        },
        Math.max(defaultTimeoutMs, batchTimeoutMs + 3_000),
        'act',
        actOptions.signal,
      );
    },
    async capture(captureOptions: CaptureOptions): Promise<CaptureResult> {
      assertActive();
      return raceWithAbortAndTimeout(
        async () => {
          if (captureOptions.mode === 'screenshot') {
            const format = captureOptions.format ?? 'webp';
            const mimeType = format === 'png' ? 'image/png' : 'image/webp';
            const webpQuality = Math.max(
              0,
              Math.min(100, Math.round((captureOptions.quality ?? 0.85) * 100)),
            );
            const clipInfo = await runBridgeCommand<ScreenshotClipInfo>(page, preloadSource, {
              op: 'resolveScreenshotClip',
              ...(captureOptions.target !== undefined ? { target: captureOptions.target } : {}),
              timeoutMs: defaultTimeoutMs,
            });
            const rawBytes = await page.screenshot({
              type: format,
              ...(format === 'webp' ? { quality: webpQuality } : {}),
              ...(clipInfo.clip !== null ? { clip: clipInfo.clip } : {}),
            });
            const bytes = new Uint8Array(
              rawBytes.buffer,
              rawBytes.byteOffset,
              rawBytes.byteLength,
            ).slice();
            const dims = readImageDimensions(
              bytes,
              format,
              clipInfo.clip?.width ?? clipInfo.viewportWidth,
              clipInfo.clip?.height ?? clipInfo.viewportHeight,
            );
            return {
              mimeType,
              bytes,
              width: dims.width,
              height: dims.height,
              modeUsed: 'viewport-gpu',
            };
          }

          if (captureOptions.mode === 'start_recording') {
            if (activeRecording !== null) {
              throw new DriverError('DRIVER_PROTOCOL', 'A capture recording is already active.');
            }
            const clipInfo = await runBridgeCommand<ScreenshotClipInfo>(page, preloadSource, {
              op: 'resolveScreenshotClip',
              timeoutMs: defaultTimeoutMs,
            });
            const cdpSession = await page.createCDPSession();
            const frames: string[] = [];

            try {
              const initialFrame = await cdpSession.send('Page.captureScreenshot', {
                format: 'jpeg',
                quality: 80,
              });
              if (initialFrame.data.length > 0) {
                frames.push(initialFrame.data);
              }

              const recState: ActiveRecordingState = {
                session: cdpSession,
                startedAtMs: Date.now(),
                frames,
                width: clipInfo.viewportWidth,
                height: clipInfo.viewportHeight,
                detachListener: () => {},
              };

              const onFrame = (ev: {
                data: string;
                sessionId: number;
                metadata: { deviceWidth: number; deviceHeight: number };
              }): void => {
                if (frames.length < 180 && ev.data.length > 0) {
                  frames.push(ev.data);
                }
                if (ev.metadata.deviceWidth > 0 && ev.metadata.deviceHeight > 0) {
                  recState.width = ev.metadata.deviceWidth;
                  recState.height = ev.metadata.deviceHeight;
                }
                void cdpSession
                  .send('Page.screencastFrameAck', { sessionId: ev.sessionId })
                  .catch(() => {});
              };

              cdpSession.on('Page.screencastFrame', onFrame);
              const detach = (): void => {
                cdpSession.off('Page.screencastFrame', onFrame);
              };
              activeRecording = {
                ...recState,
                detachListener: detach,
              };

              await cdpSession.send('Page.startScreencast', {
                format: 'jpeg',
                quality: 80,
                everyNthFrame: 1,
              });

              return {
                mimeType: 'video/webm',
                bytes: new Uint8Array(0),
                width: clipInfo.viewportWidth,
                height: clipInfo.viewportHeight,
                modeUsed: 'viewport-gpu',
                durationMs: 0,
              };
            } catch (err) {
              activeRecording = null;
              await cdpSession.detach().catch(() => {});
              throw err;
            }
          }

          if (activeRecording === null) {
            throw new DriverError('DRIVER_PROTOCOL', 'No active capture recording to stop.');
          }

          const rec = activeRecording;
          activeRecording = null;
          rec.detachListener();
          await rec.session.send('Page.stopScreencast').catch(() => {});
          try {
            const finalShot = await rec.session.send('Page.captureScreenshot', {
              format: 'jpeg',
              quality: 80,
            });
            if (finalShot.data.length > 0) {
              rec.frames.push(finalShot.data);
            }
          } catch {
            // Ignore if target closed before final screenshot
          }
          await rec.session.detach().catch(() => {});

          const durationMs = Math.max(1, Date.now() - rec.startedAtMs);
          const encoded = await page.evaluate(encodeFramesToWebmInPage, {
            frames: rec.frames,
            fallbackWidth: rec.width,
            fallbackHeight: rec.height,
          });
          return {
            mimeType: encoded.mimeType,
            bytes: new Uint8Array(encoded.bytesArray),
            width: encoded.width,
            height: encoded.height,
            modeUsed: 'viewport-gpu',
            durationMs,
          };
        },
        defaultTimeoutMs,
        'capture',
        captureOptions.signal,
      );
    },
    async eval(evalOptions: EvalOptions): Promise<EvalResult> {
      assertActive();
      if (!allowEval) {
        throw new DriverError('DRIVER_EVAL_DISABLED', 'Evaluation disabled; pass allowEval: true.');
      }
      const timeoutMs = evalOptions.timeoutMs ?? defaultTimeoutMs;
      const params = {
        expression: evalOptions.expression,
        ...(evalOptions.timeoutMs !== undefined ? { timeoutMs: evalOptions.timeoutMs } : {}),
      };
      const raw = await raceWithAbortAndTimeout(
        () =>
          runBridgeCommand<unknown>(page, preloadSource, {
            op: 'rpc',
            sessionId,
            allowEval,
            minRev: highestRev,
            method: 'eval',
            params,
          }),
        Math.max(defaultTimeoutMs, timeoutMs + 2_000),
        'eval',
        evalOptions.signal,
      );
      if (!isEvalResult(raw)) {
        throw new DriverError('DRIVER_PROTOCOL', 'Invalid eval result payload from page.');
      }
      const mergedDiag = mergeDiagnosticsWithHost(raw.diagnostics, drainHostConsoleErrors());
      return mergedDiag === raw.diagnostics ? raw : { value: raw.value, diagnostics: mergedDiag };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (activeRecording !== null) {
        const rec = activeRecording;
        activeRecording = null;
        rec.detachListener();
        void rec.session.detach().catch(() => {});
      }
      page.off('dialog', onDialog);
      page.off('pageerror', onPageError);
      page.off('console', onConsole);
      void browser.disconnect().catch(() => {});
    },
  };
}
