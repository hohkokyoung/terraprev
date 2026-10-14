import type { TfResource } from '../../../shared/types.ts';
import { sensitiveValues } from './redact.ts';

export interface ParsedState {
  serial: number;
  lineage: string;
  terraformVersion: string;
  resources: TfResource[];
  /** Every value terraform marked sensitive, anywhere in the state. Used to scrub display strings. */
  secrets: Set<string>;
}

/** provider["registry.terraform.io/hashicorp/aws"] → aws ; provider["…/aws"].west → aws */
export function providerName(raw: string): string {
  const m = raw.match(/provider\["[^"]*\/([^"/]+)"\]/);
  return m ? m[1] : raw;
}

function indexSuffix(key: unknown): string {
  if (key === undefined || key === null) return '';
  return typeof key === 'number' ? `[${key}]` : `[${JSON.stringify(key)}]`;
}

/** Parses a terraform state file (format version 4). */
export function parseState(json: any): ParsedState {
  if (json?.version !== 4) {
    throw new Error(`Unsupported state format version ${json?.version}; expected 4 (Terraform >= 0.12)`);
  }
  const resources: TfResource[] = [];
  const secrets = new Set<string>();
  for (const r of json.resources ?? []) {
    const prefix = r.module ? `${r.module}.` : '';
    const dataPrefix = r.mode === 'data' ? 'data.' : '';
    const baseAddress = `${prefix}${dataPrefix}${r.type}.${r.name}`;
    for (const inst of r.instances ?? []) {
      for (const v of sensitiveValues(inst.attributes ?? {}, inst.sensitive_attributes)) secrets.add(v);
      resources.push({
        address: baseAddress + indexSuffix(inst.index_key),
        baseAddress,
        mode: r.mode,
        type: r.type,
        name: r.name,
        module: r.module,
        indexKey: inst.index_key,
        provider: providerName(r.provider ?? ''),
        attrs: inst.attributes ?? {},
        deps: inst.dependencies ?? [],
      });
    }
  }
  return {
    serial: json.serial ?? 0,
    lineage: json.lineage ?? '',
    terraformVersion: json.terraform_version ?? '',
    resources,
    secrets,
  };
}
