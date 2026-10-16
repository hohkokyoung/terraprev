import { useCallback, useEffect, useRef, useState } from 'react';
import type { Comparison, Snapshot } from '../../../shared/types.ts';
import { STATIC } from './staticData.ts';

/**
 * What the live page shows: a stack ("live" = the watched state, or a .tfstate in the compare root) or a
 * plan, and optionally another stack to compare it with. Paths are relative to the compare root.
 */
export interface View {
  show: string;
  against?: string;
}

export const LIVE: View = { show: 'live' };
export const isPlanPath = (p: string) => p !== 'live' && !/\.tfstate$/.test(p);
export const isLiveOnly = (v: View) => v.show === 'live' && !v.against;

export interface StackFile {
  path: string;
  label: string;
  modified: string;
}

export interface StackFiles {
  dir: string;
  live: { label: string; path: string };
  states: StackFile[];
  plans: StackFile[];
}

const KEY = 'terraprev.view';

/**
 * The stack pickers (live server only). The server builds and prices whatever isn't the live stack.
 * Reloads when the live state changes, since a comparison may involve it.
 */
export function useView(liveSerial: number | undefined) {
  const [view, setViewState] = useState<View>(() => {
    if (STATIC) return LIVE;
    try {
      const saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
      return typeof saved?.show === 'string' ? { show: saved.show, against: typeof saved.against === 'string' ? saved.against : undefined } : LIVE;
    } catch {
      return LIVE;
    }
  });
  const [files, setFiles] = useState<StackFiles>();
  const [compare, setCompare] = useState<Comparison>();
  const [viewSnapshot, setViewSnapshot] = useState<Snapshot>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const setView = (v: View) => {
    const next = { show: v.show, against: v.against && !isPlanPath(v.show) && v.against !== v.show ? v.against : undefined };
    setViewState(next);
    try {
      sessionStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const refreshFiles = useCallback(() => {
    if (STATIC) return;
    fetch('/api/views')
      .then((r) => (r.ok ? r.json() : undefined))
      .then((f: StackFiles | undefined) => f && setFiles(f))
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshFiles();
    // A plan written or a state file copied while the page is open shows up when you come back to it.
    window.addEventListener('focus', refreshFiles);
    return () => window.removeEventListener('focus', refreshFiles);
  }, [refreshFiles, liveSerial]);

  const key = `${view.show}|${view.against ?? ''}`;
  const shown = useRef<string>(undefined);
  useEffect(() => {
    if (STATIC || isLiveOnly(view) || liveSerial === undefined) {
      setCompare(undefined);
      setViewSnapshot(undefined);
      setError(undefined);
      shown.current = undefined;
      return;
    }
    let stale = false;
    // Something else picked: drop the old result now. Same pick after an apply: keep it until the new one lands.
    if (shown.current !== key) {
      setCompare(undefined);
      setViewSnapshot(undefined);
      shown.current = key;
    }
    setLoading(true);
    setError(undefined);
    const q = new URLSearchParams({ show: view.show, ...(view.against ? { against: view.against } : {}) });
    fetch(`/api/view?${q}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        return body as { compare?: Comparison; snapshot?: Snapshot };
      })
      .then((body) => {
        if (stale) return;
        setCompare(body.compare);
        setViewSnapshot(body.snapshot);
      })
      .catch((err: Error) => {
        if (stale) return;
        setCompare(undefined);
        setViewSnapshot(undefined);
        setError(err.message);
      })
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
    };
  }, [key, liveSerial]);

  return { view, setView, files, refreshFiles, compare, viewSnapshot, loading, error };
}
