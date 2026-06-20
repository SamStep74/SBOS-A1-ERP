// l10n-am audit CLI.
//
// Thin command-line wrapper around audit.js. Two pure functions (parseArgs,
// runAudit) make the CLI testable without spawning a child process. A small
// main() at the bottom wires them to process.argv / console / process.exit
// when this file is invoked directly.
//
// Usage:
//   node audit-cli.js [--root <dir>] [--format json|text] [--quiet] [--help]
//
// Exit codes:
//   0 — clean scan (no issues)
//   1 — issues found, or invalid arguments

import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname as pathDirname, join as pathJoin } from 'node:path';
import { auditAll, findHardcodedRates, findEvalLike, findStringConcatSql } from './audit.js';

// ---- parseArgs ------------------------------------------------------------

/**
 * @param {string[]} [argv] - defaults to process.argv.slice(2)
 * @returns {{
 *   root: (string|undefined),
 *   format: ('text'|'json'),
 *   quiet: boolean,
 *   help: boolean,
 *   checkRates: boolean,
 *   checkEval: boolean,
 *   checkSql: boolean,
 *   errors: string[],
 * }}
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    root: undefined,
    format: 'text',
    quiet: false,
    help: false,
    checkRates: false,
    checkEval: false,
    checkSql: false,
    errors: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') {
      const v = argv[++i];
      if (!v) {
        out.errors.push('--root needs a value');
        continue;
      }
      out.root = v;
    } else if (arg === '--format') {
      const v = argv[++i];
      if (v !== 'text' && v !== 'json') {
        out.errors.push(`--format must be 'text' or 'json' (got ${JSON.stringify(v)})`);
        continue;
      }
      out.format = v;
    } else if (arg === '--quiet' || arg === '-q') {
      out.quiet = true;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--check-rates') {
      out.checkRates = true;
    } else if (arg === '--check-eval') {
      out.checkEval = true;
    } else if (arg === '--check-sql') {
      out.checkSql = true;
    } else {
      out.errors.push(`unknown flag: ${arg}`);
    }
  }
  return out;
}

// ---- runAudit -------------------------------------------------------------
//
// Takes already-parsed args + a scan function (so tests can inject a stub).
// Calls scan({ root }), formats the result, and returns { exitCode, result }.
// stdout / stderr are injected for the same reason — the test captures them.

/**
 * @param {object}  ctx
 * @param {object}  ctx.args    - return of parseArgs()
 * @param {Function} ctx.scan   - callable, defaults to auditAll
 * @param {Function} ctx.stdout - defaults to console.log
 * @param {Function} ctx.stderr - defaults to console.error
 * @returns {{ exitCode: number, result?: object }}
 */
export function runAudit({
  args,
  scan = auditAll,
  stdout = console.log.bind(console),
  stderr = console.error.bind(console),
} = {}) {
  // 1. Help: print usage, do not run the scanner, exit 0
  if (args.help) {
    if (!args.quiet) printUsage(stdout);
    return { exitCode: 0 };
  }
  // 2. Argument errors: print them, do not run the scanner, exit 1
  if (args.errors.length > 0) {
    if (!args.quiet) {
      for (const e of args.errors) stderr(`error: ${e}`);
      printUsage(stderr);
    }
    return { exitCode: 1 };
  }
  // 3. Run the scan
  const result = scan(args.root ? { root: args.root } : {});
  // 4. Format output
  if (!args.quiet) {
    if (args.format === 'json') {
      stdout(JSON.stringify(result, null, 2));
    } else {
      printTextReport(result, stdout);
    }
  }
  return { exitCode: result.issues && result.issues.length > 0 ? 1 : 0, result };
}

// ---- formatters -----------------------------------------------------------

function printUsage(out) {
  out('Usage: node audit-cli.js [--root <dir>] [--format text|json] [--quiet] [--help]');
  out('                [--check-rates] [--check-eval] [--check-sql]');
  out('');
  out('Options:');
  out("  --root <dir>     Walk this directory for source files (default: this module's dir)");
  out('  --format <fmt>   Output format: text (default) or json');
  out('  --quiet, -q      Suppress all output; exit code only');
  out('  --help, -h       Print this usage message');
  out('  --check-rates    Scan for hardcoded tax-rate literals (server/l10n-am/ by default)');
  out('  --check-eval     Scan for eval() and new Function() call sites (server/ by default)');
  out('  --check-sql      Scan for SQL string-concat patterns (server/ by default)');
  out('');
  out('Exit codes: 0 = clean, 1 = issues found or invalid arguments');
  out('             When all three --check-* flags are set, exit 1 if ANY finds matches.');
}

function printTextReport(result, out) {
  const issues = result.issues || [];
  out(`l10n-am audit`);
  if (typeof result.catalogKeyCount === 'number') {
    out(`  catalog keys: ${result.catalogKeyCount}`);
  }
  if (typeof result.tCallCount === 'number') {
    out(`  t() calls:    ${result.tCallCount}`);
  }
  if (typeof result.usedKeyCount === 'number') {
    out(`  used keys:    ${result.usedKeyCount}`);
  }
  if (typeof result.unusedKeyCount === 'number') {
    out(`  unused keys:  ${result.unusedKeyCount}`);
  }
  out(`  issues:       ${issues.length}`);
  if (issues.length === 0) {
    out('');
    out('OK — no issues.');
  } else {
    out('');
    for (const i of issues) {
      const loc = i.file ? ` (${i.file}${i.line ? `:${i.line}` : ''})` : '';
      const extra = i.missingLocales ? ` [missing: ${i.missingLocales.join(', ')}]` : '';
      out(`  ${i.type}: ${i.key}${loc}${extra}`);
    }
  }
}

// ---- runExtraChecks -------------------------------------------------------
//
// Async handler for the three new --check-* flags. Each flag independently
// invokes its scanner; when more than one is set, all run and results are
// merged into a single report.
//
// Exit code rule: exit 1 if ANY active check finds a match. When all
// three flags are present, the run is "strict" — the same rule applies,
// just to the union of all three checks.
//
// Output shape:
//   - text (default): one `file:line:col: ...` line per match
//   - json:          { rates: [...], eval: [...], sql: [...], ok: bool }
//   - quiet:         no per-match output; exit code is preserved

/**
 * @param {object} ctx
 * @param {object} ctx.args     - return of parseArgs()
 * @param {string} [ctx.rootDir] - override root for every active check;
 *                                  otherwise each check falls back to its
 *                                  own conventional default (server/l10n-am
 *                                  for rates, server/ for eval/sql).
 * @param {Function} [ctx.stdout] - defaults to console.log
 * @returns {Promise<{
 *   exitCode: number,
 *   rates: Array,
 *   eval: Array,
 *   sql: Array,
 * }>}
 */
export async function runExtraChecks({ args, rootDir, stdout = console.log.bind(console) } = {}) {
  // If `args.root` was supplied AND the caller didn't pass an explicit
  // rootDir, prefer args.root. Otherwise use the per-check default.
  const resolvedRoot = rootDir ?? args.root;

  // Always run all three scanners so the JSON output shape is stable
  // (`{rates, eval, sql, ok}`). When a flag is OFF we still call the
  // scanner; we just don't fail the exit code on its results. This keeps
  // the consumer's payload shape constant regardless of which flags
  // were passed.
  const [rates, evalHits, sqlHits] = await Promise.all([
    findHardcodedRates(resolvedRoot ?? defaultRootFor('rates')),
    findEvalLike(resolvedRoot ?? defaultRootFor('eval')),
    findStringConcatSql(resolvedRoot ?? defaultRootFor('sql')),
  ]);

  // Exit code is driven ONLY by the flags that were actually requested.
  // An unrequested scanner returning hits should not flip the exit code
  // (operator asked for one check, they get one signal).
  const activeHits = [
    args.checkRates ? rates : [],
    args.checkEval ? evalHits : [],
    args.checkSql ? sqlHits : [],
  ].flat();
  const exitCode = activeHits.length > 0 ? 1 : 0;
  const ok = rates.length === 0 && evalHits.length === 0 && sqlHits.length === 0;

  if (!args.quiet) {
    if (args.format === 'json') {
      stdout(JSON.stringify({ rates, eval: evalHits, sql: sqlHits, ok }, null, 2));
    } else {
      // Text output — only print the checks that were explicitly asked for.
      if (args.checkRates) {
        for (const r of rates) {
          stdout(`${r.file}:${r.line}:${r.column}: ${r.value}  ${r.context}`);
        }
      }
      if (args.checkEval) {
        for (const r of evalHits) {
          stdout(`${r.file}:${r.line}:${r.column}: ${r.kind}`);
        }
      }
      if (args.checkSql) {
        for (const r of sqlHits) {
          stdout(`${r.file}:${r.line}:${r.column}: ${r.pattern}`);
        }
      }
    }
  }

  return { exitCode, rates, eval: evalHits, sql: sqlHits };
}

// ---- main -----------------------------------------------------------------

// Resolve a default rootDir for the new check families when --root is
// not supplied. Each check has its own convention:
//   - --check-rates: server/l10n-am/ (the module that defines the rates)
//   - --check-eval / --check-sql: server/ (whole backend subtree)
function defaultRootFor(flag) {
  const moduleDir = pathDirname(fileURLToPath(import.meta.url));
  if (flag === 'rates') return moduleDir; // server/l10n-am/
  return pathJoin(moduleDir, '..'); // server/
}

async function main() {
  const args = parseArgs();
  // If any of the new --check-* flags is set, route to the async handler.
  // The legacy `runAudit` is unchanged and still owns --root / --format
  // / --quiet / --help in their original meaning.
  if (args.checkRates || args.checkEval || args.checkSql) {
    // Argument errors still flow through the same parseArgs branch; the
    // legacy handler would have already captured them. Reuse that gate.
    if (args.errors.length > 0) {
      const stderr = console.error.bind(console);
      if (!args.quiet) {
        for (const e of args.errors) stderr(`error: ${e}`);
        printUsage(stderr);
      }
      process.exit(1);
    }
    if (args.help) {
      if (!args.quiet) printUsage(console.log.bind(console));
      process.exit(0);
    }
    const { exitCode } = await runExtraChecks({
      args,
      rootDir: args.root,
      stdout: console.log.bind(console),
    });
    process.exit(exitCode);
  }
  const { exitCode } = runAudit({ args });
  process.exit(exitCode);
}

// Standard ESM "is this the entry point?" check. When `node audit-cli.js`
// is run, process.argv[1] is this file's path, so the comparison is true.
// When the file is imported (e.g. from a test), this is false and main()
// is not invoked — the test instead calls parseArgs/runAudit directly.
const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) main();
