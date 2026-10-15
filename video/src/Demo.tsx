import type { ReactNode } from 'react';
import { AbsoluteFill, Easing, interpolate, Series, useVideoConfig } from 'remotion';
import { at, Caption, PACE, Shot, union, useT, type ShotName } from './Shot.tsx';

// Scene timings below are in 30 fps units (see useT); the video renders at FPS.
export const FPS = 60;
const FADE = 8; // crossfade between scenes

const diagram = { x: 420, y: 150, w: 620, h: 560 };

// The slider drag: capture.ts saved one shot per step of a real drag (drag-0 … drag-8).
const DRAG = Array.from({ length: 9 }, (_, i) => `drag-${i}` as ShotName);
const DRAG_START = 26;
const DRAG_STEP = 3;
// The track sits 36px below the top of its .slider row; the row moves down once a value is set.
const dragPoint = (i: number) => ({ x: at(DRAG[i], 'cursor').x, y: at(DRAG[i], 'slider').y + 36 });

const SCENES: { frames: number; node: ReactNode }[] = [
  { frames: 55, node: <Intro /> },
  { frames: 75, node: <Terminal /> },
  {
    frames: 80,
    node: <Shot images={[{ shot: 'overview', from: 0 }]} focus={[{ from: 0, rect: null }, { from: 16, rect: diagram, zoom: 1.5 }]} caption="Your architecture, drawn from terraform.tfstate" />,
  },
  {
    frames: 100,
    node: (
      // Into the charts: the category bar and legend, then the per-resource bars.
      <Shot
        images={[{ shot: 'overview', from: 0 }]}
        focus={[
          { from: 0, rect: diagram, zoom: 1.5 },
          { from: 6, rect: union(at('overview', 'stackbar'), at('overview', 'legend')), zoom: 3 },
          { from: 50, rect: at('overview', 'costrows'), zoom: 2.6 },
        ]}
        caption="Monthly cost from AWS's public price list"
      />
    ),
  },
  {
    frames: 95,
    node: (
      <Shot
        images={[{ shot: 'overview', from: 0 }, { shot: 'select', from: 28 }]}
        focus={[{ from: 0, rect: null }, { from: 32, rect: union(at('select', 'head'), at('select', 'lines')), zoom: 1.9 }]}
        cursor={[{ at: 2, x: 900, y: 480 }, { at: 24, x: 537, y: 605, click: true }]}
        caption="Click anything to see the cost, line by line"
      />
    ),
  },
  {
    frames: 95,
    node: (
      <Shot
        images={DRAG.map((shot, i) => ({ shot, from: i === 0 ? 0 : DRAG_START + i * DRAG_STEP }))}
        focus={[{ from: 0, rect: union(at('drag-8', 'slider'), at('drag-8', 'total')), zoom: 2 }]}
        cursor={[
          { at: 2, x: 1320, y: 440 },
          { at: 20, ...dragPoint(0), click: true },
          ...DRAG.slice(1).map((_, i) => ({ at: DRAG_START + (i + 1) * DRAG_STEP, ...dragPoint(i + 1) })),
        ]}
        caption="Usage-based costs follow your sliders"
      />
    ),
  },
  {
    frames: 120,
    node: (
      // Cuts land on the frame each click does: toggle on (flow-1), then the resource picked (flow).
      <Shot
        images={[{ shot: 'flow-0', from: 0 }, { shot: 'flow-1', from: 16 }, { shot: 'flow', from: 40 }]}
        focus={[{ from: 0, rect: null }, { from: 46, rect: { x: 240, y: 630, w: 560, h: 110 }, zoom: 2.1 }, { from: 82, rect: { x: 1225, y: 740, w: 375, h: 100 }, zoom: 2.1 }]}
        cursor={[{ at: 2, x: 700, y: 420 }, { at: 16, x: 303, y: 100, click: true }, { at: 23, x: 303, y: 100 }, { at: 40, x: 712, y: 682, click: true }]}
        caption="Trace every path that can reach a resource"
      />
    ),
  },
  {
    frames: 75,
    node: (
      <Shot
        images={[{ shot: 'access', from: 0 }]}
        focus={[{ from: 0, rect: null }, { from: 18, rect: { x: 560, y: 120, w: 540, h: 135 }, zoom: 2.1 }]}
        cursor={[{ at: 2, x: 900, y: 420 }, { at: 16, x: 842, y: 237, click: true }]}
        caption="IAM roles and security groups, on demand"
      />
    ),
  },
  {
    frames: 75,
    node: (
      <Shot
        images={[{ shot: 'report', from: 0 }]}
        focus={[{ from: 0, rect: null }, { from: 12, rect: union(at('report', 'title'), at('report', 'kpis')), zoom: 1.6 }]}
        caption="A CTO-ready brief, as Markdown or PDF"
      />
    ),
  },
  {
    frames: 85,
    node: (
      <Shot
        images={[{ shot: 'report-cost', from: 0 }]}
        focus={[{ from: 0, rect: at('report-cost', 'split'), zoom: 1.6 }, { from: 14, rect: at('report-cost', 'catbars'), zoom: 2.6 }]}
        caption="What drives the bill, by category"
      />
    ),
  },
  {
    frames: 70,
    node: (
      <Shot
        images={[{ shot: 'findings', from: 0 }]}
        focus={[{ from: 0, rect: { x: 417, y: 60, w: 766, h: 460 } }, { from: 16, rect: { x: 417, y: 90, w: 766, h: 330 } }]}
        caption="Findings, each with a concrete fix"
      />
    ),
  },
  {
    frames: 60,
    node: <Shot images={[{ shot: 'dark', from: 0 }]} focus={[{ from: 0, rect: null }, { from: 8, rect: diagram, zoom: 1.3 }]} caption="Light or dark, offline once prices are cached" />,
  },
  { frames: 80, node: <Outro /> },
];

/** The README's autoplaying loop: cost-chart zooms, slider drag, data flow. Indexes into SCENES. */
export const TEASER = [3, 5, 6];
export const TEASER_FPS = 20;

const ALL = SCENES.map((_, i) => i);
const real = (t: number, fps: number) => Math.round((t * fps) / 30 / PACE);
export const durationOf = (pick: number[], fps: number) =>
  real(pick.reduce((n, i) => n + SCENES[i].frames, 0) - FADE * (pick.length - 1), fps);
export const DURATION = durationOf(ALL, FPS);

export function Demo({ pick = ALL }: { pick?: number[] }) {
  const { width, fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: '#121316' }}>
      {/* Laid out at 1080p and scaled, so other sizes render the same video. Sequences use layout="none":
          their default wrapper is sized to the composition, which would scale twice. */}
      <div style={{ width: 1920, height: 1080, transform: `scale(${width / 1920})`, transformOrigin: '0 0', position: 'relative' }}>
        <Series>
          {pick.map((s, i) => (
            <Series.Sequence key={s} layout="none" durationInFrames={real(SCENES[s].frames, fps)} offset={i === 0 ? 0 : -real(FADE, fps)}>
              {/* The first scene of a loop starts on screen: no fade in from black. */}
              <FadeIn skip={i === 0 && pick !== ALL}>{SCENES[s].node}</FadeIn>
            </Series.Sequence>
          ))}
        </Series>
      </div>
    </AbsoluteFill>
  );
}

/** One scene's 1080p box. Sized explicitly: percentage sizes resolved against the composition, not the 1080p stage. */
function FadeIn({ children, skip }: { children: ReactNode; skip?: boolean }) {
  const f = useT();
  const opacity = skip ? 1 : interpolate(f, [0, FADE], [0, 1], { extrapolateRight: 'clamp' });
  return <div style={{ position: 'absolute', left: 0, top: 0, width: 1920, height: 1080, overflow: 'hidden', opacity }}>{children}</div>;
}

const ease = Easing.bezier(0.45, 0, 0.2, 1);
const rise = (f: number, start: number) => {
  const t = interpolate(f, [start, start + 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });
  return { opacity: t, transform: `translateY(${(1 - t) * 24}px)` };
};

function Mark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <rect x="1" y="2" width="14" height="12" rx="2" fill="none" stroke="#5b9bff" strokeWidth="1.6" />
      <rect x="1" y="2" width="5" height="12" rx="1.5" fill="#5b9bff" />
    </svg>
  );
}

function Intro() {
  const f = useT();
  return (
    <AbsoluteFill style={{ background: '#121316', color: '#ecebe6', fontFamily: 'Inter, sans-serif', alignItems: 'center', justifyContent: 'center', gap: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 22, ...rise(f, 2) }}>
        <Mark size={72} />
        <span style={{ font: '700 104px Inter', letterSpacing: '-0.035em' }}>terraprev</span>
      </div>
      <div style={{ font: '500 40px/1.35 Inter', color: '#b4b3ad', letterSpacing: '-0.01em', textAlign: 'center', ...rise(f, 9) }}>
        See your Terraform stack and what it costs on AWS,
        <br />
        every time you apply.
      </div>
    </AbsoluteFill>
  );
}

const LINES: { at: number; text: string; color?: string }[] = [
  { at: 26, text: 'Apply complete! Resources: 20 added, 0 changed, 0 destroyed.', color: '#8fcf9c' },
  { at: 36, text: '[terraprev] serial 7 · 20 resources · ~$108.36/mo', color: '#ecebe6' },
  { at: 42, text: '            → out/terraprev.html', color: '#8ab4ff' },
];

function Terminal() {
  const f = useT();
  const cmd = 'tf apply';
  const typed = cmd.slice(0, Math.max(0, Math.floor((f - 6) / 2)));
  return (
    <AbsoluteFill style={{ background: '#121316', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 1360, borderRadius: 18, background: '#1c1d22', border: '1px solid #2a2b31', boxShadow: '0 30px 80px rgba(0,0,0,0.45)', overflow: 'hidden', ...rise(f, 0) }}>
        <div style={{ display: 'flex', gap: 10, padding: '18px 22px', borderBottom: '1px solid #2a2b31' }}>
          {['#ff5f57', '#febc2e', '#28c840'].map((c) => <i key={c} style={{ width: 14, height: 14, borderRadius: 7, background: c }} />)}
        </div>
        <div style={{ padding: '30px 36px 40px', font: '400 30px/1.7 "JetBrains Mono", monospace', color: '#ecebe6', minHeight: 300 }}>
          <div>
            <span style={{ color: '#7c7c78' }}>~/my-stack $ </span>
            {typed}
            {f < 26 && <span style={{ opacity: Math.floor(f / 8) % 2 ? 0 : 1 }}>▍</span>}
          </div>
          {LINES.filter((l) => f >= l.at).map((l) => <div key={l.text} style={{ color: l.color, whiteSpace: 'pre' }}>{l.text}</div>)}
        </div>
      </div>
      <Caption text="Wraps terraform apply: a fresh snapshot every time" frame={f} />
    </AbsoluteFill>
  );
}

function Outro() {
  const f = useT();
  return (
    <AbsoluteFill style={{ background: '#121316', color: '#ecebe6', fontFamily: 'Inter, sans-serif', alignItems: 'center', justifyContent: 'center', gap: 40 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, ...rise(f, 3) }}>
        <Mark size={56} />
        <span style={{ font: '700 80px Inter', letterSpacing: '-0.035em' }}>terraprev</span>
      </div>
      <div style={{ display: 'flex', gap: 18, ...rise(f, 10) }}>
        {['No AWS account', 'No credentials', 'Nothing uploaded'].map((t) => (
          <span key={t} style={{ font: '600 30px Inter', padding: '12px 24px', borderRadius: 999, border: '1px solid #3a3b42', color: '#b4b3ad' }}>{t}</span>
        ))}
      </div>
      <div style={{ font: '400 34px "JetBrains Mono", monospace', color: '#8ab4ff', background: '#1c1d22', border: '1px solid #2a2b31', padding: '18px 32px', borderRadius: 12, ...rise(f, 17) }}>
        npm run snapshot -- --open
      </div>
    </AbsoluteFill>
  );
}
