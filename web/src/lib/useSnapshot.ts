import { useEffect, useRef, useState } from 'react';
import type { PriceProgress, Snapshot, UsageFile } from '../../../shared/types.ts';
import { STATIC } from './staticData.ts';

export type Connection = 'connecting' | 'live' | 'offline' | 'static';

export interface ApplyEvent {
  serial: number;
  prevSerial: number;
  added: string[];
  removed: string[];
  at: number;
}

/** Live snapshot over SSE. EventSource reconnects on its own if the server restarts. */
export function useSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>(STATIC?.snapshot);
  const [connection, setConnection] = useState<Connection>(STATIC ? 'static' : 'connecting');
  const [error, setError] = useState<string>();
  const [progress, setProgress] = useState<Record<string, PriceProgress>>({});
  const [lastApply, setLastApply] = useState<ApplyEvent>();
  /** terraprev.usage.json as the server last saw it; `origin` is the page that changed it. */
  const [usageFile, setUsageFile] = useState<UsageFile & { origin?: string }>();
  const prev = useRef<Snapshot>(undefined);

  useEffect(() => {
    if (STATIC) return; // snapshot file: everything is embedded, nothing to connect to
    const es = new EventSource('/api/events');
    es.onopen = () => setConnection('live');
    es.onerror = () => setConnection(es.readyState === EventSource.CLOSED ? 'offline' : 'connecting');
    es.addEventListener('snapshot', (e) => {
      const next: Snapshot = JSON.parse((e as MessageEvent).data);
      const before = prev.current;
      if (before && before.serial !== next.serial) {
        const was = new Set(before.graph.nodes.map((n) => n.id));
        const now = new Set(next.graph.nodes.map((n) => n.id));
        setLastApply({
          serial: next.serial,
          prevSerial: before.serial,
          added: [...now].filter((id) => !was.has(id)),
          removed: [...was].filter((id) => !now.has(id)),
          at: Date.now(),
        });
      }
      prev.current = next;
      setSnapshot(next);
      setError(undefined);
    });
    es.addEventListener('usage', (e) => setUsageFile(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('progress', (e) => {
      const p: PriceProgress = JSON.parse((e as MessageEvent).data);
      setProgress((cur) => ({ ...cur, [p.source]: p }));
    });
    es.addEventListener('error', (e) => {
      const data = (e as MessageEvent).data;
      if (data) setError(JSON.parse(data).message);
    });
    return () => es.close();
  }, []);

  return { snapshot, connection, error, progress, lastApply, usageFile };
}
