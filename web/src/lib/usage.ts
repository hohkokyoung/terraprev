import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CostReport, UsageFile } from '../../../shared/types.ts';
import { lineCosts } from '../../../shared/cost.ts';
import { STATIC } from './staticData.ts';

// Before terraprev.usage.json, slider values lived only in this browser. The live page adopts them
// once into the file; a snapshot file still keeps a viewer's own edits here.
const STORAGE_KEY = 'terraprev.usage.v1';
const FREE_KEY = 'terraprev.freeTier';

/** Names this page in its writes, so it can ignore the server echoing them back. */
const CLIENT = Math.random().toString(36).slice(2);

function readStored(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function storedFreeTier() {
  try {
    return localStorage.getItem(FREE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Slider values, keyed by `${address}:${param}` so they survive re-applies. Live, they are the server's
 * terraprev.usage.json (shared with snapshot builds and the MCP server); in a snapshot file, the
 * values it was built with, plus the viewer's own edits.
 */
export function useUsage(cost: CostReport | undefined, forceFreeTier = false, remote?: UsageFile & { origin?: string }) {
  const [overrides, setOverrides] = useState<Record<string, number>>(() => (STATIC ? STATIC.usage ?? readStored() : {}));
  const [freeTier, setFreeTierState] = useState<boolean>(() => forceFreeTier || (STATIC ? STATIC.freeTier ?? storedFreeTier() : false));
  const latest = useRef({ usage: overrides, freeTier });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const adopted = useRef(false);

  const save = useCallback((next: { usage: Record<string, number>; freeTier: boolean }) => {
    latest.current = next;
    if (STATIC) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next.usage));
        localStorage.setItem(FREE_KEY, next.freeTier ? '1' : '0');
      } catch {
        /* private mode: keep in memory only */
      }
      return;
    }
    // One write per pause, not one per slider step.
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void fetch('/api/usage', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Terraprev-Client': CLIENT },
        body: JSON.stringify(latest.current),
      }).catch(() => {});
    }, 300);
  }, []);

  // The server's file is the truth: take changes made elsewhere (another tab, an assistant, an edit).
  useEffect(() => {
    if (STATIC || !remote || remote.origin === CLIENT) return;
    const saved = readStored();
    if (!adopted.current && !Object.keys(remote.usage).length && !remote.freeTier && (Object.keys(saved).length || storedFreeTier())) {
      adopted.current = true;
      const next = { usage: saved, freeTier: storedFreeTier() };
      setOverrides(next.usage);
      setFreeTierState(forceFreeTier || next.freeTier);
      save(next);
    } else {
      adopted.current = true;
      latest.current = { usage: remote.usage, freeTier: remote.freeTier };
      setOverrides(remote.usage);
      setFreeTierState(forceFreeTier || remote.freeTier);
    }
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(FREE_KEY);
    } catch {
      /* ignore */
    }
  }, [remote, forceFreeTier, save]);

  const setFreeTier = useCallback((on: boolean) => {
    setFreeTierState(on);
    save({ ...latest.current, freeTier: on });
  }, [save]);

  const values = useMemo(() => {
    const v: Record<string, number> = {};
    for (const p of cost?.usage ?? []) v[p.key] = overrides[p.key] ?? p.default;
    return v;
  }, [cost, overrides]);

  const update = useCallback((fn: (cur: Record<string, number>) => Record<string, number>) => {
    const next = fn(latest.current.usage);
    setOverrides(next);
    save({ ...latest.current, usage: next });
  }, [save]);

  const set = useCallback(
    (key: string, value: number | undefined) =>
      update((cur) => {
        const next = { ...cur };
        if (value === undefined) delete next[key];
        else next[key] = value;
        return next;
      }),
    [update],
  );

  /** Every slider to 0: the total becomes the always-on cost only. */
  const zeroAll = useCallback(() => update(() => Object.fromEntries((cost?.usage ?? []).map((p) => [p.key, 0]))), [update, cost]);
  const resetAll = useCallback(() => update(() => ({})), [update]);

  const lines = useMemo(() => lineCosts(cost?.components ?? [], values, freeTier), [cost, values, freeTier]);

  const totals = useMemo(() => {
    const byNode = new Map<string, number>();
    let fixed = 0;
    let usage = 0;
    let saved = 0;
    const withoutFree = freeTier ? lineCosts(cost?.components ?? [], values, false) : lines;
    for (const c of cost?.components ?? []) {
      const m = lines.get(c.id)!.monthly;
      saved += withoutFree.get(c.id)!.monthly - m;
      byNode.set(c.nodeId, (byNode.get(c.nodeId) ?? 0) + m);
      if (c.kind === 'fixed') fixed += m;
      else usage += m;
    }
    return { fixed, usage, total: fixed + usage, byNode, saved };
  }, [cost, values, lines, freeTier]);

  return { values, overrides, set, zeroAll, resetAll, totals, lines, freeTier, setFreeTier };
}
