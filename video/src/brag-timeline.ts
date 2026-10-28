// When everything happens in the brag video, in seconds. Shared by the picture (Brag.tsx) and the
// soundtrack (brag-audio.ts), so every cut, click and typed key lands on its sound.
// Plain TypeScript, no React: Node runs brag-audio.ts on it directly.

/**
 * Playback runs this much slower than the times below: picture, camera and sound alike, so the
 * full video is 21.5 × 8/7 ≈ 24.6 s. Change it here to re-pace everything at once.
 */
export const STRETCH = 8 / 7;

export const BPM = 120 / STRETCH; // 105: a beat is 0.5 timeline seconds, and scene cuts sit on beats

export type SceneName = 'hook' | 'reveal' | 'dollar' | 'risks' | 'whatif' | 'outro';

export interface Timeline {
  duration: number;
  /** [start, end] of each scene. The loop has no hook or outro. */
  scenes: Partial<Record<SceneName, [number, number]>>;
  /** When the snapshot page appears in the browser window. */
  pageIn: number;
}

/** The full video, with sound: hook → reveal → three highlights → outro. */
export const FULL: Timeline = {
  duration: 21.5,
  scenes: { hook: [0, 3], reveal: [3, 7], dollar: [7, 11], risks: [11, 14.5], whatif: [14.5, 18.5], outro: [18.5, 21.5] },
  pageIn: 3.9,
};

/**
 * The README loop: the highlights only. It opens on the overview already settled (GitHub shows the
 * first frame while the image loads), and its last half second rebuilds that frame, so there is no seam.
 */
export const LOOP: Timeline = {
  duration: 15.5,
  scenes: { reveal: [0, 3.6], dollar: [3.6, 7.6], risks: [7.6, 11.1], whatif: [11.1, 15] },
  pageIn: -0.3,
};

// ── events inside scenes (seconds after the scene starts) ──

export const HOOK = {
  command: 'bin/tf apply',
  typeFrom: 0.15,
  perKey: 0.05,
  applied: 0.95, // "Apply complete!"
  answer: 2.3, // terraprev's line, with the monthly total
};

/** The terminal glides from under the headline to the stage slot and becomes the browser. */
export const MORPH = { from: 3.2, to: 3.9 };

/** Seconds after the page appears: the camera moves straight onto the traffic path, which then lights up. */
export const REVEAL = { toPath: 0.7, flow: 1.4 };

/** A click on app-db scopes the panel to it: the switch and its total, then quantity × unit price. */
export const DOLLAR = { cursorIn: 0.2, click: 0.9, toHead: 1.1, toLines: 2.2 };

/** The scoped findings: the whole panel, then the camera settles on the worst one and its fix. */
export const RISKS = { toFinding: 0.35 };

/** The assistant prices a change with terraprev's what_if tool, before any .tf is written. */
export const WHATIF = {
  question: 'what would Multi-AZ on db.t4g.small cost?',
  typeFrom: 0.2,
  perKey: 0.028,
  tool: 1.55,
  args: 1.7,
  rows: [2.0, 2.3, 2.6],
};

export const OUTRO = { windowOut: 0, mark: 0.3, chips: 0.6, url: 0.9 };

// ── cues for the soundtrack (absolute playback seconds in FULL, i.e. already stretched) ──

export function cues(tl: Timeline = FULL) {
  const at = (sec: number) => sec * STRETCH;
  const s = tl.scenes;
  const keys: number[] = [];
  if (s.hook) for (let i = 0; i < HOOK.command.length; i++) keys.push(s.hook[0] + HOOK.typeFrom + i * HOOK.perKey);
  if (s.whatif) for (let i = 0; i < WHATIF.question.length; i++) if (WHATIF.question[i] !== ' ') keys.push(s.whatif[0] + WHATIF.typeFrom + i * WHATIF.perKey);
  return {
    duration: at(tl.duration),
    keys: keys.map(at),
    /** Soft bell notes: something arrived. */
    bells: [
      ...(s.hook ? [s.hook[0] + HOOK.applied, s.hook[0] + HOOK.answer] : []),
      ...(s.reveal ? [tl.pageIn + REVEAL.flow] : []),
      ...(s.whatif ? [s.whatif[0] + WHATIF.tool, ...WHATIF.rows.map((r) => s.whatif![0] + r)] : []),
    ].map(at),
    clicks: (s.dollar ? [s.dollar[0] + DOLLAR.click] : []).map(at),
    /** Whooshes lead into these times. */
    cuts: Object.values(s).map(([a]) => a).filter((a) => a > 0).map(at),
    dropAt: at(s.reveal?.[0] ?? 0), // drums enter
    outroAt: at(s.outro?.[0] ?? tl.duration), // drums leave
  };
}
