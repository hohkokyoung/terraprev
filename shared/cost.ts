import type { CostComponent, PriceTier, UsageParam } from './types.ts';

export const HOURS_PER_MONTH = 730;

/** Cost of `quantity` units priced in graduated tiers (each unit pays its own tier's rate). */
export function tieredCost(tiers: PriceTier[], quantity: number): number {
  let total = 0;
  for (const t of tiers) {
    if (quantity <= t.from) break;
    const upper = t.to === null ? quantity : Math.min(quantity, t.to);
    total += (upper - t.from) * t.price;
  }
  return total;
}

export function componentQuantity(c: CostComponent, usage: Record<string, number>): number {
  let q = c.quantity.base;
  for (const key of c.quantity.usage ?? []) q *= usage[key] ?? 0;
  return q;
}

export function componentMonthly(c: CostComponent, usage: Record<string, number>): number {
  return tieredCost(c.tiers, componentQuantity(c, usage));
}

export function defaultUsage(params: UsageParam[]): Record<string, number> {
  return Object.fromEntries(params.map((p) => [p.key, p.default]));
}

export function formatUsd(n: number): string {
  if (n === 0) return '$0';
  if (Math.abs(n) < 0.01) return '<$0.01';
  if (Math.abs(n) >= 1000) return '$' + Math.round(n).toLocaleString('en-US');
  return '$' + n.toFixed(2);
}

/** "0.0000002" → "$0.20 per 1M" style unit price, readable at any magnitude. */
export function formatUnitPrice(price: number, unit: string): string {
  unit = prettyUnit(unit);
  if (price === 0) return `$0 / ${unit}`;
  for (const [mult, label] of [
    [1, ''],
    [1e3, '1K '],
    [1e6, '1M '],
  ] as const) {
    const scaled = price * mult;
    if (scaled >= 0.001) return `$${trim(scaled)} / ${label}${unit}`;
  }
  return `$${trim(price * 1e9)} / 1B ${unit}`;
}

function trim(n: number): string {
  return n >= 1 ? n.toFixed(2).replace(/\.00$/, '') : Number(n.toPrecision(3)).toString();
}

export function formatQuantity(n: number): string {
  if (n >= 1e9) return `${+(n / 1e9).toPrecision(3)}B`;
  if (n >= 1e6) return `${+(n / 1e6).toPrecision(3)}M`;
  if (n >= 1e4) return `${+(n / 1e3).toPrecision(3)}K`;
  return Number.isInteger(n) ? n.toLocaleString('en-US') : (+n.toPrecision(4)).toString();
}

const UNIT_NAMES: Record<string, string> = {
  Hrs: 'hour',
  'GB-Mo': 'GB-month',
  GB: 'GB',
  Requests: 'request',
  'API Requests': 'request',
  'LCU-Hrs': 'LCU-hour',
  'Lambda-GB-Second': 'GB-second',
  CognitoUserPoolsMAU: 'MAU',
  Secrets: 'secret',
  Alarms: 'alarm',
  ReadRequestUnits: 'read unit',
  WriteRequestUnits: 'write unit',
  'ReadCapacityUnit-Hrs': 'RCU-hour',
  'WriteCapacityUnit-Hrs': 'WCU-hour',
  Notifications: 'notification',
};

/** AWS price-list units ("Hrs", "GB-Mo") → words people read. */
export function prettyUnit(unit: string): string {
  return UNIT_NAMES[unit] ?? unit;
}

export interface LineCost {
  monthly: number;
  /** Units covered by the free tier (0 when free tier is off or not applicable). */
  freeUnits: number;
}

/**
 * Monthly cost of every component. With `freeTier`, each allowance is shared by all lines in
 * its pool (AWS free tier is per account): the pool's free units are split pro-rata by usage.
 */
export function lineCosts(components: CostComponent[], usage: Record<string, number>, freeTier: boolean): Map<string, LineCost> {
  const out = new Map<string, LineCost>();
  const qty = new Map(components.map((c) => [c.id, componentQuantity(c, usage)]));
  const pools = new Map<string, { allowance: number; total: number }>();
  if (freeTier) {
    for (const c of components) {
      if (!c.freeTier) continue;
      const p = pools.get(c.freeTier.pool) ?? { allowance: c.freeTier.allowance, total: 0 };
      p.total += qty.get(c.id)!;
      pools.set(c.freeTier.pool, p);
    }
  }
  for (const c of components) {
    const q = qty.get(c.id)!;
    const pool = c.freeTier && pools.get(c.freeTier.pool);
    const freeUnits = pool && pool.total > 0 ? (Math.min(pool.allowance, pool.total) * q) / pool.total : 0;
    out.set(c.id, { monthly: tieredCost(c.tiers, q - freeUnits), freeUnits });
  }
  return out;
}
