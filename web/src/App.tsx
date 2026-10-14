import { useEffect, useMemo, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { formatUsd } from '../../shared/cost.ts';
import { useSnapshot } from './lib/useSnapshot.ts';
import { useUsage } from './lib/usage.ts';
import { Diagram } from './components/Diagram.tsx';
import { CostPanel } from './components/CostPanel.tsx';
import { Inspector } from './components/Inspector.tsx';
import { UsageSlider } from './components/UsageSlider.tsx';
import { ThemeToggle } from './components/ThemeToggle.tsx';
import { ReportView } from './components/ReportView.tsx';

type Tab = 'cost' | 'usage' | 'inspect';

/** Diagram PDFs print A4 landscape; everything else (the report) uses the default A4 portrait. */
function setPrintPage(landscape: boolean) {
  let el = document.getElementById('print-page') as HTMLStyleElement | null;
  if (!landscape) return el?.remove();
  if (!el) {
    el = Object.assign(document.createElement('style'), { id: 'print-page' });
    document.head.appendChild(el);
  }
  el.textContent = '@page { size: A4 landscape; margin: 0; }';
}

/** A4 landscape at 96 dpi; must match the print CSS. */
const PAGE = { width: 1123, height: 794 };

export function App() {
  const { snapshot, connection, error, progress, lastApply } = useSnapshot();
  const { values, overrides, set, zeroAll, resetAll, totals, lines, freeTier, setFreeTier } = useUsage(snapshot?.cost, typeof location !== 'undefined' && /[#&]free/.test(location.hash));
  const [sideOpen, setSideOpen] = useState(() => {
    try {
      return localStorage.getItem('terraprev.side') !== '0';
    } catch {
      return true;
    }
  });
  const toggleSide = (open = !sideOpen) => {
    setSideOpen(open);
    try {
      localStorage.setItem('terraprev.side', open ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  const hasFreeTier = !!snapshot?.cost.components.some((c) => c.freeTier);
  const [selected, setSelected] = useState<string>();
  const [tab, setTab] = useState<Tab>('cost');
  const [showSupporting, setShowSupporting] = useState(false);
  const [showDeps, setShowDeps] = useState(false);
  const [flowMode, setFlowMode] = useState(false);
  // Print layout: fixed-size diagram + report pages. "#print" in the URL = headless PDF export.
  const autoPrint = typeof location !== 'undefined' && location.hash.startsWith('#print');
  const autoReport = typeof location !== 'undefined' && location.hash.startsWith('#report');
  const [reportOpen, setReportOpen] = useState(autoReport);
  if (autoPrint) {
    setPrintPage(true);
    // Headless export picks the theme in the URL (#print&dark), independent of saved preferences.
    document.documentElement.setAttribute('data-theme', location.hash.includes('dark') ? 'dark' : 'light');
  }
  const [printing, setPrinting] = useState(autoPrint);
  const exportPdf = () => {
    // Print preview ignores the system dark preference, so "Auto" would print light.
    // Pin the theme that's actually on screen for the duration of the print.
    const root = document.documentElement;
    const chosen = root.getAttribute('data-theme');
    if (!chosen) root.setAttribute('data-theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    setPrinting(true); // canvas switches to page size; Diagram re-fits (fitSignal)
    setPrintPage(true);
    setTimeout(() => {
      window.print(); // blocks until the dialog closes in Chromium
      setPrintPage(false);
      setPrinting(false);
      if (!chosen) root.removeAttribute('data-theme');
    }, 600);
  };
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (id: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  // "\" toggles the side panel (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '\\' || e.metaKey || e.ctrlKey || (e.target as HTMLElement)?.closest('input, textarea')) return;
      e.preventDefault();
      setSideOpen((open) => {
        try {
          localStorage.setItem('terraprev.side', open ? '0' : '1');
        } catch {
          /* ignore */
        }
        return !open;
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Highlight what the last apply added, for a few seconds.
  useEffect(() => {
    if (!lastApply?.added.length) return;
    setFresh(new Set(lastApply.added));
    const t = setTimeout(() => setFresh(new Set()), 6000);
    return () => clearTimeout(t);
  }, [lastApply]);

  const nodes = snapshot?.graph.nodes ?? [];
  const selectedNode = nodes.find((n) => n.id === selected);
  const select = (id: string | undefined) => {
    setSelected(id);
    if (id) {
      setTab('inspect');
      if (!sideOpen) toggleSide(true);
    }
    else if (tab === 'inspect') setTab('cost');
  };

  const loading = snapshot?.cost.status === 'loading';
  const downloads = Object.values(progress).filter((p) => !p.done);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  return (
    <div className={`app ${printing ? 'is-printing' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden>
            ◧
          </span>
          terraprev
        </div>
        <div className="statefile" title={snapshot?.stateFile}>
          <span className={`dot dot--${error ? 'error' : connection}`} />
          {snapshot ? (
            <>
              <code>{shortPath(snapshot.stateFile)}</code>
              <span className="muted">
                serial {snapshot.serial} · {snapshot.resourceCount} resources ·{' '}
                {connection === 'static' ? (
                  <span title="Static snapshot written by terraprev build. Re-run it (or use bin/tf apply), then reload this page.">
                    applied <Ago iso={snapshot.updatedAt} bare /> · snapshot
                  </span>
                ) : (
                  <Ago iso={snapshot.updatedAt} />
                )}
              </span>
            </>
          ) : (
            <span className="muted">{connection === 'live' ? 'waiting for terraform state…' : 'connecting to terraprev server…'}</span>
          )}
        </div>
        {hasFreeTier && (
          <label className="switch" title="Apply AWS Always Free allowances (per account, shared across resources). 12-month and credit-based offers are not included.">
            <input type="checkbox" checked={freeTier} onChange={(e) => setFreeTier(e.target.checked)} />
            <span className="switch__track" aria-hidden />
            Free tier
          </label>
        )}
        <ThemeToggle />
        {snapshot && (
          <button type="button" className="pdfbtn pdfbtn--report" onClick={() => setReportOpen(true)} title="Architecture & cost brief: summary, findings, costs, security. Save as PDF or Markdown.">
            Report
          </button>
        )}
        {snapshot && (
          <button type="button" className="pdfbtn" onClick={exportPdf} title="Diagram as a one-page PDF, in the current theme. Choose “Save as PDF” in the print dialog.">
            PDF
          </button>
        )}
        {snapshot && (
          <div className={`total ${loading ? 'is-loading' : ''}`}>
            <span className="total__label">Estimated monthly</span>
            <span className="total__value">{formatUsd(totals.total)}</span>
            <span className="total__split">
              {formatUsd(totals.fixed)} always-on · {formatUsd(totals.usage)} usage
              {freeTier && totals.saved > 0 && <span className="total__free"> · −{formatUsd(totals.saved)} free tier</span>}
            </span>
          </div>
        )}
      </header>

      {error && <div className="banner banner--error">{error}</div>}
      {downloads.length > 0 && (
        <div className="banner">
          Downloading price lists (first run only):{' '}
          {downloads.map((d) => `${d.source} ${(d.loadedBytes / 1e6).toFixed(0)}${d.totalBytes ? `/${(d.totalBytes / 1e6).toFixed(0)}` : ''} MB`).join(' · ')}
        </div>
      )}
      {lastApply && Date.now() - lastApply.at < 15000 && (
        <div className="banner banner--apply" key={lastApply.at}>
          Applied · serial {lastApply.prevSerial} → {lastApply.serial}
          {lastApply.added.length > 0 && <span className="plus"> +{lastApply.added.length} added</span>}
          {lastApply.removed.length > 0 && <span className="minus"> −{lastApply.removed.length} removed</span>}
        </div>
      )}

      <main className={`main ${sideOpen ? '' : 'main--noside'}`}>
        <div className="canvas">
          {snapshot ? (
            <ReactFlowProvider>
              <Diagram
                nodes={nodes}
                edges={snapshot.graph.edges}
                showSupporting={showSupporting}
                showDeps={showDeps}
                expanded={expanded}
                onToggleExpand={toggleExpand}
                flowMode={flowMode}
                fitSignal={`${sideOpen}:${printing}`}
                pageSize={printing ? PAGE : undefined}
                costByNode={totals.byNode}
                components={snapshot.cost.components}
                fresh={fresh}
                selected={selected}
                onSelect={select}
              />
            </ReactFlowProvider>
          ) : (
            <Empty connection={connection} />
          )}
          <div className="canvas__tools">
            <label className="toggle">
              <input type="checkbox" checked={showSupporting} onChange={(e) => setShowSupporting(e.target.checked)} />
              All IAM, security groups &amp; routes
            </label>
            <label className={`toggle toggle--flow ${flowMode ? 'is-on' : ''}`} title="Click a resource to highlight everything that can send data or traffic into it">
              <input type="checkbox" checked={flowMode} onChange={(e) => setFlowMode(e.target.checked)} />
              Data flow
            </label>
            {flowMode && !selected && <span className="flowhint">Click a resource to trace what reaches it</span>}
            <label className="toggle">
              <input type="checkbox" checked={showDeps} onChange={(e) => setShowDeps(e.target.checked)} />
              All dependencies
            </label>
            <ul className="edgekey" aria-label="Edge legend">
              <li className="k-flow">traffic / events</li>
              <li className="k-uses">uses (click a node)</li>
              <li className="k-route">route</li>
            </ul>
          </div>
        </div>

        <button
          type="button"
          className={`sidetoggle ${sideOpen ? 'is-open' : ''}`}
          onClick={() => toggleSide()}
          title={sideOpen ? 'Hide panel ( \\ )' : 'Show panel ( \\ )'}
          aria-label={sideOpen ? 'Hide side panel' : 'Show side panel'}
          aria-expanded={sideOpen}
        >
          {sideOpen ? '›' : '‹'}
        </button>
        <aside className="side" hidden={!sideOpen}>
          <nav className="tabs" role="tablist">
            {(['cost', 'usage', 'inspect'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'is-on' : ''} onClick={() => setTab(t)} disabled={t === 'inspect' && !selectedNode}>
                {t === 'cost' ? 'Cost' : t === 'usage' ? `Usage${snapshot ? ` (${snapshot.cost.usage.length})` : ''}` : selectedNode ? 'Resource' : 'Resource'}
              </button>
            ))}
          </nav>
          <div className="side__body">
            {!snapshot ? null : loading && !snapshot.cost.components.length ? (
              <p className="muted pad">Fetching AWS prices…</p>
            ) : tab === 'inspect' && selectedNode ? (
              <Inspector edges={snapshot.graph.edges} nodesById={nodeById} lines={lines} node={selectedNode} cost={snapshot.cost} values={values} overrides={overrides} setUsage={set} expanded={expanded.has(selectedNode.id)} onToggleExpand={() => toggleExpand(selectedNode.id)} onSelect={select} stateSerial={snapshot.serial} />
            ) : tab === 'usage' ? (
              <div className="usagelist">
                <p className="muted small">
                  Terraform knows what you deployed, not how much traffic it gets. Set expected monthly usage here; values are saved in
                  this browser and survive re-applies.
                </p>
                <div className="usagebar">
                  <button type="button" onClick={zeroAll} disabled={snapshot.cost.usage.every((p) => values[p.key] === 0)}>
                    Set all to 0
                  </button>
                  <button type="button" onClick={resetAll} disabled={Object.keys(overrides).length === 0}>
                    Reset to defaults
                  </button>
                  <span className="muted small">{totals.usage === 0 ? 'showing always-on cost only' : `usage adds ${formatUsd(totals.usage)}/mo`}</span>
                </div>
                {groupBy(snapshot.cost.usage, (p) => p.nodeId).map(([nodeId, params]) => (
                  <section key={nodeId}>
                    <h3>
                      <button type="button" className="linkish" onClick={() => select(nodeId)}>
                        {nodeById.get(nodeId)?.label ?? nodeId}
                      </button>
                      <span className="muted"> {formatUsd(totals.byNode.get(nodeId) ?? 0)}</span>
                    </h3>
                    {params.map((p) => (
                      <UsageSlider key={p.key} param={p} value={values[p.key] ?? p.default} overridden={p.key in overrides} onChange={(v) => set(p.key, v)} />
                    ))}
                  </section>
                ))}
              </div>
            ) : (
              <CostPanel cost={snapshot.cost} nodes={nodes} byNode={totals.byNode} total={totals.total} onSelect={select} />
            )}
          </div>
        </aside>
      </main>
      {reportOpen && snapshot && (
        <ReportView snapshot={snapshot} usage={values} freeTier={freeTier} costByNode={totals.byNode} onClose={() => setReportOpen(false)} autoPrint={autoReport} />
      )}
    </div>
  );
}

function Empty({ connection }: { connection: string }) {
  return (
    <div className="empty">
      <h2>{connection === 'live' ? 'No state yet' : 'Connecting…'}</h2>
      <p>
        Run <code>terraform apply</code> in the watched project. The diagram and cost update by themselves.
      </p>
    </div>
  );
}

function Ago({ iso, bare }: { iso: string; bare?: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15000);
    return () => clearInterval(t);
  }, []);
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const ago = s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
  return <span title={new Date(iso).toLocaleString()}>{bare ? ago : `loaded ${ago}`}</span>;
}

function shortPath(p: string) {
  const parts = p.split('/');
  return parts.slice(-2).join('/');
}

function groupBy<T>(xs: T[], key: (x: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return [...m.entries()];
}
