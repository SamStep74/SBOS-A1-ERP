import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

test('arithmetic sanity: 1 + 1 === 2', () => {
  assert.equal(1 + 1, 2);
});

test('engine contract: package.json declares node >=20', () => {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
  const engines = pkg.engines ?? {};
  const nodeRange = engines.node;
  assert.ok(
    typeof nodeRange === 'string' && nodeRange.includes('20'),
    `expected engines.node to include 20, got ${JSON.stringify(nodeRange)}`,
  );
});

test('engine contract: .nvmrc pins Node 20', () => {
  const nvmrc = readFileSync(resolve(repoRoot, '.nvmrc'), 'utf8').trim();
  assert.equal(nvmrc, '20');
});

test('runtime: current Node satisfies engines >=20 (informational)', () => {
  // CI uses setup-node@v4 with node-version: '20', so the supported
  // production runtime is Node 20. Locally an engineer may be on 22+ for
  // tooling; this test only asserts the runtime is >=20, not that it equals 20.
  const major = Number.parseInt(process.version.slice(1).split('.')[0] ?? '', 10);
  assert.ok(Number.isFinite(major) && major >= 20, `expected Node >=20, got ${process.version}`);
});
