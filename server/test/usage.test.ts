import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanUsage, readUsage, usagePath, writeUsage } from '../src/usage.ts';

const dir = mkdtempSync(join(tmpdir(), 'tp-usage-'));
const state = join(dir, 'terraform.tfstate');

test('no file: nothing saved', () => {
  assert.deepEqual(readUsage(state), { usage: {}, freeTier: false });
});

test('written sorted next to the state, read back the same, removed when empty', () => {
  writeUsage(state, { usage: { 'b:x': 2, 'a:y': 1 }, freeTier: true });
  assert.equal(usagePath(state), join(dir, 'terraprev.usage.json'));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(usagePath(state), 'utf8')).usage), ['a:y', 'b:x']);
  assert.deepEqual(readUsage(state), { usage: { 'a:y': 1, 'b:x': 2 }, freeTier: true });
  writeUsage(state, { usage: {}, freeTier: false });
  assert.ok(!existsSync(usagePath(state)));
});

test('bad values are dropped, and a broken file reads as none with a warning', () => {
  assert.deepEqual(cleanUsage({ usage: { ok: 3, neg: -1, str: '5', inf: Infinity }, freeTier: 'yes' }), { usage: { ok: 3 }, freeTier: false });
  writeFileSync(usagePath(state), '{ not json');
  const warnings: string[] = [];
  assert.deepEqual(readUsage(state, (m) => warnings.push(m)), { usage: {}, freeTier: false });
  assert.match(warnings[0], /ignoring .*terraprev\.usage\.json/);
});
