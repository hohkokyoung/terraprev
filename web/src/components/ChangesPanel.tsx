import { useState } from 'react';
import type { Insight } from '../../../shared/types.ts';
import { changeText, fieldText, formatDelta, gapText, type Diff, type NodeDiff } from '../../../shared/compare.ts';
import { formatUsd } from '../../../shared/cost.ts';
import { SEVERITY_LABEL } from '../../../shared/report.ts';

interface Props {
  diff: Diff;
  onSelect: (id: string) => void;
}

/** What a plan does (or how two stacks differ): cost before → after, every changed resource, findings that come and go. */
export function ChangesPanel({ diff, onSelect }: Props) {
  const [showQuiet, setShowQuiet] = useState(false);
  const plan = diff.kind === 'plan';
  // Supporting resources and groups with no cost effect are noise next to the rest; fold them away.
  const main = diff.nodes.filter((n) => !n.group && !n.supporting);
  const quiet = diff.nodes.filter((n) => n.group || n.supporting);
  return (
    <div className="changes">
      <section className="changes__head">
        {plan ? (
          <div className="changes__totals">
            <div>
              <span className="changes__lbl">Now</span>
              <span className="changes__amt">{formatUsd(diff.total.before)}</span>
            </div>
            <span className="changes__arrow" aria-hidden>→</span>
            <div>
              <span className="changes__lbl">After apply</span>
              <span className="changes__amt">{formatUsd(diff.total.after)}</span>
            </div>
            <div className={`changes__delta ${deltaClass(diff.total.delta)}`}>
              <span className="changes__lbl">per month</span>
              <span className="changes__amt">{formatDelta(diff.total.delta)}</span>
            </div>
          </div>
        ) : (
          // Two stacks that both exist: side by side, and the gap without a verdict.
          <div className="changes__totals changes__totals--sides">
            <div>
              <span className="changes__lbl">{diff.baseLabel}</span>
              <span className="changes__amt">{formatUsd(diff.total.before)}</span>
            </div>
            <div>
              <span className="changes__lbl">{diff.targetLabel}</span>
              <span className="changes__amt">{formatUsd(diff.total.after)}</span>
            </div>
            <div className="changes__delta is-gap">
              <span className="changes__lbl">{diff.targetLabel} costs</span>
              <span className="changes__amt">{gapText(diff.total.delta)}</span>
            </div>
          </div>
        )}
        <ul className="changes__counts">
          {plan ? (
            <>
              <Count n={diff.resources.create} label="to add" cls="added" />
              <Count n={diff.resources.update} label="to change" cls="changed" />
              <Count n={diff.resources.replace} label="to replace" cls="replaced" />
              <Count n={diff.resources.delete} label="to destroy" cls="removed" />
            </>
          ) : (
            <>
              <Count n={diff.nodes.filter((n) => n.change === 'added' && !n.group).length} label={`only in ${diff.targetLabel}`} cls="added" />
              <Count n={diff.nodes.filter((n) => n.change === 'changed' || n.change === 'replaced').length} label="differ" cls="changed" />
              <Count n={diff.nodes.filter((n) => n.change === 'removed' && !n.group).length} label={`only in ${diff.baseLabel}`} cls="removed" />
            </>
          )}
        </ul>
        {diff.unknownAfterApply.length > 0 && (
          <p className="changes__note small">
            Some values are only known after apply, so resources marked ⚠ may cost more than shown (for example, a public IPv4 address
            assigned at launch).
          </p>
        )}
      </section>

      <section>
        <h3>{plan ? 'What this plan changes' : 'What differs'}</h3>
        {main.length === 0 && <p className="muted small">{plan ? 'No resources change.' : 'The two stacks have the same resources and costs.'}</p>}
        <ol className={`changerows ${plan ? '' : 'changerows--sides'}`}>
          {main.map((n) => <Row key={n.id} n={n} diff={diff} onSelect={onSelect} />)}
        </ol>
        {quiet.length > 0 && (
          <>
            <button type="button" className="disclosure changes__more" aria-expanded={showQuiet} onClick={() => setShowQuiet(!showQuiet)}>
              {quiet.length} network, IAM and security group {plan ? 'change' : 'difference'}{quiet.length === 1 ? '' : 's'}
            </button>
            {showQuiet && <ol className={`changerows ${plan ? '' : 'changerows--sides'}`}>{quiet.map((n) => <Row key={n.id} n={n} diff={diff} onSelect={onSelect} />)}</ol>}
          </>
        )}
      </section>

      {(diff.findings.added.length > 0 || diff.findings.resolved.length > 0) && (
        <section>
          <h3>Findings</h3>
          <ul className="changefindings">
            {diff.findings.added.map((f) => <Finding key={f.id} f={f} cls="is-new" label={plan ? 'new' : `only in ${diff.targetLabel}`} onSelect={onSelect} />)}
            {diff.findings.resolved.map((f) => <Finding key={f.id} f={f} cls={plan ? 'is-fixed' : 'is-base'} label={plan ? 'fixed' : `only in ${diff.baseLabel}`} onSelect={onSelect} />)}
          </ul>
        </section>
      )}
    </div>
  );
}

function Count({ n, label, cls }: { n: number; label: string; cls: string }) {
  return (
    <li className={`changes__count is-${cls} ${n ? '' : 'is-zero'}`}>
      <b>{n}</b> {label}
    </li>
  );
}

function Row({ n, diff, onSelect }: { n: NodeDiff; diff: Diff; onSelect: (id: string) => void }) {
  const plan = diff.kind === 'plan';
  const what = n.fields.length ? n.fields.map((f) => fieldText(diff, f)).join(' · ') : n.attrs.join(', ');
  const usd = (x: number) => (x ? formatUsd(x) : '–');
  return (
    <li>
      <button type="button" onClick={() => onSelect(n.id)}>
        <span className={`chg chg--${n.change}`}>{changeText(diff, n.change)}</span>
        <span className="changerows__name">
          <span className="changerows__label">{n.label}</span>
          <span className="changerows__kind">{n.kind}</span>
          {what && <span className="changerows__what" title={what}>{what}</span>}
        </span>
        <span className="changerows__cost">
          <span className={`changerows__delta ${plan ? deltaClass(n.delta) : 'is-gap'}`}>
            {n.unknown && <i title="Some cost-relevant values are only known after apply">⚠ </i>}
            {Math.abs(n.delta) >= 0.005 ? formatDelta(n.delta) : ''}
          </span>
          {(n.before > 0 || n.after > 0) && (plan ? (
            <span className="changerows__ba">{usd(n.before)} → {usd(n.after)}</span>
          ) : (
            <>
              <span className="changerows__ba">{diff.baseLabel} {usd(n.before)}</span>
              <span className="changerows__ba">{diff.targetLabel} {usd(n.after)}</span>
            </>
          ))}
        </span>
      </button>
    </li>
  );
}

/** cls: is-new, is-fixed (a plan resolves it: struck through), or is-base (only the other stack has it). */
function Finding({ f, cls, label, onSelect }: { f: Insight; cls: string; label: string; onSelect: (id: string) => void }) {
  return (
    <li className={cls}>
      <span className={`sev sev--${f.severity}`}>{SEVERITY_LABEL[f.severity]}</span>
      <span className="changefindings__tag">{label}</span>
      {f.nodes[0] ? (
        <button type="button" className="linkish" onClick={() => onSelect(f.nodes[0])}>{f.title}</button>
      ) : (
        <span>{f.title}</span>
      )}
    </li>
  );
}

/** A plan making the bill go up reads as a warning, down as good. Two stacks just differ: see `is-gap`. */
export function deltaClass(n: number): string {
  return n >= 0.005 ? 'is-up' : n <= -0.005 ? 'is-down' : 'is-flat';
}
