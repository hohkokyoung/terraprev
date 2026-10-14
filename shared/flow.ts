import type { GraphEdge } from './types.ts';

/**
 * Edges a trace follows backwards: traffic/events ("flow") and dependencies ("uses"), so tracing an
 * IAM policy walks policy ← role ← Lambda ← ALB ← … Route/manages edges aren't data paths.
 */
const isFlow = (e: GraphEdge) => e.kind === 'flow' || e.kind === 'uses';

/** Everything that can send data, directly or indirectly, into `target`. */
export function upstream(edges: GraphEdge[], target: string): { nodes: Set<string>; edges: Set<string> } {
  const into = new Map<string, GraphEdge[]>();
  for (const e of edges.filter(isFlow)) into.set(e.target, [...(into.get(e.target) ?? []), e]);
  const nodes = new Set([target]);
  const used = new Set<string>();
  const queue = [target];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of into.get(id) ?? []) {
      used.add(e.id);
      if (!nodes.has(e.source)) {
        nodes.add(e.source);
        queue.push(e.source);
      }
    }
  }
  return { nodes, edges: used };
}

export interface FlowStep {
  node: string;
  /** Label of the edge leading *out* of this step towards the target. */
  via?: string;
  /** Kind of that edge: traffic, or a dependency (e.g. Lambda uses its IAM role). */
  kind?: GraphEdge['kind'];
}

/** Every distinct path that ends at `target`, starting from something nothing else feeds. Capped to stay readable. */
export function pathsInto(edges: GraphEdge[], target: string, max = 12): FlowStep[][] {
  const into = new Map<string, GraphEdge[]>();
  for (const e of edges.filter(isFlow)) into.set(e.target, [...(into.get(e.target) ?? []), e]);
  const out: FlowStep[][] = [];
  const walk = (id: string, tail: FlowStep[], seen: Set<string>) => {
    if (out.length >= max) return;
    const ins = (into.get(id) ?? []).filter((e) => !seen.has(e.source));
    if (!ins.length) {
      if (tail.length > 1) out.push(tail);
      return;
    }
    for (const e of ins) walk(e.source, [{ node: e.source, via: e.label, kind: e.kind }, ...tail], new Set(seen).add(e.source));
  };
  walk(target, [{ node: target }], new Set([target]));
  return out;
}
