// Reading cost history: what changed since the last apply, and over the last month or so.

import type { HistoryPoint } from './types.ts';
import { formatUsd } from './cost.ts';
import { formatDelta } from './compare.ts';

export const pointTotal = (p: HistoryPoint) => p.fixed + p.usage;

export interface HistorySummary {
  last: HistoryPoint;
  /** The apply before the last one. */
  previous?: HistoryPoint;
  /** About 30 days before the last apply, or the oldest point if history is shorter. */
  since?: HistoryPoint;
  /** Change from `since` to `last`. */
  delta: number;
  /** Relative change (0.18 = +18%); undefined when `since` cost nothing. */
  ratio?: number;
  /** The category that moved most over that time, e.g. { category: 'Database', delta: 40 }. */
  driver?: { category: string; delta: number };
}

const DAY = 86_400_000;

export function summarizeHistory(points: HistoryPoint[] | undefined): HistorySummary | undefined {
  if (!points?.length) return undefined;
  const last = points[points.length - 1];
  const previous = points.length > 1 ? points[points.length - 2] : undefined;
  const cutoff = new Date(last.appliedAt).getTime() - 30 * DAY;
  const older = points.slice(0, -1);
  const since = older.length ? ([...older].reverse().find((p) => new Date(p.appliedAt).getTime() <= cutoff) ?? older[0]) : undefined;
  const delta = since ? pointTotal(last) - pointTotal(since) : 0;
  let driver: HistorySummary['driver'];
  if (since) {
    for (const category of new Set([...Object.keys(last.byCategory), ...Object.keys(since.byCategory)])) {
      const d = (last.byCategory[category] ?? 0) - (since.byCategory[category] ?? 0);
      if (Math.abs(d) >= 0.005 && (!driver || Math.abs(d) > Math.abs(driver.delta))) driver = { category, delta: d };
    }
  }
  return { last, previous, since, delta, ratio: since && pointTotal(since) > 0 ? delta / pointTotal(since) : undefined, driver };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "16 Sep 2026", in UTC and the same in every locale (briefs must be byte-identical for the same input). */
export const shortDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/** "Since 16 Sep 2026 the bill went up 18% (+$16.40), mostly Database (+$12.00)." */
export function historySentence(s: HistorySummary | undefined): string | undefined {
  if (!s?.since) return undefined;
  if (Math.abs(s.delta) < 0.005) return `The bill is unchanged since ${shortDate(s.since.appliedAt)} (serial ${s.since.serial}), at ${formatUsd(pointTotal(s.last))}/month.`;
  const pct = s.ratio !== undefined ? ` ${Math.abs(Math.round(s.ratio * 100))}%` : '';
  const why = s.driver && Math.abs(s.driver.delta) >= Math.abs(s.delta) * 0.4 ? `, mostly ${s.driver.category} (${formatDelta(s.driver.delta)})` : '';
  return `Since ${shortDate(s.since.appliedAt)} (serial ${s.since.serial}) the bill went ${s.delta > 0 ? 'up' : 'down'}${pct} (${formatDelta(s.delta)}/month)${why}.`;
}
