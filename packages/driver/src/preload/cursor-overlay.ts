import {
  DRIVER_UI_ATTRIBUTE,
  attachOpenShadow,
  doc,
  isTrustedEvent,
  offEvent,
  onEvent,
  setAttr,
  win,
} from './intrinsics.js';

const TAKEOVER_EVENTS = 'pointerdown mousedown keydown touchstart wheel'.split(' ');

let ui: readonly [HTMLDivElement, HTMLDivElement, HTMLDivElement, HTMLDivElement] | null = null;

const px = (n: number): string => `${Math.round(n)}px`;
const place = (el: HTMLDivElement, x: number, y: number, extra = ''): void => {
  el.style.cssText = `display:block;left:${px(x)};top:${px(y)}${extra}`;
};
const hideEl = (el: HTMLDivElement | undefined): void => {
  if (el) el.style.display = 'none';
};

function ensureMounted():
  | readonly [HTMLDivElement, HTMLDivElement, HTMLDivElement, HTMLDivElement]
  | null {
  if (!doc?.documentElement) return null;
  if (!ui) {
    const h = doc.createElement('div');
    setAttr(h, DRIVER_UI_ATTRIBUTE, 'cursor');
    setAttr(h, 'aria-hidden', 'true');
    const sr = attachOpenShadow(h);
    if (!sr) return null;
    const styleEl = doc.createElement('style');
    styleEl.textContent =
      ':host,[data-part]{all:initial;position:fixed;pointer-events:none;box-sizing:border-box}:host{inset:0;z-index:2147483647}[data-part=box]{border:2px solid #2563eb;background:#2563eb14}[data-part=dot]{width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:9px;background:#2563eb}[data-part=badge]{padding:2px 5px;background:#0f172a;color:#fff;font:600 11px sans-serif;white-space:nowrap}';
    const parts = ['box', 'dot', 'badge'].map((part) => {
      const d = doc!.createElement('div');
      setAttr(d, 'data-part', part);
      return d;
    });
    sr.append(styleEl, ...parts);
    ui = [h, parts[0]!, parts[1]!, parts[2]!];
  }
  if (!ui[0].isConnected) doc.documentElement.appendChild(ui[0]);
  ui[0].style.display = 'block';
  return ui;
}

export function moveCursorPoint(x: number, y: number): void {
  const m = ensureMounted();
  if (m) place(m[2], x, y);
}

export function showCursorStep(
  stepIndex: number,
  totalSteps: number,
  label: string,
  rect?: DOMRect,
  pointX?: number,
  pointY?: number,
): void {
  const m = ensureMounted();
  if (!m) return;
  const [, boxEl, dotEl, badgeEl] = m;
  badgeEl.textContent = `${stepIndex + 1}/${totalSteps} ${label}`;
  place(badgeEl, rect ? Math.max(4, rect.left) : 8, rect ? Math.max(4, rect.top - 22) : 8);
  if (rect) {
    place(
      boxEl,
      rect.left,
      rect.top,
      `;width:${px(Math.max(2, rect.width))};height:${px(Math.max(2, rect.height))}`,
    );
    place(dotEl, pointX ?? rect.left + rect.width / 2, pointY ?? rect.top + rect.height / 2);
  } else {
    hideEl(boxEl);
    if (pointX !== undefined && pointY !== undefined) place(dotEl, pointX, pointY);
    else hideEl(dotEl);
  }
}

export function hideCursorOverlay(): void {
  hideEl(ui?.[0]);
}

export type HumanTakeoverGuard = [tripped: boolean, wake: (() => void) | null, dispose: () => void];

export function installHumanTakeoverGuard(): HumanTakeoverGuard {
  const onInput = (ev: Event): void => {
    if (!guard[0] && isTrustedEvent(ev)) {
      guard[0] = true;
      guard[1]?.();
      guard[1] = null;
    }
  };
  const bind = (
    fn: typeof onEvent | typeof offEvent,
    opts: boolean | AddEventListenerOptions,
  ): void => {
    if (win) {
      for (const t of TAKEOVER_EVENTS) fn(win, t, onInput, opts);
    }
  };
  const guard: HumanTakeoverGuard = [
    false,
    null,
    (): void => {
      guard[1] = null;
      bind(offEvent, true);
    },
  ];
  bind(onEvent, { capture: true, passive: true });
  return guard;
}
