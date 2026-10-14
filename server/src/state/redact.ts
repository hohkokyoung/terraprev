// Nothing from raw state attributes goes to the browser except curated detail
// values, and those pass through here as a second line of defence.

const SECRET_KEY = /(password|passwd|secret|private_key|access_key|token|credential|user_data|connection_string|api_key|^result$)/i;
const SECRET_VALUE = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16})/;

export const REDACTED = '‹redacted›';

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** Collects every string marked sensitive by terraform for one instance, so we can scrub them anywhere. */
export function sensitiveValues(attrs: Record<string, any>, sensitivePaths: any[] = []): Set<string> {
  const out = new Set<string>();
  for (const path of sensitivePaths) {
    let cur: any = attrs;
    for (const step of path) {
      if (cur == null) break;
      const key = step?.value?.value ?? step?.value;
      cur = cur[key];
    }
    collectStrings(cur, out);
  }
  return out;
}

function collectStrings(v: any, out: Set<string>) {
  if (typeof v === 'string' && v.length >= 4) out.add(v);
  else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => collectStrings(x, out));
}

export function redactValue(key: string, value: string, secrets: Set<string>): string {
  if (isSecretKey(key) || SECRET_VALUE.test(value)) return REDACTED;
  for (const s of secrets) if (value.includes(s)) return REDACTED;
  return value;
}
