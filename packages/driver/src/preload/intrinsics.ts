/**
 * Saved browser and JavaScript intrinsics captured synchronously before guest scripts execute.
 *
 * Reused across `entry.ts`, `diagnostics.ts`, `ref-registry.ts`, `observe.ts`, `diff.ts`, `act.ts`, and `eval.ts`.
 * Guards browser constructors via `globalThis` so preload modules remain importable in Node unit tests.
 */

export const reflectApply = Reflect.apply;
export const reflectGet = Reflect.get;
export const reflectSet = Reflect.set;
export const reflectHas = Reflect.has;
export const reflectDefineProperty = Reflect.defineProperty;
const getOwnDescriptor = Object.getOwnPropertyDescriptor;

export const HostWeakRef = WeakRef;
export const HostWeakMap = WeakMap;
export const HostWeakSet = WeakSet;
export const HostMap = Map;
export const HostSet = Set;

/* @__NO_SIDE_EFFECTS__ */
export function wordSet(words: string): Set<string> {
  return new HostSet(words.split(' '));
}

/* @__NO_SIDE_EFFECTS__ */
export function pairRecord(pairs: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of pairs.split(' ')) {
    const idx = entry.indexOf(':');
    if (idx > 0) out[entry.slice(0, idx)] = entry.slice(idx + 1);
  }
  return out;
}

type AnyCtor<T> = abstract new (...args: never[]) => T;
export function is<T>(value: unknown, ctor: AnyCtor<T> | undefined): value is T {
  return ctor !== undefined && value instanceof ctor;
}

type GlobalBag = Partial<typeof globalThis>;
const g = globalThis as GlobalBag; // Invariant: optional DOM constructors may be absent in Node unit tests

export const win = g.window;
export const doc = g.document;

export const HostMessageEvent = g.MessageEvent;
export const HostErrorEvent = g.ErrorEvent;
export const HostPromiseRejectionEvent = g.PromiseRejectionEvent;
export const HostMutationObserver = g.MutationObserver;
export const HostEvent = g.Event;
export const HostMouseEvent = g.MouseEvent;
export const HostPointerEvent = g.PointerEvent;
export const HostKeyboardEvent = g.KeyboardEvent;
export const HostInputEvent = g.InputEvent;

export const NodeCtor = g.Node;
export const El = g.Element;
export const HtmlEl = g.HTMLElement;
export const ShadowEl = g.ShadowRoot;
export const DocEl = g.Document;
export const SlotEl = g.HTMLSlotElement;
export const InputEl = g.HTMLInputElement;
export const TextAreaEl = g.HTMLTextAreaElement;
export const SelectEl = g.HTMLSelectElement;
export const OptionEl = g.HTMLOptionElement;
export const FormEl = g.HTMLFormElement;
export const LabelEl = g.HTMLLabelElement;
export const ButtonEl = g.HTMLButtonElement;
export const AnchorEl = g.HTMLAnchorElement;
export const DialogEl = g.HTMLDialogElement;
export const MediaEl = g.HTMLMediaElement;
export const VideoEl = g.HTMLVideoElement;
export const CanvasEl = g.HTMLCanvasElement;
export const Ctx2dEl = g.CanvasRenderingContext2D;
export const HostImage = g.Image;
export const HostXMLSerializer = g.XMLSerializer;
export const UrlCtor = g.URL;
export const ReqCtor = g.Request;
export const XhrCtor = g.XMLHttpRequest;
export const FunctionCtor = Function;

/* @__NO_SIDE_EFFECTS__ */
function protoProp<T extends object, K extends keyof T>(
  ctor: AnyCtor<T> | undefined,
  prop: K,
): readonly [(self: T) => T[K], (self: T, value: T[K]) => void] {
  const d = ctor ? getOwnDescriptor(ctor.prototype, prop) : undefined;
  return [
    (s: T): T[K] => (d?.get ? reflectApply(d.get, s, []) : reflectGet(s, prop)),
    (s: T, v: T[K]): void => {
      if (d?.set) reflectApply(d.set, s, [v]);
      else reflectSet(s, prop, v);
    },
  ];
}

/* @__NO_SIDE_EFFECTS__ */
function protoMethod<T extends object, A extends unknown[], R>(
  ctor: AnyCtor<T> | undefined,
  key: keyof T,
): (self: T, ...args: A) => R {
  const proto = ctor?.prototype as T | undefined; // Invariant: constructor prototype matches instance T
  const fn = proto !== undefined ? (proto[key] as unknown as (...args: A) => R) : undefined; // Invariant: selected method property on prototype T
  return (self: T, ...args: A): R => reflectApply(fn!, self, args);
}

const winStyleRaw = win?.getComputedStyle;
const rawSetTimeout = win?.setTimeout ?? setTimeout;
const rawClearTimeout = win?.clearTimeout ?? clearTimeout;
const rawRaf = win?.requestAnimationFrame;
const rawPerf = g.performance;
const rawPerfNow = rawPerf?.now;
const isTrustedGetter = /* @__PURE__ */ (() =>
  HostEvent ? getOwnDescriptor(new HostEvent('x'), 'isTrusted')?.get : undefined)();

export const origSetTimeout = (fn: () => void, ms: number): ReturnType<typeof setTimeout> =>
  reflectApply(rawSetTimeout, win, [fn, ms]);
export const origClearTimeout = (id: ReturnType<typeof setTimeout>): void => {
  reflectApply(rawClearTimeout, win, [id]);
};
export const origRequestAnimationFrame = (cb: FrameRequestCallback): number | null =>
  rawRaf && win ? reflectApply(rawRaf, win, [cb]) : null;
export const nowMs = (): number =>
  rawPerf && rawPerfNow ? reflectApply(rawPerfNow, rawPerf, []) : Date.now();
export const isTrustedEvent = (ev: Event): boolean =>
  isTrustedGetter ? Boolean(reflectApply(isTrustedGetter, ev, [])) : ev.isTrusted === true;

export const onEvent = /* @__PURE__ */ protoMethod<
  EventTarget,
  [string, EventListenerOrEventListenerObject, (boolean | AddEventListenerOptions)?],
  void
>(g.EventTarget, 'addEventListener');
export const offEvent = /* @__PURE__ */ protoMethod<
  EventTarget,
  [string, EventListenerOrEventListenerObject, (boolean | EventListenerOptions)?],
  void
>(g.EventTarget, 'removeEventListener');
export const targetDispatchEvent = /* @__PURE__ */ protoMethod<EventTarget, [Event], boolean>(
  g.EventTarget,
  'dispatchEvent',
);

export const getComputedStyleSafe = (el: Element): CSSStyleDeclaration | null =>
  winStyleRaw ? reflectApply(winStyleRaw, window, [el]) : null;

export const portPostMessage = /* @__PURE__ */ protoMethod<MessagePort, [unknown], void>(
  g.MessagePort,
  'postMessage',
);
export const portStart = /* @__PURE__ */ protoMethod<MessagePort, [], void>(g.MessagePort, 'start');
export const portClose = /* @__PURE__ */ protoMethod<MessagePort, [], void>(g.MessagePort, 'close');

const elProto = El?.prototype;
const elScrollIntoView = elProto?.scrollIntoView;
const elAttachShadow = elProto?.attachShadow;
const htmlFocus = HtmlEl?.prototype.focus;
const formReqSubmit = FormEl?.prototype.requestSubmit;
const formSubmit = FormEl?.prototype.submit;

export const getBoundingClientRect = /* @__PURE__ */ protoMethod<Element, [], DOMRect>(
  El,
  'getBoundingClientRect',
);
export const getOpenShadowRoot = /* @__PURE__ */ protoProp(El, 'shadowRoot')[0];
export const attachOpenShadow = (el: Element): ShadowRoot | null => {
  try {
    return elAttachShadow ? reflectApply(elAttachShadow, el, [{ mode: 'open' }]) : null;
  } catch {
    return getOpenShadowRoot(el);
  }
};
const elFromPt = [DocEl, ShadowEl].map((c) => c?.prototype.elementFromPoint);
export const elementFromPointSafe = (
  root: Document | ShadowRoot,
  x: number,
  y: number,
): Element | null => {
  const fn = elFromPt[is(root, DocEl) ? 0 : 1];
  return fn ? reflectApply(fn, root, [x, y]) : null;
};
export const scrollIntoViewSafe = (el: Element): void => {
  if (elScrollIntoView) {
    reflectApply(elScrollIntoView, el, [{ block: 'nearest', inline: 'nearest' }]);
  }
};
export const focusElement = (el: HTMLElement): void => {
  if (htmlFocus) reflectApply(htmlFocus, el, [{ preventScroll: true }]);
};
export const clickElement = /* @__PURE__ */ protoMethod<HTMLElement, [], void>(HtmlEl, 'click');
export const submitFormSafe = (form: HTMLFormElement): void => {
  const fn = formReqSubmit ?? formSubmit;
  if (fn) reflectApply(fn, form, []);
};
export const setAttr = /* @__PURE__ */ protoMethod<Element, [string, string], void>(
  El,
  'setAttribute',
);
export const cloneNode = /* @__PURE__ */ protoMethod<Node, [boolean?], Node>(NodeCtor, 'cloneNode');
const qSels = [El, DocEl, ShadowEl].map((c) => c?.prototype.querySelector);
export const querySelectorSafe = (root: ParentNode, selector: string): Element | null => {
  const fn = qSels[is(root, El) ? 0 : is(root, DocEl) ? 1 : is(root, ShadowEl) ? 2 : 3];
  return fn ? reflectApply(fn, root, [selector]) : null;
};

const [getInputValue, setInputValue] = /* @__PURE__ */ protoProp(InputEl, 'value');
const [getTextAreaValue, setTextAreaValue] = /* @__PURE__ */ protoProp(TextAreaEl, 'value');
const [getSelectValue, setSelectValue] = /* @__PURE__ */ protoProp(SelectEl, 'value');
export { getInputValue, setInputValue, setSelectValue, setTextAreaValue };
export const setOptionSelected = /* @__PURE__ */ protoProp(OptionEl, 'selected')[1];
export const formControlValue = (el: Element): string | null =>
  is(el, InputEl)
    ? getInputValue(el)
    : is(el, TextAreaEl)
      ? getTextAreaValue(el)
      : is(el, SelectEl)
        ? getSelectValue(el)
        : null;
export const setMediaCurrentTime = /* @__PURE__ */ protoProp(MediaEl, 'currentTime')[1];
export const origCanvasGetContext = CanvasEl?.prototype.getContext;
export const origCanvasTransferOffscreen = CanvasEl?.prototype.transferControlToOffscreen;

export const origConsoleError = g.console?.error;
export const origFetch = win?.fetch;
export const origXhrOpen = XhrCtor?.prototype.open;
export const origXhrSend = XhrCtor?.prototype.send;
export const origAlert = win?.alert;
export const origConfirm = win?.confirm;
export const origPrompt = win?.prompt;

export const DRIVER_UI_ATTRIBUTE = 'data-inbrowser-driver-ui';

export const normSpace = (value: string): string => value.replace(/\s+/g, ' ').trim();
export const tag = (el: Element): string => el.tagName.toLowerCase();
export const rawAttr = /* @__PURE__ */ protoMethod<Element, [string], string | null>(
  El,
  'getAttribute',
);
export const attr = (el: Element, name: string): string => normSpace(rawAttr(el, name) ?? '');
export const has = /* @__PURE__ */ protoMethod<Element, [string], boolean>(El, 'hasAttribute');

export function getComposedChildNodes(node: Node): readonly Node[] {
  if (is(node, El)) {
    if (is(node, SlotEl)) {
      const assigned = node.assignedNodes({ flatten: false });
      if (assigned.length) return assigned;
    }
    const shadow = getOpenShadowRoot(node);
    if (shadow) return [...shadow.childNodes];
    if (is(node, SelectEl)) return [...node.childNodes].slice(0, 50);
  }
  return [...node.childNodes];
}
