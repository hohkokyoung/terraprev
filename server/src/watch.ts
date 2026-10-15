import { existsSync, watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

/**
 * Calls `onChange(json)` whenever the state file settles after a write.
 * Watches the directory, not the file: terraform may replace the file, which
 * would orphan a file watcher. If the directory doesn't exist yet (no apply has
 * run), polls every `pollMs` until it appears, then watches it.
 */
export function watchState(
  file: string,
  onChange: (json: unknown) => void,
  onError: (err: Error) => void,
  { pollMs = 1000 }: { pollMs?: number } = {},
): { close(): void } {
  const name = basename(file);
  const dir = dirname(file);
  let timer: NodeJS.Timeout | undefined;
  let poll: NodeJS.Timeout | undefined;
  let w: FSWatcher | undefined;
  let lastText = '';

  const read = async (attempt = 0) => {
    try {
      const text = await readFile(file, 'utf8');
      if (text === lastText) return;
      const json = JSON.parse(text); // throws on a half-written file → retry
      lastText = text;
      onChange(json);
    } catch (err) {
      if (attempt < 5) setTimeout(() => read(attempt + 1), 300);
      else onError(err as Error);
    }
  };

  const start = () => {
    w = watch(dir, (_event, changed) => {
      if (changed && changed !== name) return;
      clearTimeout(timer);
      timer = setTimeout(() => read(), 400);
    });
    read();
  };

  if (existsSync(dir)) start();
  else
    poll = setInterval(() => {
      if (!existsSync(dir)) return;
      clearInterval(poll);
      start();
    }, pollMs);

  return {
    close() {
      clearInterval(poll);
      clearTimeout(timer);
      w?.close();
    },
  };
}
