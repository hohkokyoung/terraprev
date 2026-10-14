import type { StaticBundle } from '../../../shared/types.ts';

declare global {
  interface Window {
    __TERRAPREV__?: StaticBundle;
  }
}

/** Present when this page is a file written by `terraprev build`: no server, data is embedded. */
export const STATIC: StaticBundle | undefined = typeof window !== 'undefined' ? window.__TERRAPREV__ : undefined;
