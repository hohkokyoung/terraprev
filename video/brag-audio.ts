// The brag video's soundtrack, synthesised from scratch: no samples. Music and sound effects are one
// piece: C major, 120 BPM, Am–F–C–G, and every effect is pitched to the chord and sent to the same
// reverb. Cue times come from src/brag-timeline.ts, so the sounds land on the picture.
//
//   node brag-audio.ts        (from video/: writes public/brag.wav)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BPM, cues, FULL, STRETCH } from './src/brag-timeline.ts';

const SR = 44100;
const cue = cues(FULL); // playback seconds (stretched)
const DUR = cue.duration;
const N = Math.round(SR * DUR);
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const GRID = -1 * STRETCH; // first bar line, so bars start on the cuts into the reveal and the first two highlights
const DROP = cue.dropAt;
const OUT = cue.outroAt;

// Am F C G Am F C G F G C: the last three are a IV–V–I cadence into the outro's final chord.
const PROGRESSION = ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G', 'F', 'G', 'C'] as const;
const PAD: Record<string, number[]> = { Am: [57, 60, 64], F: [57, 60, 65], C: [55, 60, 64], G: [55, 59, 62] }; // smooth voice leading
const ROOT: Record<string, number> = { Am: 45, F: 41, C: 48, G: 43 };
const chordAt = (t: number) => PROGRESSION[Math.min(PROGRESSION.length - 1, Math.max(0, Math.floor((t - GRID) / BAR)))];

const dryL = new Float32Array(N);
const dryR = new Float32Array(N);
const send = new Float32Array(N); // → reverb
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const TAU = Math.PI * 2;

// Deterministic noise, so the same timeline always gives the same file.
let seed = 0x9e3779b9;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};
const noise = () => rand() * 2 - 1;

// Sidechain: the pad, bass and arp dip under each kick, so the low end stays clean.
const KICKS: number[] = [];
for (let t = DROP; t < OUT - 1e-6; t += BEAT) KICKS.push(t);
const duck = new Float32Array(N).fill(1);
for (const k of KICKS) for (let i = Math.round(k * SR), j = 0; j < SR * 0.4 && i < N; i++, j++) duck[i] = Math.min(duck[i], 1 - 0.45 * Math.exp((-j / SR) * 10));

/** Writes `fn(local time)` from `start` for `dur` seconds, panned (-1…1), with a reverb send. */
function voice(start: number, dur: number, fn: (t: number) => number, o: { pan?: number; send?: number; duck?: boolean } = {}) {
  const pan = o.pan ?? 0;
  const gl = Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = Math.sin(((pan + 1) * Math.PI) / 4);
  const from = Math.max(0, Math.round(start * SR));
  const to = Math.min(N, Math.round((start + dur) * SR));
  for (let i = from; i < to; i++) {
    let v = fn(i / SR - start);
    if (o.duck) v *= duck[i];
    dryL[i] += v * gl;
    dryR[i] += v * gr;
    if (o.send) send[i] += v * o.send;
  }
}

/** Chamberlin state-variable filter: cheap, and fine with a cutoff that moves every sample. */
function svf() {
  let low = 0, band = 0;
  return (x: number, cutoff: number, q = 0.7) => {
    const f = 2 * Math.sin((Math.PI * Math.min(cutoff, SR / 6)) / SR);
    low += f * band;
    const high = x - low - q * band;
    band += f * high;
    return { low, band, high };
  };
}

// ── instruments ──

function pad(start: number, dur: number, notes: number[], gain: number) {
  for (const [n, midi] of notes.entries()) {
    for (const det of [-1, 1]) {
      const f = hz(midi) * 2 ** ((det * 5) / 1200);
      const ph = rand() * TAU;
      voice(start, dur + 0.6, (t) => {
        const env = Math.min(1, t / 0.45) * Math.min(1, Math.max(0, (dur + 0.6 - t) / 0.6));
        let w = 0;
        for (let h = 1; h <= 5; h++) w += Math.sin(TAU * f * h * t + ph * h) / (h * h); // soft, triangle-ish
        return w * env * gain;
      }, { pan: det * 0.35 + (n - 1) * 0.1, send: 0.55, duck: true });
    }
  }
}

function pluck(start: number, midi: number, gain: number, bright: number, pan = 0) {
  const f = hz(midi);
  voice(start, 0.6, (t) => {
    const env = Math.min(1, t / 0.003) * Math.exp(-t * 9);
    return (Math.sin(TAU * f * t) + bright * (0.5 * Math.sin(TAU * 2 * f * t) * Math.exp(-t * 14) + 0.22 * Math.sin(TAU * 3 * f * t) * Math.exp(-t * 22))) * env * gain;
  }, { pan, send: 0.35, duck: true });
}

function bass(start: number, dur: number, midi: number, gain: number) {
  const f = hz(midi);
  voice(start, dur, (t) => {
    const env = Math.min(1, t / 0.006) * Math.exp(-t * 4) * Math.min(1, (dur - t) / 0.02);
    return Math.tanh(1.6 * (Math.sin(TAU * f * t) + 0.35 * Math.sin(TAU * 2 * f * t) + 0.12 * Math.sin(TAU * 3 * f * t))) * env * gain;
  }, { duck: true });
}

function kick(start: number, gain: number) {
  let phase = 0;
  voice(start, 0.42, (t) => {
    phase += (TAU * (44 + 80 * Math.exp(-t * 32))) / SR;
    const click = t < 0.003 ? noise() * 0.25 * (1 - t / 0.003) : 0;
    return (Math.sin(phase) * Math.exp(-t * 8) + click) * gain;
  });
}

function clap(start: number, gain: number) {
  const f = svf();
  voice(start, 0.3, (t) => {
    // three quick bursts, then a short tail: a soft hand clap
    const bursts = [0, 0.011, 0.022].reduce((s, b) => s + (t >= b ? Math.exp(-(t - b) * (b === 0.022 ? 18 : 160)) : 0), 0);
    return f(noise(), 1600, 0.9).band * bursts * gain;
  }, { send: 0.4, pan: 0.05 });
}

function hat(start: number, gain: number, pan: number) {
  const f = svf();
  voice(start, 0.07, (t) => f(noise(), 7500, 0.6).high * Math.exp(-t * 70) * gain, { pan, send: 0.1 });
}

function bell(start: number, midi: number, gain: number, pan = 0) {
  const f = hz(midi);
  voice(start, 1.8, (t) => {
    const a = Math.min(1, t / 0.002);
    return a * gain * (Math.sin(TAU * f * t) * Math.exp(-t * 2.6) + 0.35 * Math.sin(TAU * 2 * f * t) * Math.exp(-t * 4.5) + 0.12 * Math.sin(TAU * 3 * f * t) * Math.exp(-t * 7));
  }, { pan, send: 0.6 });
}

function tick(start: number, gain: number) {
  const f = svf();
  voice(start, 0.025, (t) => f(noise(), 5000, 0.8).band * Math.exp(-t * 380) * gain, { pan: (rand() - 0.5) * 0.4, send: 0.05 });
}

/** Filtered noise that swells into `at`: the riser before the drop and the whooshes into each cut. */
function swell(from: number, at: number, gain: number, lo: number, hi: number) {
  const f = svf();
  const len = at - from;
  voice(from, len + 0.12, (t) => {
    const p = Math.min(1, t / len);
    const env = t < len ? p * p : Math.exp(-(t - len) * 30);
    return f(noise(), lo * (hi / lo) ** p, 0.5).band * env * gain;
  }, { pan: 0, send: 0.45 });
}

function impact(start: number, gain: number) {
  let phase = 0;
  const f = svf();
  voice(start, 1.4, (t) => {
    phase += (TAU * (36 + 22 * Math.exp(-t * 6))) / SR;
    return (Math.sin(phase) * Math.exp(-t * 3.2) + 0.3 * f(noise(), 900).low * Math.exp(-t * 9)) * gain;
  }, { send: 0.45 });
}

// ── arrangement ──

// Pad: every bar, louder in the intro and for the final chord.
for (let k = 0; k < PROGRESSION.length; k++) {
  const start = GRID + k * BAR;
  const last = k === PROGRESSION.length - 1;
  const gain = last ? 0.075 : start + BAR <= DROP ? 0.06 : 0.055;
  pad(Math.max(0, start), last ? DUR - start : BAR + 0.05 - Math.max(0, -start), PAD[PROGRESSION[k]], gain);
}

// Arpeggio: eighths in the intro, sixteenths with the drums, slowing down into the outro.
const ARP = [0, 2, 1, 2, 0, 2, 1, 3];
for (let n = 0; ; n++) {
  const intro = GRID + n * (BEAT / 4) < DROP;
  const step = BEAT / 4;
  const t = GRID + n * step;
  if (t >= OUT + 1) break;
  if (t < 0) continue;
  const groove = t >= DROP && t < OUT;
  if (!groove && n % 2) continue; // eighths outside the groove
  const tones = PAD[chordAt(t)].map((m) => m + 12);
  const idx = ARP[n % ARP.length];
  const midi = idx === 3 ? ROOT[chordAt(t)] + 36 : tones[idx];
  const fade = t >= OUT ? 1 - (t - OUT) : 1;
  pluck(t, midi, (intro ? 0.11 : 0.08) * fade * (n % 4 === 0 ? 1.15 : 1), intro ? 0.35 : 0.7, (n % 2 ? 0.25 : -0.25));
}
// The outro's last chord, rising once.
const END = GRID + (PROGRESSION.length - 1) * BAR;
[72, 76, 79, 84].forEach((m, i) => pluck(END + i * 0.25, m, 0.06, 0.4, (i - 1.5) * 0.2));
bell(END + 0.75, 84, 0.06, 0);

// Drums and bass: from the reveal to the outro.
for (const k of KICKS) kick(k, 0.38);
for (let t = DROP; t < OUT - 1e-6; t += BEAT) {
  const beatInBar = Math.round((t - GRID) / BEAT) % 4;
  if (beatInBar === 1 || beatInBar === 3) clap(t, 0.32);
  hat(t + BEAT / 2, 0.06, beatInBar % 2 ? 0.2 : -0.2);
  bass(t + BEAT / 2, BEAT / 2 - 0.02, ROOT[chordAt(t)], 0.11);
}

// Into the drop: a riser, then a low impact on the cut.
swell(DROP - 1.1, DROP, 0.3, 300, 6000);
impact(DROP, 0.3);

// A quiet whoosh into every other cut.
for (const c of cue.cuts) if (c !== DROP) swell(c - 0.35, c, 0.12, 700, 3500);

// Something arrived: bells up the current chord.
cue.bells.forEach((t, j) => {
  const tones = PAD[chordAt(t)];
  bell(t, tones[j % 3] + 24, 0.05, ((j % 3) - 1) * 0.3);
});
// The cursor click on app-db: a soft pluck on the chord's top note.
for (const t of cue.clicks) {
  pluck(t, PAD[chordAt(t)][2] + 24, 0.05, 0.3, 0.2);
  tick(t, 0.05);
}
// Typing, well under the music.
for (const t of cue.keys) tick(t, 0.022 * (0.7 + 0.6 * rand()));

// ── reverb (Freeverb-style: 4 combs + 2 allpasses per side) and master ──

function reverb(input: Float32Array, spread: number) {
  const out = new Float32Array(N);
  const combs = [1116, 1188, 1277, 1356].map((d) => ({ buf: new Float32Array(d + spread), i: 0, lp: 0 }));
  const alls = [556, 441].map((d) => ({ buf: new Float32Array(d + spread), i: 0 }));
  for (let n = 0; n < N; n++) {
    const x = input[n] * 0.12;
    let y = 0;
    for (const c of combs) {
      const v = c.buf[c.i];
      c.lp = v * 0.65 + c.lp * 0.35; // damping
      c.buf[c.i] = x + c.lp * 0.84;
      c.i = (c.i + 1) % c.buf.length;
      y += v;
    }
    for (const a of alls) {
      const v = a.buf[a.i];
      a.buf[a.i] = y + v * 0.5;
      a.i = (a.i + 1) % a.buf.length;
      y = v - y;
    }
    out[n] = y;
  }
  return out;
}

const wetL = reverb(send, 0);
const wetR = reverb(send, 23);
const L = new Float32Array(N);
const R = new Float32Array(N);
let peak = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const fade = Math.min(1, t / 0.01) * Math.min(1, ((DUR - t) / 0.9) ** 1.5);
  // gentle bus saturation instead of a hard limiter
  L[i] = Math.tanh(1.1 * (dryL[i] + wetL[i])) * fade;
  R[i] = Math.tanh(1.1 * (dryR[i] + wetR[i])) * fade;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}

const gain = 0.89 / peak; // -1 dBFS peak
const wav = Buffer.alloc(44 + N * 4);
wav.write('RIFF', 0);
wav.writeUInt32LE(36 + N * 4, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); // PCM
wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(SR, 24);
wav.writeUInt32LE(SR * 4, 28);
wav.writeUInt16LE(4, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  wav.writeInt16LE(Math.round(L[i] * gain * 32767), 44 + i * 4);
  wav.writeInt16LE(Math.round(R[i] * gain * 32767), 46 + i * 4);
}
const out = join(import.meta.dirname, 'public', 'brag.wav');
mkdirSync(join(import.meta.dirname, 'public'), { recursive: true });
writeFileSync(out, wav);
console.log(`${DUR.toFixed(2)} s → ${out} (${(wav.length / 1e6).toFixed(1)} MB, gain ${gain.toFixed(2)})`);
