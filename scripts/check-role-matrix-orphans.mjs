// Check whether any orphan-permission-key is referenced by roleMatrix.js,
// matrix.js, or any other rbac consumer. Deleting orphan perms that are
// referenced by role definitions would create dangling refs.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

let auditJson;
try {
  auditJson = execFileSync('node', ['server/l10n-am/audit-cli.js', '--format', 'json'], {
    encoding: 'utf8',
  });
} catch (err) {
  // audit-cli exits 1 when issues are present — but stdout still has the
  // JSON we need. The error object has the captured output.
  auditJson = err.stdout ? err.stdout.toString() : '';
  if (!auditJson) throw err;
}
const audit = JSON.parse(auditJson);
const orphanSet = new Set(
  audit.issues.filter((i) => i.type === 'orphan-permission-key').map((i) => i.key),
);
console.log(`orphan count: ${orphanSet.size}`);

const files = [
  'server/rbac/roleMatrix.js',
  'server/rbac/matrix.js',
  'server/rbac/index.js',
  'server/rbac/routes.js',
  'server/rbac/seed.js',
  'server/rbac/express-adapter.js',
  'server/rbac/guards.js',
  'server/rbac/roles.js',
];

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const refs = [];
  for (const k of orphanSet) {
    const re1 = new RegExp(`'${k}'`, 'g');
    const re2 = new RegExp(`"${k}"`, 'g');
    if (re1.test(src) || re2.test(src)) refs.push(k);
  }
  if (refs.length > 0) {
    console.log(`${f}: ${refs.length} orphan refs`);
    console.log(`  ${refs.slice(0, 5).join(', ')}${refs.length > 5 ? '...' : ''}`);
  } else {
    console.log(`${f}: clean`);
  }
}
