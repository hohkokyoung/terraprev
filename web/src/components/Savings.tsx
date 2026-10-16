import type { PricedSaving } from '../../../shared/savings.ts';
import { formatUsd } from '../../../shared/cost.ts';

interface Props {
  items: PricedSaving[];
  /** Jump to the resource a saving is about (omitted inside the inspector, which already shows it). */
  onSelect?: (id: string) => void;
}

/** Savings as a compact list; each opens to say what changes, what it takes, and the Terraform change. */
export function SavingsList({ items, onSelect }: Props) {
  return (
    <ul className="savings">
      {items.map(({ saving: s, monthly }) => (
        <li key={s.id}>
          <details>
            <summary>
              <span className="savings__title">{s.title}</span>
              <span className="savings__amt">
                {monthly >= 0.005 ? <>−{formatUsd(monthly)}<small>/mo</small></> : <small>{s.perUnit ? `saves ${s.perUnit}` : ''}</small>}
              </span>
            </summary>
            <div className="savings__body">
              <p>{s.detail}</p>
              {s.change && <pre className="savings__change">{s.change}</pre>}
              {s.caveat && <p className="savings__caveat">{s.caveat}</p>}
              {onSelect && (
                <button type="button" className="linkish small" onClick={() => onSelect(s.nodeId)}>
                  Show on diagram
                </button>
              )}
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}
