import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type { Snapshot } from '../../../shared/types.ts';
import { buildReport, renderMarkdown, SEVERITY_LABEL, type Report } from '../../../shared/report.ts';
import { formatUsd } from '../../../shared/cost.ts';
import { formatDelta, type Diff } from '../../../shared/compare.ts';
import { Diagram } from './Diagram.tsx';
import { STATIC } from '../lib/staticData.ts';
import type { View } from '../lib/useView.ts';

interface Props {
  snapshot: Snapshot;
  usage: Record<string, number>;
  freeTier: boolean;
  costByNode: Map<string, number>;
  /** Plan preview / comparison shown on the page: the brief leads with it. */
  diff?: Diff;
  /** Live server: the comparison or plan on screen, so the server-printed PDF shows the same. */
  view?: View;
  onClose: () => void;
  /** Headless export: print as soon as the figure has rendered. */
  autoPrint?: boolean;
}

/** Figure height relative to its width; the diagram is fitted to whatever width the page gives it. */
const FIGURE_RATIO = 0.5;
const pct = (n: number) => `${Math.round(n * 100)}%`;

/** The CTO brief as a document: read on screen, save as PDF, or download as Markdown. */
export function ReportView({ snapshot, usage, freeTier, costByNode, diff, view, onClose, autoPrint }: Props) {
  const report: Report = useMemo(() => buildReport({ snapshot, usage, freeTier, diff }), [snapshot, usage, freeTier, diff]);
  const [copied, setCopied] = useState(false);
  const figRef = useRef<HTMLDivElement>(null);
  const [figW, setFigW] = useState(0);
  useLayoutEffect(() => {
    const el = figRef.current;
    if (!el) return;
    const measure = () => setFigW(Math.round(el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // Printing changes the page width; re-fit for paper, then back for screen.
    window.addEventListener('beforeprint', measure);
    window.addEventListener('afterprint', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('beforeprint', measure);
      window.removeEventListener('afterprint', measure);
    };
  }, []);
  const fileBase = `${report.title.split(':')[0].replace(/[^\w.-]+/g, '-')}-${diff?.kind === 'stacks' ? 'comparison' : 'brief'}`;
  // A plan or comparison: the same markers as the page's diagram, and what only the other side has, dashed.
  const figure = useMemo(() => ({
    nodes: [...snapshot.graph.nodes, ...(diff?.ghosts.nodes ?? [])],
    edges: [...snapshot.graph.edges, ...(diff?.ghosts.edges ?? [])],
    ghostEdges: new Set(diff?.ghosts.edges.map((e) => e.id)),
    deltas: new Map(diff?.nodes.filter((n) => Math.abs(n.delta) >= 0.005).map((n) => [n.id, n.delta])),
  }), [snapshot, diff]);

  // A modal: focus moves in on open and back to whatever opened it on close; the app behind is inert.
  const dialog = useRef<HTMLDivElement>(null);
  // Read during the first render: once the app behind turns inert, the opener has already lost focus.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => {
    dialog.current?.focus();
    // Wait a frame: the app behind is still inert while this unmounts.
    return () => { requestAnimationFrame(() => opener?.focus?.()); };
  }, [opener]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.documentElement.classList.add('report-open');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.documentElement.classList.remove('report-open');
    };
  }, [onClose]);

  const downloadMd = () => {
    const blob = new Blob([renderMarkdown(report)], { type: 'text/markdown' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${fileBase}.md` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const copyMd = async () => {
    try {
      await navigator.clipboard.writeText(renderMarkdown(report));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };
  const savePdf = () => {
    // Keep the theme on screen. "Auto" follows the OS, which print preview ignores, so pin it while printing.
    const root = document.documentElement;
    const chosen = root.getAttribute('data-theme');
    if (!chosen) root.setAttribute('data-theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    setTimeout(() => {
      window.print();
      if (!chosen) root.removeAttribute('data-theme');
    }, 300);
  };

  // Live server: it prints the PDF with headless Chrome and sends the file, so there's no print preview.
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string>();
  const downloadPdf = async () => {
    setPdfBusy(true);
    setPdfError(undefined);
    try {
      const theme = document.documentElement.getAttribute('data-theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const res = await fetch('/api/report.pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme, freeTier, usage, view }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await res.blob()), download: `${fileBase}.pdf` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (err) {
      setPdfError(`PDF failed: ${(err as Error).message}`);
    } finally {
      setPdfBusy(false);
    }
  };

  useEffect(() => {
    // Same pin for Ctrl+P / the browser's own Print, which bypass savePdf.
    const root = document.documentElement;
    let pinned = false;
    const pin = () => {
      if (root.hasAttribute('data-theme')) return;
      root.setAttribute('data-theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      pinned = true;
    };
    const unpin = () => {
      if (pinned) root.removeAttribute('data-theme');
      pinned = false;
    };
    window.addEventListener('beforeprint', pin);
    window.addEventListener('afterprint', unpin);
    return () => {
      window.removeEventListener('beforeprint', pin);
      window.removeEventListener('afterprint', unpin);
    };
  }, []);

  useEffect(() => {
    if (!autoPrint) return;
    // Headless export: theme from the URL (#report&dark), light by default.
    document.documentElement.setAttribute('data-theme', location.hash.includes('dark') ? 'dark' : 'light');
  }, [autoPrint]);


  return (
    <div className="report" role="dialog" aria-modal="true" aria-label={diff?.kind === 'stacks' ? 'Architecture & cost comparison' : 'Architecture & cost brief'} ref={dialog} tabIndex={-1}>
      <div className="report__bar">
        <span className="report__barTitle">{diff?.kind === 'stacks' ? 'Architecture & cost comparison' : 'Architecture & cost brief'}</span>
        <span className="report__barHint muted small">Uses your current usage assumptions{freeTier ? ' and free tier' : ''}.</span>
        {pdfError && <span className="report__barError small">{pdfError}</span>}
        {STATIC ? (
          <button type="button" onClick={savePdf}>Save as PDF</button>
        ) : (
          <button type="button" onClick={downloadPdf} disabled={pdfBusy} title="Rendered in the current theme and saved straight to a file">
            {pdfBusy ? 'Making PDF…' : 'Download PDF'}
          </button>
        )}
        <button type="button" onClick={downloadMd} title="Markdown with a Mermaid diagram: renders in GitHub, Notion and Confluence">Download Markdown</button>
        <button type="button" onClick={copyMd}>{copied ? 'Copied' : 'Copy Markdown'}</button>
        <button type="button" className="report__close" onClick={onClose} aria-label="Close report">✕</button>
      </div>

      <article className="doc">
        <header className="doc__head">
          <p className="doc__kicker">{diff?.kind === 'stacks' ? 'Architecture & cost comparison' : 'Architecture & cost brief'}</p>
          <h1>{report.title.split(':')[0]}</h1>
          <dl className="doc__meta" style={{ ['--meta-cols' as string]: Math.ceil(report.meta.length / 2) }}>
            {report.meta.map((m) => (
              <div key={m.label}>
                <dt>{m.label}</dt>
                <dd>{m.value}</dd>
              </div>
            ))}
          </dl>
        </header>

        <section>
          <h2>Executive summary</h2>
          {report.summary.map((p, i) => (
            <p key={i} className={i === report.summary.length - 1 && snapshot.environment ? 'doc__note' : undefined}>
              {renderBold(p)}
            </p>
          ))}
          <div className="kpis">
            {report.kpis.map((k) => (
              <div key={k.label} className="kpi">
                <span className="kpi__label">{k.label}</span>
                <span className="kpi__value">{k.value}</span>
                {k.note && <span className="kpi__note">{k.note}</span>}
              </div>
            ))}
          </div>
        </section>

        {report.changes && (
          <section>
            <h2>{report.changes.kind === 'plan' ? 'What this plan changes' : `How ${report.changes.targetLabel} differs from ${report.changes.baseLabel}`}</h2>
            <p>{report.changes.summary}</p>
            {report.changes.rows.length > 0 && (
              <table className="doc__table">
                <thead>
                  <tr>
                    <th>Resource</th><th>{report.changes.kind === 'plan' ? 'Change' : 'Difference'}</th>
                    <th className="num">{report.changes.kind === 'plan' ? 'Before' : report.changes.baseLabel}</th>
                    <th className="num">{report.changes.kind === 'plan' ? 'After' : report.changes.targetLabel}</th>
                    <th className="num">{report.changes.kind === 'plan' ? 'Δ / month' : `${report.changes.targetLabel} vs ${report.changes.baseLabel}`}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.changes.rows.map((x, i) => (
                    <tr key={i}>
                      <td>{x.name} <span className="muted">· {x.kind}</span></td>
                      <td>{x.change}{x.what && <div className="mono small muted">{x.what}</div>}</td>
                      <td className="num">{x.before ? formatUsd(x.before) : '–'}</td>
                      <td className="num">{x.after ? formatUsd(x.after) : '–'}{x.unknown ? ' ⚠' : ''}</td>
                      <td className="num">{formatDelta(x.delta)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {report.changes.findingsAdded.length > 0 && (
              <>
                <h3>{report.changes.kind === 'plan' ? 'New findings' : `Findings only in ${report.changes.targetLabel}`}</h3>
                <ul className="doc__bullets">{report.changes.findingsAdded.map((f, i) => <li key={i}>{f}</li>)}</ul>
              </>
            )}
            {report.changes.findingsResolved.length > 0 && (
              <>
                <h3>{report.changes.kind === 'plan' ? 'Resolved by this plan' : `Findings only in ${report.changes.baseLabel}`}</h3>
                <ul className="doc__bullets">{report.changes.findingsResolved.map((f, i) => <li key={i}><s>{f}</s></li>)}</ul>
              </>
            )}
            {report.changes.unknownAfterApply.length > 0 && (
              <p className="doc__foot">⚠ Some values are only known after apply, so these may cost more than shown: {report.changes.unknownAfterApply.join(', ')}.</p>
            )}
          </section>
        )}

        <section>
          <h2>Architecture</h2>
          <ul className="doc__bullets">
            {report.architecture.overview.map((o, i) => <li key={i}>{o}</li>)}
          </ul>
          <figure className="doc__figure">
            <div ref={figRef} className="doc__diagram" inert style={{ height: figW ? Math.round(figW * FIGURE_RATIO) : undefined, aspectRatio: figW ? undefined : `1 / ${FIGURE_RATIO}` }}>
              {figW > 0 && <ReactFlowProvider key={figW}>
                <Diagram
                  nodes={figure.nodes}
                  edges={figure.edges}
                  showSupporting={false}
                  showDeps={false}
                  expanded={new Set()}
                  onToggleExpand={() => {}}
                  flowMode={false}
                  pageSize={{ width: figW, height: Math.round(figW * FIGURE_RATIO) }}
                  embedded
                  costByNode={costByNode}
                  components={snapshot.cost.components}
                  fresh={new Set()}
                  changes={diff?.status}
                  deltas={figure.deltas}
                  ghostEdges={figure.ghostEdges}
                  onSelect={() => {}}
                />
              </ReactFlowProvider>}
            </div>
            <figcaption>
              {diff && (
                <ul className="edgekey changekey doc__changekey" aria-label="Change legend">
                  <li className="is-added">{diff.kind === 'plan' ? 'add' : `only in ${diff.targetLabel}`}</li>
                  <li className="is-changed">{diff.kind === 'plan' ? 'change' : 'differs'}</li>
                  {diff.kind === 'plan' && <li className="is-replaced">replace</li>}
                  <li className="is-removed">{diff.kind === 'plan' ? 'destroy' : `only in ${diff.baseLabel}`}</li>
                </ul>
              )}
              {diff?.kind === 'stacks'
                ? `The diagram is ${diff.targetLabel}; what only ${diff.baseLabel} has is drawn dashed where it sits there. Badges show each resource's monthly cost difference.`
                : 'Solid arrows carry traffic or events; numbers are estimated monthly cost per component.'}
            </figcaption>
          </figure>

          <h3>Components by tier</h3>
          <div className="tiers">
            {report.architecture.tiers.map((t) => (
              <div key={t.tier} className="tier">
                <h4>{t.tier}</h4>
                <ul>
                  {t.items.map((i) => (
                    <li key={i.name}>
                      <b>{i.name}</b>
                      <span>{i.kind}{i.note ? ` · ${i.note}` : ''}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {report.architecture.paths.length > 0 && (
            <>
              <h3>Request & data paths</h3>
              <ol className="doc__paths">
                {report.architecture.paths.map((p, i) => <li key={i}>{p.steps}</li>)}
              </ol>
            </>
          )}

          {report.architecture.network.map((v) => (
            <div key={v.name}>
              <h3>Network: {v.name} <span className="muted">({v.cidr})</span></h3>
              <table className="doc__table">
                <thead><tr><th>Subnet</th><th>Type</th><th>CIDR</th><th>AZ</th><th>Runs</th></tr></thead>
                <tbody>
                  {v.subnets.map((s) => (
                    <tr key={s.name}><td>{s.name}</td><td>{s.kind}</td><td className="mono">{s.cidr}</td><td>{s.az}</td><td>{s.contains.join(', ') || '-'}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>

        <section>
          <h2>Cost</h2>
          <div className="costsplit">
            <table className="doc__table doc__table--narrow">
              <tbody>
                <tr><td>Always-on</td><td className="num">{formatUsd(report.cost.fixed)}</td></tr>
                <tr><td>Usage-based (at assumptions below)</td><td className="num">{formatUsd(report.cost.usage)}</td></tr>
                {report.cost.freeTier && report.cost.saved > 0 && <tr><td>AWS Free Tier applied</td><td className="num good">−{formatUsd(report.cost.saved)}</td></tr>}
                <tr className="doc__total"><td>Estimated monthly total</td><td className="num">{formatUsd(report.cost.total)}</td></tr>
              </tbody>
            </table>
            <div className="catbars">
              {report.cost.byCategory.map((c) => (
                <div key={c.category} className="catbar">
                  <span>{c.category}</span>
                  <span className="catbar__track"><span style={{ width: pct(c.share) }} /></span>
                  <span className="num">{formatUsd(c.monthly)}</span>
                </div>
              ))}
            </div>
          </div>
          <h3>What drives the bill</h3>
          <ul className="doc__bullets">{report.cost.drivers.map((d, i) => <li key={i}>{d}</li>)}</ul>
          <h3>By resource</h3>
          <table className="doc__table">
            <thead><tr><th>Resource</th><th>Type</th><th className="num">Monthly</th><th className="num">Share</th></tr></thead>
            <tbody>
              {report.cost.top.map((t) => (
                <tr key={t.id}><td>{t.name}</td><td className="muted">{t.kind}</td><td className="num">{t.usageBased ? '~' : ''}{formatUsd(t.monthly)}</td><td className="num">{pct(t.share)}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="doc__foot">~ includes usage-based charges.</p>
          {report.cost.savings.items.length > 0 && (
            <>
              <h3>Ways to cut the bill</h3>
              {report.cost.savings.total >= 0.005 && <p>Up to <b>{formatUsd(report.cost.savings.total)}/month</b> together (savings on the same resource count once).</p>}
              <table className="doc__table">
                <thead><tr><th>Change</th><th>Resource</th><th className="num">Saves / month</th><th>What it takes</th></tr></thead>
                <tbody>
                  {report.cost.savings.items.map((s, i) => (
                    <tr key={i}>
                      <td>{s.title}{s.change && <div className="mono small muted">{s.change.split('\n')[0]}</div>}</td>
                      <td>{s.resource}</td>
                      <td className="num">{s.monthly >= 0.005 ? formatUsd(s.monthly) : s.perUnit ?? '-'}</td>
                      <td className="small">{s.caveat}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {report.cost.history && (
            <>
              <h3>Cost over time</h3>
              {report.cost.history.sentence && <p>{report.cost.history.sentence}</p>}
              <table className="doc__table doc__table--narrow">
                <thead><tr><th>Applied</th><th className="num">Serial</th><th className="num">Always-on</th><th className="num">Total</th></tr></thead>
                <tbody>
                  {report.cost.history.points.map((p) => (
                    <tr key={p.serial}><td>{p.date}</td><td className="num">{p.serial}</td><td className="num">{formatUsd(p.fixed)}</td><td className="num">{formatUsd(p.total)}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {report.cost.assumptions.length > 0 && (
            <>
              <h3>Usage assumptions</h3>
              <table className="doc__table">
                <thead><tr><th>Resource</th><th>Assumption</th><th className="num">Value</th></tr></thead>
                <tbody>{report.cost.assumptions.map((a, i) => <tr key={i}><td>{a.resource}</td><td>{a.label}</td><td className="num">{a.value}</td></tr>)}</tbody>
              </table>
            </>
          )}
          {report.cost.unpriced.length > 0 && (
            <>
              <h3>Not priced</h3>
              <ul className="doc__bullets">{report.cost.unpriced.map((u, i) => <li key={i}><code>{u.address}</code>: {u.reason}</li>)}</ul>
            </>
          )}
        </section>

        <section>
          <h2>Findings & recommendations</h2>
          <div className="sevcounts">
            {(['high', 'medium', 'low', 'info', 'good'] as const).map((s) => (
              <span key={s} className={`sev sev--${s}`}>{SEVERITY_LABEL[s]} {report.findings.counts[s]}</span>
            ))}
          </div>
          {report.findings.items.map((i) => (
            <div key={i.id} className={`finding finding--${i.severity}`}>
              <div className="finding__head">
                {i.severity === 'good'
                  ? <span className="sev sev--good" aria-label="Strength">✓</span>
                  : <span className={`sev sev--${i.severity}`}>{SEVERITY_LABEL[i.severity]}</span>}
                <span className="finding__cat">{i.category}</span>
                <b>{i.title}</b>
              </div>
              <p>{i.detail}</p>
              {i.recommendation && <p className="finding__rec"><b>Recommendation:</b> {i.recommendation}</p>}
              {i.resourceNames.length > 0 && <p className="finding__res">{i.resourceNames.join(' · ')}</p>}
            </div>
          ))}
        </section>

        <section>
          <h2>Security posture</h2>
          {report.security.entryPoints.length > 0 && <p><b>Internet-facing:</b> {report.security.entryPoints.join(', ')}</p>}
          {report.security.rules.length > 0 && (
            <>
              <h3>Network access (security groups)</h3>
              <table className="doc__table">
                <thead><tr><th>Security group</th><th>Attached to</th><th>Allows in</th></tr></thead>
                <tbody>{report.security.rules.map((g) => <tr key={g.group}><td>{g.group}</td><td>{g.attachedTo.join(', ')}</td><td className="mono">{g.ingress.join('; ') || 'nothing'}</td></tr>)}</tbody>
              </table>
            </>
          )}
          {report.security.roles.length > 0 && (
            <>
              <h3>What each role can do (IAM)</h3>
              <table className="doc__table">
                <thead><tr><th>Role</th><th>Used by</th><th>Assumed by</th><th>Permissions</th></tr></thead>
                <tbody>
                  {report.security.roles.map((r) => (
                    <tr key={r.role}><td>{r.role}</td><td>{r.usedBy.join(', ')}</td><td className="mono">{r.trustedBy.join(', ')}</td><td className="mono small">{r.permissions.map((p, i) => <div key={i}>{p}</div>)}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>

        <section>
          <h2>Appendix</h2>
          <h3>Resource inventory</h3>
          <table className="doc__table">
            <thead><tr><th>Name</th><th>Type</th><th>Terraform address</th><th className="num">Monthly</th></tr></thead>
            <tbody>
              {report.inventory.map((i) => (
                <tr key={i.address}><td>{i.name}</td><td className="muted">{i.kind}</td><td className="mono small">{i.address}</td><td className="num">{i.monthly ? formatUsd(i.monthly) : '-'}</td></tr>
              ))}
            </tbody>
          </table>
          <h3>Pricing sources</h3>
          <ul className="doc__bullets small">
            {report.cost.sources.map((s) => (
              <li key={s.name}>{s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.name}</a> : s.name}{s.published ? ` · published ${s.published}` : ''}</li>
            ))}
          </ul>
          <h3>Methodology & caveats</h3>
          <ul className="doc__bullets small">{report.methodology.map((m, i) => <li key={i}>{m}</li>)}</ul>
          <p className="doc__foot">Generated by terraprev · report <code>{report.id}</code>. Same ID means same inputs and identical content.</p>
        </section>
      </article>
    </div>
  );
}

/** **bold** → <b> (the summary is shared with the Markdown renderer). */
function renderBold(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/).map((part, i) => (part.startsWith('**') ? <b key={i}>{part.slice(2, -2)}</b> : part));
}
