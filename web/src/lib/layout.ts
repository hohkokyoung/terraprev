import ELK, { type ElkNode, type ElkExtendedEdge, type ElkPoint } from 'elkjs/lib/elk.bundled.js';
import { Position, type Edge, type Node } from '@xyflow/react';
import type { GraphEdge, GraphNode } from '../../../shared/types.ts';
import type { NodeChange } from '../../../shared/compare.ts';

const elk = new ELK();

export const SIZE = {
  resource: { width: 216, height: 64 },
  virtual: { width: 176, height: 48 },
  emptyGroup: { width: 240, height: 84 },
};

export type FlowNodeData = {
  node: GraphNode; monthly?: number; hasUsage: boolean; fresh: boolean; expanded?: boolean; revealed?: boolean; traced?: 'target' | 'source' | 'off';
  /** Plan preview / comparison: what happens to this node, and its monthly cost change. */
  change?: NodeChange; delta?: number;
};
export type FlowEdgeData = { kind: GraphEdge['kind']; points?: ElkPoint[]; labelPos?: ElkPoint };

/** Header height reserved inside each group so children never overlap its title + subtitle. */
const GROUP_TOP = { provider: 58, vpc: 54, subnet: 54 } as const;

function sizeOf(n: GraphNode) {
  return n.virtual ? SIZE.virtual : SIZE.resource;
}

const labelSize = (text: string) => ({ width: Math.ceil(text.length * 6.4) + 10, height: 16 });

/**
 * Nested ELK layout: provider → VPC → subnet → resources.
 * ELK also routes the edges (orthogonal, around boxes); we draw exactly those routes.
 */
export async function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const ids = new Set(nodes.map((n) => n.id));
  const children = new Map<string | undefined, GraphNode[]>();
  for (const n of nodes) {
    const parent = n.parentId && ids.has(n.parentId) ? n.parentId : undefined;
    children.set(parent, [...(children.get(parent) ?? []), n]);
  }

  const toElk = (n: GraphNode): ElkNode => {
    const kids = children.get(n.id) ?? [];
    if (n.kind === 'group') {
      if (!kids.length) return { id: n.id, ...SIZE.emptyGroup };
      const subnet = n.groupKind === 'subnet';
      return {
        id: n.id,
        layoutOptions: {
          'elk.padding': `[top=${GROUP_TOP[n.groupKind ?? 'vpc']},left=20,bottom=20,right=20]`,
          'elk.spacing.nodeNode': subnet ? '16' : '32',
          'elk.nodeSize.constraints': 'MINIMUM_SIZE',
          'elk.nodeSize.minimum': '(260,84)',
        },
        children: sortStable(kids).map(toElk),
      };
    }
    return { id: n.id, ...sizeOf(n) };
  };

  const visibleEdges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  const root: ElkNode = {
    id: '__root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      // Edge bend points in root coordinates = React Flow's absolute coordinates.
      'elk.json.edgeCoords': 'ROOT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '72',
      'elk.layered.spacing.edgeNodeBetweenLayers': '28',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '14',
      'elk.spacing.edgeEdge': '14',
      'elk.spacing.edgeNode': '22',
      'elk.spacing.nodeNode': '32',
      'elk.spacing.edgeLabel': '4',
      'elk.edgeLabels.placement': 'CENTER',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.mergeEdges': 'false',
    },
    children: sortStable(children.get(undefined) ?? []).map(toElk),
    edges: visibleEdges.map(
      (e): ElkExtendedEdge => ({
        id: e.id,
        sources: [e.source],
        targets: [e.target],
        labels: e.label ? [{ id: `${e.id}:label`, text: e.label, ...labelSize(e.label) }] : undefined,
      }),
    ),
  };

  const out = await elk.layout(root);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const flowNodes: Node[] = [];
  const walk = (en: ElkNode, parentId?: string) => {
    for (const c of en.children ?? []) {
      const n = byId.get(c.id)!;
      flowNodes.push({
        id: c.id,
        type: n.kind === 'group' ? 'group-box' : 'resource',
        position: { x: c.x ?? 0, y: c.y ?? 0 },
        parentId,
        width: c.width,
        height: c.height,
        // Known size + handle positions: React Flow can draw edges without measuring the DOM
        // (needed for headless PDF export, and avoids a blank first frame).
        measured: { width: c.width, height: c.height },
        handles: [
          { type: 'target', position: Position.Left, x: 0, y: (c.height ?? 0) / 2, width: 1, height: 1 },
          { type: 'source', position: Position.Right, x: (c.width ?? 0) - 1, y: (c.height ?? 0) / 2, width: 1, height: 1 },
        ],
        style: { width: c.width, height: c.height },
        draggable: false,
        selectable: true,
        data: { node: n, hasUsage: false, fresh: false } satisfies FlowNodeData,
        zIndex: n.kind === 'group' ? 0 : 10,
      });
      walk(c, c.id);
    }
  };
  walk(out);

  const routed = new Map((out.edges ?? []).map((e) => [e.id, e as ElkExtendedEdge]));
  const flowEdges: Edge[] = visibleEdges.map((e) => {
    const r = routed.get(e.id);
    const s = r?.sections?.[0];
    const points = s ? [s.startPoint, ...(s.bendPoints ?? []), s.endPoint] : undefined;
    const l = r?.labels?.[0];
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      type: 'elk',
      className: `edge-${e.kind}`,
      data: { kind: e.kind, points, labelPos: l && l.x !== undefined ? { x: l.x + (l.width ?? 0) / 2, y: (l.y ?? 0) + (l.height ?? 0) / 2 } : undefined } satisfies FlowEdgeData,
      zIndex: 5,
      markerEnd: e.kind === 'flow' ? { type: 'arrowclosed' as any, width: 14, height: 14 } : undefined,
    };
  });
  return { nodes: flowNodes, edges: flowEdges };
}

/** Model order matters to ELK: spanning resources first, then public subnets, then private, each by AZ. */
function rank(n: GraphNode): number {
  if (n.kind === 'resource') return 0;
  if (n.groupKind === 'subnet') return n.sublabel?.startsWith('public') ? 1 : 2;
  return 1;
}
function sortStable(xs: GraphNode[]) {
  return [...xs].sort((a, b) => rank(a) - rank(b) || (a.sublabel ?? '').localeCompare(b.sublabel ?? '') || a.id.localeCompare(b.id));
}

/** Viewport that fits the whole laid-out diagram into a box of the given size (no DOM measuring). */
export function fitViewport(nodes: Node[], width: number, height: number, padding = 0.04) {
  const top = nodes.filter((n) => !n.parentId);
  if (!top.length) return { x: 0, y: 0, zoom: 1 };
  const x1 = Math.min(...top.map((n) => n.position.x));
  const y1 = Math.min(...top.map((n) => n.position.y));
  const x2 = Math.max(...top.map((n) => n.position.x + (n.width ?? 0)));
  const y2 = Math.max(...top.map((n) => n.position.y + (n.height ?? 0)));
  const zoom = Math.min((width * (1 - 2 * padding)) / (x2 - x1), (height * (1 - 2 * padding)) / (y2 - y1), 2);
  return { x: (width - (x2 - x1) * zoom) / 2 - x1 * zoom, y: (height - (y2 - y1) * zoom) / 2 - y1 * zoom, zoom };
}
