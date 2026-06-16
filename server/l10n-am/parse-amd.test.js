import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAmd, formatAmd } from './localization.js';
import { t, missingMarker } from './i18n.js';

// parseAmd is the STRICT boundary parser. Unlike roundAmd (lenient, returns 0 for
// anything un-parseable — which silently corrupts "1,000" → 0), parseAmd returns
// { ok, amount, error } and is locale-tolerant: it accepts grouped/spaced input and
// round-trips formatAmd output, but fails loud on genuinely non-numeric input.

test('parseAmd: a finite number is accepted and rounded to whole dram', () => {
  assert.deepEqual(parseAmd(1000), { ok: true, amount: 1000 });
  assert.deepEqual(parseAmd(999.99), { ok: true, amount: 1000 });
});

test('parseAmd: a clean numeric string is accepted', () => {
  assert.deepEqual(parseAmd('100000'), { ok: true, amount: 100000 });
});

test('parseAmd: a grouped string (the silent-corruption case) is parsed correctly', () => {
  // roundAmd("1,000") returns 0 — a data-corruption trap. parseAmd parses it.
  assert.deepEqual(parseAmd('1,000'), { ok: true, amount: 1000 });
  assert.deepEqual(parseAmd('1 000'), { ok: true, amount: 1000 });
  assert.deepEqual(parseAmd('2,500,000'), { ok: true, amount: 2500000 });
});

test('parseAmd: formatAmd output round-trips back through parseAmd', () => {
  const formatted = formatAmd(1500); // "1,500 ֏"
  assert.deepEqual(parseAmd(formatted), { ok: true, amount: 1500 });
});

test('parseAmd: a negative amount is accepted (credit notes / reversals)', () => {
  assert.deepEqual(parseAmd(-2000), { ok: true, amount: -2000 });
  assert.deepEqual(parseAmd('-2,000'), { ok: true, amount: -2000 });
});

test('parseAmd: genuinely non-numeric input fails loud (not a silent 0)', () => {
  const r = parseAmd('abc');
  assert.equal(r.ok, false);
  assert.equal(r.amount, 0);
  assert.equal(typeof r.error, 'string');
  assert.ok(r.error.length > 0);
});

test('parseAmd: empty/blank/missing input is a required-error, not 0', () => {
  for (const v of ['', '   ', null, undefined]) {
    const r = parseAmd(v);
    assert.equal(r.ok, false, `expected ${JSON.stringify(v)} to fail`);
    assert.ok(r.error.length > 0);
  }
});

test('parseAmd: NaN / Infinity numbers fail loud', () => {
  assert.equal(parseAmd(NaN).ok, false);
  assert.equal(parseAmd(Infinity).ok, false);
  assert.equal(parseAmd(-Infinity).ok, false);
});

test('parseAmd: a malformed numeric-looking string fails (no partial parse)', () => {
  assert.equal(parseAmd('12.3.4').ok, false);
  assert.equal(parseAmd('1,00x').ok, false);
  assert.equal(parseAmd('--5').ok, false);
});

// --- i18n wiring: locale override routes through t() ---
//
// parseAmd's existing hardcoded strings are English, so the default locale is
// 'en' to keep the existing call sites and tests green. locale=ru/hy must
// route through the kernel.

test('parseAmd: locale=ru returns Russian errors via t()', () => {
  const ruRequired = t('ru', 'amd.required');
  const ruNotFinite = t('ru', 'amd.notFinite');
  const ruNotNumber = t('ru', 'amd.notNumber', { raw: 'abc' });
  // Sanity: kernel has the keys (catches translator regressions).
  for (const [name, value] of Object.entries({ ruRequired, ruNotFinite, ruNotNumber })) {
    assert.notEqual(value, missingMarker(name), `kernel must have ru translation: ${name}`);
  }
  assert.equal(parseAmd('', { locale: 'ru' }).error, ruRequired);
  assert.equal(parseAmd(NaN, { locale: 'ru' }).error, ruNotFinite);
  assert.equal(parseAmd('abc', { locale: 'ru' }).error, ruNotNumber);
});

test('parseAmd: locale=hy returns Armenian errors via t()', () => {
  const hyRequired = t('hy', 'amd.required');
  assert.notEqual(
    hyRequired,
    missingMarker('amd.required'),
    'kernel must have hy translation for amd.required',
  );
  assert.equal(parseAmd('', { locale: 'hy' }).error, hyRequired);
  assert.equal(parseAmd(NaN, { locale: 'hy' }).error, t('hy', 'amd.notFinite'));
  // {{raw}} interpolation: the user's input is echoed into the localized message.
  assert.equal(parseAmd('xyz', { locale: 'hy' }).error, t('hy', 'amd.notNumber', { raw: 'xyz' }));
});

test('parseAmd: default locale is en (backward compat with English errors)', () => {
  // No locale arg → English, matching the hardcoded strings every existing
  // call site and test depends on.
  assert.equal(parseAmd('').error, t('en', 'amd.required'));
  assert.equal(parseAmd(NaN).error, t('en', 'amd.notFinite'));
  assert.equal(parseAmd('abc').error, t('en', 'amd.notNumber', { raw: 'abc' }));
});

// --- security: raw user input is sanitized before being echoed into the error ---
//
// `raw` echoes user input back into a localized error that lands in logs/UI
// sinks. Unfiltered, an attacker (or a buggy upstream) could inject control
// characters (log forging, terminal escape codes) or unbounded length (log
// spam / DoS on sinks). parseAmd MUST strip ASCII control chars and cap the
// length to a small fixed budget before interpolation. The contract: the
// echoed substring is plain printable text and fits in 200 chars.

test('parseAmd: control characters in raw are stripped from the error', () => {
  // \n and \r are the canonical log-injection vectors. \x1b is the ANSI ESC
  // that turns a terminal log into a slot machine. \x00 is a NUL byte. All
  // must be removed; the printable parts survive intact.
  const evil = 'abc\nline2\rline3\x1b[31mred\x1b[0m\x00end';
  const err = parseAmd(evil, { locale: 'en' }).error;
  assert.equal(err.includes('\n'), false, 'newline leaked into error');
  assert.equal(err.includes('\r'), false, 'carriage return leaked into error');
  assert.equal(err.includes('\x1b'), false, 'ANSI ESC leaked into error');
  assert.equal(err.includes('\x00'), false, 'NUL byte leaked into error');
  // Printable fragments must remain so the message still tells the user what they sent.
  assert.ok(err.includes('abc'), 'expected the printable prefix to survive');
  assert.ok(err.includes('end'), 'expected the printable suffix to survive');
  // Equivalent to the kernel's interpolation applied to the sanitized raw.
  const safe = evil.replace(/[\x00-\x1f\x7f]/g, '');
  assert.equal(err, t('en', 'amd.notNumber', { raw: safe }));
});

test('parseAmd: raw is capped at 200 characters in the error', () => {
  // A 5,000-char string of 'a' would otherwise be echoed verbatim, inflating
  // log lines and downstream error renderers. Cap at 200.
  const huge = 'a'.repeat(5000);
  const err = parseAmd(huge, { locale: 'en' }).error;
  // Anchor to the template's "number: " prefix so we measure the echoed run,
  // not the lone 'a' in "valid" (the first `/a+/` match is always that one).
  const match = err.match(/number: (a+)/);
  assert.ok(match, 'expected the echoed run of a to follow the "number: " prefix');
  assert.equal(
    match[1].length,
    200,
    `expected the echoed run to be capped at 200 chars, got ${match[1].length}`,
  );
  // Total error length must also stay bounded (template + 200 chars).
  const safe = 'a'.repeat(200);
  assert.equal(err, t('en', 'amd.notNumber', { raw: safe }));
});
