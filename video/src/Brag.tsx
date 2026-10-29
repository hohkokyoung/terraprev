// The 25-second launch video ("brag", made with the /brag-slim recipe) and its silent README loop.
// One window stays on stage the whole time: it starts as the terminal running `tf apply`, becomes
// the browser showing the real snapshot page, then your AI assistant pricing a change with what_if.
// Every frame is a function of time; all timings live in brag-timeline.ts, shared with the soundtrack.

import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, Html5Audio, interpolate, interpolateColors, Sequence, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { at, ease, selectIn, Shot, union } from './Shot.tsx';
import { DOLLAR, FULL, HOOK, LOOP, MORPH, OUTRO, REVEAL, RISKS, STRETCH, WHATIF, type SceneName, type Timeline } from './brag-timeline.ts';

export const BRAG_FPS = 30;
export const BRAG_FRAMES = Math.round(FULL.duration * STRETCH * BRAG_FPS);
export const LOOP_FPS = 20;
export const LOOP_FRAMES = Math.round(LOOP.duration * STRETCH * LOOP_FPS);

const C = { bg: '#121316', text: '#ecebe6', muted: '#a9a8a3', dim: '#7c7c78', accent: '#5b9bff', link: '#8ab4ff', green: '#8fcf9c', term: '#15161a', bar: '#1c1d22', border: '#2e3038', page: '#f4f2ec' };

// Stage layout (1920 × 1080): captions on the left, the window on the right.
const TEXT = { left: 110, width: 470 };
const STAGE = { x: 660, y: 196, w: 1150, h: 44 + 647 };
const BAR = 44;
const VIEW = { w: STAGE.w, h: STAGE.h - BAR };
// Where the terminal sits under the hook headline.
const HOOK_WIN = { x: 385, y: 545, w: 1150, h: 300 };

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
/** 0 → 1 over [a, b], eased. An infinite `a` never happens (a fade-out that never comes). */
const ramp = (t: number, a: number, b: number) => (Number.isFinite(a) ? interpolate(t, [a, b], [0, 1], { ...clamp, easing: ease }) : 0);
/** Timeline seconds (see STRETCH): everything below is written in these. */
const useSec = () => useCurrentFrame() / useVideoConfig().fps / STRETCH;
/** Shot's camera clock, slowed to match. */
const PACE = 1 / STRETCH;

/** Fades in over [a, a+0.3], rising 22px, and out over [b-0.25, b]. */
const rise = (t: number, a: number, b = Infinity, px = 22): CSSProperties => {
  const p = ramp(t, a, a + 0.3);
  const out = 1 - ramp(t, b - 0.25, b);
  return { opacity: p * out, transform: `translateY(${(1 - p) * px - (1 - out) * 10}px)` };
};

// The opening frame is the poster: the headline is already settled on it, so every platform's
// thumbnail shows it and playback starts without a jump (a frozen frame from later in the video
// would flash for one frame before the hook).
export function Brag() {
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <Stage tl={FULL} />
      <Html5Audio src={staticFile('brag.wav')} />
    </AbsoluteFill>
  );
}

/** The README loop: the same stage at 1440 × 810, no hook, no outro, no sound. */
export function BragLoop() {
  const { width } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <div style={{ width: 1920, height: 1080, transform: `scale(${width / 1920})`, transformOrigin: '0 0' }}>
        <Stage tl={LOOP} />
      </div>
    </AbsoluteFill>
  );
}

function Stage({ tl }: { tl: Timeline }) {
  const t = useSec();
  const { fps } = useVideoConfig();
  const s = tl.scenes;
  const d0 = s.dollar![0];
  const r0 = s.risks![0];
  const a0 = s.whatif![0];
  const a1 = s.whatif![1];
  const from = (sec: number) => Math.round(sec * STRETCH * fps);

  // The window: from under the headline to the stage slot, and off at the outro.
  const m = s.hook ? ramp(t, MORPH.from, MORPH.to) : 1;
  const lerp = (a: number, b: number) => a + (b - a) * m;
  const rect = { x: lerp(HOOK_WIN.x, STAGE.x), y: lerp(HOOK_WIN.y, STAGE.y), w: lerp(HOOK_WIN.w, STAGE.w), h: lerp(HOOK_WIN.h, STAGE.h) };
  const gone = s.outro ? ramp(t, s.outro[0] + OUTRO.windowOut, s.outro[0] + OUTRO.windowOut + 0.45) : 0;

  // Window body colour: terminal → page → terminal (→ page again, so the loop's last frame meets its first).
  const body = interpolateColors(
    t,
    // To the page once the page covers it; back to the terminal fast while the page fades, so the cut dips through dark, not grey.
    [tl.pageIn + 0.25, tl.pageIn + 0.3, a0 - 0.13, a0 - 0.07, a1 + 0.05, a1 + 0.35],
    [s.hook ? C.term : C.page, C.page, C.page, C.term, C.term, s.outro ? C.term : C.page],
  );
  const loops = !s.outro;
  const title = t < tl.pageIn - 0.3 ? '~/my-stack — zsh' : t < a0 || (loops && t >= a1) ? 'out/terraprev.html' : '~/my-stack — your AI assistant';

  return (
    <AbsoluteFill style={{ fontFamily: 'Inter, sans-serif', color: C.text }}>
      <Glow t={t} period={tl.duration} />

      {s.hook && <Headline t={t} end={s.hook[1]} />}

      <div style={{
        position: 'absolute', left: rect.x, top: rect.y, width: rect.w, height: rect.h, borderRadius: 16, overflow: 'hidden',
        background: body, border: `1px solid ${C.border}`, boxShadow: '0 40px 110px rgba(0,0,0,0.55)',
        opacity: 1 - gone, transform: `translateY(${-50 * gone}px) scale(${1 - 0.05 * gone})`,
      }}>
        <TitleBar title={title} />
        <div style={{ position: 'absolute', left: 0, top: BAR, width: VIEW.w, height: VIEW.h, overflow: 'hidden' }}>
          {s.hook && t < tl.pageIn && <div style={{ position: 'absolute', inset: 0, opacity: 1 - ramp(t, tl.pageIn - 0.2, tl.pageIn - 0.05) }}><HookTerminal t={t} /></div>}

          <Layer t={t} a={tl.pageIn} b={d0}>
            <Sequence from={from(tl.pageIn)} layout="none">
              <RevealShot />
            </Sequence>
          </Layer>

          <Layer t={t} a={d0 + 0.05} b={r0}>
            <Sequence from={from(d0)} layout="none">
              <DollarShot />
            </Sequence>
          </Layer>

          <Layer t={t} a={r0 + 0.05} b={a0}>
            <Sequence from={from(r0)} layout="none">
              <RisksShot />
            </Sequence>
          </Layer>

          <Layer t={t} a={a0 + 0.1} b={s.outro ? Infinity : a1}>
            <WhatIfTerminal t={t - a0} />
          </Layer>

          {/* The loop's last moments: the overview fades back in, matching its first frame. */}
          {loops && (
            <Layer t={t} a={tl.duration - 0.35} b={Infinity}>
              <Sequence from={from(tl.duration - 0.35)} layout="none">
                <RevealShot />
              </Sequence>
            </Layer>
          )}
        </div>
      </div>

      {(['reveal', 'dollar', 'risks', 'whatif'] as const).map((name) => s[name] && (
        <Caption key={name} name={name} t={t} start={s[name]![0] + (name === 'reveal' && s.hook ? 0.6 : name === 'reveal' ? -0.5 : 0.15)} end={s[name]![1]} />
      ))}
      {loops && <Caption name="reveal" t={t} start={tl.duration - 0.5} end={Infinity} />}

      {s.outro && <Outro t={t - s.outro[0]} />}
    </AbsoluteFill>
  );
}

/** One piece of window content: fades in at `a`, out just before `b` (staggered, never a double exposure). */
function Layer({ t, a, b, children }: { t: number; a: number; b: number; children: ReactNode }) {
  if (t < a || t > b) return null;
  const opacity = ramp(t, a, a + 0.25) * (1 - ramp(t, b - 0.16, b));
  return <div style={{ position: 'absolute', inset: 0, opacity }}>{children}</div>;
}

function TitleBar({ title }: { title: string }) {
  return (
    <div style={{ position: 'relative', height: BAR, display: 'flex', alignItems: 'center', gap: 9, padding: '0 18px', background: C.bar, borderBottom: `1px solid ${C.border}` }}>
      {['#ff5f57', '#febc2e', '#28c840'].map((c) => <i key={c} style={{ width: 13, height: 13, borderRadius: 7, background: c }} />)}
      <span style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', font: '500 17px Inter', color: '#8b8d94', background: '#15161a', padding: '5px 56px', borderRadius: 8, whiteSpace: 'nowrap' }}>{title}</span>
    </div>
  );
}

/** A slow blue glow behind the window, so the dark stage isn't flat. One full drift per `period`, so the loop has no seam. */
function Glow({ t, period }: { t: number; period: number }) {
  const a = (t / period) * Math.PI * 2;
  const x = 66 + Math.sin(a) * 4;
  const y = 50 + Math.cos(a) * 5;
  return <AbsoluteFill style={{ background: `radial-gradient(1100px 760px at ${x}% ${y}%, rgba(91,155,255,0.13), rgba(91,155,255,0) 70%)` }} />;
}

function Headline({ t, end }: { t: number; end: number }) {
  const line: CSSProperties = { font: '700 92px/1.12 Inter', letterSpacing: '-0.035em', textAlign: 'center', whiteSpace: 'nowrap' };
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: 235, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      {/* Settled from the first frame (the poster); only the terminal under it moves. */}
      <div style={{ ...line, ...rise(t, -1, end + 0.25, 30) }}>Your Terraform stack,</div>
      <div style={{ ...line, color: C.accent, ...rise(t, -1, end + 0.25, 30) }}>explained.</div>
    </div>
  );
}

const MONO = '"JetBrains Mono", monospace';

/** A terminal line that slides in when it's printed. */
function Line({ t, at: when, children, style }: { t: number; at: number; children: ReactNode; style?: CSSProperties }) {
  if (t < when) return null;
  const p = ramp(t, when, when + 0.14);
  return <div style={{ whiteSpace: 'pre', opacity: p, transform: `translateY(${(1 - p) * 8}px)`, ...style }}>{children}</div>;
}

function Caret({ t }: { t: number }) {
  return <span style={{ color: C.text, opacity: Math.floor(t * 3.2) % 2 ? 0 : 1 }}>▍</span>;
}

function HookTerminal({ t }: { t: number }) {
  const typed = HOOK.command.slice(0, Math.max(0, Math.floor((t - HOOK.typeFrom) / HOOK.perKey) + 1));
  const done = t >= HOOK.typeFrom + HOOK.command.length * HOOK.perKey;
  return (
    <div style={{ position: 'absolute', inset: 0, padding: '34px 44px', font: `400 27px/1.7 ${MONO}`, color: C.text }}>
      <div>
        <span style={{ color: C.dim }}>~/my-stack $ </span>
        {t >= HOOK.typeFrom ? typed : ''}
        {t < HOOK.applied && !done && <Caret t={t} />}
      </div>
      <Line t={t} at={HOOK.applied} style={{ color: C.green }}>Apply complete! Resources: 20 added, 0 changed, 0 destroyed.</Line>
      <Line t={t} at={HOOK.answer}>
        <span style={{ color: C.dim }}>[terraprev]</span> serial 7 · 20 resources · <b style={{ color: C.accent, fontWeight: 600 }}>~$108.36/mo</b>
      </Line>
      <Line t={t} at={HOOK.answer + 0.15} style={{ color: C.link }}>{'            → out/terraprev.html'}</Line>
    </div>
  );
}

// Shot's timeline units: 30 per timeline second, from the start of the shot's Sequence.
const u = (sec: number) => sec * 30;

/** The architecture: the whole page, then a click on app-asg lights up the traffic path into it. */
function RevealShot() {
  const path = union(at('overview', 'internet'), at('overview', 'asg')); // Internet → web-alb → app-asg
  const asg = at('overview', 'asg');
  return (
    <Shot
      w={VIEW.w}
      h={VIEW.h}
      pace={PACE}
      images={selectIn('overview', 'flow', u(REVEAL.flow))}
      focus={[
        { from: 0, rect: null },
        { from: u(REVEAL.toPath), rect: { ...path, y: path.y - 60, h: path.h + 90 }, zoom: 2.3 },
      ]}
      cursor={[
        { at: u(REVEAL.cursorIn), x: asg.x + asg.w + 40, y: asg.y + asg.h + 70 },
        { at: u(REVEAL.flow), x: asg.x + asg.w * 0.55, y: asg.y + asg.h / 2, click: true },
      ]}
    />
  );
}

/** The bill: a click on app-db scopes the panel to it (switch and total), then quantity × unit price. */
function DollarShot() {
  const db = at('overview', 'db');
  return (
    <Shot
      w={VIEW.w}
      h={VIEW.h}
      pace={PACE}
      images={selectIn('overview', 'cost-one', u(DOLLAR.click))}
      focus={[
        { from: 0, rect: { x: 400, y: 0, w: 1200, h: 700 }, zoom: 1.4 }, // the diagram and the panel, header included
        { from: u(DOLLAR.toHead), rect: union(at('cost-one', 'scope'), at('cost-one', 'head')), zoom: 2.4 },
        { from: u(DOLLAR.toLines), rect: { ...at('cost-one', 'lines'), h: 200 }, zoom: 2.4 },
      ]}
      cursor={[
        { at: u(DOLLAR.cursorIn), x: 860, y: 470 },
        { at: u(DOLLAR.click), x: db.x + db.w / 2, y: db.y + db.h / 2, click: true },
      ]}
    />
  );
}

/** app-db's findings, scoped to it: the panel, then the worst one and its fix. */
function RisksShot() {
  return (
    <Shot
      w={VIEW.w}
      h={VIEW.h}
      pace={PACE}
      images={[{ shot: 'risks', from: 0 }]}
      focus={[
        { from: 0, rect: { x: 400, y: 0, w: 1200, h: 700 }, zoom: 1.4 },
        { from: u(RISKS.toFinding), rect: union(at('risks', 'scope'), at('risks', 'finding')), zoom: 2.2 },
      ]}
    />
  );
}

/** Real numbers from the demo stack: what terraprev's what_if tool returns for this change. */
const RESULT = [
  { label: 'app-db', value: <>$18.89 → <b style={{ color: C.text, fontWeight: 600 }}>$58.95</b>/mo</>, note: <span style={{ color: C.accent, fontWeight: 600 }}>+$40.06</span> },
  { label: 'stack', value: <>$108.36 → <b style={{ color: C.text, fontWeight: 600 }}>$148.42</b>/mo</>, note: null },
  { label: 'fixes', value: <span style={{ color: C.green }}>✓ app-db is single-AZ</span>, note: null },
];

function WhatIfTerminal({ t }: { t: number }) {
  const n = Math.max(0, Math.floor((t - WHATIF.typeFrom) / WHATIF.perKey) + 1);
  const typing = t >= WHATIF.typeFrom && n <= WHATIF.question.length;
  return (
    <div style={{ position: 'absolute', inset: 0, padding: '60px 64px', font: `400 30px/1.8 ${MONO}`, color: C.text }}>
      <div>
        <span style={{ color: C.accent }}>{'> '}</span>
        {t >= WHATIF.typeFrom ? WHATIF.question.slice(0, n) : ''}
        {(typing || t < WHATIF.typeFrom) && <Caret t={t} />}
      </div>
      <div style={{ height: 34 }} />
      <Line t={t} at={WHATIF.tool} style={{ color: C.muted }}>
        <span style={{ color: t >= WHATIF.rows[0] ? C.green : C.accent }}>●</span> terraprev · what_if
      </Line>
      <Line t={t} at={WHATIF.args} style={{ color: C.dim, fontSize: 25 }}>{'  app-db: multi_az = true, instance_class = db.t4g.small'}</Line>
      <div style={{ marginTop: 24, lineHeight: 1.95 }}>
        {RESULT.map((r, i) => {
          const when = WHATIF.rows[i];
          if (t < when) return null;
          const p = ramp(t, when, when + 0.14);
          return (
            <div key={r.label} style={{ display: 'flex', alignItems: 'baseline', gap: 28, opacity: p, transform: `translateY(${(1 - p) * 8}px)` }}>
              <span style={{ width: 140, color: C.dim }}>{r.label}</span>
              <span style={{ color: C.muted }}>{r.value}</span>
              {r.note}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const CAPTIONS: Record<Exclude<SceneName, 'hook' | 'outro'>, { kicker: string; title: string; body: string }> = {
  reveal: { kicker: '', title: 'Your stack,\ndrawn from state.', body: 'Every resource.\nEvery path in.' },
  dollar: { kicker: 'COST', title: 'Every dollar, explained.', body: 'Quantity × unit price, from AWS’s price list.' },
  risks: { kicker: 'FINDINGS', title: 'Risks,\nwith the fix.', body: 'Checked on every apply.' },
  whatif: { kicker: 'MCP', title: 'Price it before\nyou write it.', body: 'Your AI asks terraprev.\nReal AWS prices.' },
};

function Caption({ name, t, start, end }: { name: keyof typeof CAPTIONS; t: number; start: number; end: number }) {
  if (t < start - 0.01 || t > end + 0.01) return null;
  const c = CAPTIONS[name];
  return (
    <div style={{ position: 'absolute', left: TEXT.left, width: TEXT.width, top: 0, height: 1080, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 24 }}>
      {name === 'reveal' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, ...rise(t, start, end) }}>
          <Mark size={40} />
          <span style={{ font: '700 42px Inter', letterSpacing: '-0.03em' }}>terraprev</span>
        </div>
      ) : (
        <div style={{ font: `600 22px ${MONO}`, color: C.accent, letterSpacing: '0.12em', ...rise(t, start, end) }}>{c.kicker}</div>
      )}
      <div style={{ font: '700 66px/1.08 Inter', letterSpacing: '-0.035em', whiteSpace: 'pre-line', ...rise(t, start + 0.08, end) }}>{c.title}</div>
      <div style={{ font: '400 33px/1.4 Inter', color: C.muted, letterSpacing: '-0.01em', whiteSpace: 'pre-line', ...rise(t, start + 0.16, end) }}>{c.body}</div>
    </div>
  );
}

function Outro({ t }: { t: number }) {
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 44 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24, ...rise(t, OUTRO.mark, Infinity, 30) }}>
        <Mark size={84} />
        <span style={{ font: '700 124px Inter', letterSpacing: '-0.04em' }}>terraprev</span>
      </div>
      <div style={{ display: 'flex', gap: 18, ...rise(t, OUTRO.chips) }}>
        {['No AWS account', 'No credentials', 'Nothing uploaded'].map((x) => (
          <span key={x} style={{ font: '600 30px Inter', padding: '12px 26px', borderRadius: 999, border: '1px solid #3a3b42', color: '#c4c3bd' }}>{x}</span>
        ))}
      </div>
      <div style={{ font: `500 36px ${MONO}`, color: C.link, background: C.bar, border: '1px solid #2a2b31', padding: '18px 34px', borderRadius: 12, ...rise(t, OUTRO.url) }}>
        github.com/hohkokyoung/terraprev
      </div>
    </AbsoluteFill>
  );
}

function Mark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <rect x="1" y="2" width="14" height="12" rx="2" fill="none" stroke={C.accent} strokeWidth="1.6" />
      <rect x="1" y="2" width="5" height="12" rx="1.5" fill={C.accent} />
    </svg>
  );
}
