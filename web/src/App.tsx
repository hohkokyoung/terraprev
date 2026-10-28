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
import { ChangesPanel, deltaClass } from './components/ChangesPanel.tsx';
import { FindingsPanel } from './components/FindingsPanel.tsx';
import { bySeverity, isIssue, issuesByNode } from './lib/findings.ts';
import { losesData } from './lib/dataLoss.ts';
import { STATIC } from './lib/staticData.ts';
import { isLiveOnly, isPlanPath, LIVE, useView } from './lib/useView.ts';
import { ViewSwitch } from './components/ViewSwitch.tsx';
import { diffSnapshots, diffSummary, formatDelta, gapText } from '../../shared/compare.ts';

type Tab = 'changes' | 'cost' | 'findings' | 'usage' | 'inspect';

/** Plan preview or stack comparison, embedded by `terraprev build --plan / --compare`. */
const COMPARE = STATIC?.compare;

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
  const { snapshot: liveSnapshot, connection, error, progress, lastApply } = useSnapshot();
  // Live server: the stack itself, or compared with another state file, or after a plan (the header switch).
  const views = useView(liveSnapshot?.serial);
  // A plan, or a swapped comparison, shows a stack other than the live one; until it arrives, show the live one alone.
  const otherShown = views.view.show !== 'live';
  const snapshot = otherShown && views.viewSnapshot ? views.viewSnapshot : liveSnapshot;
  const compare = STATIC?.compare ?? (otherShown && !views.viewSnapshot ? undefined : views.compare);
  const viewPending = views.loading && (otherShown ? !views.viewSnapshot : !views.compare);
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
  const [tab, setTab] = useState<Tab>(COMPARE ? 'changes' : 'cost');
  const [showSupporting, setShowSupporting] = useState(false);
  const [showDeps, setShowDeps] = useState(false);
  const [flowMode, setFlowMode] = useState(false);
  const [showKey, setShowKey] = useState(false);
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

  // Plan preview / comparison: the "after" diagram, plus what the plan removes drawn faded in place.
  const diff = useMemo(() => (compare && snapshot ? diffSnapshots(compare, snapshot, values, freeTier) : undefined), [compare, snapshot, values, freeTier]);
  const nodes = useMemo(() => [...(snapshot?.graph.nodes ?? []), ...(diff?.ghosts.nodes ?? [])], [snapshot, diff]);
  const edges = useMemo(() => [...(snapshot?.graph.edges ?? []), ...(diff?.ghosts.edges ?? [])], [snapshot, diff]);
  const ghostEdges = useMemo(() => new Set(diff?.ghosts.edges.map((e) => e.id)), [diff]);
  const deltas = useMemo(() => new Map(diff?.nodes.filter((n) => Math.abs(n.delta) >= 0.005).map((n) => [n.id, n.delta])), [diff]);
  const homeTab: Tab = diff ? 'changes' : 'cost';
  const tabOrder: Tab[] = diff ? ['changes', 'cost', 'findings', 'usage', 'inspect'] : ['cost', 'findings', 'usage', 'inspect'];
  // Switching view lands on what that view is about: the differences or changes, or the cost when live.
  useEffect(() => {
    if (STATIC) return;
    setSelected(undefined);
    setTab(views.view.against || isPlanPath(views.view.show) ? 'changes' : 'cost');
  }, [views.view.show, views.view.against]);
  const selectedNode = nodes.find((n) => n.id === selected);
  const select = (id: string | undefined) => {
    setSelected(id);
    if (id) {
      setTab('inspect');
      if (!sideOpen) toggleSide(true);
    }
    else if (tab === 'inspect') setTab(homeTab);
  };

  const loading = snapshot?.cost.status === 'loading';
  const downloads = Object.values(progress).filter((p) => !p.done);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const insights = snapshot?.insights;
  const nodeFindings = useMemo(() => issuesByNode(insights ?? []), [insights]);
  const dataLoss = useMemo(
    () => new Set(diff?.kind === 'plan' ? diff.nodes.filter((n) => losesData(n.change, nodeById.get(n.id)?.type)).map((n) => n.id) : []),
    [diff, nodeById],
  );
  const issueCount = insights?.filter(isIssue).length ?? 0;
  const highCount = insights?.filter((f) => f.severity === 'high').length ?? 0;

  return (
    <div className={`app ${printing ? 'is-printing' : ''} ${compare?.kind === 'stacks' ? 'app--stacks' : ''}`}>
      <a className="skiplink" href="#sidepanel">Skip to side panel</a>
      <header className="topbar" inert={reportOpen || undefined}>
        <div className="brand">
          <span className="brand__mark" aria-hidden>
            ◧
          </span>
          terraprev
        </div>
        <div className="statefile" title={snapshot?.stateFile}>
          <span className={`dot dot--${error ? 'error' : connection}`} role="img" aria-label={error ? 'Connection error' : connection === 'live' ? 'Live: updates on every apply' : `Connection: ${connection}`} title={error ? 'Connection error' : connection === 'live' ? 'Live: updates on every apply' : `Connection: ${connection}`} />
          {!STATIC && liveSnapshot && <ViewSwitch view={views.view} setView={views.setView} files={views.files} onOpen={views.refreshFiles} />}
          {snapshot && compare && !STATIC ? null : snapshot && compare ? (
            <>
              <span className="modebadge">{compare.kind === 'plan' ? 'Plan preview' : 'Comparison'}</span>
              <code>{shortPath(snapshot.stateFile)}</code>
              <span className="muted">
                {compare.kind === 'plan' ? (
                  <>nothing applied yet · {snapshot.resourceCount} resources after apply · planned <Ago iso={snapshot.updatedAt} bare /></>
                ) : (
                  <>{compare.targetLabel} ({snapshot.resourceCount} resources) compared with {compare.baseLabel} ({compare.base.resourceCount})</>
                )}
              </span>
            </>
          ) : snapshot ? (
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
            <span className="total__label">{diff ? (diff.kind === 'plan' ? 'Monthly after apply' : `Monthly · ${diff.targetLabel}`) : 'Estimated monthly'}</span>
            <span className="total__value">{formatUsd(totals.total)}</span>
            {diff?.kind === 'plan' ? (
              <span className="total__split">
                <b className={`total__delta ${deltaClass(diff.total.delta)}`}>{formatDelta(diff.total.delta)}</b> vs now ({formatUsd(diff.total.before)})
              </span>
            ) : diff ? (
              <span className="total__split">
                <b className="total__delta is-gap">{gapText(diff.total.delta)}</b> {Math.abs(diff.total.delta) < 0.005 ? 'as' : 'than'} {diff.baseLabel} ({formatUsd(diff.total.before)})
              </span>
            ) : (
              <span className="total__split">
                {formatUsd(totals.fixed)} always-on · {formatUsd(totals.usage)} usage
                {freeTier && totals.saved > 0 && <span className="total__free"> · −{formatUsd(totals.saved)} free tier</span>}
              </span>
            )}
          </div>
        )}
      </header>

      {error && <div className="banner banner--error" role="alert">{error}</div>}
      {views.error && (
        <div className="banner banner--error">
          Could not {isPlanPath(views.view.show) ? 'read that plan' : views.view.against ? 'compare those stacks' : 'read that stack'}: {views.error}{' '}
          <button type="button" className="linkish" onClick={() => views.setView(LIVE)}>Back to live</button>
        </div>
      )}
      {viewPending && !views.error && (
        <div className="banner" role="status">{isPlanPath(views.view.show) ? 'Reading and pricing the plan…' : 'Reading and pricing the stack…'}</div>
      )}
      {diff && (
        <div className="banner banner--plan">
          {diff.kind === 'plan' ? <b>Preview of a plan. Nothing here has been applied.</b> : <b>{diff.targetLabel} compared with {diff.baseLabel}.</b>} {diffSummary(diff)}
          {diff.kind === 'stacks' && <span className="muted"> The diagram is {diff.targetLabel}; what only {diff.baseLabel} has is drawn dashed where it sits there.</span>}
        </div>
      )}
      {downloads.length > 0 && (
        <div className="banner">
          Downloading price lists (first run only):{' '}
          {downloads.map((d) => `${d.source} ${(d.loadedBytes / 1e6).toFixed(0)}${d.totalBytes ? `/${(d.totalBytes / 1e6).toFixed(0)}` : ''} MB`).join(' · ')}
        </div>
      )}
      {lastApply && Date.now() - lastApply.at < 15000 && (
        <div className="banner banner--apply" key={lastApply.at} role="status">
          Applied · serial {lastApply.prevSerial} → {lastApply.serial}
          {lastApply.added.length > 0 && <span className="plus"> +{lastApply.added.length} added</span>}
          {lastApply.removed.length > 0 && <span className="minus"> −{lastApply.removed.length} removed</span>}
        </div>
      )}

      <main className={`main ${sideOpen ? '' : 'main--noside'}`} inert={reportOpen || undefined}>
        <div className="canvas">
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
            {diff && (
              <ul className="edgekey changekey" aria-label="Change legend">
                <li className="is-added">{diff.kind === 'plan' ? 'add' : `only in ${diff.targetLabel}`}</li>
                <li className="is-changed">{diff.kind === 'plan' ? 'change' : 'differs'}</li>
                {diff.kind === 'plan' && <li className="is-replaced">replace</li>}
                <li className="is-removed">{diff.kind === 'plan' ? 'destroy' : `only in ${diff.baseLabel}`}</li>
              </ul>
            )}
            <ul className="edgekey" aria-label="Edge legend">
              <li className="k-flow">traffic / events</li>
              <li className="k-uses">uses (click a node)</li>
              <li className="k-route">route</li>
            </ul>
            <button type="button" className={`toggle toggle--key ${showKey ? 'is-on' : ''}`} aria-expanded={showKey} aria-controls="diagkey" onClick={() => setShowKey(v => !v)}>Key</button>
            {showKey && (
              <ul className="keypanel" id="diagkey" aria-label="How to read the diagram">
                <li aria-hidden="true"><span className="keypanel__title" style={{ gridColumn: '1 / -1' }}>How to read the diagram</span></li>
                <li>
                  <span className="sample" style={{ ['--cat' as string]: 'var(--cat-storage)' }}>
                    <span className="rnode__tag">DB</span>
                  </span>
                  <span>4px stripe and tinted tag: the resource's AWS category, reused in the cost rows and legend.</span>
                </li>
                <li>
                  <span className="sample">
                    <span className="rnode__cost">{'~$1.23'}</span>
                  </span>
                  <span>{"~ before a figure: usage-based estimate, adjustable with the sliders in Cost."}</span>
                </li>
                <li>
                  <span className="sample">
                    <span className="chip chip--iam">IAM</span>
                    <span className="chip chip--sg">SG</span>
                  </span>
                  <span>IAM / SG chips: access attached to the node; click to expand the policies.</span>
                </li>
                <li>
                  <span className="sample"><span className="kdash" /></span>
                  <span>Dashed contour: a virtual boundary such as a router or the internet edge, not a deployed resource.</span>
                </li>
                <li>
                  <span className="sample"><span className="sev sev--high">High</span></span>
                  <span>Severity stamp: the worst open finding; select the resource for the details.</span>
                </li>
                {diff && (
                  <li>
                    <span className="sample"><span className="chg chg--added">+ added</span></span>
                    <span>In this {diff.kind === 'plan' ? 'plan' : 'comparison'}: pills mark what changes; a dashed contour means the resource only exists on the other side.</span>
                  </li>
                )}
              </ul>
            )}
          </div>
          {snapshot ? (
            <ReactFlowProvider>
              <Diagram
                nodes={nodes}
                edges={edges}
                showSupporting={showSupporting}
                showDeps={showDeps}
                expanded={expanded}
                onToggleExpand={toggleExpand}
                flowMode={flowMode}
                fitSignal={String(printing)}
                pageSize={printing ? PAGE : undefined}
                costByNode={totals.byNode}
                components={snapshot.cost.components}
                fresh={fresh}
                changes={diff?.status}
                deltas={deltas}
                ghostEdges={ghostEdges}
                findings={nodeFindings}
                dataLoss={dataLoss}
                selected={selected}
                onSelect={select}
              />
            </ReactFlowProvider>
          ) : (
            <Empty connection={connection} />
          )}
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
        <aside className="side" id="sidepanel" tabIndex={-1} aria-label="Costs, findings and resource details" hidden={!sideOpen}>
          <nav className="tabs" role="tablist" aria-label="Side panel" onKeyDown={(e) => {
            // Arrow keys move between tabs; only the current tab is in the Tab order.
            const order = tabOrder.filter((t) => t !== 'inspect' || selectedNode);
            const i = order.indexOf(tab);
            const next = e.key === 'ArrowRight' ? order[(i + 1) % order.length] : e.key === 'ArrowLeft' ? order[(i - 1 + order.length) % order.length] : e.key === 'Home' ? order[0] : e.key === 'End' ? order[order.length - 1] : undefined;
            if (!next) return;
            e.preventDefault();
            setTab(next);
            document.getElementById(`tab-${next}`)?.focus();
          }}>
            {tabOrder.map((t) => (
              <button key={t} id={`tab-${t}`} role="tab" aria-selected={tab === t} aria-controls="sidepanel-body" tabIndex={tab === t ? 0 : -1} className={tab === t ? 'is-on' : ''} onClick={() => setTab(t)} disabled={t === 'inspect' && !selectedNode}>
                {t === 'changes' ? `${diff?.kind === 'stacks' ? 'Differences' : 'Changes'} (${diff?.nodes.filter((n) => !n.group && !n.supporting).length ?? 0})` : t === 'cost' ? 'Cost' : t === 'findings' ? (
                  <>
                    Findings{snapshot ? ` (${issueCount})` : ''}
                    {highCount > 0 && <span className="sev sev--high tabs__flag">High {highCount}</span>}
                  </>
                ) : t === 'usage' ? `Usage${snapshot ? ` (${snapshot.cost.usage.length})` : ''}` : 'Resource'}
              </button>
            ))}
          </nav>
          <div className="side__body" id="sidepanel-body" role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={-1}>
            {!snapshot ? null : loading && !snapshot.cost.components.length ? (
              <p className="muted pad">Fetching AWS prices…</p>
            ) : tab === 'changes' && diff ? (
              <ChangesPanel diff={diff} nodesById={nodeById} onSelect={select} />
            ) : tab === 'findings' ? (
              <FindingsPanel insights={snapshot.insights} nodesById={nodeById} onSelect={select} />
            ) : tab === 'inspect' && selectedNode ? (
              <Inspector findings={snapshot.insights.filter((f) => f.nodes.includes(selectedNode.id)).sort(bySeverity)} change={diff?.nodes.find((n) => n.id === selectedNode.id)} compare={diff} freeTier={freeTier} edges={edges} nodesById={nodeById} lines={lines} node={selectedNode} cost={snapshot.cost} values={values} overrides={overrides} setUsage={set} expanded={expanded.has(selectedNode.id)} onToggleExpand={() => toggleExpand(selectedNode.id)} onSelect={select} stateSerial={snapshot.serial} />
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
              <CostPanel cost={snapshot.cost} nodes={nodes} byNode={totals.byNode} total={totals.total} usage={values} freeTier={freeTier} history={compare ? undefined : snapshot.history} onSelect={select} />
            )}
          </div>
        </aside>
      </main>
      {reportOpen && snapshot && (
        <ReportView snapshot={snapshot} usage={values} freeTier={freeTier} costByNode={totals.byNode} diff={diff} view={isLiveOnly(views.view) ? undefined : views.view} onClose={() => setReportOpen(false)} autoPrint={autoReport} />
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
  const parts = p.split(/[\\/]/);
  return parts.slice(-2).join('/');
}

function groupBy<T>(xs: T[], key: (x: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return [...m.entries()];
}
