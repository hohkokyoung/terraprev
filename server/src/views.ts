// What the live page can switch to besides the live stack: other state files to compare with, and
// plans to preview. Only files inside the compare root (config.compareRoot: the watched state file's
// folder unless set, a few levels down) are listed or read, so the local server can't be pointed anywhere else.

import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Comparison, Snapshot } from '../../shared/types.ts';
import { isPlan } from './state/plan.ts';
import { planComparison, readPlan, readStack, stackLabel, stacksCompared } from './compare.ts';
import { priceSnapshot, type SnapshotParts } from './snapshot.ts';
import type { ProviderPricer } from './pricing/types.ts';

export interface StackFile {
  /** Relative to the stack folder, with forward slashes: what the page sends back. */
  path: string;
  label: string;
  modified: string;
}

export interface StackFiles {
  /** The compare root, for display. */
  dir: string;
  /** The watched state: shown as "live", and listed first. */
  live: { label: string; path: string };
  /** Other state files: staging next to prod, an older copy, envs/*.tfstate … */
  states: StackFile[];
  /** `terraform show -json` output, or saved plan files (terraform reads those). */
  plans: StackFile[];
}

const SKIP_DIRS = new Set(['node_modules', '.terraform', '.git', 'dist', 'out', 'history']);
const MAX_DEPTH = 3;
const MAX_ENTRIES = 5000;
/** Big enough for a large plan's JSON; anything bigger is not read just to list it. */
const MAX_PLAN_BYTES = 200 * 1024 * 1024;

export function listStackFiles(compareRoot: string, stateFile: string): StackFiles {
  const root = realDir(compareRoot);
  const current = safeReal(stateFile);
  const states: StackFile[] = [];
  const plans: StackFile[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > MAX_ENTRIES) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      const entry = () => {
        const rel = relative(root, full).split(sep).join('/');
        return { path: rel, label: rel, modified: statSync(full).mtime.toISOString() };
      };
      if (/\.tfstate$/.test(e.name)) {
        if (safeReal(full) !== current) states.push({ ...entry(), label: stateLabel(root, full) });
      } else if (/plan/i.test(e.name) && isPlanFile(full)) plans.push(entry());
    }
  };
  walk(root, 0);
  const byName = (a: StackFile, b: StackFile) => a.path.localeCompare(b.path, 'en');
  const live = { label: stackLabel(stateFile), path: current ? relative(root, current).split(sep).join('/') : stateFile };
  return { dir: root, live, states: states.sort(byName), plans: plans.sort((a, b) => b.modified.localeCompare(a.modified)) };
}

/** What the page asks for: a stack or plan to show ("live" = the watched state), and optionally a stack to compare it with. */
export interface ViewRequest {
  show?: string;
  against?: string;
}

export interface ViewContext {
  compareRoot: string;
  /** The watched state, built; undefined until it first loads. */
  live?: SnapshotParts;
  defaultRegion: string;
  pricers: ProviderPricer[];
}

/**
 * Any stack in the compare root on its own, any two compared, or a plan.
 * `snapshot` is the stack on show when it isn't the live one; `compare` is set when there is a comparison.
 */
export async function buildView(req: ViewRequest, ctx: ViewContext): Promise<{ snapshot?: Snapshot; compare?: Comparison }> {
  const show = req.show || 'live';
  const against = req.against || undefined;
  if (show === against) throw new ViewError(400, 'Pick two different stacks to compare');
  if (show !== 'live' && !/\.tfstate$/.test(show)) {
    const file = resolveInStack(ctx.compareRoot, show, 'plan');
    const { parts, cost, compare } = await planComparison(file, readPlan(file), ctx.defaultRegion, ctx.pricers);
    return { snapshot: { ...parts.base, cost }, compare };
  }
  const stack = (which: string) => {
    if (which !== 'live') return readStack(resolveInStack(ctx.compareRoot, which, 'state'), ctx.defaultRegion);
    if (!ctx.live) throw new ViewError(404, 'The live state is not loaded yet');
    return ctx.live;
  };
  const target = stack(show);
  const base = against ? stack(against) : undefined;
  const [cost, compare] = await Promise.all([
    show === 'live' ? undefined : priceSnapshot(target, ctx.pricers),
    base ? stacksCompared(target, base, ctx.pricers) : undefined,
  ]);
  return { snapshot: cost ? { ...target.base, cost } : undefined, compare };
}

/** A path the page sent, as an absolute path inside the compare root; throws for anything else. */
export function resolveInStack(compareRoot: string, rel: string | undefined, kind: 'state' | 'plan'): string {
  if (!rel) throw new ViewError(400, `${kind === 'state' ? 'with' : 'file'} is required`);
  const root = realDir(compareRoot);
  const full = resolve(root, rel);
  const real = safeReal(full);
  const inside = (p: string) => {
    const r = relative(root, p);
    return r !== '' && !r.startsWith('..') && !isAbsolute(r);
  };
  // Check the path as given and after symlinks, so neither "../" nor a link can leave the folder.
  if (!inside(full) || !real || !inside(real)) throw new ViewError(404, `${rel} is not a file in ${root}`);
  if (!statSync(real).isFile()) throw new ViewError(404, `${rel} is not a file`);
  if (kind === 'state' && !/\.tfstate$/.test(real)) throw new ViewError(400, `${rel} is not a .tfstate file`);
  if (kind === 'plan' && !isPlanFile(real)) throw new ViewError(400, `${rel} is not a Terraform plan`);
  return real;
}

export class ViewError extends Error {
  readonly status: 400 | 404;
  constructor(status: 400 | 404, message: string) {
    super(message);
    this.status = status;
  }
}

function realDir(dir: string): string {
  return safeReal(resolve(dir)) ?? resolve(dir);
}

function safeReal(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/** staging/terraform.tfstate → staging ; prod.tfstate → prod ; a bare terraform.tfstate keeps its path. */
function stateLabel(root: string, file: string): string {
  return basename(file) === 'terraform.tfstate' && dirname(file) === root ? relative(root, file) : stackLabel(file);
}

/** A saved plan (a zip) or `terraform show -json` output. JSON is parsed only when it is plausibly a plan. */
function isPlanFile(file: string): boolean {
  try {
    const size = statSync(file).size;
    if (size < 2 || size > MAX_PLAN_BYTES) return false;
    const head = Buffer.alloc(512);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
    if (head[0] === 0x50 && head[1] === 0x4b) return true; // saved plan file
    const start = head.toString('utf8');
    if (!/^\s*\{/.test(start) || !start.includes('"format_version"')) return false;
    return isPlan(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return false;
  }
}
