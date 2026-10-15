// The feature tour: one beat per feature, each a title and a line of copy beside the real app in a
// browser window. `Demo` (full video) wraps the beats in an intro and outro; `Teaser` (the README's
// autoplaying loop) is the beats alone. Times are timeline units (30 per second at PACE 1, see useT).

import type { ReactNode } from 'react';
import { AbsoluteFill, interpolate, Series, useVideoConfig } from 'remotion';
import { at, ease, PACE, Shot, union, useT, type ShotName } from './Shot.tsx';

export const FPS = 60;
export const TEASER_FPS = 20;
const FADE = 8; // crossfade between beats

// Stage layout (1920 × 1080; other sizes scale it).
const TEXT = { left: 110, width: 450 };
const WIN = { left: 620, top: 172, w: 1200, bar: 44 };
const VIEW = { w: WIN.w, h: Math.round((WIN.w * 9) / 16) };

// The diagram beats use close-ups (shots 'diagram', 'dark') captured at the app's own zoom, so boxes stay crisp.
const vpc = union(at('diagram', 'vpc'), at('diagram', 'internet')); // the VPC with its subnets
const traffic = union(at('diagram', 'internet'), at('diagram', 'alb'), at('diagram', 'asg')); // Internet → ALB → ASG

// The slider drag: capture.ts saved one shot per step of a real drag (drag-0 … drag-8).
const DRAG = Array.from({ length: 9 }, (_, i) => `drag-${i}` as ShotName);
const DRAG_START = 26;
const DRAG_STEP = 3;
// The track sits 36px below the top of its .slider row; the row moves down once a value is set.
const dragPoint = (i: number) => ({ x: at(DRAG[i], 'cursor').x, y: at(DRAG[i], 'slider').y + 36 });

type Beat = { frames: number; title: string; body: string; view: ReactNode };

const shot = (props: Omit<Parameters<typeof Shot>[0], 'w' | 'h'>) => <Shot w={VIEW.w} h={VIEW.h} {...props} />;

const BEATS: Beat[] = [
  {
    frames: 90,
    title: 'Runs on every apply',
    body: 'Use bin/tf in place of terraform: each apply rebuilds the snapshot.',
    view: <Terminal />,
  },
  {
    frames: 95,
    title: 'Your architecture, drawn from state',
    body: 'Cloud → VPC → subnets → resources, with traffic arrows from real relationships.',
    view: shot({ images: [{ shot: 'diagram', from: 0 }], focus: [{ from: 0, rect: null }, { from: 12, rect: vpc, zoom: 1.7 }, { from: 52, rect: traffic, zoom: 2.4 }] }),
  },
  {
    frames: 115,
    title: 'Monthly cost, from AWS prices',
    body: 'On-demand prices for your region. Anything unpriced is listed, never counted as $0.',
    view: shot({
      images: [{ shot: 'overview', from: 0 }],
      focus: [
        { from: 0, rect: null },
        { from: 10, rect: union(at('overview', 'total'), at('overview', 'stackbar'), at('overview', 'legend')), zoom: 3 },
        { from: 60, rect: at('overview', 'costrows'), zoom: 3 },
      ],
    }),
  },
  {
    frames: 115,
    title: 'Every dollar, line by line',
    body: 'Click a resource: quantity × unit price, with the SKU and price file behind it.',
    view: shot({
      images: [{ shot: 'overview', from: 0 }, { shot: 'select', from: 28 }],
      focus: [{ from: 0, rect: null }, { from: 34, rect: at('select', 'head'), zoom: 2.6 }, { from: 72, rect: at('select', 'lines'), zoom: 2.6 }],
      cursor: [{ at: 2, x: 900, y: 480 }, { at: 26, x: 537, y: 605, click: true }],
    }),
  },
  {
    frames: 110,
    title: 'Usage you control',
    body: 'Set traffic for usage-based charges and watch the total follow.',
    view: shot({
      images: DRAG.map((s, i) => ({ shot: s, from: i === 0 ? 0 : DRAG_START + i * DRAG_STEP })),
      focus: [{ from: 0, rect: union(at('drag-8', 'slider'), at('drag-8', 'total')), zoom: 3 }],
      cursor: [
        { at: 2, x: 1320, y: 440 },
        { at: 20, ...dragPoint(0), click: true },
        ...DRAG.slice(1).map((_, i) => ({ at: DRAG_START + (i + 1) * DRAG_STEP, ...dragPoint(i + 1) })),
      ],
    }),
  },
  {
    frames: 125,
    title: 'Trace what can reach it',
    body: 'Turn on Data flow, pick a resource, and every path to it lights up.',
    view: shot({
      // Cuts land on the frame each click does: toggle on (flow-1), then the resource picked (flow).
      images: [{ shot: 'flow-0', from: 0 }, { shot: 'flow-1', from: 16 }, { shot: 'flow', from: 40 }],
      focus: [{ from: 0, rect: null }, { from: 46, rect: { x: 240, y: 630, w: 560, h: 110 }, zoom: 2.6 }, { from: 84, rect: { x: 1225, y: 740, w: 375, h: 100 }, zoom: 2.8 }],
      cursor: [{ at: 2, x: 700, y: 420 }, { at: 16, x: 303, y: 100, click: true }, { at: 23, x: 303, y: 100 }, { at: 40, x: 712, y: 682, click: true }],
    }),
  },
  {
    frames: 90,
    title: 'Access in plain English',
    body: 'Expand a resource to draw its IAM role, policies and security groups.',
    view: shot({
      images: [{ shot: 'access', from: 0 }],
      focus: [{ from: 0, rect: null }, { from: 22, rect: { x: 560, y: 120, w: 540, h: 135 }, zoom: 2.6 }],
      cursor: [{ at: 2, x: 900, y: 420 }, { at: 18, x: 842, y: 237, click: true }],
    }),
  },
  {
    frames: 120,
    title: 'A brief for your CTO',
    body: 'Summary, cost drivers, findings and inventory, as Markdown or PDF.',
    view: shot({
      // The second shot is the same page scrolled to the cost section: the pan reads as a scroll.
      images: [{ shot: 'report', from: 0 }, { shot: 'report-cost', from: 60 }],
      focus: [{ from: 0, rect: null }, { from: 10, rect: union(at('report', 'title'), at('report', 'kpis')), zoom: 2 }, { from: 60, rect: at('report-cost', 'catbars'), zoom: 2.8 }],
    }),
  },
  {
    frames: 95,
    title: 'Findings with fixes',
    body: 'Rule-based checks for backups, encryption, IMDSv1, open ports and more.',
    view: shot({
      images: [{ shot: 'findings', from: 0 }],
      focus: [{ from: 0, rect: { x: 417, y: 60, w: 766, h: 460 }, zoom: 2 }, { from: 20, rect: { x: 417, y: 90, w: 766, h: 330 }, zoom: 2.2 }],
    }),
  },
  {
    frames: 90,
    title: 'Light or dark, all local',
    body: 'No AWS account or credentials. Offline once prices are cached.',
    view: shot({ images: [{ shot: 'dark', from: 0 }], focus: [{ from: 0, rect: null }, { from: 12, rect: vpc, zoom: 1.7 }] }),
  },
];

const INTRO = 55;
const OUTRO = 85;

const real = (t: number, fps: number) => Math.round((t * fps) / 30 / PACE);
const spanOf = (frames: number[]) => frames.reduce((a, b) => a + b, 0) - FADE * (frames.length - 1);
const TOUR = spanOf(BEATS.map((b) => b.frames));
/** Where each beat starts on the tour timeline. */
const STARTS = BEATS.map((_, i) => BEATS.slice(0, i).reduce((n, b) => n + b.frames - FADE, 0));

export const DURATION = real(spanOf([INTRO, TOUR, OUTRO]), FPS);
export const TEASER_DURATION = real(TOUR, TEASER_FPS);

/** Full video: intro, the tour, outro. */
export function Demo() {
  const { fps } = useVideoConfig();
  return (
    <Stage>
      <Series>
        <Series.Sequence layout="none" durationInFrames={real(INTRO, fps)}>
          <Scene>
            <Intro />
          </Scene>
        </Series.Sequence>
        <Series.Sequence layout="none" durationInFrames={real(TOUR, fps)} offset={-real(FADE, fps)}>
          <Scene fade>
            <Tour />
          </Scene>
        </Series.Sequence>
        <Series.Sequence layout="none" durationInFrames={real(OUTRO, fps)} offset={-real(FADE, fps)}>
          <Scene fade>
            <Outro />
          </Scene>
        </Series.Sequence>
      </Series>
    </Stage>
  );
}

/** The README loop: the tour alone. */
export function Teaser() {
  return (
    <Stage>
      <Tour />
    </Stage>
  );
}

/** Lays everything out at 1920 × 1080 and scales it to the composition. */
function Stage({ children }: { children: ReactNode }) {
  const { width } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: '#121316' }}>
      <div style={{ position: 'relative', width: 1920, height: 1080, transform: `scale(${width / 1920})`, transformOrigin: '0 0' }}>{children}</div>
    </AbsoluteFill>
  );
}

/** A full-stage layer. Sized explicitly: percentage sizes would resolve against the composition, not the stage. */
function Scene({ children, fade }: { children: ReactNode; fade?: boolean }) {
  const f = useT();
  const opacity = fade ? interpolate(f, [0, FADE], [0, 1], { extrapolateRight: 'clamp' }) : 1;
  return <div style={{ position: 'absolute', left: 0, top: 0, width: 1920, height: 1080, overflow: 'hidden', opacity }}>{children}</div>;
}

function Tour() {
  const { fps } = useVideoConfig();
  const t = useT();
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: 1920, height: 1080, background: 'radial-gradient(1200px 700px at 75% 45%, #1d2230 0%, #121316 70%)', fontFamily: 'Inter, sans-serif', color: '#ecebe6' }}>
      <div style={{ position: 'absolute', left: TEXT.left, top: 76, display: 'flex', alignItems: 'center', gap: 14 }}>
        <Mark size={34} />
        <span style={{ font: '700 34px Inter', letterSpacing: '-0.03em' }}>terraprev</span>
      </div>

      {/* Browser window: the frame stays put, beats swap what is inside it. */}
      <div style={{ position: 'absolute', left: WIN.left, top: WIN.top, width: WIN.w, height: WIN.bar + VIEW.h, borderRadius: 16, overflow: 'hidden', background: '#1c1d22', border: '1px solid #2e3038', boxShadow: '0 40px 100px rgba(0,0,0,0.5)' }}>
        <div style={{ height: WIN.bar, display: 'flex', alignItems: 'center', gap: 9, padding: '0 18px', borderBottom: '1px solid #2e3038' }}>
          {['#ff5f57', '#febc2e', '#28c840'].map((c) => <i key={c} style={{ width: 13, height: 13, borderRadius: 7, background: c }} />)}
          <span style={{ margin: '0 auto', font: '500 17px Inter', color: '#8b8d94', background: '#15161a', padding: '5px 60px', borderRadius: 8 }}>out/terraprev.html</span>
        </div>
      </div>

      <Series>
        {BEATS.map((b, i) => (
          <Series.Sequence key={i} layout="none" durationInFrames={real(b.frames, fps)} offset={i === 0 ? 0 : -real(FADE, fps)}>
            <BeatLayer beat={b} index={i} first={i === 0} />
          </Series.Sequence>
        ))}
      </Series>

      {/* Progress: one segment per beat. */}
      <div style={{ position: 'absolute', left: TEXT.left, width: WIN.left + WIN.w - TEXT.left, top: 992, display: 'flex', gap: 10 }}>
        {BEATS.map((b, i) => {
          const fill = interpolate(t, [STARTS[i], STARTS[i] + b.frames - FADE], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
          return (
            <div key={i} style={{ flex: 1, height: 5, borderRadius: 3, background: '#2a2c33', overflow: 'hidden' }}>
              <div style={{ width: `${fill * 100}%`, height: 5, background: '#5b9bff' }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BeatLayer({ beat, index, first }: { beat: Beat; index: number; first: boolean }) {
  const t = useT();
  // The view crossfades in over the previous beat; the copy waits for the old copy to leave.
  const viewIn = first ? 1 : interpolate(t, [0, FADE], [0, 1], { extrapolateRight: 'clamp' });
  const out = interpolate(t, [beat.frames - FADE - 6, beat.frames - FADE], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const rise = (start: number) => {
    const p = interpolate(t, [start, start + 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });
    return { opacity: p * out, transform: `translateY(${(1 - p) * 18}px)` };
  };
  return (
    <>
      <div style={{ position: 'absolute', left: WIN.left, top: WIN.top + WIN.bar, width: VIEW.w, height: VIEW.h, overflow: 'hidden', borderRadius: '0 0 16px 16px', opacity: viewIn }}>
        {beat.view}
      </div>
      <div style={{ position: 'absolute', left: TEXT.left, width: TEXT.width, top: 0, height: 1080, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 22 }}>
        <div style={{ font: '600 22px "JetBrains Mono", monospace', color: '#5b9bff', letterSpacing: '0.04em', ...rise(4) }}>
          {String(index + 1).padStart(2, '0')} / {String(BEATS.length).padStart(2, '0')}
        </div>
        <div style={{ font: '700 54px/1.12 Inter', letterSpacing: '-0.03em', ...rise(7) }}>{beat.title}</div>
        <div style={{ font: '400 29px/1.45 Inter', color: '#a9a8a3', letterSpacing: '-0.005em', ...rise(11) }}>{beat.body}</div>
      </div>
    </>
  );
}

function Mark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <rect x="1" y="2" width="14" height="12" rx="2" fill="none" stroke="#5b9bff" strokeWidth="1.6" />
      <rect x="1" y="2" width="5" height="12" rx="1.5" fill="#5b9bff" />
    </svg>
  );
}

const riseAt = (f: number, start: number) => {
  const p = interpolate(f, [start, start + 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });
  return { opacity: p, transform: `translateY(${(1 - p) * 24}px)` };
};

function Intro() {
  const f = useT();
  return (
    <AbsoluteFill style={{ background: '#121316', color: '#ecebe6', fontFamily: 'Inter, sans-serif', alignItems: 'center', justifyContent: 'center', gap: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 22, ...riseAt(f, 2) }}>
        <Mark size={72} />
        <span style={{ font: '700 104px Inter', letterSpacing: '-0.035em' }}>terraprev</span>
      </div>
      <div style={{ font: '500 40px/1.35 Inter', color: '#b4b3ad', letterSpacing: '-0.01em', textAlign: 'center', ...riseAt(f, 9) }}>
        See your Terraform stack and what it costs on AWS,
        <br />
        every time you apply.
      </div>
    </AbsoluteFill>
  );
}

const LINES: { at: number; text: string; color: string }[] = [
  { at: 28, text: 'Apply complete! Resources: 20 added, 0 changed, 0 destroyed.', color: '#8fcf9c' },
  { at: 40, text: '[terraprev] serial 7 · 20 resources · ~$108.36/mo', color: '#ecebe6' },
  { at: 48, text: '            → out/terraprev.html', color: '#8ab4ff' },
];

/** The first beat's view: the terraform wrapper in a terminal. */
function Terminal() {
  const f = useT();
  const cmd = 'bin/tf apply';
  const typed = cmd.slice(0, Math.max(0, Math.floor((f - 6) / 1.6)));
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: VIEW.w, height: VIEW.h, background: '#15161a', padding: '44px 48px', boxSizing: 'border-box', font: '400 25px/1.75 "JetBrains Mono", monospace', color: '#ecebe6' }}>
      <div>
        <span style={{ color: '#7c7c78' }}>~/my-stack $ </span>
        {typed}
        {f < 28 && <span style={{ opacity: Math.floor(f / 8) % 2 ? 0 : 1 }}>▍</span>}
      </div>
      {LINES.filter((l) => f >= l.at).map((l) => <div key={l.text} style={{ color: l.color, whiteSpace: 'pre' }}>{l.text}</div>)}
    </div>
  );
}

function Outro() {
  const f = useT();
  return (
    <AbsoluteFill style={{ background: '#121316', color: '#ecebe6', fontFamily: 'Inter, sans-serif', alignItems: 'center', justifyContent: 'center', gap: 40 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, ...riseAt(f, 3) }}>
        <Mark size={56} />
        <span style={{ font: '700 80px Inter', letterSpacing: '-0.035em' }}>terraprev</span>
      </div>
      <div style={{ display: 'flex', gap: 18, ...riseAt(f, 10) }}>
        {['No AWS account', 'No credentials', 'Nothing uploaded'].map((x) => (
          <span key={x} style={{ font: '600 30px Inter', padding: '12px 24px', borderRadius: 999, border: '1px solid #3a3b42', color: '#b4b3ad' }}>{x}</span>
        ))}
      </div>
      <div style={{ font: '400 34px "JetBrains Mono", monospace', color: '#8ab4ff', background: '#1c1d22', border: '1px solid #2a2b31', padding: '18px 32px', borderRadius: 12, ...riseAt(f, 17) }}>
        npm run snapshot -- --open
      </div>
    </AbsoluteFill>
  );
}
