// terraprev.usage.json: the usage assumptions (slider values, free tier) next to the state file.
// One file per folder, like the page's sliders always were: keys are Terraform addresses, so they
// survive re-applies, and stacks in the same folder share them.

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { UsageFile } from '../../shared/types.ts';

export const USAGE_FILE = 'terraprev.usage.json';

export const usagePath = (stateFile: string) => join(dirname(stateFile), USAGE_FILE);

/** The saved assumptions, or none. A file that can't be read counts as none, and says why. */
export function readUsage(stateFile: string, warn: (msg: string) => void = () => {}): UsageFile {
  const file = usagePath(stateFile);
  if (!existsSync(file)) return { usage: {}, freeTier: false };
  try {
    return cleanUsage(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    warn(`ignoring ${file}: ${(err as Error).message}`);
    return { usage: {}, freeTier: false };
  }
}

/** Writes the assumptions (sorted, so diffs stay small); with nothing to say, removes the file. */
export function writeUsage(stateFile: string, data: UsageFile): UsageFile {
  const file = usagePath(stateFile);
  const clean = cleanUsage(data);
  if (!Object.keys(clean.usage).length && !clean.freeTier) {
    rmSync(file, { force: true });
    return clean;
  }
  const body = { freeTier: clean.freeTier, usage: Object.fromEntries(Object.entries(clean.usage).sort(([a], [b]) => a.localeCompare(b))) };
  writeFileSync(file + '.tmp', JSON.stringify(body, null, 2) + '\n');
  renameSync(file + '.tmp', file);
  return clean;
}

/** Only finite, non-negative numbers; anything else in the file is dropped. */
export function cleanUsage(raw: unknown): UsageFile {
  const r = (raw ?? {}) as { usage?: unknown; freeTier?: unknown };
  const usage: Record<string, number> = {};
  if (r.usage && typeof r.usage === 'object') {
    for (const [k, v] of Object.entries(r.usage)) if (typeof v === 'number' && Number.isFinite(v) && v >= 0) usage[k] = v;
  }
  return { usage, freeTier: r.freeTier === true };
}
