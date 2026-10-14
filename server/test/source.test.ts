import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchBrace, parseAddress, SourceIndex } from '../src/source/hcl.ts';

test('parses module, data and indexed addresses', () => {
  assert.deepEqual(parseAddress('module.a.module.b.aws_lambda_function.this'), { modules: ['a', 'b'], mode: 'resource', type: 'aws_lambda_function', name: 'this' });
  assert.deepEqual(parseAddress('data.aws_lb.x["a.b"]'), { modules: [], mode: 'data', type: 'aws_lb', name: 'x' });
  assert.deepEqual(parseAddress('aws_subnet.public["us-east-1a"]')?.name, 'public');
});

test('brace matching skips strings, interpolation, heredocs and comments', () => {
  const src = `resource "x" "y" {
  a = "}{ \${foo("}")} "
  # } comment
  /* } */
  b = <<EOT
  }}}
  EOT
  c { d = 1 }
}
after`;
  const close = matchBrace(src, src.indexOf('{'));
  assert.equal(src.slice(close + 1).trim(), 'after');
});

test('finds root blocks with their comments, and module resources plus the module call', () => {
  const root = mkdtempSync(join(tmpdir(), 'tp-'));
  mkdirSync(join(root, 'modules', 'fn'), { recursive: true });
  writeFileSync(join(root, 'main.tf'), `# The queue\n# (two lines)\nresource "aws_sqs_queue" "jobs" {\n  name = "jobs"\n}\n\nmodule "worker" {\n  source = "./modules/fn"\n  name   = "w"\n}\n`);
  writeFileSync(join(root, 'modules', 'fn', 'main.tf'), `resource "aws_lambda_function" "this" {\n  function_name = var.name\n}\n`);
  writeFileSync(join(root, 'terraform.tfstate'), '{}');
  const idx = new SourceIndex(join(root, 'terraform.tfstate'));

  const q = idx.find('aws_sqs_queue.jobs')!;
  assert.equal(q.blocks[0].startLine, 1, 'includes leading comment');
  assert.equal(q.blocks[0].blockLine, 3);
  assert.match(q.blocks[0].text, /^# The queue[\s\S]*\}$/);

  const m = idx.find('module.worker.aws_lambda_function.this')!;
  assert.deepEqual(m.blocks.map((b) => [b.role, b.file]), [['resource', join('modules', 'fn', 'main.tf')], ['module', 'main.tf']]);
  assert.equal(idx.find('aws_sqs_queue.missing'), undefined);
});
