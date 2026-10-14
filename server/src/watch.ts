import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

/**
 * Calls `onChange(json)` whenever the state file settles after a write.
 * Watches the directory, not the file: terraform may replace the file, which
 * would orphan a file watcher.
 */
export function watchState(file: string, onChange: (json: unknown) => void, onError: (err: Error) => void): FSWatcher {
  const name = basename(file);
  let timer: NodeJS.Timeout | undefined;
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

  const w = watch(dirname(file), (_event, changed) => {
    if (changed && changed !== name) return;
    clearTimeout(timer);
    timer = setTimeout(() => read(), 400);
  });
  read();
  return w;
}
