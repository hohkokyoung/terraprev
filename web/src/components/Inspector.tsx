import type { CostComponent, CostReport, GraphEdge, GraphNode, Insight, NodeAccess } from '../../../shared/types.ts';
import { FindingRow } from './FindingsPanel.tsx';
import { pathsInto } from '../../../shared/flow.ts';
import { componentQuantity, formatQuantity, formatUnitPrice, formatUsd, prettyUnit, type LineCost } from '../../../shared/cost.ts';
import { CATEGORY_LABEL, categoryVar } from '../lib/categories.ts';
import { awsName } from '../../../shared/awsNames.ts';
import { useState } from 'react';
import { UsageSlider } from './UsageSlider.tsx';
import { TerraformSource } from './TerraformSource.tsx';
import { changeText, formatDelta, gapText, type Diff, type NodeDiff } from '../../../shared/compare.ts';
import { deltaClass } from './ChangesPanel.tsx';
import { priceSavings } from '../../../shared/savings.ts';
import { SavingsList } from './Savings.tsx';

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
  /** Plan preview / comparison: what happens to this resource. */
  change?: NodeDiff;
  compare?: Pick<Diff, 'kind' | 'baseLabel' | 'targetLabel'>;
  freeTier: boolean;
  /** Findings about this resource, worst first (strengths last). */
  findings: Insight[];
}

export function Inspector({ findings, node, cost, values, overrides, setUsage, expanded, onToggleExpand, onSelect, stateSerial, lines, edges, nodesById, change, compare, freeTier }: Props) {
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
        <nav className="subtabs" role="group" aria-label="Resource view">
          <button type="button" aria-pressed={view === 'overview'} className={view === 'overview' ? 'is-on' : ''} onClick={() => setView('overview')}>
            Overview
          </button>
          <button type="button" aria-pressed={view === 'terraform'} className={view === 'terraform' ? 'is-on' : ''} onClick={() => setView('terraform')}>
            Terraform
          </button>
        </nav>
      )}

      {view === 'terraform' && node.addresses.length > 0 ? (
        <TerraformSource addresses={node.addresses} refreshKey={`${node.id}@${stateSerial}`} />
      ) : (
      <>
      {change && compare && <ChangeSection change={change} diff={compare} />}

      {findings.length > 0 && (
        <section className="findings">
          <h3>Findings</h3>
          <ol className="findings__list">
            {findings.map((f) => <FindingRow key={f.id} f={f} />)}
          </ol>
        </section>
      )}

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

      <NodeSavings cost={cost} nodeId={node.id} values={values} freeTier={freeTier} />

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

function NodeSavings({ cost, nodeId, values, freeTier }: { cost: CostReport; nodeId: string; values: Record<string, number>; freeTier: boolean }) {
  const items = priceSavings(cost.components, cost.savings?.filter((s) => s.nodeId === nodeId), values, freeTier);
  if (!items.length) return null;
  return (
    <section className="savingsbox">
      <h3>Ways to save</h3>
      <SavingsList items={items} />
    </section>
  );
}

function ChangeSection({ change, diff }: { change: NodeDiff; diff: Pick<Diff, 'kind' | 'baseLabel' | 'targetLabel'> }) {
  const plan = diff.kind === 'plan';
  if (!plan) {
    // Two stacks: both sides in a table, so it never reads as one turning into the other.
    const usd = (x: number) => (x ? formatUsd(x) : '–');
    return (
      <section className="inspector__change">
        <h3>Compared with {diff.baseLabel}</h3>
        <p className="inspector__changeline">
          <span className={`chg chg--${change.change}`}>{changeText(diff, change.change)}</span>
          {Math.abs(change.delta) >= 0.005 && <span>{diff.targetLabel} costs <b>{gapText(change.delta)}</b> a month</span>}
        </p>
        <table className="sides">
          <thead>
            <tr><th /><th>{diff.baseLabel}</th><th>{diff.targetLabel}</th></tr>
          </thead>
          <tbody>
            <tr><th>per month</th><td>{usd(change.before)}</td><td>{usd(change.after)}</td></tr>
            {change.fields.map((f) => (
              <tr key={f.key} className="is-diff"><th>{f.key}</th><td>{f.before ?? '–'}</td><td>{f.after ?? '–'}</td></tr>
            ))}
          </tbody>
        </table>
        {change.change === 'removed' && <p className="muted small">Only {diff.baseLabel} has this. It is drawn dashed where it sits in {diff.baseLabel}.</p>}
        {change.change === 'added' && <p className="muted small">Only {diff.targetLabel} has this.</p>}
      </section>
    );
  }
  return (
    <section className="inspector__change">
      <h3>{plan ? 'This plan' : `Compared with ${diff.baseLabel}`}</h3>
      <p className="inspector__changeline">
        <span className={`chg chg--${change.change}`}>{changeText(diff, change.change)}</span>
        {(change.before > 0 || change.after > 0) && (
          <span>
            {change.before ? formatUsd(change.before) : '–'} → {change.after ? formatUsd(change.after) : '–'} /month{' '}
            <b className={deltaClass(change.delta)}>{formatDelta(change.delta)}</b>
          </span>
        )}
      </p>
      {change.change === 'removed' && <p className="muted small">{plan ? 'Destroyed by this plan.' : `Only in ${diff.baseLabel}.`} Shown faded where it would be.</p>}
      {change.fields.length > 0 && (
        <dl className="kv kv--diff">
          {change.fields.map((f) => (
            <div key={f.key}>
              <dt>{f.key}</dt>
              <dd><s>{f.before ?? '–'}</s> → <b>{f.after ?? '–'}</b></dd>
            </div>
          ))}
        </dl>
      )}
      {change.attrs.length > 0 && (
        <p className="small muted">Changed attributes: {change.attrs.map((a, i) => <span key={a}>{i ? ', ' : ''}<code>{a}</code></span>)}</p>
      )}
      {change.unknown && <p className="warn small">Some cost-relevant values are only known after apply; the cost may be higher than shown.</p>}
    </section>
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
