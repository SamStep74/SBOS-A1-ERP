// SBOS-A1-ERP permission-registry audit scanner.
//
// Two complementary regression nets for the rbac/permissions.js catalog:
//
//   1. orphan-permission-key     — declared in the catalog but never
//                                  referenced by any production .js source.
//                                  Translation cost was paid (a human wrote
//                                  label + description) but no consumer ever
//                                  guards on it. The code is dead.
//
//   2. unknown-permission-usage  — referenced by production source (string
//                                  arg to requirePerm/requirePermFastify/
//                                  requireAnyPerm/requireAllPerm) but not in
//                                  the catalog. Almost always a typo, a
//                                  deleted perm, or a phantom that snuck in
//                                  through a copy/paste.
//
// The scanner is pure-functional and DI-shaped so the audit-cli (and tests)
// can inject `permissions`, `files`, and `readFile` instead of depending on
// the live filesystem or the real catalog at import time.
//
// Mirrors the shape of server/l10n-am/audit.js :: auditUnusedKeys — same
// defensive file filter (.js + !.test.js), same stripJsComments contract,
// same { issues, count, ... } envelope. The CLI layer in
// server/l10n-am/audit-cli.js can be extended to invoke this scanner
// alongside the i18n scanners without restructuring.

import { readFileSync } from 'node:fs';
import { extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERMISSIONS } from './permissions.js';
import { stripJsComments, walkJsSources } from '../l10n-am/audit.js';

// ---- public pattern (pinned by tests) ------------------------------------
//
// Captures the key inside the most common call shapes:
//   requirePerm('a.b.c')
//   requirePermFastify('a.b.c')
//   requireAnyPerm('a.b.c')   // (legacy — prefer requireAnyPermission(user, [...]))
//   requireAllPerm('a.b.c')   // (legacy — prefer requireAllPermission(user, [...]))
//
// Group 1 is the permission key string. The /g flag is required for
// matchAll-style iteration over a single source string.
//
// The shape is intentionally narrow: only the first argument of these
// guards is treated as a permission key reference. requireAnyPermission's
// second argument is an ARRAY of keys and is handled by a separate
// internal pattern (see findPermissionReferences below).

export const PERMISSION_REFERENCE_PATTERN =
  /\brequirePerm(?:Fastify|Any|All)?\s*\(\s*['"]([a-z][a-z0-9_.\-]*)['"]/gi;

// ---- internal: array form ------------------------------------------------
//
// requireAnyPermission(user, ['k1','k2']) and
// requireAllPermission(user, ['k1','k2']) pass the keys as an array.
// This pattern captures the array literal so the keys can be extracted
// from it. Kept private (not exported) because the test contract pins
// only the single-key pattern; future expansions can export it.
const ARRAY_REFERENCE_PATTERN = /\brequire(?:Any|All)Permission\s*\(\s*\w+\s*,\s*\[([^\]]+)\]/g;

// One entry in an array literal. Single-quoted or double-quoted permission
// key — same shape as the single-key pattern's group 1.
const ARRAY_KEY_TOKEN_PATTERN = /['"]([a-z][a-z0-9_.\-]*)['"]/g;

// ---- helpers ------------------------------------------------------------

/** Convert a source-relative index into a 1-based line number. */
function lineNumberOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * Walk a comment-stripped source string and yield { key, line } for every
 * permission reference, regardless of whether the reference uses the
 * single-key or the array form. Lines are 1-based and computed against
 * the ORIGINAL (non-stripped) source so they remain meaningful to a
 * developer reading the file in their editor.
 */
function findPermissionReferences(originalSource, strippedSource) {
  const refs = [];

  // Single-key form: a fresh /g instance per scan avoids lastIndex drift
  // when the same scanner is invoked more than once (e.g. CI re-runs).
  const single = new RegExp(
    PERMISSION_REFERENCE_PATTERN.source,
    PERMISSION_REFERENCE_PATTERN.flags,
  );
  for (const m of strippedSource.matchAll(single)) {
    refs.push({
      key: m[1],
      line: lineNumberOf(originalSource, m.index),
    });
  }

  // Array form: capture the whole array literal, then iterate its keys.
  const arr = new RegExp(ARRAY_REFERENCE_PATTERN.source, ARRAY_REFERENCE_PATTERN.flags);
  for (const m of strippedSource.matchAll(arr)) {
    const inner = m[1];
    const innerStart = m.index + m[0].indexOf(inner);
    const token = new RegExp(ARRAY_KEY_TOKEN_PATTERN.source, ARRAY_KEY_TOKEN_PATTERN.flags);
    for (const k of inner.matchAll(token)) {
      refs.push({
        key: k[1],
        line: lineNumberOf(originalSource, innerStart + k.index),
      });
    }
  }

  return refs;
}

// ---- main scanner --------------------------------------------------------

/**
 * @param {object}   [opts]
 * @param {object}   [opts.permissions] - catalog map (default: PERMISSIONS
 *                                         from ./permissions.js)
 * @param {string[]} [opts.files]       - explicit file list; non-.js and
 *                                         .test.js entries are filtered out
 *                                         so the contract is "this function
 *                                         audits production source, never
 *                                         test files"
 * @param {string}   [opts.root]        - default walk root (this module's dir)
 * @param {Function} [opts.readFile]    - default node:fs readFileSync
 * @returns {{
 *   issues: Array,
 *   catalogKeyCount: number,
 *   referencedKeyCount: number,
 *   orphanCount: number,
 *   unknownUsageCount: number,
 * }}
 */
export function auditOrphanPermissions({
  permissions = PERMISSIONS,
  files,
  root = dirname(fileURLToPath(import.meta.url)),
  readFile = (p) => readFileSync(p, 'utf8'),
} = {}) {
  const allCandidates = files ?? walkJsSources(root);
  // Defensive filter: skip non-.js and .test.js even when caller passes an
  // explicit list. Test files may contain `requirePermFastify('fake.perm')`
  // and those references must NOT count as "the catalog uses this key".
  const fileList = allCandidates.filter((f) => {
    if (extname(f) !== '.js') return false;
    const base = f.split('/').pop();
    if (base.endsWith('.test.js')) return false;
    return true;
  });

  const catalogKeys = new Set(Object.keys(permissions));
  const referencedKeys = new Set();
  const issues = [];

  for (const file of fileList) {
    let text;
    try {
      text = readFile(file);
    } catch (err) {
      // Surface as an issue rather than killing the whole scan — CI logs
      // should still report any catalog drift even if one file is gone.
      issues.push({
        type: 'source-unreadable',
        file,
        message: err && err.message ? err.message : String(err),
      });
      continue;
    }
    // stripJsComments preserves source positions so line numbers stay
    // accurate. Mirrors the contract used by auditSource / auditUnusedKeys.
    const stripped = stripJsComments(text);
    for (const { key, line } of findPermissionReferences(text, stripped)) {
      referencedKeys.add(key);
      if (!catalogKeys.has(key)) {
        issues.push({
          type: 'unknown-permission-usage',
          key,
          file,
          line,
        });
      }
    }
  }

  // Catalog-side report: any key in the catalog that was never referenced.
  // We emit these AFTER the source-side scan so a single file can be the
  // source of both an unknown AND an orphan in the same report.
  let orphanCount = 0;
  for (const key of catalogKeys) {
    if (!referencedKeys.has(key)) {
      issues.push({ type: 'orphan-permission-key', key });
      orphanCount++;
    }
  }

  return {
    issues,
    catalogKeyCount: catalogKeys.size,
    referencedKeyCount: referencedKeys.size,
    orphanCount,
    unknownUsageCount: issues.filter((i) => i.type === 'unknown-permission-usage').length,
  };
}
