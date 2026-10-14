import { useContext } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { ExpandContext } from '../lib/expand.ts';
import { formatUsd } from '../../../shared/cost.ts';
import { categoryVar } from '../lib/categories.ts';
import { awsName } from '../../../shared/awsNames.ts';
import type { FlowNodeData } from '../lib/layout.ts';

type FlowNode = Node<FlowNodeData>;

const TAGS: Record<string, string> = { internet: '⇄' };

export function ResourceNode({ data, selected }: NodeProps<FlowNode>) {
  const { node, monthly, hasUsage, fresh, expanded, revealed, traced } = data;
  const toggle = useContext(ExpandContext);
  const roles = node.access?.roles.length ?? 0;
  const sgs = node.access?.securityGroups.length ?? 0;
  const tag = TAGS[node.type] ?? node.sublabel ?? '';
  const hint = node.details[0]?.[1];
  return (
    <div
      className={['rnode', node.virtual && 'rnode--virtual', node.supporting && 'rnode--supporting', selected && 'is-selected', fresh && 'is-fresh', revealed && 'is-revealed', traced && `is-traced-${traced}`, node.type === 'internet' && 'rnode--internet']
        .filter(Boolean)
        .join(' ')}
      style={{ ['--cat' as string]: categoryVar(node.category) }}
      title={awsName(node.type) ? `${awsName(node.type)!.full}\n${node.label}` : node.label}
    >
      <Handle type="target" position={Position.Left} className="handle" />
      <span className="rnode__tag">{tag}</span>
      <span className="rnode__body">
        <span className="rnode__label" title={node.label}>{node.label}</span>
        {hint && <span className="rnode__hint">{hint}</span>}
      </span>
      {monthly !== undefined && (
        <span className={`rnode__cost ${monthly === 0 ? 'is-zero' : ''}`} title={hasUsage ? 'Includes usage-based estimate' : 'Always-on monthly cost'}>
          {hasUsage && <i>~</i>}
          {formatUsd(monthly)}
        </span>
      )}
      <Handle type="source" position={Position.Right} className="handle" />
      {(roles > 0 || sgs > 0) && (
        <button
          type="button"
          className={`rnode__chips nodrag ${expanded ? 'is-open' : ''}`}
          title={expanded ? 'Hide IAM role and security groups' : 'Show IAM role and security groups on the diagram'}
          aria-expanded={!!expanded}
          onClick={(e) => {
            e.stopPropagation();
            toggle(node.id);
          }}
        >
          {roles > 0 && <span className="chip chip--iam">IAM{roles > 1 ? ` ×${roles}` : ''}</span>}
          {sgs > 0 && <span className="chip chip--sg">SG{sgs > 1 ? ` ×${sgs}` : ''}</span>}
          <span className="chip__caret">{expanded ? '−' : '+'}</span>
        </button>
      )}
    </div>
  );
}

export function GroupNode({ data, selected }: NodeProps<FlowNode>) {
  const { node, monthly } = data;
  return (
    <div className={`gnode gnode--${node.groupKind} ${node.sublabel?.startsWith('public') ? 'gnode--public' : ''} ${selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Left} className="handle" />
      <div className="gnode__head">
        <div className="gnode__title">
          <span className="gnode__kind">{node.groupKind === 'provider' ? 'cloud' : node.groupKind}</span>
          <span className="gnode__label" title={node.label}>{node.label}</span>
          {node.groupKind === 'provider' && monthly !== undefined && <span className="gnode__cost">{formatUsd(monthly)}/mo</span>}
        </div>
        {node.sublabel && <div className="gnode__sub" title={node.sublabel}>{node.sublabel}</div>}
      </div>
      <Handle type="source" position={Position.Right} className="handle" />
    </div>
  );
}

export const nodeTypes = { resource: ResourceNode, 'group-box': GroupNode };
