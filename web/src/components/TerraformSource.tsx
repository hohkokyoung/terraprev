import { useEffect, useState, type ReactNode } from 'react';
import { awsName } from '../../../shared/awsNames.ts';
import type { SourceBlock, SourceResult } from '../../../shared/types.ts';
import { STATIC } from '../lib/staticData.ts';

/** The HCL that declared this node's resources, straight from the .tf files. */
export function TerraformSource({ addresses, refreshKey }: { addresses: string[]; refreshKey: string }) {
  const [results, setResults] = useState<{ ok: SourceResult[]; missing: string[] }>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    if (STATIC) {
      const rs = addresses.map((a) => STATIC!.sources[a] ?? a);
      setResults({ ok: rs.filter((r): r is SourceResult => typeof r !== 'string'), missing: rs.filter((r): r is string => typeof r === 'string') });
      return;
    }
    setResults(undefined);
    Promise.all(
      addresses.map(async (a) => {
        const r = await fetch(`/api/source?address=${encodeURIComponent(a)}`, { signal: AbortSignal.timeout(8000) });
        if (r.status === 404) return a; // resource not declared in any .tf file we can see
        // The dev proxy answers 5xx when the API process isn't running.
        if (!r.ok) throw new Error(r.status >= 500 ? 'unreachable' : `terraprev server answered ${r.status}.`);
        return (await r.json()) as SourceResult;
      }),
    ).then(
      (rs) => {
        if (cancelled) return;
        setResults({ ok: rs.filter((r): r is SourceResult => typeof r !== 'string'), missing: rs.filter((r): r is string => typeof r === 'string') });
      },
      (err: Error) => {
        if (cancelled) return;
        setError(err.name === 'TimeoutError' ? 'The terraprev server took too long to answer.' : err.message.startsWith('terraprev') ? err.message : 'Could not reach the terraprev API server (port 4610).');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [addresses.join('|'), refreshKey, attempt]);

  if (error) {
    return (
      <div className="pad">
        <p className="tfsource__warn" style={{ margin: 0 }}>
          {error} Is <code>npm run dev</code> still running?
        </p>
        <button type="button" className="linkish" style={{ marginTop: 10 }} onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  }
  if (!results) return <p className="muted pad">Reading .tf files…</p>;

  // Indexed resources (for_each/count) and module siblings share one block; show it once, listing every address.
  const byKey = new Map<string, SourceBlock & { items: { address: string; name?: string; kind?: string }[] }>();
  for (const r of results.ok) {
    for (const b of r.blocks) {
      const key = `${b.file}:${b.blockLine}`;
      const item = b.role === 'module' ? { address: moduleAddress(r.address), kind: 'Terraform module' } : { address: r.address, name: r.name, kind: r.type ? awsName(r.type)?.full : undefined };
      const cur = byKey.get(key);
      if (!cur) byKey.set(key, { ...b, items: [item] });
      else if (!cur.items.some((i) => i.address === item.address)) cur.items.push(item);
    }
  }
  const blocks = [...byKey.values()];
  const changed = results.ok.some((r) => r.changedSinceApply);

  return (
    <div className="tfsource">
      {changed && (
        <p className="tfsource__warn">
          Edited after the last <code>terraform apply</code>. The diagram and cost still reflect what's deployed, not this code.
        </p>
      )}
      {blocks.map((b) => (
        <section key={`${b.file}:${b.blockLine}`} className="tfblock">
          <div className="tfblock__title">
            {b.items.map((it) => (
              <div key={it.address} className="tfblock__res">
                {it.kind && <span className="tfblock__kind">{it.kind}</span>}
                <div className="tfblock__ids">
                  {it.name && <span className="tfblock__name">{it.name}</span>}
                  <code className="tfblock__addr">{it.address}</code>
                </div>
              </div>
            ))}
          </div>
          <header className="tfblock__head">
            <span className={`tfblock__role tfblock__role--${b.role}`}>{b.role === 'module' ? 'module call' : b.items.length > 1 ? `${b.items.length} instances` : 'resource'}</span>
            <code className="tfblock__file">
              {b.file}:{b.blockLine}
            </code>
            <span className="tfblock__actions">
              <a href={`vscode://file/${b.absPath}:${b.blockLine}`} title="Open in VS Code">
                open ↗
              </a>
              <CopyButton text={b.text} />
            </span>
          </header>
          {b.role === 'module' && <p className="muted small tfblock__hint">The inputs passed into the module. The block above is the module's generic template.</p>}
          <pre className="hcl">
            <code>
              {b.text.split('\n').map((line, i) => (
                <span key={i} className="hcl__line">
                  <span className="hcl__ln">{b.startLine + i}</span>
                  <span>{highlight(line)}</span>
                  {'\n'}
                </span>
              ))}
            </code>
          </pre>
        </section>
      ))}
      {results.missing.length > 0 && (
        <p className="muted small pad">
          No source block found for {results.missing.map((m) => <code key={m}>{m} </code>)}(it may come from a remote module or a deleted file).
        </p>
      )}
      {!blocks.length && !results.missing.length && <p className="muted pad">This node isn't declared in Terraform (it's drawn by terraprev).</p>}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="linkish"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {done ? 'copied' : 'copy'}
    </button>
  );
}

const KEYWORDS = /^(resource|data|module|variable|output|locals|provider|terraform|dynamic|lifecycle|content|moved|import|check|for_each|count|depends_on|for|in|if)$/;
const TOKEN = /(#.*|\/\/.*)|("(?:[^"\\]|\\.|\$\{[^}]*\})*")|\b(true|false|null)\b|\b(\d+(?:\.\d+)?)\b|\b((?:var|local|module|data|each|count|path|self)\.[\w.\[\]"-]*|aws_\w+\.\w+(?:\.\w+)*)|\b([a-z_][\w-]*)(?=\s*=(?!=))|\b([a-z_][\w-]*)\b/gi;

/** Tiny HCL highlighter: comments, strings (with ${} interpolation), keywords, keys, references. */
function highlight(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index));
    const [tok, comment, str, lit, num, ref, key, word] = m;
    const k = out.length;
    if (comment) out.push(<span key={k} className="t-com">{tok}</span>);
    else if (str) out.push(<span key={k} className="t-str">{interp(str)}</span>);
    else if (lit || num) out.push(<span key={k} className="t-lit">{tok}</span>);
    else if (ref) out.push(<span key={k} className="t-ref">{tok}</span>);
    else if (key) out.push(<span key={k} className="t-key">{tok}</span>);
    else if (word && KEYWORDS.test(word)) out.push(<span key={k} className="t-kw">{tok}</span>);
    else if (word && /^[a-z_]+$/.test(word) && /\(/.test(line.slice(m.index + tok.length, m.index + tok.length + 1))) out.push(<span key={k} className="t-fn">{tok}</span>);
    else out.push(tok);
    last = m.index + tok.length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

function interp(s: string): ReactNode[] {
  return s.split(/(\$\{[^}]*\})/).map((part, i) => (part.startsWith('${') ? <span key={i} className="t-interp">{part}</span> : part));
}

/** module.a.module.b.aws_x.y → module.a.module.b */
function moduleAddress(address: string): string {
  const m = address.match(/^((?:module\.[^.[]+(?:\[[^\]]*\])?\.)*module\.[^.[]+(?:\[[^\]]*\])?)\./);
  return m ? m[1] : address;
}
