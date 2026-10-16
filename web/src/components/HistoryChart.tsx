import type { HistoryPoint } from '../../../shared/types.ts';
import { formatUsd } from '../../../shared/cost.ts';
import { formatDelta } from '../../../shared/compare.ts';
import { historySentence, pointTotal, shortDate, summarizeHistory } from '../../../shared/history.ts';
import { deltaClass } from './ChangesPanel.tsx';

const W = 320, H = 72, PAD = { top: 8, right: 6, bottom: 6, left: 6 };

/** Monthly cost at each apply (default usage), with the always-on part underneath. */
export function HistoryChart({ points }: { points: HistoryPoint[] }) {
  const s = summarizeHistory(points);
  if (!s) return null;
  if (points.length === 1) {
    return (
      <p className="muted small">
        History starts with this apply (serial {s.last.serial}, {formatUsd(pointTotal(s.last))}/month). Each apply after this adds a point.
      </p>
    );
  }
  const max = Math.max(...points.map(pointTotal)) * 1.08 || 1;
  const x = (i: number) => PAD.left + (i / (points.length - 1)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - v / max) * (H - PAD.top - PAD.bottom);
  const line = (f: (p: HistoryPoint) => number) => points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(f(p)).toFixed(1)}`).join(' ');
  const area = `${line(pointTotal)} L${x(points.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
  const sinceLast = s.previous ? pointTotal(s.last) - pointTotal(s.previous) : 0;
  return (
    <div className="history">
      <div className="history__stats">
        <div>
          <span className="history__lbl">since last apply</span>
          <b className={deltaClass(sinceLast)}>{formatDelta(sinceLast)}</b>
        </div>
        {s.since && s.since !== s.previous && (
          <div>
            <span className="history__lbl">since {shortDate(s.since.appliedAt)}</span>
            <b className={deltaClass(s.delta)}>
              {formatDelta(s.delta)}
              {s.ratio !== undefined && Math.abs(s.ratio) >= 0.005 && <small> ({s.ratio > 0 ? '+' : '−'}{Math.abs(Math.round(s.ratio * 100))}%)</small>}
            </b>
          </div>
        )}
      </div>
      <svg className="history__chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Monthly cost over ${points.length} applies`}>
        <path className="history__area" d={area} />
        <path className="history__fixed" d={line((p) => p.fixed)} vectorEffect="non-scaling-stroke" />
        <path className="history__total" d={line(pointTotal)} vectorEffect="non-scaling-stroke" />
        {points.map((p, i) => (
          <circle key={p.serial} className="history__dot" cx={x(i)} cy={y(pointTotal(p))} r={i === points.length - 1 ? 3 : 2}>
            <title>{`Serial ${p.serial} · ${shortDate(p.appliedAt)} · ${formatUsd(pointTotal(p))}/month (${formatUsd(p.fixed)} always-on) · ${p.resourceCount} resources`}</title>
          </circle>
        ))}
      </svg>
      <div className="history__axis">
        <span>{shortDate(points[0].appliedAt)}</span>
        <span>{points.length} applies</span>
        <span>{shortDate(s.last.appliedAt)}</span>
      </div>
      {historySentence(s) && <p className="small history__why">{historySentence(s)}</p>}
      <p className="muted small history__note">At default usage, so sliders don't move it. Solid line: total; dashed: always-on.</p>
    </div>
  );
}
