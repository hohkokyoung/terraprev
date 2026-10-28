import type { GraphNode, Insight } from '../../../shared/types.ts';
import { SEVERITY_LABEL } from '../../../shared/report.ts';
import { ISSUE_SEVERITIES, bySeverity, isIssue } from '../lib/findings.ts';

interface Props {
  insights: Insight[];
  nodesById: Map<string, GraphNode>;
  onSelect: (id: string) => void;
}

/** Every finding about the stack, worst first, each with its fix and the resources it's about. */
export function FindingsPanel({ insights, nodesById, onSelect }: Props) {
  const issues = insights.filter(isIssue).sort(bySeverity);
  const strengths = insights.filter((f) => !isIssue(f));
  const counts = ISSUE_SEVERITIES.map((s) => [s, issues.filter((f) => f.severity === s).length] as const).filter(([, n]) => n);

  return (
    <div className="findings">
      <section>
        {issues.length ? (
          <>
            <p className="findings__summary">
              {counts.map(([s, n]) => (
                <span key={s} className={`sev sev--${s}`}>{n} {SEVERITY_LABEL[s]}</span>
              ))}
            </p>
            <ol className="findings__list">
              {issues.map((f) => <FindingRow key={f.id} f={f} nodesById={nodesById} onSelect={onSelect} />)}
            </ol>
          </>
        ) : (
          <p className="findings__none">No issues found in this stack's state.</p>
        )}
        <p className="muted small findings__note">Checked from state attributes only: what terraprev can see, not a full audit.</p>
      </section>
      {strengths.length > 0 && (
        <section>
          <details className="findings__strengths">
            <summary>{strengths.length} thing{strengths.length > 1 ? 's' : ''} already right</summary>
            <ol className="findings__list">
              {strengths.map((f) => <FindingRow key={f.id} f={f} nodesById={nodesById} onSelect={onSelect} />)}
            </ol>
          </details>
        </section>
      )}
    </div>
  );
}

/** One finding. `nodesById` + `onSelect` add links to its resources; without them (inspector) it stands alone. */
export function FindingRow({ f, nodesById, onSelect }: { f: Insight; nodesById?: Map<string, GraphNode>; onSelect?: (id: string) => void }) {
  return (
    <li className="frow">
{f.severity === 'good'
        ? <span className="sev sev--good" aria-label="Strength">✓</span>
        : <span className={`sev sev--${f.severity}`}>{SEVERITY_LABEL[f.severity]}</span>}
      <div className="frow__body">
        <b className="frow__title">{f.title}</b>
        <p className="frow__detail">{f.detail}</p>
        {f.recommendation && <p className="frow__fix"><span>Fix:</span> {f.recommendation}</p>}
        <p className="frow__meta">
          <span className="frow__cat">{f.category}</span>
          {nodesById && onSelect && (
            f.nodes.length ? (
              f.nodes.map((id) => (
                <button key={id} type="button" className="linkish frow__res" onClick={() => onSelect(id)} title="Show on the diagram">
                  {nodesById.get(id)?.label ?? id}
                </button>
              ))
            ) : (
              <span className="frow__res frow__res--stack">Whole stack</span>
            )
          )}
        </p>
      </div>
    </li>
  );
}
