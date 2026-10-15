import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchState } from '../src/watch.ts';

// Resolves with the first state read, or rejects on a read error / after `ms`.
function firstState(file: string, ms = 5000) {
  let handle: { close(): void } | undefined;
  const got = new Promise<unknown>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out waiting for state')), ms);
    handle = watchState(
      file,
      (json) => (clearTimeout(t), resolve(json)),
      (err) => (clearTimeout(t), reject(err)),
      { pollMs: 20 },
    );
  });
  return got.finally(() => handle?.close());
}

test('waits for a missing state folder, then reads the state once it appears', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tp-'));
  const file = join(root, 'not', 'yet', 'terraform.tfstate');
  const got = firstState(file);
  await new Promise((r) => setTimeout(r, 100)); // a few polls with nothing there
  mkdirSync(join(root, 'not', 'yet'), { recursive: true });
  writeFileSync(file, JSON.stringify({ serial: 7 }));
  assert.deepEqual(await got, { serial: 7 });
});

test('reads an existing state file straight away', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tp-'));
  const file = join(root, 'terraform.tfstate');
  writeFileSync(file, JSON.stringify({ serial: 1 }));
  assert.deepEqual(await firstState(file), { serial: 1 });
});
