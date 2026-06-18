// l10n-am i18n audit scanner.
//
// Two regression nets:
//   1. auditCatalog — every key in the catalog must exist in every locale
//      (catches: developer added a key to hy but forgot en/ru).
//   2. auditSource  — every t(locale, 'key', ...) call must reference a
//      known key (catches: developer hardcoded a string instead of routing
//      through t(); developer typo'd a key; developer removed a key but
//      left a dangling call site).
//
// Both scanners are pure: no console, no throws, no side effects. They
// return { issues, count } so a CLI/CI/pre-commit layer decides what to
// do with the report.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS, LOCALES } from './i18n.js';
import { auditOrphanPermissions } from '../rbac/permissions-audit.js';

// ---- helpers --------------------------------------------------------------

/**
 * Replace the contents of JS line (//...) and block (/* ... *​/) comments
 * with spaces of the same length, so source positions (line numbers) are
 * preserved. The linter should not match `t()` calls that appear in
 * JSDoc examples or developer comments.
 */
// Characters that mark a "regex-start" position in JS: the `/` that follows
// any of these (or sits at the start of the file) is the opening delimiter of
// a regex literal, not division and not a comment. Includes operators that
// end a statement or open an expression, plus `)`, `]`, and identifier/number
// ends — anything after which a primary expression like `/foo/g` is legal.
// (A full JS-spec disambiguator would need a tokenizer; this heuristic is
// good enough for the audit scanner's source shapes.)
const REGEX_START_CHARS = new Set([
  '=', '(', '[', ',', ';', ':', '!', '&', '|', '?', '{', '}', '+', '-', '*',
  '%', '^', '~', '<', '>', ')', ']', '\n',
]);

function isRegexStartContext(source, pos) {
  // pos is the index of the candidate `/`. Walk backwards past whitespace
  // (not newlines — a newline is itself a regex-start signal) to find the
  // previous significant char.
  let j = pos - 1;
  while (j >= 0 && (source[j] === ' ' || source[j] === '\t')) j--;
  if (j < 0) return true; // start of file
  const prev = source[j];
  return REGEX_START_CHARS.has(prev);
}

export function stripJsComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  let inStr = null;          // ' " or ` if inside a string
  let inRegex = false;      // true if inside a /.../ regex literal
  let inCharClass = false;   // true if inside a [... ] char class in a regex
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    if (inStr) {
      // Inside a string literal — only the closing delimiter ends it.
      // Escape sequences are passed through.
      out += c;
      if (c === '\\' && i + 1 < n) {
        out += next;
        i += 2;
        continue;
      }
      if (c === inStr) inStr = null;
      i++;
      continue;
    }

    if (inRegex) {
      // Inside a regex literal. Pass through verbatim — the `'` and `"`
      // inside a regex's character class (e.g. /['"]/) are NOT string
      // delimiters. Only the closing `/` (unescaped, outside [...]) ends
      // the regex, followed by zero or more flags [a-z].
      out += c;
      if (c === '\\' && i + 1 < n) {
        out += next;
        i += 2;
        continue;
      }
      if (inCharClass) {
        if (c === ']') inCharClass = false;
        i++;
        continue;
      }
      if (c === '[') {
        inCharClass = true;
        i++;
        continue;
      }
      if (c === '/') {
        inRegex = false;
        i++;
        // Swallow regex flags: g, i, m, s, u, y, d.
        while (i < n && /[a-z]/.test(source[i])) {
          out += source[i];
          i++;
        }
        continue;
      }
      i++;
      continue;
    }

    if (c === "'" || c === '"' || c === '`') {
      inStr = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      // Line comment to end of line
      while (i < n && source[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      // Block comment to closing */
      out += '  ';
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (c === '/' && isRegexStartContext(source, i)) {
      inRegex = true;
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Union of every key present in any locale. */
function unionAllKeys(strings, locales) {
  const all = new Set();
  for (const loc of locales) {
    const table = strings[loc];
    if (!table || typeof table !== 'object') continue;
    for (const k of Object.keys(table)) all.add(k);
  }
  return all;
}

/** Recursive walk that returns every .js file (excluding .test.js). */
export function walkJsSources(root) {
  const out = [];
  function recurse(dir) {
    for (const name of readdirSync(dir)) {
      // Skip noise directories and dotfiles (including .git, .orchestration)
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) {
        recurse(p);
      } else if (extname(p) === '.js' && !name.endsWith('.test.js')) {
        out.push(p);
      }
    }
  }
  recurse(root);
  return out;
}

/**
 * Find every t(locale, 'key', ...) call in a source string.
 * Returns [{ key, line }] with 1-based line numbers.
 *
 * Regex strategy: match the call shape, capture the key.
 * The locale arg can be either a string literal ('hy'|'en'|'ru') or a
 * JavaScript identifier (a variable like `locale`). The key arg is
 * always a string literal.
 */
export function findTCalls(source) {
  const out = [];
  // Group 1: the key string literal's quote (reused to match the close)
  // Group 2: the key text
  // Locale arg: (?:['"]hy|en|ru['"]|[A-Za-z_$][A-Za-z0-9_$]*)
  const re = /\bt\(\s*(?:(['"])(?:hy|en|ru)\1|[A-Za-z_$][A-Za-z0-9_$]*)\s*,\s*(['"])([^'"]+)\2/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const key = m[3];
    // 1-based line number for the call
    const upTo = source.slice(0, m.index);
    const line = upTo.split('\n').length;
    out.push({ key, line });
  }
  return out;
}

// ---- auditCatalog ---------------------------------------------------------

/**
 * @param {object}  [opts]
 * @param {object}  [opts.strings] - catalog map, default STRINGS from i18n.js
 * @param {string[]} [opts.locales] - locale codes, default LOCALES
 * @returns {{ issues: Array, keyCount: number }}
 */
export function auditCatalog({ strings = STRINGS, locales = LOCALES } = {}) {
  const allKeys = unionAllKeys(strings, locales);
  const issues = [];
  for (const key of allKeys) {
    const missing = [];
    for (const loc of locales) {
      const table = strings[loc];
      if (!table || typeof table !== 'object' || !(key in table)) {
        missing.push(loc);
      }
    }
    if (missing.length > 0) {
      issues.push({
        type: 'catalog-missing-locale',
        key,
        missingLocales: missing,
      });
    }
  }
  return { issues, keyCount: allKeys.size };
}

// ---- auditSource ----------------------------------------------------------

/**
 * @param {object}    [opts]
 * @param {object}    [opts.strings] - catalog map, default STRINGS
 * @param {string[]}  [opts.locales] - locale codes, default LOCALES
 * @param {string[]}  [opts.files]   - explicit file list; skipped if not .js
 *                                      or if basename ends in .test.js
 * @param {string}    [opts.root]    - default walk root (this module's dir)
 * @param {Function}  [opts.readFile] - default node:fs readFileSync
 * @returns {{ issues: Array, tCallCount: number }}
 */
export function auditSource({
  strings = STRINGS,
  locales = LOCALES,
  files,
  root = dirname(fileURLToPath(import.meta.url)),
  readFile = (p) => readFileSync(p, 'utf8'),
} = {}) {
  const allCandidates = files ?? walkJsSources(root);
  // Defensive filter — even when the caller passes files, exclude tests
  // and non-js so the contract is "this function audits source, not tests".
  const fileList = allCandidates.filter((f) => {
    if (extname(f) !== '.js') return false;
    const base = f.split('/').pop();
    if (base.endsWith('.test.js')) return false;
    return true;
  });
  const allKeys = unionAllKeys(strings, locales);
  const issues = [];
  let tCallCount = 0;
  for (const file of fileList) {
    // Defensive: if readFile throws on a file, surface it as an issue
    // rather than killing the whole scan.
    let text;
    try {
      text = readFile(file);
    } catch (err) {
      issues.push({
        type: 'source-unreadable',
        file,
        message: err && err.message ? err.message : String(err),
      });
      continue;
    }
    for (const { key, line } of findTCalls(stripJsComments(text))) {
      tCallCount++;
      if (!allKeys.has(key)) {
        issues.push({
          type: 'source-uses-missing-key',
          key,
          file,
          line,
        });
      }
    }
  }
  return { issues, tCallCount };
}

// ---- auditUnusedKeys ------------------------------------------------------
//
// Reverse direction: every key in the catalog must be referenced by at least
// one t() call site. A key that is defined in every locale but never read
// is "dead" — translation effort was spent but no consumer uses it.
//
// Walks the same source tree as auditSource (with the same .js / !.test.js
// defensive filter) and collects the DISTINCT set of keys referenced by
// t() calls. A key is "used" if any call site mentions it; duplicate
// references do not matter.

/**
 * @param {object}    [opts]
 * @param {object}    [opts.strings] - catalog map, default STRINGS
 * @param {string[]}  [opts.locales] - locale codes, default LOCALES
 * @param {string[]}  [opts.files]   - explicit file list; skipped if not .js
 *                                      or if basename ends in .test.js
 * @param {string}    [opts.root]    - default walk root (this module's dir)
 * @param {Function}  [opts.readFile] - default node:fs readFileSync
 * @returns {{
 *   issues: Array,
 *   catalogKeyCount: number,
 *   usedKeyCount: number,
 *   unusedKeyCount: number,
 * }}
 */
export function auditUnusedKeys({
  strings = STRINGS,
  locales = LOCALES,
  files,
  root = dirname(fileURLToPath(import.meta.url)),
  readFile = (p) => readFileSync(p, 'utf8'),
} = {}) {
  const allCandidates = files ?? walkJsSources(root);
  // Same defensive filter as auditSource: this function audits production
  // source, never test files. A test.js that mentions a key does not
  // count as "consumer code uses this key".
  const fileList = allCandidates.filter((f) => {
    if (extname(f) !== '.js') return false;
    const base = f.split('/').pop();
    if (base.endsWith('.test.js')) return false;
    return true;
  });
  const usedKeys = new Set();
  const unreadableFiles = [];
  for (const file of fileList) {
    let text;
    try {
      text = readFile(file);
    } catch (err) {
      unreadableFiles.push({ file, err });
      continue;
    }
    for (const { key } of findTCalls(stripJsComments(text))) {
      usedKeys.add(key);
    }
  }
  const allKeys = unionAllKeys(strings, locales);
  const issues = [];
  for (const key of allKeys) {
    if (!usedKeys.has(key)) {
      issues.push({ type: 'catalog-unused-key', key });
    }
  }
  return {
    issues,
    catalogKeyCount: allKeys.size,
    usedKeyCount: usedKeys.size,
    unusedKeyCount: issues.length,
    // Surface unreadable files too so a CI run doesn't silently report
    // a clean unused-key check when half the source was unreadable.
    unreadableFiles,
  };
}

// ---- auditAll -------------------------------------------------------------

/** Convenience: run all three scans and return the combined report. */
export function auditAll(opts = {}) {
  const catalog = auditCatalog(opts);
  const source = auditSource(opts);
  const unused = auditUnusedKeys(opts);
  // rbac/permissions-audit mirrors the i18n shape: catalog-side
  // orphan-permission-key + source-side unknown-permission-usage. The
  // scanner is pure and DI-shaped, so we pass the same opts through.
  const rbac = auditOrphanPermissions(opts);
  return {
    issues: [...catalog.issues, ...source.issues, ...unused.issues, ...rbac.issues],
    catalogKeyCount: catalog.keyCount,
    tCallCount: source.tCallCount,
    usedKeyCount: unused.usedKeyCount,
    unusedKeyCount: unused.unusedKeyCount,
    // Rbac sub-scanner counts surfaced under their own names so the CLI
    // text/JSON output can render them as a distinct section without
    // colliding with the i18n fields.
    rbacCatalogKeyCount: rbac.catalogKeyCount,
    rbacReferencedKeyCount: rbac.referencedKeyCount,
    rbacOrphanCount: rbac.orphanCount,
    rbacUnknownUsageCount: rbac.unknownUsageCount,
  };
}
