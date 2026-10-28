import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { isPlanPath, type StackFile, type StackFiles, type View } from '../lib/useView.ts';

interface Props {
  view: View;
  setView: (v: View) => void;
  files?: StackFiles;
  onOpen: () => void;
}

interface Item {
  value: string;
  label: string;
  sub?: string;
  tag?: string;
}
interface Section {
  title?: string;
  items: Item[];
  /** Shown under the section, e.g. how to add the first item. */
  note?: ReactNode;
}

/**
 * Two pickers that read as a sentence: [prod ▾] vs [staging ▾]. The left one is what's on show (any
 * stack in the folder, or a plan); the right one is what to compare it with, or nothing.
 */
export function ViewSwitch({ view, setView, files, onOpen }: Props) {
  const live: Item = { value: 'live', label: files?.live.label ?? 'live', sub: files?.live.path, tag: 'live' };
  const stack = (f: StackFile): Item => ({ value: f.path, label: f.label, sub: `${f.path} · ${ago(f.modified)}` });
  const stacks = [live, ...(files?.states ?? []).map(stack)];
  const plans = (files?.plans ?? []).map((f): Item => ({ value: f.path, label: `after ${f.path.split('/').pop()}`, sub: `${f.path} · ${ago(f.modified)}` }));
  const all = [...stacks, ...plans];
  const find = (v: string): Item => all.find((i) => i.value === v) ?? { value: v, label: v };
  const plan = isPlanPath(view.show);

  const shown = find(view.show);
  const against = view.against ? find(view.against) : undefined;
  const showSections: Section[] = [
    { title: 'Stacks', items: stacks },
    plans.length
      ? { title: 'Plans', items: plans }
      : {
          title: 'Plans',
          items: [],
          note: files && (
            <>No plans in this folder yet. Run <code>terraform plan -out=plan.out</code> there and it shows up here, priced against the stack as it is now.</>
          ),
        },
  ];
  const againstSections: Section[] = [
    { items: [{ value: '', label: 'No comparison', sub: `just ${shown.label}` }] },
    { title: 'Compare with', items: stacks.filter((s) => s.value !== view.show) },
  ];

  return (
    <div className="viewswitch" role="group" aria-label="What to show">
      <Menu
        label="Stack or plan to show"
        sections={showSections}
        value={view.show}
        onOpen={onOpen}
        onPick={(show) => setView({ show, against: view.against === show ? undefined : view.against })}
      >
        <span className="filemenu__value">{shown.label}</span>
        {shown.tag && <span className="filemenu__tag">{shown.tag}</span>}
      </Menu>
      {plan ? (
        <span className="viewswitch__vs" title="A plan is compared with the stack as it is now">vs now</span>
      ) : (
        <>
          {against && <span className="viewswitch__vs">vs</span>}
          <Menu
            label="Stack to compare with"
            sections={againstSections}
            value={view.against ?? ''}
            ghost={!against}
            onOpen={onOpen}
            onPick={(v) => setView({ show: view.show, against: v || undefined })}
          >
            {against ? (
              <>
                <span className="filemenu__value">{against.label}</span>
                {against.tag && <span className="filemenu__tag">{against.tag}</span>}
              </>
            ) : (
              <span className="filemenu__prefix">Compare with…</span>
            )}
          </Menu>
        </>
      )}
    </div>
  );
}

/** A themed listbox: the native <select> popup ignores the page's colours. */
function Menu({ label, sections, value, ghost, onOpen, onPick, children }: {
  label: string;
  sections: Section[];
  value: string;
  ghost?: boolean;
  onOpen: () => void;
  onPick: (value: string) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const items = sections.flatMap((s) => s.items);
  // Select-only combobox: focus stays on the button, which names the highlighted option for screen readers.
  const listId = useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const show = () => {
    onOpen();
    setActive(Math.max(0, items.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const choose = (i: number) => {
    const o = items[i];
    if (o && o.value !== value) onPick(o.value);
    setOpen(false);
  };
  const onKey = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === 'Escape') setOpen(false);
    else if (e.key === 'ArrowDown') setActive((i) => Math.min(items.length - 1, i + 1));
    else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1));
    else if (e.key === 'Enter' || e.key === ' ') choose(active);
    else if (e.key === 'Tab') setOpen(false);
    else return;
    e.preventDefault();
  };

  let n = -1;
  return (
    <div className={`filemenu ${open ? 'is-open' : ''} ${ghost ? 'is-ghost' : ''}`} ref={root} onKeyDown={onKey}>
      <button
        type="button"
        className="filemenu__button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && items[active] ? optionId(active) : undefined}
        aria-label={label}
        onClick={() => (open ? setOpen(false) : show())}
      >
        {children}
        <svg className="filemenu__chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="filemenu__list" role="listbox" id={listId} aria-label={label}>
          {sections.map((s, si) =>
            s.items.length === 0 && !s.note ? null : (
              <div key={si} className="filemenu__section">
                {s.title && <div className="filemenu__title">{s.title}</div>}
                {s.items.length === 0 && s.note && <p className="filemenu__note">{s.note}</p>}
                {s.items.map((o) => {
                  const i = ++n;
                  return (
                    <div
                      key={o.value || '-'}
                      id={optionId(i)}
                      role="option"
                      aria-selected={o.value === value}
                      className={`filemenu__item ${i === active ? 'is-active' : ''}`}
                      onMouseEnter={() => setActive(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(i)}
                    >
                      <span className="filemenu__check" aria-hidden>{o.value === value ? '✓' : ''}</span>
                      <span className="filemenu__text">
                        <span className="filemenu__name">
                          {o.label}
                          {o.tag && <span className="filemenu__tag">{o.tag}</span>}
                        </span>
                        {o.sub && <span className="filemenu__path">{o.sub}</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function ago(iso: string): string {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
}
