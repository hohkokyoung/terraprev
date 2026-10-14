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
  };
}
