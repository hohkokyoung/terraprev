import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type { Snapshot } from '../../../shared/types.ts';
import { buildReport, renderMarkdown, SEVERITY_LABEL, type Report } from '../../../shared/report.ts';
import { formatUsd } from '../../../shared/cost.ts';
import { Diagram } from './Diagram.tsx';

interface Props {
  snapshot: Snapshot;
  usage: Record<string, number>;
  freeTier: boolean;
  costByNode: Map<string, number>;
  onClose: () => void;
  /** Headless export: print as soon as the figure has rendered. */
  autoPrint?: boolean;
}

/** Figure height relative to its width; the diagram is fitted to whatever width the page gives it. */
const FIGURE_RATIO = 0.5;
const pct = (n: number) => `${Math.round(n * 100)}%`;

/** The CTO brief as a document: read on screen, save as PDF, or download as Markdown. */
export function ReportView({ snapshot, usage, freeTier, costByNode, onClose, autoPrint }: Props) {
  const report: Report = useMemo(() => buildReport({ snapshot, usage, freeTier }), [snapshot, usage, freeTier]);
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
  const fileBase = `${report.title.split(':')[0].replace(/[^\w.-]+/g, '-')}-brief`;

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

  useEffect(() => {
    if (!autoPrint) return;
    // Headless export: theme from the URL (#report&dark), light by default.
    document.documentElement.setAttribute('data-theme', location.hash.includes('dark') ? 'dark' : 'light');
  }, [autoPrint]);


  return (
    <div className="report" role="dialog" aria-label="Architecture & cost brief">
      <div className="report__bar">
        <span className="report__barTitle">Architecture & cost brief</span>
        <span className="report__barHint muted small">Uses your current usage assumptions{freeTier ? ' and free tier' : ''}.</span>
        <button type="button" onClick={savePdf}>Save as PDF</button>
        <button type="button" onClick={downloadMd} title="Markdown with a Mermaid diagram: renders in GitHub, Notion and Confluence">Download Markdown</button>
        <button type="button" onClick={copyMd}>{copied ? 'Copied' : 'Copy Markdown'}</button>
        <button type="button" className="report__close" onClick={onClose} aria-label="Close report">✕</button>
      </div>

      <article className="doc">
        <header className="doc__head">
          <p className="doc__kicker">Architecture & cost brief</p>
          <h1>{report.title.split(':')[0]}</h1>
          <dl className="doc__meta">
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

        <section>
          <h2>Architecture</h2>
          <ul className="doc__bullets">
            {report.architecture.overview.map((o, i) => <li key={i}>{o}</li>)}
          </ul>
          <figure className="doc__figure">
            <div ref={figRef} className="doc__diagram" style={{ height: figW ? Math.round(figW * FIGURE_RATIO) : undefined, aspectRatio: figW ? undefined : `1 / ${FIGURE_RATIO}` }}>
              {figW > 0 && <ReactFlowProvider key={figW}>
                <Diagram
                  nodes={snapshot.graph.nodes}
                  edges={snapshot.graph.edges}
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
                  onSelect={() => {}}
                />
              </ReactFlowProvider>}
            </div>
            <figcaption>Solid arrows carry traffic or events; numbers are estimated monthly cost per component.</figcaption>
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

        <section className="doc__break">
          <h2>Findings & recommendations</h2>
          <div className="sevcounts">
            {(['high', 'medium', 'low', 'info', 'good'] as const).map((s) => (
              <span key={s} className={`sev sev--${s}`}>{SEVERITY_LABEL[s]} {report.findings.counts[s]}</span>
            ))}
          </div>
          {report.findings.items.map((i) => (
            <div key={i.id} className={`finding finding--${i.severity}`}>
              <div className="finding__head">
                <span className={`sev sev--${i.severity}`}>{i.severity === 'good' ? 'Strength' : SEVERITY_LABEL[i.severity]}</span>
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

        <section className="doc__break">
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
