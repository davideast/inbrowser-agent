import type { ObserveRpcParams } from '../protocol.js';
import {
  DriverError,
  type ObservationSnapshot,
  type RefId,
  type SemanticFingerprint,
  type SnapshotCanvasState,
  type SnapshotMediaState,
  type SnapshotNode,
} from '../types.js';
import { drainDiagnostics } from './diagnostics.js';
import {
  CanvasEl,
  Ctx2dEl,
  DRIVER_UI_ATTRIBUTE,
  DocEl,
  El,
  HostMap,
  HostSet,
  HostWeakSet,
  HtmlEl,
  InputEl,
  MediaEl,
  OptionEl,
  SelectEl,
  ShadowEl,
  TextAreaEl,
  VideoEl,
  attr,
  doc,
  formControlValue,
  getBoundingClientRect,
  getComposedChildNodes,
  getComputedStyleSafe,
  getInputValue,
  getOpenShadowRoot,
  has,
  is,
  normSpace,
  origCanvasGetContext,
  origCanvasTransferOffscreen,
  pairRecord,
  querySelectorSafe,
  rawAttr,
  reflectApply,
  tag,
  win,
  wordSet,
} from './intrinsics.js';
import {
  type SemanticCandidateItem,
  assignRef,
  currentRevision,
  failMiss,
  failNotFound,
  isRefId,
  nextRevision,
  resolveTarget,
} from './ref-registry.js';

export { DRIVER_UI_ATTRIBUTE, getComposedChildNodes, normSpace as normalizeWhitespace };

const IGNORED_TAGS = /* @__PURE__ */ wordSet(
  'script style noscript template head meta link base title param track source wbr br',
);
const SECTION_TAGS = /* @__PURE__ */ wordSet('article aside main nav section');

export const LANDMARK_ROLES: ReadonlySet<string> = /* @__PURE__ */ wordSet(
  'main navigation banner contentinfo region form toolbar dialog complementary',
);

const TOGGLE_ROLES = /* @__PURE__ */ wordSet(
  'checkbox switch radio menuitemcheckbox menuitemradio',
);
const VALUE_ROLES = /* @__PURE__ */ wordSet('textbox searchbox combobox listbox slider spinbutton');
const LEAF_ROLES = /* @__PURE__ */ wordSet('video audio canvas textbox option');

export const INTERACTIVE_ROLES: ReadonlySet<string> = /* @__PURE__ */ new HostSet([
  ...TOGGLE_ROLES,
  ...VALUE_ROLES,
  ...wordSet('button link option tab menuitem'),
]);

const DIRECT_ROLES = /* @__PURE__ */ pairRecord(
  'main:main form:form dialog:dialog button:button option:option nav:navigation aside:complementary output:status ul:list ol:list menu:list li:listitem summary:button textarea:textbox',
);

const INPUT_ROLES = /* @__PURE__ */ pairRecord(
  'button:button checkbox:checkbox radio:radio submit:button reset:button image:button range:slider number:spinbutton',
);

const non2dCanvases = new HostWeakSet<HTMLCanvasElement>();
let canvasHooked = false;

export function installCanvasContextTracker(): void {
  if (canvasHooked || !CanvasEl || !origCanvasGetContext) return;
  canvasHooked = true;
  CanvasEl.prototype.getContext = function (
    this: HTMLCanvasElement,
    id: string,
    ...a: [unknown?]
  ): RenderingContext | null {
    const ctx: RenderingContext | null = reflectApply(origCanvasGetContext!, this, [id, ...a]);
    if (ctx && id !== '2d') non2dCanvases.add(this);
    return ctx;
  } as typeof HTMLCanvasElement.prototype.getContext; // Invariant: preserves HTMLCanvasElement.prototype.getContext overload contract

  if (origCanvasTransferOffscreen) {
    CanvasEl.prototype.transferControlToOffscreen = function (): OffscreenCanvas {
      non2dCanvases.add(this);
      return reflectApply(origCanvasTransferOffscreen!, this, []);
    };
  }
}

function composedParent(node: Node): Node | null {
  if (is(node, El) && node.assignedSlot) return node.assignedSlot;
  const parent = node.parentNode;
  return is(parent, ShadowEl) ? parent.host : parent;
}

export function getComposedParentElement(node: Node): Element | null {
  let cur = composedParent(node);
  while (cur && !is(cur, El)) cur = composedParent(cur);
  return cur;
}

export function isComposedDescendant(ancestor: Node, candidate: Node): boolean {
  for (let cur: Node | null = candidate; cur; cur = composedParent(cur)) {
    if (cur === ancestor || cur.parentNode === ancestor) return true;
  }
  return false;
}

export function isElementObservableInScope(el: Element, scopeRoot: ParentNode): boolean {
  if (!el.isConnected || !isComposedDescendant(scopeRoot, el)) return false;
  for (let cur: Element | null = el; cur; cur = getComposedParentElement(cur)) {
    if (isElementHidden(cur)) return false;
    if (cur === scopeRoot) break;
  }
  return true;
}

export function findComposedAncestor(
  el: Element | null,
  pred: (candidate: Element) => boolean,
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

const hasAncestor = (el: Element, pred: (ancestor: Element) => boolean): boolean =>
  findComposedAncestor(el, pred) !== null;

export function isElementHidden(el: Element, includeAriaHidden = true): boolean {
  if (
    has(el, DRIVER_UI_ATTRIBUTE) ||
    has(el, 'hidden') ||
    (includeAriaHidden && attr(el, 'aria-hidden') === 'true')
  ) {
    return true;
  }
  const t = tag(el);
  if (IGNORED_TAGS.has(t)) return true;
  if (is(el, InputEl) && el.type.toLowerCase() === 'hidden') return true;
  if (t === 'dialog' && !has(el, 'open')) return true;

  const style = getComputedStyleSafe(el);
  if (style) {
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
    if (style.display === 'none') {
      return (t === 'audio' && !has(el, 'controls')) || t === 'option'
        ? is(el, HtmlEl) && el.style.display === 'none'
        : true;
    }
  }
  return false;
}

export function isElementDisabled(el: Element): boolean {
  if (attr(el, 'aria-disabled') === 'true') return true;
  if (is(el, OptionEl)) return el.disabled;
  if ('disabled' in el && typeof el.disabled === 'boolean') {
    return (
      el.disabled ||
      hasAncestor(el, (a) => tag(a) === 'fieldset' && 'disabled' in a && Boolean(a.disabled))
    );
  }
  return false;
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
    if (!is(cur, El) || cur === exclude || (!isRoot && visited.has(cur))) return;
    const t = tag(cur);
    if (!isRoot || !allowHiddenRoot) {
      if (isElementHidden(cur)) return;
    } else if (IGNORED_TAGS.has(t) || has(cur, DRIVER_UI_ATTRIBUTE)) return;
    if (!isRoot && skipControls) {
      const role = computeElementRole(cur);
      if (role && shouldAssignRef(cur, role)) return;
    }
    if (t === 'img') {
      const alt = rawAttr(cur, 'alt');
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
    for (const child of getComposedChildNodes(cur)) walk(child, false);
  }
  walk(root, true);
  return normSpace(parts.join(' '));
}

const hasLabel = (el: Element): boolean =>
  Boolean(attr(el, 'aria-label') || attr(el, 'aria-labelledby') || attr(el, 'title'));

const usesContentName = (role: string): boolean =>
  role === 'heading' || (INTERACTIVE_ROLES.has(role) && !VALUE_ROLES.has(role));

const DRIVER_ID_RE = /^[A-Za-z0-9_.:/-]{1,80}$/;
const DRIVER_REGION_RE = /(?:^|\.)(?:panel|section|region|list|nav|group)$/i;
const NATIVE_CTRL_SEL = 'button,a[href],input:not([type=hidden]),select,textarea,[tabindex]';

export const readDriverId = (el: Element): string => {
  const v = attr(el, 'data-driver').slice(0, 80);
  return DRIVER_ID_RE.test(v) ? v : '';
};

const readDriverIntent = (el: Element): string =>
  (attr(el, 'data-driver-intent') || attr(el, 'data-driver-description')).slice(0, 140);

function computeBaseRole(el: Element): string | null {
  const t = tag(el);
  if (t === 'video' || t === 'audio' || t === 'canvas') return t;

  const explicit = attr(el, 'role');
  if (explicit) {
    const token = explicit.split(' ')[0]?.toLowerCase() ?? '';
    return token === 'none' || token === 'presentation' ? null : token || null;
  }

  if (DIRECT_ROLES[t]) return DIRECT_ROLES[t]!;
  if (/^h[1-6]$/.test(t)) return 'heading';

  const drv = readDriverId(el);
  if (t === 'header' || t === 'footer') {
    return hasAncestor(el, (a) => SECTION_TAGS.has(tag(a)))
      ? drv
        ? 'region'
        : null
      : t === 'header'
        ? 'banner'
        : 'contentinfo';
  }
  if (t === 'section') return hasLabel(el) || drv ? 'region' : null;
  if (t === 'a' || t === 'area') return has(el, 'href') ? 'link' : drv ? 'button' : null;
  if (t === 'select') {
    return is(el, SelectEl) && (el.multiple || el.size > 1) ? 'listbox' : 'combobox';
  }
  if (t === 'input') {
    const it = is(el, InputEl) ? el.type.toLowerCase() : attr(el, 'type').toLowerCase() || 'text';
    return it === 'hidden' ? null : (INPUT_ROLES[it] ?? 'textbox');
  }
  if (t === 'img') return hasLabel(el) || Boolean(attr(el, 'alt')) || drv ? 'img' : null;
  const ce = rawAttr(el, 'contenteditable');
  if (ce === '' || ce?.toLowerCase() === 'true') return 'textbox';
  if (has(el, 'onclick')) return 'button';

  if (drv) {
    return DRIVER_REGION_RE.test(drv) ||
      (!readDriverIntent(el) &&
        getComputedStyleSafe(el)?.cursor !== 'pointer' &&
        Boolean(querySelectorSafe(el, NATIVE_CTRL_SEL)))
      ? 'region'
      : 'button';
  }
  return null;
}

export function computeElementRole(el: Element): string | null {
  const base = computeBaseRole(el);
  if (base) return base;
  const t = tag(el);
  if (t === 'html' || t === 'body' || t === 'main' || t === 'label') return null;
  if (getComputedStyleSafe(el)?.cursor !== 'pointer') return null;
  const parent = getComposedParentElement(el);
  if (parent && getComputedStyleSafe(parent)?.cursor === 'pointer') return null;
  if (
    querySelectorSafe(el, NATIVE_CTRL_SEL) ||
    hasAncestor(el, (a) => {
      const r = computeBaseRole(a);
      return Boolean(r && INTERACTIVE_ROLES.has(r));
    })
  ) {
    return null;
  }
  const txt = normSpace(el.textContent ?? '');
  return txt.length > 0 && txt.length <= 240 ? 'button' : null;
}

export function computeAccessibleName(
  el: Element,
  role: string,
  visited: Set<Element> = new HostSet<Element>(),
): string {
  if (visited.has(el)) return '';
  const next = new HostSet<Element>(visited);
  next.add(el);
  const joinEls = (els: Iterable<Element>, allowHidden: boolean, excl?: Element): string =>
    normSpace(
      [...els]
        .map((n) => extractText(n, next, allowHidden, excl))
        .filter(Boolean)
        .join(' '),
    );

  const lb = attr(el, 'aria-labelledby');
  if (lb) {
    const root = el.getRootNode();
    const targets: Element[] = [];
    for (const id of lb.split(' ')) {
      const refEl = (is(root, ShadowEl) && root.getElementById(id)) || doc?.getElementById(id);
      if (refEl) targets.push(refEl);
    }
    const joined = joinEls(targets, true);
    if (joined) return joined;
  }

  const aria = attr(el, 'aria-label');
  if (aria) return aria;

  if (is(el, InputEl)) {
    const it = el.type.toLowerCase();
    const iv = normSpace(getInputValue(el));
    if (it === 'image') return attr(el, 'alt') || iv || 'Submit';
    if (it === 'submit' || it === 'reset' || it === 'button') {
      return iv || (it === 'submit' ? 'Submit' : it === 'reset' ? 'Reset' : '');
    }
  }

  const textCtrl = is(el, InputEl) || is(el, TextAreaEl);
  const labels = textCtrl || is(el, SelectEl) ? el.labels : null;
  if (labels?.length) {
    const joined = joinEls(labels, false, el);
    if (joined) return joined;
  }

  if (is(el, OptionEl)) {
    const opt = normSpace(el.label || el.text);
    if (opt) return opt;
  }
  if (tag(el) === 'img') {
    const alt = attr(el, 'alt');
    if (alt) return alt;
  }

  const skipCtrl =
    usesContentName(role) && !((role === 'checkbox' || role === 'radio') && is(el, InputEl))
      ? false
      : role === 'alert' || role === 'status' || role === 'listitem'
        ? true
        : null;
  if (skipCtrl !== null) {
    const text = extractText(el, next, false, undefined, skipCtrl);
    if (text) return text;
  }

  const placeholder = textCtrl ? normSpace(el.placeholder) : attr(el, 'aria-placeholder');
  return placeholder || attr(el, 'title');
}

export function shouldAssignRef(el: Element, role: string): boolean {
  return (
    Boolean(readDriverId(el)) ||
    LANDMARK_ROLES.has(role) ||
    INTERACTIVE_ROLES.has(role) ||
    role === 'video' ||
    role === 'audio' ||
    role === 'canvas' ||
    (is(el, HtmlEl) && has(el, 'tabindex') && el.tabIndex >= 0)
  );
}

const childLmOf = (role: string, name: string, lm?: string): string | undefined =>
  LANDMARK_ROLES.has(role) ? (name ? `${role}:${name}` : role) : lm;

function findEnclosingLandmark(el: Element): string | undefined {
  let out: string | undefined;
  findComposedAncestor(el, (cur) => {
    const role = computeElementRole(cur);
    if (role && LANDMARK_ROLES.has(role)) {
      out = childLmOf(role, computeAccessibleName(cur, role));
      return true;
    }
    return false;
  });
  return out;
}

const fpKey = (role: string, name: string, landmark?: string, driverId?: string): string =>
  `${role}\0${name}\0${landmark ?? ''}\0${driverId ?? ''}`;

function makeFingerprint(
  counts: Map<string, number>,
  role: string,
  name: string,
  landmark: string | undefined,
  driverId: string | undefined,
): SemanticFingerprint {
  const key = fpKey(role, name, landmark, driverId);
  const nth = counts.get(key) ?? 0;
  counts.set(key, nth + 1);
  return {
    role,
    name,
    nth,
    ...(landmark !== undefined ? { landmark } : {}),
    ...(driverId ? { driverId } : {}),
  };
}

export interface LiveDomCandidate extends SemanticCandidateItem<Element> {
  readonly text: string;
}

/**
 * Side-effect-free live composed DOM query for `resolveTarget` (does not advance `rev` or drain diagnostics).
 */
export function scanLiveDom(scopeRoot: ParentNode, withText: boolean): readonly LiveDomCandidate[] {
  const start = is(scopeRoot, DocEl) ? (scopeRoot.body ?? scopeRoot.documentElement) : scopeRoot;
  if (!start) return [];

  const counts = new HostMap<string, number>();
  const out: LiveDomCandidate[] = [];

  function visit(node: Node, landmark: string | undefined): void {
    let childLandmark = landmark;
    if (is(node, El)) {
      if (isElementHidden(node)) return;
      const computedRole = computeElementRole(node);
      const role = computedRole ?? (withText ? tag(node) : null);
      if (role) {
        const name = computeAccessibleName(node, role);
        childLandmark = childLmOf(role, name, landmark);
        const text = withText ? extractText(node, new HostSet<Element>(), false) : '';
        if (computedRole || text || name) {
          out.push({
            target: node,
            text,
            fingerprint: makeFingerprint(
              counts,
              role,
              computedRole ? name : name || text,
              landmark,
              readDriverId(node) || undefined,
            ),
          });
        }
      }
    }
    for (const child of getComposedChildNodes(node)) visit(child, childLandmark);
  }

  visit(start, is(start, El) ? findEnclosingLandmark(start) : undefined);
  return out;
}

function queryComposedCss(selector: string): Element | null {
  function check(root: ParentNode): Element | null {
    try {
      const match = querySelectorSafe(root, selector);
      if (match && isElementObservableInScope(match, doc!)) return match;
    } catch {
      return null;
    }
    for (const child of getComposedChildNodes(root)) {
      if (is(child, El) && !isElementHidden(child)) {
        const hit = check(getOpenShadowRoot(child) ?? child);
        if (hit) return hit;
      }
    }
    return null;
  }
  return doc ? check(doc) : null;
}

function resolveScopeElements(rawScope: string): readonly Element[] {
  const scope = rawScope.trim();
  const miss = (role: string, name: string, driverId?: string): never =>
    failMiss(scope, doc!, role, name, undefined, driverId);
  if (!scope) failNotFound('Empty scope.');
  if (isRefId(scope)) return [resolveTarget(scope, doc)];
  if (/^driver:/i.test(scope)) {
    const pfx = normSpace(scope.slice(7));
    const hits = pfx
      ? scanLiveDom(doc!, false)
          .filter(
            ({ fingerprint: f }) =>
              f.driverId === pfx || Boolean(f.driverId?.startsWith(`${pfx}.`)),
          )
          .map((c) => c.target)
      : [];
    const out = hits.filter(
      (el) => !hits.some((anc) => anc !== el && isComposedDescendant(anc, el)),
    );
    if (!out.length) miss('', pfx, pfx);
    return out;
  }

  const m = /^([a-z]+)(?::(.+))?$/i.exec(scope);
  const name = m?.[2] !== undefined ? normSpace(m[2]) : undefined;
  if (m && name !== '') {
    try {
      return [resolveTarget({ role: m[1]!.toLowerCase(), ...(name ? { name } : {}) }, doc)];
    } catch (err) {
      if (!(err instanceof DriverError && err.code === 'DRIVER_TARGET_NOT_FOUND')) throw err;
      const css = queryComposedCss(scope);
      if (css) return [css];
      throw err;
    }
  }
  return [queryComposedCss(scope) ?? miss(scope.toLowerCase(), scope)];
}

function inspectMedia(el: HTMLMediaElement, kind: 'video' | 'audio'): SnapshotMediaState {
  const { currentTime: ct, duration: dur, error: err } = el;
  const v = kind === 'video' && is(el, VideoEl) ? el : null;
  const r = v ? getBoundingClientRect(v) : null;
  return {
    kind,
    paused: el.paused,
    currentTime: Number.isFinite(ct) && ct > 0 ? ct : 0,
    duration: Number.isFinite(dur) && dur >= 0 ? dur : null,
    width: r && v ? Math.max(0, v.videoWidth || Math.round(r.width)) : 0,
    height: r && v ? Math.max(0, v.videoHeight || Math.round(r.height)) : 0,
    ready: el.readyState >= 2,
    error: err ? err.message || `MEDIA_ERR_${err.code}` : null,
  };
}

let scratchCtx: CanvasRenderingContext2D | null = null;

function inspectCanvas(el: HTMLCanvasElement): SnapshotCanvasState {
  const width = Math.max(0, el.width);
  const height = Math.max(0, el.height);
  let nonBlank = Boolean(width && height);
  if (nonBlank && !non2dCanvases.has(el) && origCanvasGetContext) {
    const sw = Math.min(64, width);
    const sh = Math.min(64, height);
    try {
      if (!scratchCtx) {
        const rawCtx: unknown = reflectApply(origCanvasGetContext, doc!.createElement('canvas'), [
          '2d',
          { willReadFrequently: true },
        ]);
        if (is(rawCtx, Ctx2dEl)) scratchCtx = rawCtx;
      }
      if (scratchCtx) {
        scratchCtx.canvas.width = sw;
        scratchCtx.canvas.height = sh;
        scratchCtx.drawImage(el, 0, 0, sw, sh);
        nonBlank = scratchCtx
          .getImageData(0, 0, sw, sh)
          .data.some((v, i) => (i & 3) === 3 && v > 0);
      }
    } catch {
      scratchCtx = null;
    }
  }
  return { width, height, nonBlank };
}

interface MutableNode {
  role: string;
  name: string;
  ref?: RefId;
  driverId?: string;
  intent?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  min?: number;
  max?: number;
  media?: SnapshotMediaState;
  canvas?: SnapshotCanvasState;
  children?: readonly SnapshotNode[];
}

const ariaBool = (el: Element, k: string): boolean | undefined => {
  const v = rawAttr(el, k);
  return v === 'true' || v === 'false' ? v === 'true' : undefined;
};

function applyState(bag: MutableNode, el: Element, role: string): void {
  if ((role === 'video' || role === 'audio') && is(el, MediaEl)) {
    bag.media = inspectMedia(el, role);
    return;
  }
  if (role === 'canvas' && is(el, CanvasEl)) {
    bag.canvas = inspectCanvas(el);
    return;
  }

  const exp = ariaBool(el, 'aria-expanded');
  if (exp !== undefined) bag.expanded = exp;
  else if (tag(el) === 'summary') {
    const parent = getComposedParentElement(el);
    if (parent && tag(parent) === 'details') bag.expanded = has(parent, 'open');
  } else if (role === 'combobox') bag.expanded = false;

  const disabled = isElementDisabled(el);
  let alwaysDisabled = true;
  if (TOGGLE_ROLES.has(role)) {
    bag.checked = is(el, InputEl) ? el.checked : rawAttr(el, 'aria-checked') === 'true';
  } else if (role === 'option' || role === 'tab') {
    if (role === 'option' && is(el, OptionEl)) {
      bag.value = el.value;
      bag.checked = el.selected;
    } else {
      const sel = ariaBool(el, 'aria-selected');
      if (sel !== undefined) bag.checked = sel;
    }
  } else if (VALUE_ROLES.has(role)) {
    const val =
      formControlValue(el) ??
      (role === 'textbox' || role === 'searchbox'
        ? (el.textContent ?? '')
        : (rawAttr(el, 'aria-valuenow') ?? rawAttr(el, 'aria-valuetext') ?? rawAttr(el, 'value')));
    if (val !== null) bag.value = val;
    if (role === 'slider' || role === 'spinbutton') {
      const slider = role === 'slider';
      const rMin = is(el, InputEl) ? el.min || (slider ? '0' : '') : attr(el, 'aria-valuemin');
      const rMax = is(el, InputEl) ? el.max || (slider ? '100' : '') : attr(el, 'aria-valuemax');
      if (rMin !== '' && Number.isFinite(+rMin)) bag.min = +rMin;
      if (rMax !== '' && Number.isFinite(+rMax)) bag.max = +rMax;
    }
  } else {
    alwaysDisabled = false;
  }
  if (alwaysDisabled || disabled) bag.disabled = disabled;
}

type DeferredRefTuple = [node: MutableNode, el: Element, fp: SemanticFingerprint];

let lastFullSnapshot: ObservationSnapshot | null = null;

export function getLastFullSnapshot(): ObservationSnapshot | null {
  return lastFullSnapshot;
}

export function observeDocument(params?: ObserveRpcParams, passive = false): ObservationSnapshot {
  const allText = params?.includeAllText === true;
  const scopedEls = params?.scope !== undefined ? resolveScopeElements(params.scope) : null;

  const rev = passive ? currentRevision() : nextRevision();
  const diagnostics = drainDiagnostics(passive);
  const rootBody = doc!.body ?? doc!.documentElement;
  const counts = new HostMap<string, number>();
  const deferred: DeferredRefTuple[] = [];

  function buildKids(parent: Node, landmark: string | undefined, noText: boolean): SnapshotNode[] {
    const out: SnapshotNode[] = [];
    for (const child of getComposedChildNodes(parent)) {
      if (child.nodeType === 3) {
        if (allText && !noText) {
          const text = normSpace(child.nodeValue ?? '');
          if (text) out.push({ role: 'text', name: text });
        }
        continue;
      }
      if (is(child, El)) out.push(...buildEl(child, landmark));
    }
    return out;
  }

  function buildEl(el: Element, landmark: string | undefined): SnapshotNode[] {
    if (isElementHidden(el)) return [];
    if (tag(el) === 'label' && !allText) return buildKids(el, landmark, true);

    const role = computeElementRole(el);
    if (!role) return buildKids(el, landmark, false);

    const interactive = shouldAssignRef(el, role) && !LANDMARK_ROLES.has(role);
    if ((role === 'list' || role === 'listitem' || role === 'img') && !allText && !interactive) {
      return role === 'img' ? [] : buildKids(el, landmark, true);
    }

    const name = computeAccessibleName(el, role);
    const drv = readDriverId(el);
    const intent = readDriverIntent(el);
    const node: MutableNode = { role, name };
    if (drv) node.driverId = drv;
    if (intent) node.intent = intent;
    applyState(node, el, role);

    if (shouldAssignRef(el, role)) {
      deferred.push([node, el, makeFingerprint(counts, role, name, landmark, drv || undefined)]);
    }

    if (!LEAF_ROLES.has(role) && !is(el, OptionEl)) {
      const noText =
        usesContentName(role) || role === 'alert' || role === 'status' || role === 'listitem';
      const children = buildKids(el, childLmOf(role, name, landmark), noText);
      if (children.length > 0) node.children = children;
    }

    return [node];
  }

  const elements = scopedEls
    ? scopedEls.flatMap((el) => buildEl(el, findEnclosingLandmark(el)))
    : rootBody
      ? buildKids(rootBody, undefined, false)
      : [];

  for (const [node, el, fp] of deferred) {
    node.ref = assignRef(
      el,
      fp,
      counts.get(fpKey(fp.role, fp.name, fp.landmark, fp.driverId)) ?? 1,
      rev,
    );
  }

  const snapshot: ObservationSnapshot = {
    rev,
    url: win!.location.href,
    title: doc!.title,
    viewport: { width: Math.max(0, win!.innerWidth), height: Math.max(0, win!.innerHeight) },
    diagnostics,
    elements,
  };
  if (!passive && scopedEls === null && !allText) {
    lastFullSnapshot = snapshot;
  }
  return snapshot;
}
