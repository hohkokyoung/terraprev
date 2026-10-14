import { useMemo, useState } from 'react';
import type { Category, CostReport, GraphNode } from '../../../shared/types.ts';
import { formatUsd } from '../../../shared/cost.ts';
import { CATEGORY_LABEL, categoryVar } from '../lib/categories.ts';

interface Props {
  cost: CostReport;
  nodes: GraphNode[];
  byNode: Map<string, number>;
  total: number;
  onSelect: (id: string) => void;
}

export function CostPanel({ cost, nodes, byNode, total, onSelect }: Props) {
  const [showFree, setShowFree] = useState(false);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const usageNodes = useMemo(() => new Set(cost.components.filter((c) => c.kind === 'usage').map((c) => c.nodeId)), [cost]);

  const rows = useMemo(
    () =>
      [...byNode.entries()]
        .map(([id, monthly]) => ({ id, monthly, node: nodeById.get(id) }))
        .filter((r) => r.node)
        .sort((a, b) => b.monthly - a.monthly),
    [byNode, nodeById],
  );

  const byCategory = useMemo(() => {
    const m = new Map<Category, number>();
    for (const r of rows) m.set(r.node!.category, (m.get(r.node!.category) ?? 0) + r.monthly);
    return [...m.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const freeTypes = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of cost.free) m.set(f.type, (m.get(f.type) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [cost.free]);

  const max = rows[0]?.monthly || 1;

  return (
    <div className="costpanel">
      {total > 0 && (
        <section>
          <div className="stackbar" role="img" aria-label="Monthly cost by category">
            {byCategory.map(([cat, v]) => (
              <span key={cat} style={{ width: `${(v / total) * 100}%`, background: categoryVar(cat) }} title={`${CATEGORY_LABEL[cat]}: ${formatUsd(v)}`} />
            ))}
          </div>
          <ul className="legend">
            {byCategory.map(([cat, v]) => (
              <li key={cat}>
                <i style={{ background: categoryVar(cat) }} />
                {CATEGORY_LABEL[cat]} <b>{formatUsd(v)}</b>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3>By resource</h3>
        <ol className="costrows">
          {rows.map(({ id, monthly, node }) => (
            <li key={id}>
              <button type="button" onClick={() => onSelect(id)} style={{ ['--cat' as string]: categoryVar(node!.category) }}>
                <span className="costrows__tag">{node!.sublabel}</span>
                <span className="costrows__label">{node!.label}</span>
                <span className="costrows__bar">
                  <span style={{ width: `${(monthly / max) * 100}%` }} />
                </span>
                <span className="costrows__amt">
                  {usageNodes.has(id) && <i title="Includes usage-based estimate">~</i>}
                  {formatUsd(monthly)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </section>

      {cost.unpriced.length > 0 && (
        <section>
          <h3 className="warn">Not priced ({cost.unpriced.length})</h3>
          <p className="muted small">These are not in the total. Click to inspect.</p>
          <ul className="warnlist">
            {cost.unpriced.map((u, i) => (
              <li key={i}>
                <button type="button" className="linkish" onClick={() => u.nodeId && onSelect(u.nodeId)}>
                  <code>{u.address}</code>
                </button>
                <span>{u.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {cost.free.length > 0 && (
        <section>
          <button type="button" className="disclosure" aria-expanded={showFree} onClick={() => setShowFree(!showFree)}>
            {cost.free.length} resources are free on their own
          </button>
          {showFree && (
            <ul className="freelist">
              {freeTypes.map(([t, n]) => (
                <li key={t}>
                  <code>{t}</code> {n > 1 && <span className="muted">×{n}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="sources">
        <h3>Prices from</h3>
        <ul>
          {cost.sources.map((s) => (
            <li key={s.name}>
              {s.pageUrl ? (
                <a href={s.pageUrl} target="_blank" rel="noreferrer">
                  {s.name.replace('AWS Price List · ', '')} ↗
                </a>
              ) : (
                s.name.replace('AWS Price List · ', '')
              )}
              {s.publishedAt && (
                <span className="muted">
                  {' · published '}
                  {s.dataUrl ? (
                    <a className="muted" href={s.dataUrl} target="_blank" rel="noreferrer" title="Raw AWS price list CSV (large file)">
                      {new Date(s.publishedAt).toLocaleDateString()}
                    </a>
                  ) : (
                    new Date(s.publishedAt).toLocaleDateString()
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
        <p className="muted small">
          On-demand list prices in USD for {cost.region}, from the public AWS Price List API. Free tier, savings plans, reserved
          capacity, taxes and data transfer out to the internet are not included. Month = 730 hours.
        </p>
        {cost.errors.map((e) => (
          <p key={e} className="warn small">{e}</p>
        ))}
      </section>
    </div>
  );
}
