import type { CostComponent, CostReport, GraphEdge, GraphNode, NodeAccess } from '../../../shared/types.ts';
import { pathsInto } from '../../../shared/flow.ts';
import { componentQuantity, formatQuantity, formatUnitPrice, formatUsd, prettyUnit, type LineCost } from '../../../shared/cost.ts';
import { CATEGORY_LABEL, categoryVar } from '../lib/categories.ts';
import { awsName } from '../../../shared/awsNames.ts';
import { useState } from 'react';
import { UsageSlider } from './UsageSlider.tsx';
import { TerraformSource } from './TerraformSource.tsx';

interface Props {
  node: GraphNode;
  cost: CostReport;
  values: Record<string, number>;
  overrides: Record<string, number>;
  setUsage: (key: string, v: number | undefined) => void;
  expanded: boolean;
  onToggleExpand: () => void;
  onSelect: (id: string) => void;
  /** Changes on every apply, so the source view re-reads files. */
  stateSerial: number;
  /** Per-line monthly cost after any free tier. */
  lines: Map<string, LineCost>;
  edges: GraphEdge[];
  nodesById: Map<string, GraphNode>;
}

export function Inspector({ node, cost, values, overrides, setUsage, expanded, onToggleExpand, onSelect, stateSerial, lines, edges, nodesById }: Props) {
  const [view, setView] = useState<'overview' | 'terraform'>('overview');
  const components = cost.components.filter((c) => c.nodeId === node.id);
  const params = cost.usage.filter((p) => p.nodeId === node.id);
  const unpriced = cost.unpriced.filter((u) => u.nodeId === node.id);
  const total = components.reduce((s, c) => s + (lines.get(c.id)?.monthly ?? 0), 0);
  const isFree = !components.length && !unpriced.length && node.addresses.some((a) => cost.free.some((f) => f.address === a));

  return (
    <div className="inspector">
      <header className="inspector__head" style={{ ['--cat' as string]: categoryVar(node.category) }}>
        <span className="inspector__cat">{awsName(node.type)?.service ?? CATEGORY_LABEL[node.category]}</span>
        {awsName(node.type) && <span className="inspector__kind">{awsName(node.type)!.resource}</span>}
        <h2>{node.label}</h2>
        <code className="inspector__type">{node.type}</code>
        {(components.length > 0 || isFree) && (
          <div className="inspector__total">
            <strong>{formatUsd(total)}</strong>
            <span>/ month{params.length ? ' at the usage below' : ''}</span>
          </div>
        )}
      </header>

      {node.addresses.length > 0 && (
        <nav className="subtabs" role="tablist">
          <button role="tab" aria-selected={view === 'overview'} className={view === 'overview' ? 'is-on' : ''} onClick={() => setView('overview')}>
            Overview
          </button>
          <button role="tab" aria-selected={view === 'terraform'} className={view === 'terraform' ? 'is-on' : ''} onClick={() => setView('terraform')}>
            Terraform
          </button>
        </nav>
      )}

      {view === 'terraform' && node.addresses.length > 0 ? (
        <TerraformSource addresses={node.addresses} refreshKey={`${node.id}@${stateSerial}`} />
      ) : (
      <>
      {node.virtual && node.type === 'aws_instance' && (
        <p className="muted small">Launched by the Auto Scaling Group. Its cost is counted on the ASG.</p>
      )}

      {components.length > 0 && (
        <section>
          <h3>Cost breakdown</h3>
          <table className="lines">
            <tbody>
              {components.map((c) => (
                <Line key={c.id} c={c} values={values} line={lines.get(c.id)} />
              ))}
            </tbody>
          </table>
        </section>
      )}

      {params.length > 0 && (
        <section>
          <h3>Usage assumptions</h3>
          {params.map((p) => (
            <UsageSlider key={p.key} param={p} value={values[p.key] ?? p.default} overridden={p.key in overrides} onChange={(v) => setUsage(p.key, v)} />
          ))}
        </section>
      )}

      {unpriced.length > 0 && (
        <section>
          <h3>Not priced</h3>
          <ul className="warnlist">
            {unpriced.map((u, i) => (
              <li key={i}>{u.reason}</li>
            ))}
          </ul>
        </section>
      )}

      <Reaches target={node.id} edges={edges} nodesById={nodesById} onSelect={onSelect} />

      {node.access && <Access access={node.access} expanded={expanded} onToggle={onToggleExpand} onSelect={onSelect} />}

      {node.details.length > 0 && (
        <section>
          <h3>Configuration</h3>
          <dl className="kv">
            {node.details.map(([k, v], i) => (
              <div key={i}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {node.addresses.length > 0 && (
        <section>
          <h3>Terraform {node.addresses.length > 1 ? `resources (${node.addresses.length})` : 'resource'}</h3>
          <ul className="addresses">
            {node.addresses.map((a) => (
              <li key={a}>
                <code>{a}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
      </>
      )}
    </div>
  );
}

function Line({ c, values, line }: { c: CostComponent; values: Record<string, number>; line?: LineCost }) {
  const qty = componentQuantity(c, values);
  const monthly = line?.monthly ?? 0;
  const free = line?.freeUnits ?? 0;
  return (
    <tr>
      <td>
        <div className="lines__name">
          {c.kind === 'usage' && <span className="pill">usage</span>}
          {c.name}
        </div>
        <div className="lines__calc">
          {formatQuantity(qty)} {prettyUnit(c.unit)} × {formatUnitPrice(c.tiers[0]?.price ?? 0, c.unit)}
          {c.tiers.length > 1 && <span title={c.tiers.map((t) => `${formatQuantity(t.from)}–${t.to === null ? '∞' : formatQuantity(t.to)}: ${formatUnitPrice(t.price, c.unit)}`).join('\n')}> · tiered</span>}
        </div>
        {free > 0 && (
          <div className="lines__free" title={c.freeTier?.label}>
            − {formatQuantity(free)} {prettyUnit(c.unit)} covered by free tier
            {c.freeTier && free < c.freeTier.allowance * 0.999 && ` (shares ${formatQuantity(c.freeTier.allowance)}/mo with similar resources)`}
          </div>
        )}
        {!free && c.freeTier && <div className="lines__free is-off">free tier: {formatQuantity(c.freeTier.allowance)} {prettyUnit(c.unit)}/mo per account</div>}
        {c.note && <div className="lines__note">{c.note}</div>}
        <div className="lines__sku" title={c.priceDescription}>
          {c.pageUrl ? (
            <a href={c.pageUrl} target="_blank" rel="noreferrer">
              {c.source} ↗
            </a>
          ) : (
            c.source
          )}{' '}
          · SKU {c.sku}
          {c.dataUrl && (
            <>
              {' · '}
              <a href={c.dataUrl} target="_blank" rel="noreferrer" title="Raw AWS price list CSV this number was read from (large file)">
                raw CSV
              </a>
            </>
          )}
        </div>
      </td>
      <td className="num">{formatUsd(monthly)}</td>
    </tr>
  );
}

function Access({ access, expanded, onToggle, onSelect }: { access: NodeAccess; expanded: boolean; onToggle: () => void; onSelect: (id: string) => void }) {
  const go = (id?: string) => (id ? () => onSelect(id) : undefined);
  return (
    <section className="access">
      <h3>
        Access
        <button type="button" className="linkish access__toggle" onClick={onToggle}>
          {expanded ? 'hide on diagram' : 'show on diagram'}
        </button>
      </h3>

      {access.roles.map((r) => (
        <div key={r.address} className="access__block">
          <div className="access__head">
            <span className="chip chip--iam">IAM role</span>
            <button type="button" className="linkish" onClick={go(r.nodeId)}>{r.name}</button>
          </div>
          <p className="access__meta">
            {r.via && <>via instance profile <code>{r.via}</code> · </>}
            assumed by {r.trustedBy.map((t) => <code key={t}>{t}</code>)}
          </p>
          {r.policies.length === 0 && <p className="muted small">No policies attached: this role can't do anything yet.</p>}
          {r.policies.map((p) => (
            <div key={p.name} className="policy">
              <div className="policy__name">
                {p.managed ? 'AWS managed' : 'policy'}{' '}
                <button type="button" className="linkish" onClick={go(p.nodeId)}>{p.name}</button>
              </div>
              {p.statements.map((st, i) => (
                <div key={i} className={`stmt stmt--${st.effect.toLowerCase()}`}>
                  <span className="stmt__effect">{st.effect}</span>
                  <span className="stmt__actions">{st.actions.map((a) => <code key={a}>{a}</code>)}</span>
                  <span className="stmt__on">on {st.resources.join(', ')}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}

      {access.securityGroups.map((g) => (
        <div key={g.address} className="access__block">
          <div className="access__head">
            <span className="chip chip--sg">Security group</span>
            <button type="button" className="linkish" onClick={go(g.nodeId)}>{g.name}</button>
          </div>
          <ul className="rules">
            {g.ingress.length === 0 && <li><span className="rules__dir">in</span> nothing allowed</li>}
            {g.ingress.map((r) => <li key={r}><span className="rules__dir">in</span> {r}</li>)}
            {g.egress.map((r) => <li key={r}><span className="rules__dir">out</span> {r}</li>)}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** "How does traffic get here?" Every path into this resource, from its origin. */
function Reaches({ target, edges, nodesById, onSelect }: { target: string; edges: GraphEdge[]; nodesById: Map<string, GraphNode>; onSelect: (id: string) => void }) {
  const paths = pathsInto(edges, target);
  if (!paths.length) return null;
  return (
    <section className="reaches">
      <h3>What can reach this</h3>
      <ol className="paths">
        {paths.map((p, i) => (
          <li key={i}>
            {p.map((step, j) => (
              <span key={j} className="paths__step">
                {j === p.length - 1 ? (
                  <b>{nodesById.get(step.node)?.label ?? step.node}</b>
                ) : (
                  <button type="button" className="linkish" onClick={() => onSelect(step.node)}>
                    {nodesById.get(step.node)?.label ?? step.node}
                  </button>
                )}
                {j < p.length - 1 && (
                  <span className={`paths__arrow ${step.kind === 'uses' ? 'is-uses' : ''}`} title={step.kind === 'uses' ? 'uses (dependency, not traffic)' : 'sends traffic/events to'}>
                    {step.kind === 'uses' ? ` ⇢${step.via ? ` ${step.via}` : ''} ` : step.via ? ` —${step.via}→ ` : ' → '}
                  </span>
                )}
              </span>
            ))}
          </li>
        ))}
      </ol>
    </section>
  );
}
