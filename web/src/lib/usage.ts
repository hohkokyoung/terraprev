import { useCallback, useMemo, useState } from 'react';
import type { CostReport } from '../../../shared/types.ts';
import { lineCosts } from '../../../shared/cost.ts';

const STORAGE_KEY = 'terraprev.usage.v1';
const FREE_KEY = 'terraprev.freeTier';

function readStored(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

/** Slider values, keyed by `${address}:${param}` so they survive re-applies. */
export function useUsage(cost: CostReport | undefined, forceFreeTier = false) {
  const [overrides, setOverrides] = useState<Record<string, number>>(readStored);
  const [freeTier, setFreeTierState] = useState<boolean>(() => {
    if (forceFreeTier) return true;
    try {
      return localStorage.getItem(FREE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setFreeTier = useCallback((on: boolean) => {
    setFreeTierState(on);
    try {
      localStorage.setItem(FREE_KEY, on ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);

  const values = useMemo(() => {
    const v: Record<string, number> = {};
    for (const p of cost?.usage ?? []) v[p.key] = overrides[p.key] ?? p.default;
    return v;
  }, [cost, overrides]);

  const update = useCallback((fn: (cur: Record<string, number>) => Record<string, number>) => {
    setOverrides((cur) => {
      const next = fn(cur);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* private mode: keep in memory only */
      }
      return next;
    });
  }, []);

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
