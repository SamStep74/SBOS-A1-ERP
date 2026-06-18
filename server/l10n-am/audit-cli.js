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

import { pathToFileURL } from 'node:url';
import { auditAll } from './audit.js';

// ---- parseArgs ------------------------------------------------------------

/**
 * @param {string[]} [argv] - defaults to process.argv.slice(2)
 * @returns {{
 *   root: (string|undefined),
 *   format: ('text'|'json'),
 *   quiet: boolean,
 *   help: boolean,
 *   errors: string[],
 * }}
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    root: undefined,
    format: 'text',
    quiet: false,
    help: false,
    errors: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') {
      const v = argv[++i];
      if (!v) { out.errors.push('--root needs a value'); continue; }
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
  out('');
  out('Options:');
  out('  --root <dir>     Walk this directory for source files (default: this module\'s dir)');
  out('  --format <fmt>   Output format: text (default) or json');
  out('  --quiet, -q      Suppress all output; exit code only');
  out('  --help, -h       Print this usage message');
  out('');
  out('Exit codes: 0 = clean, 1 = issues found or invalid arguments');
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
  // rbac sub-scanner section: same pattern, different registry. The
  // permission-registry drift can show up even when the i18n side is
  // clean, so render it as a distinct block rather than folding into
  // the i18n counts above.
  if (typeof result.rbacCatalogKeyCount === 'number') {
    out('');
    out(`rbac permissions audit`);
    out(`  catalog keys: ${result.rbacCatalogKeyCount}`);
    if (typeof result.rbacReferencedKeyCount === 'number') {
      out(`  referenced:   ${result.rbacReferencedKeyCount}`);
    }
    if (typeof result.rbacOrphanCount === 'number') {
      out(`  orphan keys:  ${result.rbacOrphanCount}`);
    }
    if (typeof result.rbacUnknownUsageCount === 'number') {
      out(`  unknown uses: ${result.rbacUnknownUsageCount}`);
    }
  }
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

// ---- main -----------------------------------------------------------------

function main() {
  const args = parseArgs();
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
