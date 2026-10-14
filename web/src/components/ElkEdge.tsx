import { BaseEdge, EdgeLabelRenderer, Position, getSmoothStepPath, useInternalNode, type Edge, type EdgeProps, type InternalNode } from '@xyflow/react';
import type { FlowEdgeData } from '../lib/layout.ts';

/** Draws the orthogonal route ELK computed, with rounded corners. */
export function ElkEdge(props: EdgeProps<Edge<FlowEdgeData>>) {
  const { id, data, markerEnd, label } = props;
  const pts = data?.points;
  const src = useInternalNode(props.source);
  const dst = useInternalNode(props.target);
  let path: string;
  let lx: number;
  let ly: number;
  if ((!pts || pts.length < 2) && src && dst) {
    // No ELK route (e.g. edge added without a re-layout): connect the facing sides.
    [path, lx, ly] = getSmoothStepPath({ ...facingSides(src, dst), borderRadius: 8, offset: 16 });
  } else if (pts && pts.length >= 2) {
    path = roundedPath(pts, 8);
    const mid = data?.labelPos ?? midpoint(pts);
    lx = mid.x;
    ly = mid.y;
  } else {
    [path, lx, ly] = getSmoothStepPath(props);
  }
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      {label && (
        <EdgeLabelRenderer>
          <div className="edge-label nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}>
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

function roundedPath(pts: { x: number; y: number }[], r: number): string {
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [p, c, n] = [pts[i - 1], pts[i], pts[i + 1]];
    const r1 = Math.min(r, dist(p, c) / 2, dist(c, n) / 2);
    const a = toward(c, p, r1);
    const b = toward(c, n, r1);
    d += ` L ${a.x} ${a.y} Q ${c.x} ${c.y} ${b.x} ${b.y}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L ${last.x} ${last.y}`;
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const toward = (from: { x: number; y: number }, to: { x: number; y: number }, len: number) => {
  const d = dist(from, to) || 1;
  return { x: from.x + ((to.x - from.x) / d) * len, y: from.y + ((to.y - from.y) / d) * len };
};

/** Middle of the longest segment: where a label is least likely to sit on a corner. */
function midpoint(pts: { x: number; y: number }[]) {
  let best = 0;
  for (let i = 1; i < pts.length - 1; i++) if (dist(pts[i], pts[i + 1]) > dist(pts[best], pts[best + 1])) best = i;
  return { x: (pts[best].x + pts[best + 1].x) / 2, y: (pts[best].y + pts[best + 1].y) / 2 };
}

function facingSides(a: InternalNode, b: InternalNode) {
  const ra = rect(a);
  const rb = rect(b);
  const horizontal = rb.x >= ra.x + ra.w || rb.x + rb.w <= ra.x;
  if (horizontal) {
    const right = rb.x >= ra.x + ra.w;
    return {
      sourceX: right ? ra.x + ra.w : ra.x, sourceY: ra.y + ra.h / 2, sourcePosition: right ? Position.Right : Position.Left,
      targetX: right ? rb.x : rb.x + rb.w, targetY: rb.y + rb.h / 2, targetPosition: right ? Position.Left : Position.Right,
    };
  }
  const down = rb.y >= ra.y;
  return {
    sourceX: ra.x + ra.w / 2, sourceY: down ? ra.y + ra.h : ra.y, sourcePosition: down ? Position.Bottom : Position.Top,
    targetX: rb.x + rb.w / 2, targetY: down ? rb.y : rb.y + rb.h, targetPosition: down ? Position.Top : Position.Bottom,
  };
}

function rect(n: InternalNode) {
  return { x: n.internals.positionAbsolute.x, y: n.internals.positionAbsolute.y, w: n.measured.width ?? 0, h: n.measured.height ?? 0 };
}
