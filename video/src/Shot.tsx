// One scene over real screenshots: a camera that eases between focus areas, an optional cursor
// that moves and clicks, and a caption. Positions are in the page's CSS pixels (see shots.json).

import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame } from 'remotion';
import data from './shots.json';

export type Rect = { x: number; y: number; w: number; h: number };
type ShotName = keyof typeof data.shots;

const VW = 1920;
const VH = 1080;
const K = VW / data.width; // page px → video px
const MOVE = 28; // frames per camera move
const ease = Easing.bezier(0.45, 0, 0.2, 1);

export const at = (shot: ShotName, key: string): Rect => (data.shots[shot] as Record<string, Rect>)[key];
export const union = (...rs: Rect[]): Rect => {
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
};

type Cam = { cx: number; cy: number; s: number };

function camFor(r: Rect | null, maxZoom: number): Cam {
  if (!r) return { cx: VW / 2, cy: VH / 2, s: 1 };
  const s = Math.max(1, Math.min(maxZoom, VW / (r.w * K * 1.35), VH / (r.h * K * 1.35)));
  const clamp = (v: number, half: number, size: number) => Math.min(size - half, Math.max(half, v));
  return {
    cx: clamp((r.x + r.w / 2) * K, VW / 2 / s, VW),
    cy: clamp((r.y + r.h / 2) * K, VH / 2 / s, VH),
    s,
  };
}

export interface ShotProps {
  /** Screenshots in order; each one fades in at its frame. */
  images: { shot: ShotName; from: number }[];
  /** Camera targets: null = whole page. Each move starts at its frame. */
  focus: { from: number; rect: Rect | null; zoom?: number }[];
  /** Cursor waypoints in page px; `click` shows a ripple on arrival. */
  cursor?: { at: number; x: number; y: number; click?: boolean }[];
  caption: string;
}

export function Shot({ images, focus, cursor, caption }: ShotProps) {
  const f = useCurrentFrame();

  // Camera: ease from the previous target to the current one.
  let cam = camFor(focus[0].rect, focus[0].zoom ?? 2.2);
  for (let i = 1; i < focus.length; i++) {
    const next = camFor(focus[i].rect, focus[i].zoom ?? 2.2);
    const t = interpolate(f, [focus[i].from, focus[i].from + MOVE], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });
    // Zoom in log space so in/out moves feel even.
    const s = Math.exp(Math.log(cam.s) + (Math.log(next.s) - Math.log(cam.s)) * t);
    cam = { cx: cam.cx + (next.cx - cam.cx) * t, cy: cam.cy + (next.cy - cam.cy) * t, s };
  }
  const toScreen = (x: number, y: number) => ({ x: (x * K - cam.cx) * cam.s + VW / 2, y: (y * K - cam.cy) * cam.s + VH / 2 });

  return (
    <AbsoluteFill style={{ background: '#f4f2ec', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', width: VW, height: VH, transformOrigin: '0 0', transform: `translate(${VW / 2 - cam.cx * cam.s}px, ${VH / 2 - cam.cy * cam.s}px) scale(${cam.s})` }}>
        {images.map((im) => (
          <Img
            key={im.shot}
            src={staticFile(`shots/${im.shot}.png`)}
            style={{ position: 'absolute', inset: 0, width: VW, height: VH, opacity: interpolate(f, [im.from, im.from + 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) }}
          />
        ))}
      </div>
      {cursor && <Cursor points={cursor} frame={f} toScreen={toScreen} />}
      <Caption text={caption} frame={f} />
    </AbsoluteFill>
  );
}

function Cursor({ points, frame, toScreen }: { points: NonNullable<ShotProps['cursor']>; frame: number; toScreen: (x: number, y: number) => { x: number; y: number } }) {
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
  return (
    <>
      {since < 18 && (
        <div style={{
          position: 'absolute', left: s.x, top: s.y, width: 0, height: 0,
          boxShadow: `0 0 0 ${interpolate(since, [0, 18], [6, 46])}px rgba(31, 111, 235, ${interpolate(since, [0, 18], [0.45, 0])})`, borderRadius: '50%',
        }} />
      )}
      <svg width="38" height="38" viewBox="0 0 24 24" style={{ position: 'absolute', left: s.x - 4, top: s.y - 3, opacity, transform: `scale(${press})`, transformOrigin: '4px 3px', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.35))' }}>
        <path d="M4 3l15 7.2-6.4 1.6 3.9 7.2-2.6 1.4-3.9-7.2L5.2 17z" fill="#111" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    </>
  );
}

export function Caption({ text, frame }: { text: string; frame: number }) {
  const t = interpolate(frame, [6, 20], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 64, display: 'flex', justifyContent: 'center', opacity: t, transform: `translateY(${(1 - t) * 16}px)` }}>
      <div style={{
        font: '600 38px/1.2 Inter, sans-serif', letterSpacing: '-0.015em', color: '#fff',
        background: 'rgba(18, 19, 22, 0.88)', padding: '18px 30px', borderRadius: 14, boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
      }}>
        {text}
      </div>
    </div>
  );
}
