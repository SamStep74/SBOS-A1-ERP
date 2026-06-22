#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readRepoFile(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function gitLines(args) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function repoFiles() {
  return [
    ...new Set([
      ...gitLines(['ls-files']),
      ...gitLines(['ls-files', '--others', '--exclude-standard']),
    ]),
  ]
    .filter((file) => existsSync(path.join(repoRoot, file)))
    .sort();
}

function hasLine(text, expected) {
  return text.split(/\r?\n/).some((line) => line.trim() === expected);
}

function isSourceBoundaryFile(file) {
  if (file === 'scripts/check-open-core-boundary-contract.mjs') return false;
  return (
    file === 'package.json' ||
    file === 'tsconfig.json' ||
    file === 'eslint.config.js' ||
    file === 'AGENTS.md' ||
    file.startsWith('server/') ||
    file.startsWith('scripts/') ||
    file.startsWith('test/') ||
    file.startsWith('.github/workflows/')
  );
}

function isTextFile(file) {
  return (
    /\.(?:cjs|cts|js|jsx|json|md|mjs|mts|sh|sql|ts|tsx|txt|yml|yaml)$/i.test(file) ||
    !path.extname(file)
  );
}

const files = {
  readme: readRepoFile('README.md'),
  boundaryDoc: readRepoFile('docs/SBOS_VS_A1_ERP_HY.md'),
  gitignore: readRepoFile('.gitignore'),
  packageJson: JSON.parse(readRepoFile('package.json')),
};

const errors = [];

function requireMatch(label, text, pattern) {
  if (!pattern.test(text)) errors.push(label);
}

requireMatch(
  'README must declare public open-core distribution',
  files.readme,
  /public,\s+open-core/i,
);
requireMatch(
  'README must declare brand-neutral code landing zone',
  files.readme,
  /de-privatized,\s+brand-neutral/i,
);
requireMatch(
  'README must point to the porting protocol',
  files.readme,
  /docs\/SBOS_VS_A1_ERP_HY\.md/,
);
requireMatch('README must document the Karpathy eval', files.readme, /## Karpathy Eval/);
requireMatch(
  'README must expose the open-core eval command',
  files.readme,
  /check-open-core-boundary-contract\.mjs/,
);

requireMatch(
  'Boundary doc must describe private R&D source repo',
  files.boundaryDoc,
  /private R&D and\s+hardening ground/i,
);
requireMatch(
  'Boundary doc must describe public-facing open-core target',
  files.boundaryDoc,
  /public-facing open-core/i,
);
requireMatch(
  'Boundary doc must require secret scrubbing',
  files.boundaryDoc,
  /Secrets \(API keys, tenant IDs, paid-integration credentials,\s+personal phone numbers\) are scrubbed/s,
);
requireMatch(
  'Boundary doc must require vendor-name normalization',
  files.boundaryDoc,
  /Vendor-specific names are normalized/s,
);
requireMatch(
  'Boundary doc must ban brand identifiers in source',
  files.boundaryDoc,
  /should not appear in source\s+code shipped here/s,
);
requireMatch(
  'Boundary doc must require deploy-time branding',
  files.boundaryDoc,
  /configured at deploy time/s,
);

if (files.packageJson.name !== 'sbos-a1-erp') {
  errors.push('package name must remain sbos-a1-erp');
}
if (files.packageJson.private !== true) {
  errors.push('package must stay private until license and release gate are explicit');
}

if (!hasLine(files.gitignore, '.env')) {
  errors.push('.gitignore must ignore .env');
}
if (!hasLine(files.gitignore, '.env.*')) {
  errors.push('.gitignore must ignore .env.*');
}
if (!hasLine(files.gitignore, '!.env.example')) {
  errors.push('.gitignore must allow .env.example');
}
if (!hasLine(files.gitignore, 'evals/karpathy/results/')) {
  errors.push('.gitignore must ignore local Karpathy result logs');
}

const repoFileList = repoFiles();
const trackedFiles = gitLines(['ls-files']);
const trackedEnvFiles = trackedFiles.filter((file) => {
  const name = path.basename(file);
  return (name === '.env' || name.startsWith('.env.')) && name !== '.env.example';
});
if (trackedEnvFiles.length) {
  errors.push(`tracked env files must be removed: ${trackedEnvFiles.join(', ')}`);
}

const stableEInvoiceNamespaceLine = "const EINVOICE_NAMESPACE = 'urn:hayhashvapah:einvoice:1';";
const forbiddenBrandPattern = /(?:armosphera|hayhashvapah|samvel)/i;
const brandLeaks = [];
for (const file of repoFileList.filter(isSourceBoundaryFile).filter(isTextFile)) {
  if (forbiddenBrandPattern.test(file)) {
    brandLeaks.push(`${file}:path`);
    continue;
  }
  const text = readRepoFile(file);
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const isStableProtocolException =
      file === 'server/l10n-am/einvoice/einvoice.js' && line.trim() === stableEInvoiceNamespaceLine;
    if (!isStableProtocolException && forbiddenBrandPattern.test(line)) {
      brandLeaks.push(`${file}:${index + 1}`);
    }
  });
}
if (brandLeaks.length) {
  errors.push(
    `forbidden brand identifiers in shipped source: ${brandLeaks.slice(0, 10).join(', ')}`,
  );
}

const secretSentinels = [
  { label: 'github token', pattern: /\b(?:github_pat|gh[pousr])_[A-Za-z0-9_]{16,}/i },
  { label: 'openai-style key', pattern: /\bsk-[A-Za-z0-9_-]{16,}/i },
  { label: 'google api key literal', pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { label: 'private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'bearer token', pattern: /\bbearer\s+[-._~+/=a-z0-9]{16,}/i },
];
const secretLeaks = [];
for (const file of repoFileList.filter(isTextFile)) {
  if (file.startsWith('evals/karpathy/results/')) continue;
  const text = readRepoFile(file);
  const leaked = secretSentinels.find((sentinel) => sentinel.pattern.test(text));
  if (leaked) secretLeaks.push(`${file} (${leaked.label})`);
}
if (secretLeaks.length) {
  errors.push(`key-shaped secrets in tracked text files: ${secretLeaks.slice(0, 10).join(', ')}`);
}

const einvoiceSource = readRepoFile('server/l10n-am/einvoice/einvoice.js');
requireMatch(
  'e-invoice namespace must preserve stable protocol URN',
  einvoiceSource,
  /const EINVOICE_NAMESPACE = 'urn:hayhashvapah:einvoice:1';/,
);
const stableNamespaceUses = einvoiceSource
  .split(/\r?\n/)
  .filter((line) => line.includes('urn:hayhashvapah:einvoice:1'));
if (
  stableNamespaceUses.length !== 1 ||
  stableNamespaceUses[0].trim() !== stableEInvoiceNamespaceLine
) {
  errors.push('only the stable e-invoice namespace constant may carry the legacy URN');
}

console.log(`failing_checks=${errors.length}`);
if (errors.length) {
  console.error(`open_core_boundary_error=${errors[0]}`);
}
process.exitCode = errors.length ? 1 : 0;
