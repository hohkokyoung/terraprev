// How much each saving is worth, at the usage and free-tier settings on screen. A saving swaps some
// cost lines for others; its value is the bill with the old lines minus the bill with the new ones
// (so shared free-tier allowances are handled the same way as everywhere else).

import type { CostComponent, Saving } from './types.ts';
import { lineCosts } from './cost.ts';

export interface PricedSaving {
  saving: Saving;
  /** Monthly saving; 0 for savings that depend on traffic the state can't show (see perUnit). */
  monthly: number;
}

const total = (components: CostComponent[], usage: Record<string, number>, freeTier: boolean) => {
  let sum = 0;
  for (const l of lineCosts(components, usage, freeTier).values()) sum += l.monthly;
  return sum;
};

export function savingMonthly(components: CostComponent[], s: Saving, usage: Record<string, number>, freeTier: boolean, base = total(components, usage, freeTier)): number {
  if (!s.replaces.length && !s.with.length) return 0;
  const gone = new Set(s.replaces);
  return base - total([...components.filter((c) => !gone.has(c.id)), ...s.with], usage, freeTier);
}

/** Every saving worth showing, biggest first. Ones that would cost more at this usage are dropped. */
export function priceSavings(components: CostComponent[], savings: Saving[] | undefined, usage: Record<string, number>, freeTier: boolean): PricedSaving[] {
  const base = total(components, usage, freeTier);
  return (savings ?? [])
    .map((saving) => ({ saving, monthly: savingMonthly(components, saving, usage, freeTier, base) }))
    .filter((p) => p.monthly >= 0.005 || (p.saving.perUnit && !p.saving.replaces.length))
    .sort((a, b) => b.monthly - a.monthly || a.saving.id.localeCompare(b.saving.id, 'en'));
}

/**
 * What the savings add up to when they don't overlap: two that change the same cost line (Graviton,
 * or a reservation of the same instances) count once, the bigger one.
 */
export function combinedSaving(priced: PricedSaving[]): number {
  const used = new Set<string>();
  let sum = 0;
  for (const p of priced) {
    if (p.saving.replaces.some((id) => used.has(id))) continue;
    p.saving.replaces.forEach((id) => used.add(id));
    sum += p.monthly;
  }
  return sum;
}
