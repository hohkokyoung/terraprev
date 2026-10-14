import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBase } from '../src/snapshot.ts';
import { buildReport, renderMarkdown, defaultUsageValues } from '../../shared/report.ts';
import type { Snapshot } from '../../shared/types.ts';
import { fixtureState, SECRET } from './fixture.ts';

const snapshot = (): Snapshot => {
  const parts = buildBase('/tmp/stack/terraform.tfstate', fixtureState(), 'us-east-1');
  return {
    ...parts.base,
    cost: { currency: 'USD', region: 'us-east-1', status: 'ready', components: [], usage: [], unpriced: [], free: [], sources: [], errors: [] },
  };
};

test('findings come from state attributes', () => {
  const ids = snapshot().insights.map((i) => i.id.split(':')[0]);
  for (const id of ['rds-single-az', 'rds-no-backup', 'rds-unencrypted', 'imdsv1', 'no-alarms']) assert.ok(ids.includes(id), `missing ${id}`);
  assert.ok(!ids.includes('rds-public'), 'fixture DB is not public');
});

test('markdown brief has every section, a mermaid diagram, and no secrets', () => {
  const s = snapshot();
  const md = renderMarkdown(buildReport({ snapshot: s, usage: defaultUsageValues(s), freeTier: false }));
  for (const h of ['## Executive summary', '## Architecture', '```mermaid', 'flowchart LR', '## Cost', '## Findings & recommendations', '## Security posture', '## Appendix']) {
    assert.ok(md.includes(h), `missing ${h}`);
  }
  assert.ok(!md.includes(SECRET), 'secret leaked into report');
  assert.match(md, /app-db has automated backups disabled/);
});

test('hard-coded secret rule: catches literals, ignores references', async () => {
  const { hardcodedSecret } = await import('../src/insights/aws.ts');
  // real problems
  assert.equal(hardcodedSecret('DB_PASSWORD="hunter2-prod"'), 'DB_PASSWORD');
  assert.equal(hardcodedSecret('#!/bin/bash\nexport PGPASSWORD=s3cr3tValue\npsql'), 'PGPASSWORD');
  assert.equal(hardcodedSecret("api_key: 'sk_live_abcdef123456'"), 'api_key');
  // references, like the tf-lab user_data: must NOT fire
  assert.equal(hardcodedSecret('SECRET_ID = "arn:aws:secretsmanager:us-east-1:111122223333:secret:db-AbCd"'), undefined);
  assert.equal(hardcodedSecret('secret = client.get_secret_value(SecretId=SECRET_ID)'), undefined);
  assert.equal(hardcodedSecret('conn = pg8000.connect(password=creds["password"])'), undefined);
  assert.equal(hardcodedSecret('DB_PASSWORD="${db_password}"'), undefined);
  assert.equal(hardcodedSecret('export PGPASSWORD=$(aws secretsmanager get-secret-value ...)'), undefined);
  assert.equal(hardcodedSecret('PASSWORD=$DB_PASS'), undefined);
});

test('report is deterministic: independent of clock, timezone and price-load order', () => {
  const s = snapshot();
  s.cost.sources = [
    { name: 'AWS Price List · AmazonS3 · us-east-1', publishedAt: '2026-10-01T00:00:00Z' },
    { name: 'AWS Price List · AWSLambda · us-east-1', publishedAt: '2026-10-02T00:00:00Z' },
  ];
  const render = () => renderMarkdown(buildReport({ snapshot: s, usage: defaultUsageValues(s), freeTier: false }));
  const a = render();
  const tz = process.env.TZ;
  process.env.TZ = 'Pacific/Auckland';
  s.cost.sources.reverse(); // parallel loads can finish in any order
  const b = render();
  process.env.TZ = tz;
  assert.equal(a, b);
  assert.match(a, /report [0-9a-f]{12}\./, 'carries an input fingerprint instead of a timestamp');
  assert.match(a, /\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/, 'dates in UTC');
  // and the fingerprint changes when an input changes
  const c = renderMarkdown(buildReport({ snapshot: s, usage: defaultUsageValues(s), freeTier: true }));
  assert.notEqual(a.match(/report ([0-9a-f]{12})/)![1], c.match(/report ([0-9a-f]{12})/)![1]);
});
