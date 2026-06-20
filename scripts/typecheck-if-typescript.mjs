#!/usr/bin/env node
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirs = new Set([
  '.claude',
  '.git',
  '.orchestration',
  'coverage',
  'dist',
  'node_modules',
]);

function hasTypeScriptSource(directory) {
  for (const entry of readdirSync(directory)) {
    if (ignoredDirs.has(entry)) continue;
    const fullPath = path.join(directory, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (hasTypeScriptSource(fullPath)) return true;
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      return true;
    }
  }
  return false;
}

if (!hasTypeScriptSource(repoRoot)) {
  console.log('No TypeScript source files found; skipping tsc.');
  process.exit(0);
}

const result = spawnSync('tsc', ['--noEmit'], {
  cwd: repoRoot,
  stdio: 'inherit',
});
process.exitCode = result.status ?? 1;
