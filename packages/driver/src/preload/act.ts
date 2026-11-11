import type { ActRpcParams } from '../protocol.js';
import {
  type ActInterruptionReason,
  type ActResult,
  type ClickStep,
  type DragStep,
  DriverError,
  type DriverStep,
  type FillStep,
  type NavigateStep,
  type PressStep,
  type SelectStep,
  type SetValueStep,
  type TargetSpec,
  type WaitForStep,
} from '../types.js';
import {
  type HumanTakeoverGuard,
  hideCursorOverlay,
  installHumanTakeoverGuard,
  moveCursorPoint,
  showCursorStep,
} from './cursor-overlay.js';
import {
  inFlightRequests,
  onNativeDialog,
  onRuntimePageError,
  readCompileOverlayFromDocument,
} from './diagnostics.js';
import { diffSnapshots, originAndPathname } from './diff.js';
import {
  AnchorEl,
  ButtonEl,
  DRIVER_UI_ATTRIBUTE,
  DialogEl,
  El,
  FormEl,
  HostEvent,
  HostInputEvent,
  HostKeyboardEvent,
  HostMouseEvent,
  HostMutationObserver,
  HostPointerEvent,
  HostSet,
  HtmlEl,
  InputEl,
  LabelEl,
  MediaEl,
  SelectEl,
  ShadowEl,
  TextAreaEl,
  UrlCtor,
  clickElement,
  doc,
  elementFromPointSafe,
  focusElement,
  formControlValue,
  getBoundingClientRect,
  getOpenShadowRoot,
  has,
  is,
  normSpace,
  nowMs,
  origClearTimeout,
  origRequestAnimationFrame,
  origSetTimeout,
  pairRecord,
  rawAttr,
  reflectApply,
  reflectGet,
  scrollIntoViewSafe,
  setAttr,
  setInputValue,
  setMediaCurrentTime,
  setOptionSelected,
  setSelectValue,
  setTextAreaValue,
  submitFormSafe,
  tag,
  targetDispatchEvent,
  win,
  wordSet,
} from './intrinsics.js';
import {
  computeElementRole,
  findComposedAncestor,
  getLastFullSnapshot,
  isComposedDescendant,
  isElementDisabled,
  isElementHidden,
  observeDocument,
  scanLiveDom,
} from './observe.js';
import { failDriver, failNotFound, getRefEntry, isRefId, resolveTarget } from './ref-registry.js';

const BUBBLING_COMPOSED = { bubbles: true, cancelable: true, composed: true } as const;
const ENTER_ACTIVATE_ROLES = /* @__PURE__ */ wordSet('button link');
const SPACE_ACTIVATE_ROLES = /* @__PURE__ */ wordSet('button checkbox switch');
const SPECIAL_KEYS = /* @__PURE__ */ pairRecord(
  'space:Space esc:Escape escape:Escape enter:Enter tab:Tab',
);
const MOD_KEYS = /* @__PURE__ */ pairRecord(
  'control:Control ctrl:Control shift:Shift alt:Alt option:Alt meta:Meta command:Meta cmd:Meta',
);

const TAKEOVER = {};

function waitTimerOrRaf(guard: HumanTakeoverGuard, ms: number, useRaf: boolean): Promise<void> {
  if (guard[0]) return Promise.reject(TAKEOVER);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (aborted: boolean): void => {
      if (!settled) {
        settled = true;
        origClearTimeout(timer);
        if (guard[1] === abortNow) guard[1] = null;
        if (aborted) reject(TAKEOVER);
        else resolve();
      }
    };
    const abortNow = (): void => finish(true);
    const timer = origSetTimeout(() => finish(false), ms);
    if (useRaf) origRequestAnimationFrame(() => finish(false));
    guard[1] = abortNow;
  });
}

const emitMouse = (
  target: EventTarget,
  type: string,
  clientX: number,
  clientY: number,
  button = 0,
  buttons = 0,
  detail = 1,
  isPtr = false,
): boolean => {
  const Ctor = isPtr ? HostPointerEvent : HostMouseEvent;
  const base = { ...BUBBLING_COMPOSED, clientX, clientY, button, buttons };
  return (
    !Ctor ||
    targetDispatchEvent(
      target,
      new Ctor(
        type,
        isPtr ? { ...base, pointerId: 1, isPrimary: true } : { ...base, view: win ?? null, detail },
      ),
    )
  );
};

const emitPair = (
  target: EventTarget,
  pType: string,
  mType: string,
  cx: number,
  cy: number,
  btn = 0,
  btns = 0,
  detail = 1,
): boolean => (
  emitMouse(target, pType, cx, cy, pType === 'pointermove' ? -1 : btn, btns, 1, true),
  emitMouse(target, mType, cx, cy, btn, btns, detail)
);

interface KeyMods {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

function emitKey(
  target: EventTarget,
  type: 'keydown' | 'keyup',
  key: string,
  code: string,
  mods?: Partial<KeyMods>,
): boolean {
  return (
    !HostKeyboardEvent ||
    targetDispatchEvent(
      target,
      new HostKeyboardEvent(type, { ...BUBBLING_COMPOSED, key, code, ...mods }),
    )
  );
}

export function deepElementFromPoint(x: number, y: number): Element | null {
  if (!doc) return null;
  let hit = elementFromPointSafe(doc, x, y);
  while (hit) {
    const sr = getOpenShadowRoot(hit);
    const inner = sr ? elementFromPointSafe(sr, x, y) : null;
    if (!inner || inner === hit) break;
    hit = inner;
  }
  return hit;
}

function getDeepActiveElement(): Element | null {
  if (!doc) return null;
  let cur = doc.activeElement;
  while (cur) {
    const next = getOpenShadowRoot(cur)?.activeElement;
    if (!next || next === cur) break;
    cur = next;
  }
  return cur;
}

function submitControlForm(el: Element): void {
  const f = findComposedAncestor(el, (c) => is(c, FormEl), true);
  const form =
    (is(el, InputEl) || is(el, TextAreaEl) ? el.form : null) ?? (is(f, FormEl) ? f : null);
  if (form) submitFormSafe(form);
}

function setTextControlValue(el: Element, value: string): boolean {
  if (!is(el, InputEl) && !is(el, TextAreaEl)) return false;
  const prev = formControlValue(el);
  const vt: unknown = reflectGet(el, '_valueTracker');
  if (typeof vt === 'object' && vt !== null) {
    const fn: unknown = reflectGet(vt, 'setValue');
    if (typeof fn === 'function') {
      try {
        reflectApply(fn, vt, [prev]);
      } catch {
        // ignore tracker errors
      }
    }
  }
  if (is(el, InputEl)) setInputValue(el, value);
  else setTextAreaValue(el, value);
  return true;
}

function dispatchInputAndChange(el: Element, data?: string, inputType = 'insertText'): void {
  const init = { bubbles: true, composed: true };
  if (HostInputEvent) {
    targetDispatchEvent(
      el,
      new HostInputEvent('input', { ...init, ...(data !== undefined ? { data } : {}), inputType }),
    );
  } else if (HostEvent) {
    targetDispatchEvent(el, new HostEvent('input', init));
  }
  if (HostEvent) targetDispatchEvent(el, new HostEvent('change', { bubbles: true }));
}

type ActionableTuple = readonly [
  el: Element,
  hitEl: Element,
  rect: DOMRect,
  cx: number,
  cy: number,
];

async function waitForActionable(
  spec: TargetSpec,
  deadlineMs: number,
  guard: HumanTakeoverGuard,
  allowZeroSizeAudio = false,
): Promise<ActionableTuple> {
  let lastError: unknown = null;
  let lastReason = 'not actionable';
  let prevRect: DOMRect | null = null;
  let stableFrames = 0;
  let sawAmbiguous = false;

  while (true) {
    if (guard[0]) throw TAKEOVER;
    let el: Element | null = null;
    try {
      el = resolveTarget(spec);
    } catch (err) {
      lastError = err;
      if (err instanceof DriverError && err.code === 'DRIVER_TARGET_AMBIGUOUS') {
        if (sawAmbiguous) throw err;
        sawAmbiguous = true;
      }
    }

    if (el) {
      sawAmbiguous = false;
      const t = tag(el);
      const skipHit = t === 'audio' || t === 'option';
      if (!el.isConnected || isElementHidden(el)) {
        lastReason = 'hidden';
        stableFrames = 0;
      } else {
        let rect = getBoundingClientRect(el);
        if (!(allowZeroSizeAudio && t === 'audio') && (rect.width <= 0 || rect.height <= 0)) {
          lastReason = 'zero size';
          stableFrames = 0;
        } else {
          const iw = win!.innerWidth;
          const ih = win!.innerHeight;
          if (
            !skipHit &&
            (rect.bottom <= 0 || rect.top >= ih || rect.right <= 0 || rect.left >= iw)
          ) {
            scrollIntoViewSafe(el);
            rect = getBoundingClientRect(el);
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
              lastReason = 'disabled';
            } else if (skipHit) {
              return [el, el, rect, rect.left + rect.width / 2, rect.top + rect.height / 2];
            } else {
              const vx0 = Math.max(0, rect.left);
              const vy0 = Math.max(0, rect.top);
              const vx1 = Math.min(iw, rect.right);
              const vy1 = Math.min(ih, rect.bottom);
              if (vx1 > vx0 && vy1 > vy0) {
                const cx = (vx0 + vx1) / 2;
                const cy = (vy0 + vy1) / 2;
                const hit = deepElementFromPoint(cx, cy);
                if (
                  hit &&
                  (hit === el ||
                    isComposedDescendant(el, hit) ||
                    findComposedAncestor(hit, (c) => is(c, LabelEl) && c.control === el, true))
                ) {
                  return [el, hit, rect, cx, cy];
                }
                lastReason = `obscured at (${Math.round(cx)}, ${Math.round(cy)})`;
              } else {
                lastReason = 'outside viewport';
              }
            }
          }
        }
      }
    }

    if (nowMs() >= deadlineMs) {
      if (lastError instanceof DriverError) throw lastError;
      failDriver('DRIVER_TIMEOUT', `Target ${lastReason}.`);
    }
    await waitTimerOrRaf(guard, 16, true);
  }
}

const isSameDocHashUrl = (next: URL): boolean =>
  Boolean(next.hash) && next.href.split('#')[0] === win!.location.href.split('#')[0];

function isCrossDocAnchorClick(hitEl: Element, clickAllowed: boolean): boolean {
  if (!clickAllowed) return false;
  const anchor = findComposedAncestor(hitEl, (c) => is(c, AnchorEl) && has(c, 'href'), true);
  if (!anchor || has(anchor, 'download')) return false;
  const t = (rawAttr(anchor, 'target') ?? '').trim().toLowerCase();
  if (t && t !== '_self') return false;
  const href = rawAttr(anchor, 'href') ?? '';
  if (!UrlCtor) return Boolean(href) && !href.startsWith('#');
  try {
    const next = new UrlCtor(href, win!.location.href);
    return (next.protocol === 'http:' || next.protocol === 'https:') && !isSameDocHashUrl(next);
  } catch {
    return false;
  }
}

function dispatchClickAt(
  el: Element,
  hitEl: Element,
  cx: number,
  cy: number,
  step: Pick<ClickStep, 'button' | 'clickCount'>,
): boolean {
  const button = step.button === 'middle' ? 1 : step.button === 'right' ? 2 : 0;
  const buttons = button === 1 ? 4 : button || 1;
  const count = step.clickCount ?? 1;
  let expectsUnload = false;

  emitPair(hitEl, 'pointerover', 'mouseover', cx, cy);
  for (let i = 1; i <= count; i += 1) {
    if (emitPair(hitEl, 'pointerdown', 'mousedown', cx, cy, button, buttons, i) && is(el, HtmlEl)) {
      focusElement(el);
    }
    emitPair(hitEl, 'pointerup', 'mouseup', cx, cy, button, 0, i);
    if (button === 2) emitMouse(hitEl, 'contextmenu', cx, cy, 2, 0, i);
    else if (button === 0) {
      if (isCrossDocAnchorClick(hitEl, emitMouse(hitEl, 'click', cx, cy, 0, 0, i))) {
        expectsUnload = true;
      }
      if (i === 2) emitMouse(hitEl, 'dblclick', cx, cy, 0, 0, 2);
    }
  }
  return expectsUnload;
}

function executeFillStep(el: Element, step: FillStep): void {
  if (is(el, HtmlEl)) focusElement(el);
  const ce = rawAttr(el, 'contenteditable');
  if (!setTextControlValue(el, step.value)) {
    if (ce === '' || ce?.toLowerCase() === 'true' || (is(el, HtmlEl) && el.isContentEditable)) {
      el.textContent = step.value;
    } else {
      failDriver('DRIVER_PROTOCOL', 'Not fillable.');
    }
  }
  dispatchInputAndChange(el, step.value, 'insertText');
  if (step.submit === true) {
    if (emitKey(el, 'keydown', 'Enter', 'Enter')) submitControlForm(el);
    emitKey(el, 'keyup', 'Enter', 'Enter');
  }
}

function executeSetValueStep(el: Element, step: SetValueStep): void {
  if (is(el, MediaEl)) {
    const nextTime = Number(step.value);
    if (!Number.isFinite(nextTime) || nextTime < 0) failDriver('DRIVER_PROTOCOL', 'Invalid time.');
    setMediaCurrentTime(el, nextTime);
    if (HostEvent) {
      for (const evName of 'input timeupdate seeked'.split(' ')) {
        targetDispatchEvent(
          el,
          new HostEvent(evName, evName === 'input' ? { bubbles: true, composed: true } : undefined),
        );
      }
    }
    return;
  }
  const strVal = String(step.value);
  if (is(el, HtmlEl)) focusElement(el);
  if (!setTextControlValue(el, strVal)) setAttr(el, 'aria-valuenow', strVal);
  dispatchInputAndChange(el, strVal, 'insertReplacementText');
}

function requireOption<T>(found: T | undefined, disabled: boolean, val: string): T {
  if (!found) failNotFound(`Option "${val}" not found.`);
  if (disabled) failDriver('DRIVER_PROTOCOL', `Option "${val}" disabled.`);
  return found;
}

async function executeSelectStep(
  target: ActionableTuple,
  step: SelectStep,
  guard: HumanTakeoverGuard,
): Promise<void> {
  const [el, hitEl, , cx, cy] = target;
  const wanted = typeof step.value === 'string' ? [step.value] : [...step.value];

  if (is(el, SelectEl)) {
    focusElement(el);
    const opts = [...el.options];
    const matched = wanted.map((val) => {
      const trimmed = normSpace(val);
      const found = opts.find((o) => o.value === val || normSpace(o.label || o.text) === trimmed);
      return requireOption(found, Boolean(found?.disabled), val);
    });
    if (el.multiple) {
      const set = new HostSet(matched);
      for (const o of opts) setOptionSelected(o, set.has(o));
    } else if (matched[0]) {
      setSelectValue(el, matched[0].value);
      setOptionSelected(matched[0], true);
    }
    dispatchInputAndChange(el);
    return;
  }

  if (computeElementRole(el) === 'combobox' && rawAttr(el, 'aria-expanded') !== 'true') {
    dispatchClickAt(el, hitEl, cx, cy, {});
    await waitTimerOrRaf(guard, 16, true);
  }
  for (const val of wanted) {
    const trimmed = normSpace(val);
    const found = scanLiveDom(doc!, true).find(
      (c) =>
        c.fingerprint.role === 'option' &&
        (c.fingerprint.name === trimmed ||
          c.text === trimmed ||
          rawAttr(c.target, 'data-value') === val ||
          rawAttr(c.target, 'value') === val),
    );
    const match = requireOption(found, Boolean(found && isElementDisabled(found.target)), val);
    const r = getBoundingClientRect(match.target);
    dispatchClickAt(match.target, match.target, r.left + r.width / 2, r.top + r.height / 2, {});
    await Promise.resolve();
  }
}

function executePressStep(step: PressStep, targetEl: Element | null): void {
  const active = targetEl ?? getDeepActiveElement() ?? doc?.body ?? doc?.documentElement;
  if (!active) return;

  const parts = step.key === '+' ? ['+'] : step.key.split('+').filter(Boolean);
  const mods: Partial<KeyMods> = {};
  const modNames: string[] = [];
  for (let i = 0; i < parts.length - 1; i += 1) {
    const canon = MOD_KEYS[(parts[i] ?? '').trim().toLowerCase()];
    if (canon) {
      mods[`${canon === 'Control' ? 'ctrl' : canon.toLowerCase()}Key` as keyof KeyMods] = true; // Invariant: canon is Control | Shift | Alt | Meta
      modNames.push(canon);
    }
  }

  const tok = (parts.at(-1) ?? step.key).trim();
  const mapped = step.key === ' ' ? 'Space' : SPECIAL_KEYS[tok.toLowerCase()];
  let key = mapped === 'Space' ? ' ' : (mapped ?? tok);
  let code = mapped ?? tok;
  if (!mapped && tok.length === 1) {
    if (/^[a-z]$/i.test(tok)) {
      key = mods.shiftKey ? tok.toUpperCase() : tok;
      code = `Key${tok.toUpperCase()}`;
    } else if (/^[0-9]$/.test(tok)) {
      code = `Digit${tok}`;
    }
  }

  for (const m of modNames) emitKey(active, 'keydown', m, `${m}Left`, mods);
  const allowed = emitKey(active, 'keydown', key, code, mods);

  if (allowed && !mods.ctrlKey && !mods.altKey && !mods.metaKey && is(active, El)) {
    const role = computeElementRole(active) ?? '';
    if (key === 'Tab') {
      const tabs = scanLiveDom(doc!, false)
        .map((c) => c.target)
        .filter((n): n is HTMLElement => is(n, HtmlEl) && !isElementDisabled(n) && n.tabIndex >= 0);
      if (tabs.length > 0) {
        const idx = is(active, HtmlEl) ? tabs.indexOf(active) : -1;
        const next = tabs.at(
          idx < 0 ? (mods.shiftKey ? -1 : 0) : (idx + (mods.shiftKey ? -1 : 1)) % tabs.length,
        );
        if (next) focusElement(next);
      }
    } else if (key === 'Enter' || key === ' ') {
      const shouldClick =
        is(active, ButtonEl) ||
        tag(active) === 'summary' ||
        (key === 'Enter'
          ? (is(active, AnchorEl) && has(active, 'href')) || ENTER_ACTIVATE_ROLES.has(role)
          : (is(active, InputEl) && (active.type === 'checkbox' || active.type === 'radio')) ||
            SPACE_ACTIVATE_ROLES.has(role));
      if (shouldClick) {
        if (is(active, HtmlEl)) clickElement(active);
      } else if (key === 'Enter' && is(active, InputEl)) {
        submitControlForm(active);
      }
    } else if (key === 'Escape') {
      const dlg = findComposedAncestor(active, (c) => is(c, DialogEl) && c.open, true);
      if (is(dlg, DialogEl)) dlg.close();
    }
  }

  const upTarget = getDeepActiveElement() ?? active;
  emitKey(upTarget, 'keyup', key, code, mods);
  for (const m of modNames.reverse()) emitKey(upTarget, 'keyup', m, `${m}Left`);
}

async function executeDragStep(
  step: DragStep,
  stepIndex: number,
  totalSteps: number,
  deadlineMs: number,
  guard: HumanTakeoverGuard,
): Promise<void> {
  const [, fromHit, fromRect, x0, y0] = await waitForActionable(step.from, deadlineMs, guard);
  const [x1, y1] =
    'target' in step.to
      ? ((await waitForActionable(step.to.target, deadlineMs, guard)).slice(3) as [number, number]) // Invariant: ActionableTuple indices 3,4 are [cx, cy]
      : 'deltaX' in step.to
        ? [x0 + step.to.deltaX, y0 + step.to.deltaY]
        : [step.to.clientX, step.to.clientY];

  const count = Math.max(1, step.steps ?? 5);
  showCursorStep(stepIndex, totalSteps, 'drag', fromRect, x0, y0);
  emitMouse(fromHit, 'pointerover', x0, y0, 0, 0, 1, true);
  emitPair(fromHit, 'pointerdown', 'mousedown', x0, y0, 0, 1);

  for (let s = 1; s <= count; s += 1) {
    if (guard[0]) throw TAKEOVER;
    const cx = x0 + ((x1 - x0) * s) / count;
    const cy = y0 + ((y1 - y0) * s) / count;
    moveCursorPoint(cx, cy);
    emitPair(deepElementFromPoint(cx, cy) ?? fromHit, 'pointermove', 'mousemove', cx, cy, 0, 1);
    await Promise.resolve();
  }

  emitPair(deepElementFromPoint(x1, y1) ?? fromHit, 'pointerup', 'mouseup', x1, y1);
}

function executeNavigateStep(step: NavigateStep): 'unload' | 'history' | 'none' {
  const loc = win!.location;
  if ('url' in step) {
    const resolved = UrlCtor ? new UrlCtor(step.url, loc.href) : null;
    const sameDoc = resolved !== null && isSameDocHashUrl(resolved);
    loc.assign(resolved ? resolved.href : step.url);
    return sameDoc ? 'none' : 'unload';
  }
  if (step.action === 'reload') {
    loc.reload();
    return 'unload';
  }
  if (step.action === 'back') win!.history.back();
  else win!.history.forward();
  return 'history';
}

function checkTargetState(
  spec: TargetSpec,
  desired: 'attached' | 'visible' | 'hidden' | 'detached',
): boolean {
  if (
    typeof spec === 'string' &&
    isRefId(spec) &&
    getRefEntry(spec)?.[0].deref()?.isConnected &&
    (desired === 'detached' || desired === 'attached')
  ) {
    return desired === 'attached';
  }
  try {
    const el = resolveTarget(spec);
    if (desired === 'detached') return false;
    if (desired === 'attached') return el.isConnected;
    const r = getBoundingClientRect(el);
    const vis =
      el.isConnected &&
      !isElementHidden(el) &&
      (tag(el) === 'audio' || (r.width > 0 && r.height > 0));
    return desired === 'visible' ? vis : !vis;
  } catch (err) {
    return (
      (desired === 'detached' || desired === 'hidden') &&
      err instanceof DriverError &&
      err.code === 'DRIVER_TARGET_NOT_FOUND'
    );
  }
}

async function executeWaitForStep(
  step: WaitForStep,
  batchDeadlineMs: number,
  hasBatchTimeout: boolean,
  guard: HumanTakeoverGuard,
): Promise<void> {
  const stepDeadline =
    step.timeoutMs !== undefined
      ? Math.min(hasBatchTimeout ? batchDeadlineMs : Infinity, nowMs() + step.timeoutMs)
      : batchDeadlineMs;

  const desired = step.state ?? 'visible';
  const needle = step.text !== undefined ? normSpace(step.text).toLowerCase() : undefined;
  let lastActivityAt = nowMs();
  let observer: MutationObserver | null = null;

  if (step.idleMs !== undefined && HostMutationObserver && doc?.documentElement) {
    observer = new HostMutationObserver((records) => {
      if (
        records.some((m) => {
          const t = m.target;
          const el = is(t, El) ? t : is(t, ShadowEl) ? t.host : t.parentElement;
          return !findComposedAncestor(el, (c) => has(c, DRIVER_UI_ATTRIBUTE), true);
        })
      ) {
        lastActivityAt = nowMs();
      }
    });
    observer.observe(doc.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  }

  try {
    while (true) {
      if (guard[0]) throw TAKEOVER;
      const targetOk = step.target === undefined || checkTargetState(step.target, desired);
      const present =
        !needle ||
        scanLiveDom(doc!, true).some((c) =>
          [c.text, c.fingerprint.name].some((s) => s.toLowerCase().includes(needle)),
        );
      const textOk =
        needle === undefined ||
        (desired === 'hidden' || desired === 'detached' ? !present : present);

      if (inFlightRequests() > 0) lastActivityAt = nowMs();
      const idleOk =
        step.idleMs === undefined ||
        (!inFlightRequests() && nowMs() - lastActivityAt >= step.idleMs);

      if (targetOk && textOk && idleOk) return;
      if (nowMs() >= stepDeadline) failDriver('DRIVER_TIMEOUT', 'waitFor timeout.');
      await waitTimerOrRaf(guard, Math.min(20, Math.max(4, stepDeadline - nowMs())), false);
    }
  } finally {
    observer?.disconnect();
  }
}

const visibleDialogs = (): Element[] =>
  doc
    ? scanLiveDom(doc, false)
        .filter((c) => c.fingerprint.role === 'dialog' || c.fingerprint.role === 'alertdialog')
        .map((c) => c.target)
    : [];

async function waitForQuiet(deadlineMs: number, guard: HumanTakeoverGuard): Promise<void> {
  await waitTimerOrRaf(guard, 0, false);
  await waitTimerOrRaf(guard, 16, true);
  if (inFlightRequests() > 0) {
    const cap = Math.min(deadlineMs, nowMs() + 250);
    while (inFlightRequests() > 0 && nowMs() < cap) await waitTimerOrRaf(guard, 12, false);
    if (!inFlightRequests()) await waitTimerOrRaf(guard, 16, true);
  }
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

export async function executeActBatch(
  params: ActRpcParams,
  onProgress?: (fromRev: number, completedSteps: number) => void,
): Promise<ActResult> {
  const guard = installHumanTakeoverGuard();
  const hasExplicitTimeout = params.timeoutMs !== undefined;
  const deadlineMs = nowMs() + (params.timeoutMs ?? 5_000);

  const baseline = getLastFullSnapshot() ?? observeDocument(undefined, true);
  onProgress?.(baseline.rev, 0);

  const totalSteps = params.steps.length;
  let completedSteps = 0;
  let interruptedReason: ActInterruptionReason | undefined;
  let stepErrorMsg: string | undefined;
  let stepPageError: string | null = null;
  let nativeDialogOpened = false;

  const unsubPageErr = onRuntimePageError((msg) => {
    stepPageError ??= msg;
  });
  const unsubDialog = onNativeDialog(() => {
    nativeDialogOpened = true;
  });

  try {
    for (let i = 0; i < totalSteps; i += 1) {
      const step: DriverStep | undefined = params.steps[i];
      if (!step) break;
      if (guard[0]) {
        interruptedReason = 'user_takeover';
        break;
      }

      stepPageError = null;
      nativeDialogOpened = false;
      const dialogsBefore = new HostSet(visibleDialogs());
      const loc = win!.location;
      const hrefBefore = loc.href;
      const urlBefore = originAndPathname(hrefBefore);
      let navMode: 'unload' | 'history' | 'none' = 'none';

      try {
        const stepLabel = step.kind === 'press' ? `press ${step.key}` : step.kind;
        const prepared =
          'target' in step && step.target !== undefined && step.kind !== 'waitFor'
            ? await waitForActionable(step.target, deadlineMs, guard, step.kind === 'setValue')
            : null;
        const el = prepared?.[0] ?? null;
        if (step.kind !== 'drag') {
          showCursorStep(i, totalSteps, stepLabel, prepared?.[2], prepared?.[3], prepared?.[4]);
        }
        onProgress?.(baseline.rev, i + 1);

        switch (step.kind) {
          case 'click':
            if (dispatchClickAt(el!, prepared![1], prepared![3], prepared![4], step)) {
              navMode = 'unload';
            }
            break;
          case 'fill':
            executeFillStep(el!, step);
            break;
          case 'setValue':
            executeSetValueStep(el!, step);
            break;
          case 'select':
            await executeSelectStep(prepared!, step, guard);
            break;
          case 'press':
            if (el && is(el, HtmlEl)) focusElement(el);
            executePressStep(step, el);
            break;
          case 'drag':
            await executeDragStep(step, i, totalSteps, deadlineMs, guard);
            break;
          case 'navigate':
            navMode = executeNavigateStep(step);
            break;
          case 'waitFor':
            onProgress?.(baseline.rev, i);
            await executeWaitForStep(step, deadlineMs, hasExplicitTimeout, guard);
            break;
          default:
            failDriver('DRIVER_PROTOCOL', 'Unsupported step.');
        }
        completedSteps = i + 1;
        await waitForQuiet(deadlineMs, guard);
        if (navMode !== 'none' && loc.href === hrefBefore) {
          const navCap = navMode === 'history' ? Math.min(deadlineMs, nowMs() + 2_000) : deadlineMs;
          while (loc.href === hrefBefore && nowMs() < navCap) {
            await waitTimerOrRaf(guard, 20, false);
          }
        }
      } catch (err) {
        if (err === TAKEOVER || guard[0]) {
          interruptedReason = 'user_takeover';
        } else {
          interruptedReason = 'step_error';
          stepErrorMsg = formatStepError(err);
        }
        break;
      }

      if (guard[0]) {
        interruptedReason = 'user_takeover';
      } else if (stepPageError !== null) {
        stepErrorMsg = stepPageError;
        interruptedReason = 'step_error';
      } else if (readCompileOverlayFromDocument() !== null) {
        interruptedReason = 'compile_error';
      } else if (
        nativeDialogOpened ||
        (i < totalSteps - 1 && visibleDialogs().some((d) => !dialogsBefore.has(d)))
      ) {
        interruptedReason = 'dialog_opened';
      } else if (i < totalSteps - 1 && originAndPathname(loc.href) !== urlBefore) {
        interruptedReason = 'navigation';
      }
      if (interruptedReason) break;
    }
  } finally {
    unsubPageErr();
    unsubDialog();
    guard[2]();
    hideCursorOverlay();
  }

  const after = observeDocument();
  return {
    completedSteps,
    totalSteps,
    ...(interruptedReason !== undefined ? { interruptedReason } : {}),
    ...(stepErrorMsg !== undefined ? { error: stepErrorMsg } : {}),
    rev: after.rev,
    url: after.url,
    title: after.title,
    diff: diffSnapshots(baseline, after),
    diagnostics: after.diagnostics,
  };
}
