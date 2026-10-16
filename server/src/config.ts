import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface Config {
  stateFile: string;
  port: number;
  defaultRegion: string;
  priceCacheDays: number;
  cacheDir: string;
  /** One cost-history file per stack (state lineage). */
  historyDir: string;
  /**
   * The folder the live page may pick other state files and plans from (Compare / Plan). Defaults to the
   * state file's folder; set it to e.g. "envs" to compare envs/prod with envs/staging. Nothing outside it is read.
   */
  compareRoot: string;
}

export function loadConfig(): Config {
  const file = resolve(ROOT, 'terraprev.config.json');
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const stateFile = process.env.TERRAPREV_STATE ?? raw.stateFile ?? 'terraform.tfstate';
  return {
    stateFile: resolve(ROOT, stateFile),
    port: Number(process.env.PORT ?? raw.port ?? 4610),
    defaultRegion: process.env.TERRAPREV_REGION ?? raw.defaultRegion ?? 'us-east-1',
    priceCacheDays: raw.priceCacheDays ?? 7,
    cacheDir: resolve(ROOT, '.cache'),
    historyDir: resolve(ROOT, process.env.TERRAPREV_HISTORY ?? raw.historyDir ?? 'history'),
    compareRoot: resolve(ROOT, process.env.TERRAPREV_COMPARE_ROOT ?? raw.compareRoot ?? dirname(stateFile)),
  };
}
