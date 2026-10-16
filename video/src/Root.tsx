import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import { Composition } from 'remotion';
import { Demo, DURATION, FPS, Teaser, TEASER_DURATION, TEASER_FPS } from './Demo.tsx';
import { Brag, BRAG_FPS, BRAG_FRAMES, BragLoop, LOOP_FPS, LOOP_FRAMES } from './Brag.tsx';

export function Root() {
  return (
    <>
      {/* The launch video (README walkthrough) and its silent loop (top of the README, as an animated WebP). */}
      <Composition id="Brag" component={Brag} durationInFrames={BRAG_FRAMES} fps={BRAG_FPS} width={1920} height={1080} />
      <Composition id="BragLoop" component={BragLoop} durationInFrames={LOOP_FRAMES} fps={LOOP_FPS} width={1440} height={810} />
      <Composition id="Demo" component={Demo} durationInFrames={DURATION} fps={FPS} width={1920} height={1080} />
      {/* GitHub won't autoplay video in a README, so the top of the page is this loop as an animated WebP (see webp.py). */}
      <Composition id="Teaser" component={Teaser} durationInFrames={TEASER_DURATION} fps={TEASER_FPS} width={1440} height={810} />
    </>
  );
}
