// Cost over time: one point per apply, kept per state lineage (a state's lifelong id), so every stack
// has its own history however its state file is moved or named. Written by the snapshot build and
// the live server; read back into every snapshot.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoryPoint, Snapshot } from '../../shared/types.ts';
import { buildReport, defaultUsageValues } from '../../shared/report.ts';
import { lineCosts } from '../../shared/cost.ts';

const MAX_POINTS = 500;

export function historyPoint(snapshot: Snapshot): HistoryPoint {
  const usage = defaultUsageValues(snapshot);
  const lines = lineCosts(snapshot.cost.components, usage, false);
  let fixed = 0, use = 0;
  for (const c of snapshot.cost.components) {
    const m = lines.get(c.id)!.monthly;
    if (c.kind === 'fixed') fixed += m;
    else use += m;
  }
  const report = buildReport({ snapshot, usage, freeTier: false });
  return {
    serial: snapshot.serial,
    appliedAt: snapshot.updatedAt,
    resourceCount: snapshot.resourceCount,
    fixed: round(fixed),
    usage: round(use),
    byCategory: Object.fromEntries(report.cost.byCategory.map((c) => [c.category, round(c.monthly)])),
    findings: { high: report.findings.counts.high, medium: report.findings.counts.medium },
  };
}

const fileFor = (dir: string, lineage: string) => join(dir, `${lineage.replace(/[^\w-]/g, '_')}.json`);

export function readHistory(dir: string, lineage: string): HistoryPoint[] {
  if (!lineage) return [];
  try {
    const points = JSON.parse(readFileSync(fileFor(dir, lineage), 'utf8'));
    return Array.isArray(points) ? points : [];
  } catch {
    return [];
  }
}

/**
 * Records this apply (once per serial: a rebuild of the same serial replaces its point, e.g. after
 * a price refresh) and returns the history up to and including it. Prices that are still loading,
 * or failed, are not recorded: a $0 point would look like a real drop.
 */
export function recordHistory(dir: string, snapshot: Snapshot): HistoryPoint[] {
  const points = readHistory(dir, snapshot.lineage);
  if (!snapshot.lineage || snapshot.cost.status !== 'ready' || snapshot.cost.errors.length) return points;
  const point = historyPoint(snapshot);
  const next = points.filter((p) => p.serial !== point.serial).concat(point).sort((a, b) => a.serial - b.serial).slice(-MAX_POINTS);
  if (JSON.stringify(next) !== JSON.stringify(points)) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const file = fileFor(dir, snapshot.lineage);
      writeFileSync(file + '.tmp', JSON.stringify(next, null, 1));
      renameSync(file + '.tmp', file);
    } catch {
      /* history is a nicety: never fail a build over it */
    }
  }
  return next.filter((p) => p.serial <= point.serial);
}

const round = (n: number) => Math.round(n * 100) / 100;
