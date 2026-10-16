import { useEffect, useState } from 'react';
import type { UsageParam } from '../../../shared/types.ts';
import { formatQuantity } from '../../../shared/cost.ts';

const STEPS = 1000;

const toPos = (p: UsageParam, v: number) =>
  p.scale === 'log' ? (Math.log1p(Math.max(0, v)) / Math.log1p(p.max)) * STEPS : (v / p.max) * STEPS;

const fromPos = (p: UsageParam, pos: number) => {
  const raw = p.scale === 'log' ? Math.expm1((pos / STEPS) * Math.log1p(p.max)) : (pos / STEPS) * p.max;
  return niceRound(raw);
};

/** Rounds to 2 significant digits so log sliders land on readable numbers (1.2M, not 1,193,422). */
function niceRound(v: number) {
  if (v < 10) return Math.round(v * 10) / 10;
  const mag = 10 ** (Math.floor(Math.log10(v)) - 1);
  return Math.round(v / mag) * mag;
}

interface Props {
  param: UsageParam;
  value: number;
  overridden: boolean;
  onChange: (v: number | undefined) => void;
}

export function UsageSlider({ param, value, overridden, onChange }: Props) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);

  return (
    <div className="slider">
      <div className="slider__top">
        <label htmlFor={param.key}>{param.label}</label>
        <span className="slider__value">
          <input
            aria-label={`${param.label} value`}
            value={text}
            inputMode="decimal"
            onChange={(e) => setText(e.target.value)}
            onBlur={() => {
              const n = Number(text.replace(/[, _]/g, ''));
              if (Number.isFinite(n) && n >= 0) onChange(n);
              else setText(String(value));
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <span className="slider__unit">{param.unit}</span>
        </span>
      </div>
      <input
        id={param.key}
        type="range"
        min={0}
        max={STEPS}
        value={Math.min(STEPS, toPos(param, value))}
        style={{ ['--fill' as string]: `${(Math.min(STEPS, toPos(param, value)) / STEPS) * 100}%` }}
        onChange={(e) => onChange(fromPos(param, Number(e.target.value)))}
      />
      <div className="slider__foot">
        <span>≈ {formatQuantity(value)}</span>
        {overridden && (
          <button type="button" className="linkish" onClick={() => onChange(undefined)}>
            reset to {formatQuantity(param.default)}
          </button>
        )}
      </div>
    </div>
  );
}
