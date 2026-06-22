import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['src', 'test'];

function hasTypeScriptFile(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }

  return entries.some((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return hasTypeScriptFile(fullPath);
    return entry.isFile() && entry.name.endsWith('.ts');
  });
}

if (!roots.some(hasTypeScriptFile)) {
  console.log('typecheck: no TypeScript inputs found; skipping tsc');
  process.exit(0);
}

const result = spawnSync('tsc', ['--noEmit'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
