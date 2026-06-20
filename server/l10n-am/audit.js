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
import { readFile as readFileAsync, readdir as readdirAsync } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS, LOCALES } from './i18n.js';

// ---- helpers --------------------------------------------------------------

/**
 * Replace the contents of JS line and block comments
 * with spaces of the same length, so source positions (line numbers) are
 * preserved. The linter should not match `t()` calls that appear in
 * JSDoc examples or developer comments.
 */
export function stripJsComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  let inStr = null; // ' " or ` if inside a string
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
  return {
    issues: [...catalog.issues, ...source.issues, ...unused.issues],
    catalogKeyCount: catalog.keyCount,
    tCallCount: source.tCallCount,
    usedKeyCount: unused.usedKeyCount,
    unusedKeyCount: unused.unusedKeyCount,
  };
}

// ---- findHardcodedRates / findEvalLike / findStringConcatSql -------------
//
// Three new operator-visible scans. They share a common async walker over
// rootDir; each one applies a per-line regex heuristic and returns a flat
// array of {file, line, column, ...} hits. No throws on malformed input —
// unreadable files / binary content / unreadable dirs are silently skipped.
//
// The "rate-shape" heuristic in findHardcodedRates is intentionally simple:
// flag a literal >= 0.01 on any line whose trimmed text contains 'rate'
// or 'percent' (case-insensitive substring, per spec) OR any line inside
// a `RATES = { ... }` object literal (tracked across lines via brace
// depth). This is a coarse operator-visible signal, not a parser.

// Match the opening of a `RATES = { ... }` block. Case-sensitive on the
// identifier name — RATES is a coding convention here.
const RATES_OBJECT_HEAD_RE = /\b(RATES|rates)\s*=\s*\{/;

// Rate-shaped identifier anywhere on a line (spec is `/rate/i` substring).
const RATE_SHAPED_LINE_RE = /(rate|percent)/i;

// Match a numeric literal that is NOT glued to an identifier. Examples:
//   "0.20"     → match (value=0.20)
//   "rate=5"   → match (value=5)
//   "id_123"   → no match (the 123 is part of the identifier)
//   "1.5.6"    → matches "1.5" then "6" (left-to-right)
const NUMERIC_LITERAL_RE = /(?<![A-Za-z0-9_$.])(\d+(?:\.\d+)?)/g;

// `eval(` and `new Function(` are red flags; treat them symmetrically.
const EVAL_CALL_RE = /\beval\s*\(/g;
const NEW_FUNCTION_RE = /\bnew\s+Function\s*\(/g;

// SQL keywords followed on the same line by a `+` (string concat). Each
// pattern is reported under a distinct `pattern` name so the CLI can echo
// which keyword tripped.
const SQL_CONCAT_PATTERNS = [
  { name: 'select-+', re: /\bSELECT\b.*\+/i },
  { name: 'insert-+', re: /\bINSERT\b.*\+/i },
  { name: 'update-+', re: /\bUPDATE\b.*\+/i },
  { name: 'delete-+', re: /\bDELETE\b.*\+/i },
];

/**
 * Async walker that returns every `.js` file under `root`, recursing into
 * subdirectories. Skips `node_modules` and any dotfile-prefixed directory
 * (including `.git`, `.orchestration`). When `skipTest` is true, files
 * whose basename ends in `.test.js` are also dropped.
 *
 * Unreadable directories are silently skipped — the caller wants a flat
 * list of files it CAN read, not an exception that aborts the whole scan.
 */
async function walkJsFilesAsync(root, { skipTest = false } = {}) {
  const out = [];
  async function recurse(dir) {
    let entries;
    try {
      entries = await readdirAsync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — keep going
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        await recurse(p);
      } else if (e.name.endsWith('.js')) {
        if (skipTest && e.name.endsWith('.test.js')) continue;
        out.push(p);
      }
    }
  }
  await recurse(root);
  return out;
}

/**
 * Scan `rootDir` for numeric literals that look like tax rates. A "rate"
 * is any number >= 0.01 that appears in a context suggesting a rate: the
 * line contains `/rate/i` or `/percent/i`, or the line is inside a
 * `RATES = { ... }` object literal (tracked across lines).
 *
 * @param {string} rootDir - typically `server/l10n-am/`
 * @returns {Promise<Array<{file: string, line: number, column: number, value: number, context: string}>>}
 */
export async function findHardcodedRates(rootDir) {
  const files = await walkJsFilesAsync(rootDir, { skipTest: true });
  const results = [];
  for (const file of files) {
    let text;
    try {
      text = await readFileAsync(file, 'utf8');
    } catch {
      continue; // unreadable / binary — skip silently
    }
    const lines = text.split('\n');
    let inRatesBlock = false;
    let blockDepth = 0;
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const line = rawLine.trim();

      // Block entry: `const RATES = {` (or `rates`).
      if (!inRatesBlock && RATES_OBJECT_HEAD_RE.test(line)) {
        inRatesBlock = true;
        blockDepth = 0;
      }
      // Track brace depth on every line we are inside the block.
      if (inRatesBlock) {
        blockDepth += (line.match(/\{/g) || []).length;
        blockDepth -= (line.match(/\}/g) || []).length;
      }

      const inRateContext = inRatesBlock || RATE_SHAPED_LINE_RE.test(line);
      if (!inRateContext) {
        // If we just closed the block on this line, drop the flag.
        if (inRatesBlock && blockDepth <= 0) {
          inRatesBlock = false;
          blockDepth = 0;
        }
        continue;
      }

      // Scan for numeric literals >= 0.01.
      NUMERIC_LITERAL_RE.lastIndex = 0;
      let m;
      while ((m = NUMERIC_LITERAL_RE.exec(line)) !== null) {
        const v = Number(m[1]);
        if (Number.isFinite(v) && v >= 0.01) {
          results.push({
            file,
            line: i + 1,
            column: m.index + 1,
            value: v,
            context: rawLine.trim(),
          });
        }
      }

      if (inRatesBlock && blockDepth <= 0) {
        inRatesBlock = false;
        blockDepth = 0;
      }
    }
  }
  return results;
}

/**
 * Scan `rootDir` for `eval(` and `new Function(` call sites. Both are
 * code-injection red flags; this is an operator-visible warning, not a
 * parser-accurate lint. Per spec, test files are NOT excluded for this
 * scan — `eval(` in a test still means somebody wrote `eval(`, which is
 * information the operator should see.
 *
 * @param {string} rootDir
 * @returns {Promise<Array<{file: string, line: number, column: number, kind: 'eval-call'|'new-function'}>>}
 */
export async function findEvalLike(rootDir) {
  const files = await walkJsFilesAsync(rootDir, { skipTest: false });
  const results = [];
  for (const file of files) {
    let text;
    try {
      text = await readFileAsync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      EVAL_CALL_RE.lastIndex = 0;
      NEW_FUNCTION_RE.lastIndex = 0;
      let m;
      while ((m = EVAL_CALL_RE.exec(line)) !== null) {
        results.push({
          file,
          line: i + 1,
          column: m.index + 1,
          kind: 'eval-call',
        });
      }
      while ((m = NEW_FUNCTION_RE.exec(line)) !== null) {
        results.push({
          file,
          line: i + 1,
          column: m.index + 1,
          kind: 'new-function',
        });
      }
    }
  }
  return results;
}

/**
 * Scan `rootDir` for SQL string-concat patterns on a single line:
 * `SELECT ... +`, `INSERT ... +`, `UPDATE ... +`, `DELETE ... +`
 * (case-insensitive). Test files are excluded — they legitimately contain
 * fake SQL strings as fixtures.
 *
 * @param {string} rootDir
 * @returns {Promise<Array<{file: string, line: number, column: number, pattern: string}>>}
 */
export async function findStringConcatSql(rootDir) {
  const files = await walkJsFilesAsync(rootDir, { skipTest: true });
  const results = [];
  for (const file of files) {
    let text;
    try {
      text = await readFileAsync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { name, re } of SQL_CONCAT_PATTERNS) {
        const m = re.exec(line);
        if (m) {
          results.push({
            file,
            line: i + 1,
            column: m.index + 1,
            pattern: name,
          });
        }
      }
    }
  }
  return results;
}
