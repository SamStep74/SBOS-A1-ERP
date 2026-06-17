import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const ciPath = resolve(repoRoot, '.github/workflows/ci.yml');
const pkgPath = resolve(repoRoot, 'package.json');

function readCi() {
  return readFileSync(ciPath, 'utf8');
}

function readPkg() {
  return JSON.parse(readFileSync(pkgPath, 'utf8'));
}

/** Parse the `matrix.node` YAML scalar list. Tolerates quoting and trailing commas. */
function extractNodeMatrix(ciText) {
  const block = ciText.match(/matrix:\s*\n(?:\s+[^\n]+\n)*?\s+node:\s*\[([^\]]+)\]/);
  if (!block) {
    const flow = ciText.match(/node:\s*\[([^\]]+)\]/);
    if (!flow) return [];
    return flow[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  return block[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

test('ci.yml: node matrix has at least 2 LTS versions', () => {
  const versions = extractNodeMatrix(readCi());
  assert.ok(
    versions.length >= 2,
    `expected matrix.node to contain >=2 versions, got ${JSON.stringify(versions)}`,
  );
  for (const v of versions) {
    assert.match(v, /^\d+$/, `matrix entry "${v}" is not a bare major version`);
  }
});

test('ci.yml: node matrix covers every major in package.json engines', () => {
  const engines = readPkg().engines ?? {};
  const nodeRange = engines.node ?? '';
  const requiredMajors = Array.from(
    new Set(
      Array.from(nodeRange.matchAll(/\b(\d{2})\b/g))
        .map((m) => m[1])
        .filter((m) => Number.parseInt(m, 10) >= 20),
    ),
  );
  assert.ok(requiredMajors.length > 0, `no majors >=20 in engines.node="${nodeRange}"`);
  const matrixMajors = extractNodeMatrix(readCi());
  for (const m of requiredMajors) {
    assert.ok(
      matrixMajors.includes(m),
      `matrix ${JSON.stringify(matrixMajors)} missing engines.node major ${m}`,
    );
  }
});

test('ci.yml: runs a coverage step using node --test --test-coverage (built-in)', () => {
  const ci = readCi();
  const hasCoverageStep =
    /--test-coverage/.test(ci) || /--experimental-test-coverage/.test(ci) || /npm run (test:coverage|coverage:check)/.test(ci);
  assert.ok(
    hasCoverageStep,
    'ci.yml must run a coverage step (node --test --test-coverage or npm run test:coverage / coverage:check)',
  );
});

test('ci.yml: gates the build on a coverage threshold (script exit code)', () => {
  const ci = readCi();
  // The gate is a separate step that runs after the coverage step and
  // exits non-zero when below threshold. We accept any of: a custom
  // coverage-check script, a c8 --check-coverage, or a coverage threshold job.
  const hasGate =
    /coverage:check/.test(ci) ||
    /check-coverage/.test(ci) ||
    /--check-coverage/.test(ci) ||
    /coverage[\s_-]threshold/i.test(ci);
  assert.ok(hasGate, 'ci.yml must fail the build when coverage drops below threshold');
});

test('package.json: exposes a test:coverage script using node --test --test-coverage', () => {
  const scripts = readPkg().scripts ?? {};
  assert.ok(
    typeof scripts['test:coverage'] === 'string' && scripts['test:coverage'].length > 0,
    'scripts.test:coverage missing — CI needs a coverage entry point',
  );
  // Accept either the stable flag (node 22+) or the experimental one
  // (node 20.x). The CI matrix covers both majors, so the script must
  // work on the lower one too.
  assert.ok(
    /--test-coverage/.test(scripts['test:coverage']) ||
      /--experimental-test-coverage/.test(scripts['test:coverage']),
    `scripts.test:coverage must use node --test --[experimental-]test-coverage, got ${JSON.stringify(scripts['test:coverage'])}`,
  );
});

test('package.json: exposes a coverage:check script that enforces a threshold', () => {
  const scripts = readPkg().scripts ?? {};
  assert.ok(
    typeof scripts['coverage:check'] === 'string' && scripts['coverage:check'].length > 0,
    'scripts.coverage:check missing — CI needs a threshold-gate entry point',
  );
  // The check script must reference a real script file under scripts/ so it can be TDD'd.
  assert.ok(
    /scripts\/check-coverage\./.test(scripts['coverage:check']),
    `scripts.coverage:check must invoke scripts/check-coverage.*, got ${JSON.stringify(scripts['coverage:check'])}`,
  );
});

test('scripts/check-coverage.mjs exists and is executable (>=1 byte)', () => {
  const p = resolve(repoRoot, 'scripts/check-coverage.mjs');
  assert.ok(existsSync(p), `${p} missing — coverage threshold gate has no implementation`);
  const stat = readFileSync(p, 'utf8');
  assert.ok(stat.length > 0, 'scripts/check-coverage.mjs must not be empty');
});

test('package.json: coverage/ is ignored from version control', () => {
  const gitignore = readFileSync(resolve(repoRoot, '.gitignore'), 'utf8');
  assert.match(gitignore, /^coverage\/?$/m, '.gitignore must ignore the coverage/ directory');
});
