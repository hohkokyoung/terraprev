// Finds the HCL block that declared a resource, so the UI can show the real config.
// Not a full HCL parser: it locates `resource "type" "name" {` and brace-matches,
// skipping strings, ${...} interpolation, heredocs and comments.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { SourceBlock, SourceResult } from '../../../shared/types.ts';

export type { SourceBlock, SourceResult };

interface Parsed {
  /** "module" segments, e.g. ["worker"] or ["a", "b"] for module.a.module.b */
  modules: string[];
  mode: 'resource' | 'data';
  type: string;
  name: string;
}

/** module.worker.aws_lambda_function.this / data.aws_lb.x["k"] → parts, without index keys. */
export function parseAddress(address: string): Parsed | undefined {
  const parts = splitAddress(address).map((p) => p.replace(/\[.*\]$/, ''));
  const modules: string[] = [];
  let i = 0;
  while (parts[i] === 'module' && parts[i + 1]) {
    modules.push(parts[i + 1]);
    i += 2;
  }
  let mode: Parsed['mode'] = 'resource';
  if (parts[i] === 'data') {
    mode = 'data';
    i++;
  }
  const [type, name] = [parts[i], parts[i + 1]];
  return type && name ? { modules, mode, type, name } : undefined;
}

/** Splits on dots outside of [ ] (index keys may contain dots). */
function splitAddress(a: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  for (const ch of a) {
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === '.' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export class SourceIndex {
  private readonly root: string;
  private readonly stateFile: string;
  private readonly cache = new Map<string, { mtimeMs: number; text: string }>();

  constructor(stateFile: string) {
    this.stateFile = stateFile;
    this.root = resolve(stateFile, '..');
  }

  find(address: string): SourceResult | undefined {
    const p = parseAddress(address);
    if (!p) return undefined;
    const blocks: SourceBlock[] = [];

    const dir = this.moduleDir(p.modules);
    if (dir) {
      const b = this.findBlock(dir, p.mode, [p.type, p.name]);
      if (b) blocks.push({ ...b, role: 'resource', label: `${p.mode} "${p.type}" "${p.name}"` });
    }
    // The module call holds the real inputs for generic module resources.
    if (p.modules.length) {
      const parentDir = this.moduleDir(p.modules.slice(0, -1));
      const name = p.modules[p.modules.length - 1];
      const call = parentDir && this.findBlock(parentDir, 'module', [name]);
      if (call) blocks.push({ ...call, role: 'module', label: `module "${name}"` });
    }
    if (!blocks.length) return undefined;

    const applied = existsSync(this.stateFile) ? statSync(this.stateFile).mtimeMs : 0;
    return {
      address,
      blocks,
      changedSinceApply: blocks.some((b) => new Date(b.modifiedAt).getTime() > applied),
    };
  }

  /** Resolve a module path to a directory, preferring terraform's own module manifest. */
  private moduleDir(modules: string[]): string | undefined {
    if (!modules.length) return this.root;
    const manifest = join(this.root, '.terraform', 'modules', 'modules.json');
    if (existsSync(manifest)) {
      try {
        const key = modules.join('.');
        const m = JSON.parse(readFileSync(manifest, 'utf8')).Modules?.find((x: any) => x.Key === key);
        if (m?.Dir) return this.inside(resolve(this.root, m.Dir));
      } catch {
        /* fall through */
      }
    }
    // Fallback: follow local `source = "./..."` paths.
    let dir = this.root;
    for (const name of modules) {
      const call = this.findBlock(dir, 'module', [name]);
      const src = call?.text.match(/^\s*source\s*=\s*"(\.{1,2}\/[^"]+)"/m)?.[1];
      if (!src) return undefined;
      const next = this.inside(resolve(dir, src));
      if (!next) return undefined;
      dir = next;
    }
    return dir;
  }

  /** Never read outside the stack directory. */
  private inside(p: string): string | undefined {
    return p === this.root || p.startsWith(this.root + sep) ? p : undefined;
  }

  private findBlock(dir: string, keyword: string, labels: string[]): Omit<SourceBlock, 'role' | 'label'> | undefined {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.tf')).sort();
    } catch {
      return undefined;
    }
    const header = new RegExp(`^[ \\t]*${keyword}\\s+${labels.map((l) => `"${escapeRe(l)}"`).join('\\s+')}\\s*\\{`, 'm');
    for (const f of files) {
      const abs = join(dir, f);
      const text = this.read(abs);
      const m = header.exec(text);
      if (!m) continue;
      const open = m.index + m[0].length - 1;
      const close = matchBrace(text, open);
      if (close < 0) continue;
      const lines = text.split('\n');
      const blockLine = lineOf(text, m.index);
      const endLine = lineOf(text, close);
      // Include the comment directly above (no blank line in between).
      let start = blockLine;
      while (start > 1 && /^\s*(#|\/\/)/.test(lines[start - 2])) start--;
      return {
        file: relative(this.root, abs),
        absPath: abs,
        startLine: start,
        blockLine,
        endLine,
        text: lines.slice(start - 1, endLine).join('\n'),
        modifiedAt: statSync(abs).mtime.toISOString(),
      };
    }
    return undefined;
  }

  private read(abs: string): string {
    const mtimeMs = statSync(abs).mtimeMs;
    const hit = this.cache.get(abs);
    if (hit && hit.mtimeMs === mtimeMs) return hit.text;
    const text = readFileSync(abs, 'utf8');
    this.cache.set(abs, { mtimeMs, text });
    return text;
  }
}

/** Index of the `}` matching the `{` at `open`, or -1. */
export function matchBrace(s: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    if (c === '#' || (c === '/' && next === '/')) {
      i = s.indexOf('\n', i);
      if (i < 0) return -1;
      continue;
    }
    if (c === '/' && next === '*') {
      i = s.indexOf('*/', i + 2);
      if (i < 0) return -1;
      i += 2;
      continue;
    }
    if (c === '<' && next === '<') {
      const h = /^<<-?([A-Za-z_][A-Za-z0-9_]*)\r?\n/.exec(s.slice(i, i + 80));
      if (h) {
        const end = new RegExp(`^\\s*${h[1]}\\s*$`, 'm');
        end.lastIndex = 0;
        const rest = s.slice(i + h[0].length);
        const m = end.exec(rest);
        if (!m) return -1;
        i = i + h[0].length + m.index + m[0].length;
        continue;
      }
    }
    if (c === '"') {
      i = skipString(s, i + 1);
      if (i < 0) return -1;
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** From just after an opening quote, returns the index after the closing quote. Handles ${ ... } with nested strings. */
function skipString(s: string, i: number): number {
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    if ((c === '$' || c === '%') && s[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < s.length && depth > 0) {
        if (s[i] === '"') {
          i = skipString(s, i + 1);
          if (i < 0) return -1;
          continue;
        }
        if (s[i] === '{') depth++;
        else if (s[i] === '}') depth--;
        i++;
      }
      continue;
    }
    if (c === '\n') return -1; // unterminated
    i++;
  }
  return -1;
}

function lineOf(s: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
