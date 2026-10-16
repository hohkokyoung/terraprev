import { useEffect, useMemo, useState } from 'react';
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, type Edge, type Node } from '@xyflow/react';
import type { CostComponent, GraphEdge, GraphNode } from '../../../shared/types.ts';
import { fitViewport, layoutGraph, type FlowNodeData } from '../lib/layout.ts';
import { nodeTypes } from './nodes.tsx';
import { ElkEdge } from './ElkEdge.tsx';
import { ExpandContext } from '../lib/expand.ts';
import { upstream } from '../../../shared/flow.ts';
import type { NodeChange } from '../../../shared/compare.ts';

const edgeTypes = { elk: ElkEdge };

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  showSupporting: boolean;
  /** Show every "uses" dependency line; otherwise only those touching the selected node. */
  showDeps: boolean;
  /** Nodes whose IAM / security groups are drawn. */
  expanded: Set<string>;
  onToggleExpand: (id: string) => void;
  /** Data flow mode: selecting a node highlights everything that can send data into it. */
  flowMode: boolean;
  /** Fixed canvas size (print/PDF): fit by arithmetic instead of measuring. */
  pageSize?: { width: number; height: number };
  /** Static figure (report): no controls, minimap, panning or clicking. */
  embedded?: boolean;
  /** Changes when the app resizes the canvas (side panel, print). Remounting measures the new size synchronously and fits. */
  fitSignal?: unknown;
  costByNode: Map<string, number>;
  components: CostComponent[];
  fresh: Set<string>;
  /** Plan preview / comparison: change per node, and the monthly cost change. */
  changes?: Map<string, NodeChange>;
  deltas?: Map<string, number>;
  /** Edges that only exist on the "before" side (to or from a removed node). */
  ghostEdges?: Set<string>;
  selected?: string;
  onSelect: (id: string | undefined) => void;
}

export function Diagram({ nodes, edges, showSupporting, showDeps, expanded, onToggleExpand, flowMode, fitSignal, pageSize, embedded, costByNode, components, fresh, changes, deltas, ghostEdges, selected, onSelect }: Props) {
  const [layout, setLayout] = useState<{ nodes: Node[]; edges: Edge[] }>({ nodes: [], edges: [] });
  // Bumped on every new layout; remounting ReactFlow re-runs its built-in fitView once nodes are measured.
  const [version, setVersion] = useState(0);

  // Supporting nodes revealed by expanding a resource's IAM / SG chips.
  const revealed = useMemo(() => {
    const ids = new Set<string>();
    for (const n of nodes) if (expanded.has(n.id)) n.access?.nodeIds.forEach((id) => ids.add(id));
    return ids;
  }, [nodes, expanded]);
  const visible = useMemo(() => nodes.filter((n) => showSupporting || !n.supporting || revealed.has(n.id)), [nodes, showSupporting, revealed]);
  // ASG → instance lines are implied by the labels; routes only make sense next to route tables.
  const laidOutEdges = useMemo(() => edges.filter((e) => e.kind !== 'manages' && (e.kind !== 'route' || showSupporting)), [edges, showSupporting]);
  // Re-layout only when the shape of the graph changes, not when prices or sliders move.
  const shapeKey = useMemo(
    () => visible.map((n) => `${n.id}<${n.parentId}`).join('|') + '#' + laidOutEdges.map((e) => e.id).join('|'),
    [visible, laidOutEdges],
  );

  useEffect(() => {
    let cancelled = false;
    layoutGraph(visible, laidOutEdges).then((l) => {
      if (cancelled) return;
      setLayout(l);
      setVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapeKey]);

  const usageNodes = useMemo(() => new Set(components.filter((c) => c.kind === 'usage').map((c) => c.nodeId)), [components]);
  const pricedNodes = useMemo(() => new Set(components.map((c) => c.nodeId)), [components]);
  const providerTotals = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of nodes) {
      const v = costByNode.get(n.id);
      if (v) m.set(n.provider, (m.get(n.provider) ?? 0) + v);
    }
    return m;
  }, [nodes, costByNode]);

  const trace = useMemo(() => (flowMode && selected ? upstream(edges, selected) : undefined), [flowMode, selected, edges]);

  const flowNodes = useMemo(
    () =>
      layout.nodes.map((fn) => {
        const d = fn.data as FlowNodeData;
        const n = d.node;
        const monthly = n.groupKind === 'provider' ? providerTotals.get(n.provider) : pricedNodes.has(n.id) ? (costByNode.get(n.id) ?? 0) : undefined;
        return {
          ...fn,
          selected: fn.id === selected,
          data: {
            ...d, monthly, hasUsage: usageNodes.has(n.id), fresh: fresh.has(n.id), change: changes?.get(n.id), delta: deltas?.get(n.id), expanded: expanded.has(n.id), revealed: revealed.has(n.id) && !showSupporting,
            traced: trace ? (trace.nodes.has(n.id) ? (n.id === selected ? 'target' : 'source') : n.kind === 'group' ? undefined : 'off') : undefined,
          },
        };
      }),
    [layout.nodes, costByNode, pricedNodes, usageNodes, providerTotals, fresh, changes, deltas, selected, expanded, revealed, showSupporting, trace],
  );

  const flowEdges = useMemo(
    () =>
      layout.edges.map((laid) => {
        const e = ghostEdges?.has(laid.id) ? { ...laid, className: `${laid.className} edge-ghost` } : laid;
        const touches = !!selected && (e.source === selected || e.target === selected);
        const kind = (e.data as { kind: string }).kind;
        const inCluster = (id: string) => expanded.has(id) || revealed.has(id);
        const expandedLink = inCluster(e.source) && inCluster(e.target) && (revealed.has(e.source) || revealed.has(e.target));
        if (trace) {
          const onPath = trace.edges.has(e.id);
          return {
            ...e,
            hidden: kind === 'uses' && !showDeps && !expandedLink && !onPath,
            className: [e.className, onPath ? 'is-path' : 'is-dim'].join(' '),
            zIndex: onPath ? 20 : 5,
          };
        }
        return {
          ...e,
          hidden: kind === 'uses' && !showDeps && !touches && !expandedLink,
          className: [e.className, touches && 'is-active', selected && !touches && 'is-dim'].filter(Boolean).join(' '),
          zIndex: touches ? 20 : 5,
        };
      }),
    [layout.edges, selected, showDeps, expanded, revealed, trace, ghostEdges],
  );

  return (
    <ExpandContext.Provider value={onToggleExpand}>
    <ReactFlow
      key={`${version}:${String(fitSignal)}`}
      fitView={!pageSize}
      fitViewOptions={{ padding: 0.05 }}
      defaultViewport={pageSize ? fitViewport(layout.nodes, pageSize.width, pageSize.height) : undefined}
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, n) => onSelect(n.id)}
      onPaneClick={() => onSelect(undefined)}
      edgeTypes={edgeTypes}
      nodesDraggable={false}
      panOnDrag={!embedded}
      zoomOnScroll={!embedded}
      zoomOnPinch={!embedded}
      zoomOnDoubleClick={!embedded}
      elementsSelectable={!embedded}
      nodesConnectable={false}
      minZoom={0.15}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} className="bg-dots" />
      {!embedded && <Controls showInteractive={false} position="bottom-left" />}
      {!embedded && <MiniMap
        pannable
        zoomable
        position="bottom-right"
        className="minimap"
        style={{ width: 150, height: 100 }}
        nodeColor={(n) => ((n.data as FlowNodeData).node.kind === 'group' ? 'transparent' : `var(--cat-${(n.data as FlowNodeData).node.category})`)}
        nodeStrokeColor={(n) => ((n.data as FlowNodeData).node.kind === 'group' ? 'var(--line-2)' : 'transparent')}
        nodeBorderRadius={4}
      />}
    </ReactFlow>
    </ExpandContext.Provider>
  );
}
