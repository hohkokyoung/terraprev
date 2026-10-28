// Where the diagram starts, and where it moves when a resource is selected.
//
// Fitting a whole stack into the canvas usually shrinks 12px labels to ~4px. Instead the diagram
// opens at a zoom where labels can be read, fills the canvas along the drawing's short side, and
// scrolls along the long side to what matters (see `focus` in Diagram.tsx).

export interface Rect { x: number; y: number; width: number; height: number }
export interface Viewport { x: number; y: number; zoom: number }

/** Below this, 12px node labels drop under ~8px on screen. */
export const READABLE_ZOOM = 0.7;
/** Never open larger than life. */
const MAX_START_ZOOM = 1;
/** Screen pixels kept clear around the drawing; the top clears the canvas tool row. */
const INSET = { top: 52, right: 24, bottom: 24, left: 24 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function room(w: number, h: number) {
  return { w: Math.max(1, w - INSET.left - INSET.right), h: Math.max(1, h - INSET.top - INSET.bottom) };
}

/** Zoom at which the whole of `r` fits the canvas. */
export function fitZoom(r: Rect, w: number, h: number) {
  const a = room(w, h);
  return Math.min(a.w / r.width, a.h / r.height);
}

/** Viewport that puts the middle of `r` in the middle of the usable canvas. */
export function centerOn(r: Rect, zoom: number, w: number, h: number): Viewport {
  const cx = INSET.left + room(w, h).w / 2;
  const cy = INSET.top + room(w, h).h / 2;
  return { zoom, x: cx - (r.x + r.width / 2) * zoom, y: cy - (r.y + r.height / 2) * zoom };
}

/** Keep the drawing filling the canvas: never scroll past its edges into empty paper. */
export function clampToGraph(vp: Viewport, graph: Rect, w: number, h: number): Viewport {
  const axis = (t: number, start: number, size: number, pane: number, lead: number, trail: number) => {
    const s = size * vp.zoom;
    if (s <= pane - lead - trail) return lead + (pane - lead - trail - s) / 2 - start * vp.zoom;
    return clamp(t, pane - trail - (start + size) * vp.zoom, lead - start * vp.zoom);
  };
  return {
    zoom: vp.zoom,
    x: axis(vp.x, graph.x, graph.width, w, INSET.left, INSET.right),
    y: axis(vp.y, graph.y, graph.height, h, INSET.top, INSET.bottom),
  };
}

/** The opening view: the whole stack when it is readable that way, otherwise a readable slice around `focus`. */
export function startViewport(graph: Rect, focus: Rect | undefined, w: number, h: number): Viewport {
  const whole = fitZoom(graph, w, h);
  if (whole >= READABLE_ZOOM) return centerOn(graph, Math.min(whole, MAX_START_ZOOM), w, h);
  const a = room(w, h);
  const shortSide = Math.max(a.w / graph.width, a.h / graph.height);
  const zoom = clamp(shortSide, READABLE_ZOOM, MAX_START_ZOOM);
  return clampToGraph(centerOn(focus ?? graph, zoom, w, h), graph, w, h);
}

/** Whether `r` is fully on screen, clear of the tool row and edges. */
export function inView(r: Rect, vp: Viewport, w: number, h: number) {
  const x1 = r.x * vp.zoom + vp.x;
  const y1 = r.y * vp.zoom + vp.y;
  return x1 >= INSET.left && y1 >= INSET.top && x1 + r.width * vp.zoom <= w - INSET.right && y1 + r.height * vp.zoom <= h - INSET.bottom;
}

/** Whether part of `r` is cut off by the canvas edges (a few pixels of slack). */
export function cutOff(r: Rect, vp: Viewport, w: number, h: number) {
  const x1 = r.x * vp.zoom + vp.x;
  const y1 = r.y * vp.zoom + vp.y;
  return x1 < -4 || y1 < -4 || x1 + r.width * vp.zoom > w + 4 || y1 + r.height * vp.zoom > h + 4;
}

/** The whole drawing, as large as fits (never above life size). */
export function wholeViewport(graph: Rect, w: number, h: number): Viewport {
  return centerOn(graph, Math.min(fitZoom(graph, w, h), MAX_START_ZOOM), w, h);
}

/** The view after selecting `r`: unchanged if it's already readable and on screen, else centered on it. */
export function revealViewport(r: Rect, current: Viewport, graph: Rect, w: number, h: number): Viewport | undefined {
  if (current.zoom >= READABLE_ZOOM - 0.01 && inView(r, current, w, h)) return undefined;
  const zoom = Math.max(current.zoom, READABLE_ZOOM);
  return clampToGraph(centerOn(r, zoom, w, h), graph, w, h);
}

export function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
