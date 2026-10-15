import type { ReactNode } from 'react';
import { AbsoluteFill, Easing, interpolate, Series, useCurrentFrame, useVideoConfig } from 'remotion';
import { at, Caption, Shot, union } from './Shot.tsx';

export const FPS = 30;
const FADE = 10; // crossfade between scenes, in frames

const diagram = { x: 410, y: 150, w: 640, h: 650 };

const SCENES: { frames: number; node: ReactNode }[] = [
  { frames: 80, node: <Intro /> },
  { frames: 105, node: <Terminal /> },
  {
    frames: 110,
    node: <Shot images={[{ shot: 'overview', from: 0 }]} focus={[{ from: 0, rect: null }, { from: 25, rect: diagram, zoom: 1.5 }]} caption="Your architecture, drawn from terraform.tfstate" />,
  },
  {
    frames: 100,
    node: (
      <Shot
        images={[{ shot: 'overview', from: 0 }]}
        focus={[{ from: 0, rect: diagram, zoom: 1.5 }, { from: 12, rect: { x: 1220, y: 0, w: 380, h: 470 }, zoom: 2 }]}
        caption="Monthly cost from AWS's public price list"
      />
    ),
  },
  {
    frames: 130,
    node: (
      <Shot
        images={[{ shot: 'overview', from: 0 }, { shot: 'select', from: 40 }]}
        focus={[{ from: 0, rect: null }, { from: 48, rect: union(at('select', 'head'), at('select', 'lines')), zoom: 1.9 }]}
        cursor={[{ at: 4, x: 900, y: 480 }, { at: 36, x: 537, y: 605, click: true }]}
        caption="Click anything to see the cost, line by line"
      />
    ),
  },
  {
    frames: 120,
    node: (
      <Shot
        images={[{ shot: 'usage', from: 0 }, { shot: 'usage-max', from: 58 }]}
        focus={[{ from: 0, rect: union(at('usage', 'slider'), at('usage', 'total')), zoom: 2 }]}
        cursor={[{ at: 4, x: 1320, y: 420 }, { at: 30, x: 1250, y: 332, click: true }, { at: 58, x: 1578, y: 332 }]}
        caption="Usage-based costs follow your sliders"
      />
    ),
  },
  {
    frames: 140,
    node: (
      <Shot
        images={[{ shot: 'overview', from: 0 }, { shot: 'flow', from: 44 }]}
        focus={[{ from: 0, rect: null }, { from: 52, rect: { x: 240, y: 630, w: 560, h: 110 }, zoom: 2.1 }, { from: 98, rect: { x: 1225, y: 740, w: 375, h: 100 }, zoom: 2.1 }]}
        cursor={[{ at: 4, x: 700, y: 420 }, { at: 20, x: 303, y: 100, click: true }, { at: 42, x: 712, y: 682, click: true }]}
        caption="Trace every path that can reach a resource"
      />
    ),
  },
  {
    frames: 105,
    node: (
      <Shot
        images={[{ shot: 'access', from: 0 }]}
        focus={[{ from: 0, rect: null }, { from: 26, rect: { x: 560, y: 120, w: 540, h: 135 }, zoom: 2.1 }]}
        cursor={[{ at: 2, x: 900, y: 420 }, { at: 22, x: 842, y: 237, click: true }]}
        caption="IAM roles and security groups, on demand"
      />
    ),
  },
  {
    frames: 105,
    node: (
      <Shot
        images={[{ shot: 'report', from: 0 }]}
        focus={[{ from: 0, rect: null }, { from: 22, rect: union(at('report', 'title'), at('report', 'kpis')), zoom: 1.6 }]}
        caption="A CTO-ready brief, as Markdown or PDF"
      />
    ),
  },
  {
    frames: 105,
    node: (
      <Shot
        images={[{ shot: 'findings', from: 0 }]}
        focus={[{ from: 0, rect: { x: 417, y: 60, w: 766, h: 460 } }, { from: 30, rect: { x: 417, y: 90, w: 766, h: 330 } }]}
        caption="Findings, each with a concrete fix"
      />
    ),
  },
  {
    frames: 85,
    node: <Shot images={[{ shot: 'dark', from: 0 }]} focus={[{ from: 0, rect: null }, { from: 15, rect: diagram, zoom: 1.3 }]} caption="Light or dark, fully offline" />,
  },
  { frames: 110, node: <Outro /> },
];

export const DURATION = SCENES.reduce((n, s) => n + s.frames, 0) - FADE * (SCENES.length - 1);

export function Demo() {
  const { width } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: '#121316' }}>
      {/* Laid out at 1080p and scaled, so the GIF composition is the same video, smaller. */}
      <div style={{ width: 1920, height: 1080, transform: `scale(${width / 1920})`, transformOrigin: '0 0', position: 'relative' }}>
        <Series>
          {SCENES.map((s, i) => (
            <Series.Sequence key={i} durationInFrames={s.frames} offset={i === 0 ? 0 : -FADE}>
              <FadeIn>{s.node}</FadeIn>
            </Series.Sequence>
          ))}
        </Series>
      </div>
    </AbsoluteFill>
  );
}

function FadeIn({ children }: { children: ReactNode }) {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{ opacity: interpolate(f, [0, FADE], [0, 1], { extrapolateRight: 'clamp' }) }}>{children}</AbsoluteFill>;
}

const ease = Easing.bezier(0.45, 0, 0.2, 1);
const rise = (f: number, start: number) => {
  const t = interpolate(f, [start, start + 18], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });
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
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: '#121316', color: '#ecebe6', fontFamily: 'Inter, sans-serif', alignItems: 'center', justifyContent: 'center', gap: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 22, ...rise(f, 4) }}>
        <Mark size={72} />
        <span style={{ font: '700 104px Inter', letterSpacing: '-0.035em' }}>terraprev</span>
      </div>
      <div style={{ font: '500 40px/1.35 Inter', color: '#b4b3ad', letterSpacing: '-0.01em', textAlign: 'center', ...rise(f, 16) }}>
        See your Terraform stack and what it costs on AWS,
        <br />
        every time you apply.
      </div>
    </AbsoluteFill>
  );
}

const LINES: { at: number; text: string; color?: string }[] = [
  { at: 34, text: 'Apply complete! Resources: 20 added, 0 changed, 0 destroyed.', color: '#8fcf9c' },
  { at: 48, text: '[terraprev] serial 7 · 20 resources · ~$108.36/mo', color: '#ecebe6' },
  { at: 56, text: '            → out/terraprev.html', color: '#8ab4ff' },
];

function Terminal() {
  const f = useCurrentFrame();
  const cmd = 'tf apply';
  const typed = cmd.slice(0, Math.max(0, Math.floor((f - 10) / 2.5)));
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
            {f < 34 && <span style={{ opacity: Math.floor(f / 8) % 2 ? 0 : 1 }}>▍</span>}
          </div>
          {LINES.filter((l) => f >= l.at).map((l) => <div key={l.text} style={{ color: l.color, whiteSpace: 'pre' }}>{l.text}</div>)}
        </div>
      </div>
      <Caption text="Wraps terraform apply: a fresh snapshot every time" frame={f} />
    </AbsoluteFill>
  );
}

function Outro() {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: '#121316', color: '#ecebe6', fontFamily: 'Inter, sans-serif', alignItems: 'center', justifyContent: 'center', gap: 40 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, ...rise(f, 6) }}>
        <Mark size={56} />
        <span style={{ font: '700 80px Inter', letterSpacing: '-0.035em' }}>terraprev</span>
      </div>
      <div style={{ display: 'flex', gap: 18, ...rise(f, 16) }}>
        {['No AWS account', 'No credentials', 'Nothing uploaded'].map((t) => (
          <span key={t} style={{ font: '600 30px Inter', padding: '12px 24px', borderRadius: 999, border: '1px solid #3a3b42', color: '#b4b3ad' }}>{t}</span>
        ))}
      </div>
      <div style={{ font: '400 34px "JetBrains Mono", monospace', color: '#8ab4ff', background: '#1c1d22', border: '1px solid #2a2b31', padding: '18px 32px', borderRadius: 12, ...rise(f, 28) }}>
        npm run snapshot -- --open
      </div>
    </AbsoluteFill>
  );
}
