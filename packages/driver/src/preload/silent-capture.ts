import type { CaptureRpcParams } from '../protocol.js';
import type { CaptureResult, ScreenshotCaptureOptions } from '../types.js';
import {
  CanvasEl,
  El,
  HostImage,
  HostXMLSerializer,
  TextAreaEl,
  VideoEl,
  cloneNode,
  doc,
  formControlValue,
  getBoundingClientRect,
  getComposedChildNodes,
  getComputedStyleSafe,
  is,
  normSpace,
  rawAttr,
  setAttr,
  tag,
} from './intrinsics.js';
import { isElementHidden } from './observe.js';
import { resolveTarget } from './ref-registry.js';

function inlineSvgStyles(orig: Element, copy: Element): void {
  const cs = getComputedStyleSafe(orig);
  if (cs) {
    setAttr(
      copy,
      'style',
      `${rawAttr(orig, 'style') ?? ''};color:${cs.color};fill:${cs.fill};stroke:${cs.stroke};stroke-width:${cs.strokeWidth};opacity:${cs.opacity}`,
    );
  }
  for (let i = 0; i < orig.children.length; i++) {
    inlineSvgStyles(orig.children[i]!, copy.children[i]!);
  }
}

export async function captureInPreload(params: CaptureRpcParams): Promise<CaptureResult> {
  const p = params as ScreenshotCaptureOptions; // Invariant: host capture seam handles recording modes and only sends screenshot to preload
  const r = p.target
    ? getBoundingClientRect(resolveTarget(p.target))
    : new DOMRect(0, 0, innerWidth, innerHeight);
  const c = doc!.createElement('canvas');
  const width = (c.width = Math.round(r.width) || 1);
  const height = (c.height = Math.round(r.height) || 1);
  const g = c.getContext('2d')!;
  g.translate(-r.x, -r.y);
  g.fillStyle = '#fff';
  g.fillRect(r.x, r.y, width, height);
  const rootEl = doc!.documentElement;
  const walk = async (el: Element): Promise<void> => {
    const s = !isElementHidden(el, false) && getComputedStyleSafe(el);
    if (!s || !+s.opacity) return;
    const d = el === rootEl || el === doc!.body ? r : getBoundingClientRect(el);
    const b = parseInt(s.borderWidth);
    const t = tag(el);
    g.fillStyle = s.backgroundColor;
    g.fillRect(d.x, d.y, d.width, d.height);
    if (b) {
      g.strokeStyle = s.borderColor;
      g.lineWidth = b;
      g.strokeRect(d.x, d.y, d.width, d.height);
    }
    if (is(el, CanvasEl) || is(el, VideoEl) || is(el, HostImage) || t === 'svg') {
      try {
        let m: CanvasImageSource = el as CanvasImageSource; // Invariant: narrowed to canvas, video, img, or svg
        if (t === 'svg' && HostImage && HostXMLSerializer) {
          const copy = cloneNode(el, true) as Element; // Invariant: cloning an Element yields an Element
          inlineSvgStyles(el, copy);
          const img = new HostImage();
          img.src =
            'data:image/svg+xml,' +
            encodeURIComponent(new HostXMLSerializer().serializeToString(copy));
          await img.decode();
          m = img;
        }
        g.drawImage(m, d.x, d.y, d.width, d.height);
      } catch {
        // Ignore tainted canvas or unready media sources.
      }
      return;
    }
    const fv = formControlValue(el);
    const pre = is(el, TextAreaEl) || s.whiteSpace.startsWith('pre');
    let tx = fv ?? '';
    const ch = fv === null ? getComposedChildNodes(el) : [];
    for (const child of ch) if (child.nodeType === 3) tx += (pre ? '' : ' ') + child.nodeValue;
    if (!pre) tx = normSpace(tx);
    if (tx.trim() && d.width > 0 && d.height > 0) {
      g.save();
      g.beginPath();
      g.rect(d.x, d.y, d.width, d.height);
      g.clip();
      g.font = s.font;
      g.fillStyle = s.color;
      const num = (v: string, fb: number): number => parseFloat(v) || fb;
      const fs = num(s.fontSize, 14);
      const lh = num(s.lineHeight, fs * 1.3);
      const padL = num(s.paddingLeft, 6);
      const availW = d.width - 2 * b - padL - num(s.paddingRight, 6);
      const wrap = availW > 8 && s.whiteSpace !== 'pre' && s.whiteSpace !== 'nowrap';
      const x0 = d.x + b + padL - el.scrollLeft;
      let y0 = d.y + b + num(s.paddingTop, 4) + fs - el.scrollTop;
      const drawLn = (ln: string): void => {
        if (y0 + lh > d.y && y0 - fs < d.y + d.height) g.fillText(ln, x0, y0);
        y0 += lh;
      };
      for (const rawLn of pre ? tx.split('\n') : [tx]) {
        let cur = '';
        for (const w of wrap && rawLn ? rawLn.split(/(\s+)/) : [rawLn]) {
          if (cur && g.measureText(cur + w).width > availW) {
            drawLn(cur.trimEnd());
            cur = w.trimStart();
          } else cur += w;
        }
        drawLn(cur);
      }
      g.restore();
    }
    for (const child of ch) if (is(child, El)) await walk(child);
  };
  if (rootEl) await walk(rootEl);
  const blob = await new Promise<Blob>((res) =>
    c.toBlob(
      res as BlobCallback, // Invariant: non-empty canvas produces a non-null Blob
      'image/' + (p.format === 'png' ? 'png' : 'webp'),
      p.quality ?? 0.85,
    ),
  );
  return {
    mimeType: blob.type,
    bytes: await blob.bytes(),
    width,
    height,
    modeUsed: 'silent',
  };
}
