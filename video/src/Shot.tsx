// A camera over real screenshots, drawn into a w × h viewport: it eases between focus areas and
// can show a cursor that moves and clicks. Positions are in the page's CSS pixels (see shots.json).

import { Easing, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import data from './shots.json';

export type Rect = { x: number; y: number; w: number; h: number };
export type ShotName = keyof typeof data.shots;

const MOVE = 17; // camera move length (timeline units, see useT)
export const ease = Easing.bezier(0.5, 0, 0.1, 1);

/** Playback speed: timeline units per 30 fps frame. Below 1 slows the whole video evenly. */
export const PACE = 1;

/** The current time in timeline units (30 per second at PACE 1), whatever fps the video renders at. */
export function useT(pace = PACE) {
  return (useCurrentFrame() * 30 * pace) / useVideoConfig().fps;
}

export const at = (shot: ShotName, key: string): Rect => (data.shots[shot] as Record<string, Rect>)[key];

/**
 * A click that selects a node: the app zooms its diagram onto the selection, but the video shouldn't jump.
 * From `from` on, `shot` replaces `base` with its page chrome (top bar, canvas toolbar, side panel) as
 * captured, and its diagram placed over `base`'s (by web-alb and app-asg), so only the selection and the panel change.
 */
export function selectIn(base: ShotName, shot: ShotName, from: number): ShotProps['images'] {
  const c = at(base, 'canvas');
  const tools = 50; // the canvas toolbar row: chrome, not drawing
  const W = data.width;
  const H = data.height;
  // The drawing, without the zoom buttons (bottom left), minimap (bottom right) and the panel's
  // collapse handle (right edge): chrome that stays put.
  const corner = { controls: 60, minimap: 175, height: 130, handle: 32 };
  const drawing = [
    { x: c.x, y: c.y + tools, w: c.w - corner.handle, h: c.h - tools - corner.height },
    { x: c.x + corner.controls, y: c.y + c.h - corner.height, w: c.w - corner.controls - corner.minimap, h: corner.height },
  ];
  const place = placeOver(base, shot, 'alb', 'asg');
  // Only drawing from the placed copy: its own drawing area, moved by the placement, inside base's.
  const move = (r: Rect): Rect => ({ x: r.x * place.scale + place.dx, y: r.y * place.scale + place.dy, w: r.w * place.scale, h: r.h * place.scale });
  return [
    { shot: base, from: 0 },
    { shot, from, clip: { x: 0, y: 0, w: W, h: c.y + tools } },
    { shot, from, clip: { x: c.x + c.w, y: 0, w: W - (c.x + c.w), h: H } },
    ...drawing.flatMap((a) => drawing.map((b) => ({ shot, from, clip: intersect(a, move(b)), place }))),
  ];
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
}

/** How to place `shot` over `base` so the two named elements land where they are in `base`. */
export function placeOver(base: ShotName, shot: ShotName, a: string, b: string) {
  const [pa, pb, qa, qb] = [at(base, a), at(base, b), at(shot, a), at(shot, b)];
  const scale = (pb.x - pa.x) / (qb.x - qa.x);
  return { scale, dx: pa.x - qa.x * scale, dy: pa.y - qa.y * scale };
}
export const union = (...rs: Rect[]): Rect => {
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
};

type Cam = { cx: number; cy: number; s: number };

export interface ShotProps {
  /** Viewport size in px; the page fills it at zoom 1. */
  w: number;
  h: number;
  /**
   * Screenshots in order; each one cuts in at its time, like the UI reacting to a click. `place` puts a
   * shot taken at another zoom over the first one (page px: x' = x·scale + dx), so nothing jumps at the cut;
   * `clip` shows only that part of it (page px, where it lands), e.g. the diagram but not the panel.
   */
  images: { shot: ShotName; from: number; place?: { scale: number; dx: number; dy: number }; clip?: Rect }[];
  /** Camera targets: null = whole page. Each move starts at its time; `cut` jumps there instead. */
  focus: { from: number; rect: Rect | null; zoom?: number; cut?: boolean }[];
  /** Cursor waypoints in page px; `click` shows a ripple on arrival. */
  cursor?: { at: number; x: number; y: number; click?: boolean }[];
  /** Overrides PACE for this shot (units per 30 fps frame). */
  pace?: number;
}

export function Shot({ w, h, images, focus, cursor, pace }: ShotProps) {
  const f = useT(pace);
  const k = w / data.width; // page px → viewport px

  const camFor = (r: Rect | null, maxZoom: number): Cam => {
    if (!r) return { cx: w / 2, cy: h / 2, s: 1 };
    const s = Math.max(1, Math.min(maxZoom, w / (r.w * k * 1.2), h / (r.h * k * 1.2)));
    const clamp = (v: number, half: number, size: number) => Math.min(size - half, Math.max(half, v));
    return { cx: clamp((r.x + r.w / 2) * k, w / 2 / s, w), cy: clamp((r.y + r.h / 2) * k, h / 2 / s, h), s };
  };

  // Camera: ease from the previous target to the current one.
  let cam = camFor(focus[0].rect, focus[0].zoom ?? 2.2);
  for (let i = 1; i < focus.length; i++) {
    const next = camFor(focus[i].rect, focus[i].zoom ?? 2.2);
    const t = focus[i].cut
      ? (f >= focus[i].from ? 1 : 0)
      : interpolate(f, [focus[i].from, focus[i].from + MOVE], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });
    // Zoom in log space so in/out moves feel even.
    const s = Math.exp(Math.log(cam.s) + (Math.log(next.s) - Math.log(cam.s)) * t);
    cam = { cx: cam.cx + (next.cx - cam.cx) * t, cy: cam.cy + (next.cy - cam.cy) * t, s };
  }
  const toScreen = (x: number, y: number) => ({ x: (x * k - cam.cx) * cam.s + w / 2, y: (y * k - cam.cy) * cam.s + h / 2 });

  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: w, height: h, overflow: 'hidden', background: '#f4f2ec' }}>
      <div style={{ position: 'absolute', width: w, height: h, transformOrigin: '0 0', transform: `translate(${w / 2 - cam.cx * cam.s}px, ${h / 2 - cam.cy * cam.s}px) scale(${cam.s})` }}>
        {images.map((im, i) => (
          <div
            key={i}
            style={{
              position: 'absolute', left: 0, top: 0, width: w, height: h, opacity: f >= im.from ? 1 : 0,
              ...(im.clip && { clipPath: `inset(${im.clip.y * k}px ${w - (im.clip.x + im.clip.w) * k}px ${h - (im.clip.y + im.clip.h) * k}px ${im.clip.x * k}px)` }),
            }}
          >
            <Img
              src={staticFile(`shots/${im.shot}.png`)}
              style={{
                position: 'absolute', left: 0, top: 0, width: w, height: h,
                ...(im.place && { transformOrigin: '0 0', transform: `translate(${im.place.dx * k}px, ${im.place.dy * k}px) scale(${im.place.scale})` }),
              }}
            />
          </div>
        ))}
      </div>
      {cursor && <Cursor points={cursor} frame={f} toScreen={toScreen} size={Math.max(26, 38 * (w / 1920))} />}
    </div>
  );
}

function Cursor({ points, frame, toScreen, size }: { points: NonNullable<ShotProps['cursor']>; frame: number; toScreen: (x: number, y: number) => { x: number; y: number }; size: number }) {
  let p = { x: points[0].x, y: points[0].y };
  let lastClick = -1;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const t = interpolate(frame, [a.at, b.at], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });
    if (t > 0) p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    if (b.click && frame >= b.at) lastClick = b.at;
  }
  const s = toScreen(p.x, p.y);
  const since = lastClick < 0 ? 99 : frame - lastClick;
  const press = since < 6 ? 0.85 : 1;
  const opacity = interpolate(frame, [points[0].at, points[0].at + 6], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  // The arrow's tip sits at (4, 3) of its 24-unit box.
  const tipX = (4 / 24) * size;
  const tipY = (3 / 24) * size;
  const ring = size / 38;
  return (
    <>
      {since < 18 && (() => {
        const r = interpolate(since, [0, 18], [8, 42]) * ring;
        return <div style={{ position: 'absolute', left: s.x - r, top: s.y - r, width: r * 2, height: r * 2, borderRadius: '50%', background: `rgba(31, 111, 235, ${interpolate(since, [0, 18], [0.35, 0])})` }} />;
      })()}
      <svg width={size} height={size} viewBox="0 0 24 24" style={{ position: 'absolute', left: s.x - tipX, top: s.y - tipY, opacity, transform: `scale(${press})`, transformOrigin: `${tipX}px ${tipY}px`, filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.35))' }}>
        <path d="M4 3l15 7.2-6.4 1.6 3.9 7.2-2.6 1.4-3.9-7.2L5.2 17z" fill="#111" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    </>
  );
}
