import { useEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, Controls, MiniMap, Panel, ReactFlow, useNodesInitialized, useReactFlow, useStore, type Edge, type Node } from '@xyflow/react';
import { awsName } from '../../../shared/awsNames.ts';
import { formatUsd } from '../../../shared/cost.ts';
import { cutOff, prefersReducedMotion, revealViewport, startViewport, wholeViewport, type Rect } from '../lib/viewport.ts';
import type { CostComponent, GraphEdge, GraphNode } from '../../../shared/types.ts';
import { fitViewport, layoutGraph, type FlowNodeData } from '../lib/layout.ts';
import { nodeTypes } from './nodes.tsx';
import { ElkEdge } from './ElkEdge.tsx';
import { ExpandContext } from '../lib/expand.ts';
import { upstream } from '../../../shared/flow.ts';
import type { NodeChange } from '../../../shared/compare.ts';
import type { NodeFindings } from '../lib/findings.ts';

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
  /** Live app only: each resource's worst open finding, stamped on its node. */
  findings?: Map<string, NodeFindings>;
  /** Plan preview: resources whose destruction or replacement loses stored data. */
  dataLoss?: Set<string>;
  selected?: string;
  onSelect: (id: string | undefined) => void;
}

export function Diagram({ nodes, edges, showSupporting, showDeps, expanded, onToggleExpand, flowMode, fitSignal, pageSize, embedded, costByNode, components, fresh, changes, deltas, ghostEdges, findings, dataLoss, selected, onSelect }: Props) {
  const [layout, setLayout] = useState<{ nodes: Node[]; edges: Edge[] }>({ nodes: [], edges: [] });
  // Bumped when a new stack is laid out; remounting ReactFlow re-runs its built-in fitView once nodes are measured.
  // Toggles that only show or hide nodes (supporting resources, expanded chips) keep the user's zoom and position.
  const [version, setVersion] = useState(0);
  const fittedStack = useRef<string | undefined>(undefined);
  const stackKey = useMemo(() => nodes.map((n) => n.id).join('|') + '#' + edges.map((e) => e.id).join('|'), [nodes, edges]);

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
      if (fittedStack.current !== stackKey) {
        fittedStack.current = stackKey;
        setVersion((v) => v + 1);
      }
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
        const nf = findings?.get(n.id), ch = changes?.get(n.id);
        return {
          ...fn,
          selected: fn.id === selected,
          // Boundaries (cloud, VPC, subnet) are context, not stops on the way through the diagram.
          focusable: n.kind !== 'group' && !embedded,
          ariaLabel: n.kind === 'group' ? undefined : [
            `${n.label}, ${awsName(n.type)?.full ?? n.type}`,
            monthly !== undefined && `${formatUsd(monthly)} a month`,
            ch && `plan: ${ch}`,
            dataLoss?.has(n.id) && 'data loss',
            nf && nf.summary,
          ].filter(Boolean).join('; '),
          data: {
            ...d, monthly, hasUsage: usageNodes.has(n.id), fresh: fresh.has(n.id), change: changes?.get(n.id), delta: deltas?.get(n.id), expanded: expanded.has(n.id), findings: findings?.get(n.id), dataLoss: dataLoss?.has(n.id), revealed: revealed.has(n.id) && !showSupporting,
            traced: trace ? (trace.nodes.has(n.id) ? (n.id === selected ? 'target' : 'source') : n.kind === 'group' ? undefined : 'off') : undefined,
          },
        };
      }),
    [layout.nodes, costByNode, pricedNodes, usageNodes, providerTotals, fresh, changes, deltas, findings, dataLoss, embedded, selected, expanded, revealed, showSupporting, trace],
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

  // What the opening view centers on when the whole stack can't be shown at a readable size:
  // the selection, then what just applied, then what a plan or comparison changes, then the priciest resource.
  const focus = useMemo(() => {
    const laid = new Map(layout.nodes.map((n) => [n.id, (n.data as FlowNodeData).node]));
    const real = (id: string) => laid.get(id)?.kind !== 'group' && laid.has(id);
    if (selected && laid.has(selected)) return [selected];
    const justApplied = [...fresh].filter(real);
    if (justApplied.length) return justApplied;
    const changed = changes ? [...changes.keys()].filter(real) : [];
    if (changed.length) return changed;
    let top: string | undefined;
    for (const id of laid.keys()) if (real(id) && (costByNode.get(id) ?? 0) > (costByNode.get(top ?? '') ?? 0)) top = id;
    return top ? [top] : [];
    // Only the opening view uses this; recomputing on every price tick is harmless.
  }, [layout.nodes, selected, fresh, changes, costByNode]);

  const viewKey = `${version}:${String(fitSignal)}`;
  const [placedKey, setPlacedKey] = useState<string>();
  const placing = !pageSize && placedKey !== viewKey;

  return (
    <ExpandContext.Provider value={onToggleExpand}>
    <ReactFlow
      key={viewKey}
      className={placing ? 'is-placing' : undefined}
      defaultViewport={pageSize ? fitViewport(layout.nodes, pageSize.width, pageSize.height) : undefined}
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, n) => onSelect(n.id)}
      // Keyboard: Tab moves between resources, Enter or Space opens one, Escape clears the selection.
      onKeyDown={(e) => {
        if (embedded) return;
        const id = (e.target as HTMLElement).closest?.('.react-flow__node')?.getAttribute('data-id');
        if (id && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onSelect(id);
        } else if (e.key === 'Escape' && selected) onSelect(undefined);
      }}
      edgesFocusable={false}
      ariaLabelConfig={{
        'node.a11yDescription.default': 'Press Enter or Space to open this resource in the side panel. Escape clears the selection.',
        'node.a11yDescription.keyboardDisabled': 'Press Enter or Space to open this resource in the side panel.',
      }}
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
      {!pageSize && <ViewportControl focus={focus} selected={selected} onPlaced={() => setPlacedKey(viewKey)} />}
      {!embedded && <Controls showInteractive={false} position="bottom-left" fitViewOptions={{ padding: 0.05, duration: prefersReducedMotion() ? 0 : 320 }} />}
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

/**
 * Lives inside ReactFlow so it can read the measured nodes. Places the opening view once per mount,
 * brings a newly selected resource on screen at a readable size, and offers the whole stack when
 * only part of it is showing.
 */
function ViewportControl({ focus, selected, onPlaced }: { focus: string[]; selected?: string; onPlaced: () => void }) {
  const rf = useReactFlow();
  const initialized = useNodesInitialized();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const nodes = useStore((s) => s.nodes);
  const transform = useStore((s) => s.transform);
  const placed = useRef(false);
  const lastSelected = useRef(selected);

  const graph = useMemo<Rect | undefined>(
    () => (initialized && nodes.length ? rf.getNodesBounds(nodes.filter((n) => !n.hidden)) : undefined),
    [initialized, nodes, rf],
  );

  useEffect(() => {
    if (placed.current || !graph || !width || !height) return;
    placed.current = true;
    lastSelected.current = selected;
    const target = focus.length ? rf.getNodesBounds(focus) : undefined;
    rf.setViewport(startViewport(graph, target, width, height));
    onPlaced();
    // Once per mount: later changes keep the user's view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, width, height]);

  useEffect(() => {
    if (!placed.current || !graph || selected === lastSelected.current) return;
    lastSelected.current = selected;
    if (!selected || !rf.getInternalNode(selected)) return;
    const next = revealViewport(rf.getNodesBounds([selected]), rf.getViewport(), graph, width, height);
    if (next) rf.setViewport(next, { duration: prefersReducedMotion() ? 0 : 320 });
  }, [selected, graph, width, height, rf]);

  const [x, y, zoom] = transform;
  if (!graph || !placed.current || !cutOff(graph, { x, y, zoom }, width, height)) return null;
  const whole = wholeViewport(graph, width, height);
  return (
    <Panel position="bottom-center">
      <button
        type="button"
        className="wholestack"
        onClick={() => rf.setViewport(whole, { duration: prefersReducedMotion() ? 0 : 320 })}
        title={`Zoom out to the whole stack (${Math.round(whole.zoom * 100)}%)`}
      >
        Show whole stack
      </button>
    </Panel>
  );
}
