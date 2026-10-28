import { useContext } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { ExpandContext } from '../lib/expand.ts';
import { formatUsd } from '../../../shared/cost.ts';
import { categoryVar } from '../lib/categories.ts';
import { awsName } from '../../../shared/awsNames.ts';
import type { FlowNodeData } from '../lib/layout.ts';
import { formatDelta } from '../../../shared/compare.ts';
import { SEVERITY_LABEL } from '../../../shared/report.ts';

type FlowNode = Node<FlowNodeData>;

const CHANGE_TAG = { added: '+', changed: '~', replaced: '±', removed: '−' } as const;

// The type cell has one fixed width; longer codes get a short form there and keep the full name in the hint.
const CELL_CODE: Record<string, string> = { DynamoDB: 'DDB', EventBridge: 'EVB', Cognito: 'COG', 'Step Fn': 'SFN', Secrets: 'SECR', Listener: 'LSNR' };
function cellCode(code: string) {
  if (code.length <= 6) return code;
  if (CELL_CODE[code]) return CELL_CODE[code];
  const words = code.split(/\s+/);
  return words.length > 1 ? words.map((w) => w[0]).join('').toUpperCase() : code.slice(0, 4).toUpperCase();
}

export function ResourceNode({ data, selected }: NodeProps<FlowNode>) {
  const { node, monthly, hasUsage, fresh, expanded, revealed, traced, change, delta, findings, dataLoss } = data;
  const toggle = useContext(ExpandContext);
  const roles = node.access?.roles.length ?? 0;
  const sgs = node.access?.securityGroups.length ?? 0;
  const internet = node.type === 'internet';
  // The internet edge is an annotation, not a part: no type code.
  const code = internet ? '' : node.sublabel ?? '';
  const tag = cellCode(code);
  const spec = node.details[0]?.[1];
  const hint = tag !== code ? [code, spec].filter(Boolean).join(' · ') : spec;
  return (
    <div
      className={['rnode', node.virtual && 'rnode--virtual', node.supporting && 'rnode--supporting', selected && 'is-selected', fresh && 'is-fresh', revealed && 'is-revealed', traced && `is-traced-${traced}`, change && `is-${change}`, dataLoss && 'is-dataloss', internet && 'rnode--internet']
        .filter(Boolean)
        .join(' ')}
      style={{ ['--cat' as string]: categoryVar(node.category) }}
      title={awsName(node.type) ? `${awsName(node.type)!.full}\n${node.label}` : node.label}
    >
      <Handle type="target" position={Position.Left} className="handle" />
      {tag && <span className="rnode__tag">{tag}</span>}
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
      {change && (
        <span className={`rnode__change chg chg--${change}`} title={delta ? `${formatDelta(delta)}/month` : undefined}>
          {CHANGE_TAG[change]}
          {delta !== undefined && Math.abs(delta) >= 0.005 && <b>{formatDelta(delta)}</b>}
          {dataLoss && <em>Data loss</em>}
        </span>
      )}
      {findings && (
        <span className={`rnode__finding sev sev--${findings.worst}`} title={`${findings.summary}. Select to see them.`}>
          {SEVERITY_LABEL[findings.worst]}
          {findings.count > 1 && <b>+{findings.count - 1}</b>}
        </span>
      )}
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
  const { node, monthly, change } = data;
  return (
    <div className={`gnode gnode--${node.groupKind} ${node.sublabel?.startsWith('public') ? 'gnode--public' : ''} ${selected ? 'is-selected' : ''} ${change ? `is-${change}` : ''}`}>
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
