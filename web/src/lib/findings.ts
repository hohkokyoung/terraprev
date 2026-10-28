import type { Insight, InsightSeverity } from '../../../shared/types.ts';

/** Issues worst first. "good" findings are strengths, not issues. */
export const ISSUE_SEVERITIES = ['high', 'medium', 'low', 'info'] as const satisfies readonly InsightSeverity[];
const RANK: Record<InsightSeverity, number> = { high: 0, medium: 1, low: 2, info: 3, good: 4 };

export const isIssue = (f: Insight) => f.severity !== 'good';
export const bySeverity = (a: Insight, b: Insight) => RANK[a.severity] - RANK[b.severity];

/** What a diagram node shows: its worst issue and how many it has. */
export interface NodeFindings { worst: InsightSeverity; count: number; summary: string }

export function issuesByNode(insights: Insight[]): Map<string, NodeFindings> {
  const lists = new Map<string, Insight[]>();
  for (const f of insights) if (isIssue(f)) for (const id of f.nodes) lists.set(id, [...(lists.get(id) ?? []), f]);
  const out = new Map<string, NodeFindings>();
  for (const [id, list] of lists) {
    list.sort(bySeverity);
    const counts = ISSUE_SEVERITIES.map((s) => [s, list.filter((f) => f.severity === s).length] as const).filter(([, n]) => n);
    out.set(id, {
      worst: list[0].severity,
      count: list.length,
      summary: `${list.length} finding${list.length > 1 ? 's' : ''}: ${counts.map(([s, n]) => `${n} ${s === 'info' ? 'note' : s}`).join(', ')}`,
    });
  }
  return out;
}
