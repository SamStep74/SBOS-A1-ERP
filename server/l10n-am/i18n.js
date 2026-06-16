// i18n kernel: a tiny, pure, dependency-free lookup table for user-facing
// strings. Used by parseHvhh, parseAmd, validateHvhh and any future module
// that returns an error to a user.
//
// Contract:
//   - t(locale, key, vars?) returns the string for the requested locale.
//   - If the key is missing in the requested locale, falls back to
//     DEFAULT_LOCALE.
//   - If the key is missing everywhere, returns a sentinel marker (never
//     throws). The marker is obvious in logs/UI so a missing translation is
//     visible without crashing production.
//   - {{var}} placeholders in the template are replaced with vars[name].
//     Unknown placeholders are left literal so missing data is visible too.
//
// STRINGS is deeply frozen at module load so a buggy caller cannot mutate
// the catalog at runtime. LOCALES is frozen. DEFAULT_LOCALE is the second
// line of defense: even if STRINGS[requested] is missing entirely, we still
// return the right answer for known keys.

const LOCALES = Object.freeze(['hy', 'en', 'ru']);
const DEFAULT_LOCALE = 'en';

const STRINGS = Object.freeze({
  hy: Object.freeze({
    'hvhh.required': 'ՀՎՀՀ-ն պարտադիր է',
    'hvhh.notNumeric': 'ՀՎՀՀ-ն պետք է պարունակի միայն թվանշաններ',
    'hvhh.length': 'ՀՎՀՀ-ն պետք է լինի {{length}} նիշ',
    'hvhh.degenerate': 'ՀՎՀՀ-ն անվավեր է',
    'hvhh.checkDigit': 'ՀՎՀՀ-ի ստուգիչ նիշը սխալ է',
  }),
  en: Object.freeze({
    'hvhh.required': 'HVHH is required',
    'hvhh.notNumeric': 'HVHH must contain only digits',
    'hvhh.length': 'HVHH must be {{length}} digits long',
    'hvhh.degenerate': 'HVHH is invalid',
    'hvhh.checkDigit': 'HVHH check digit is wrong',
  }),
  ru: Object.freeze({
    'hvhh.required': 'ИНН обязателен',
    'hvhh.notNumeric': 'ИНН должен содержать только цифры',
    'hvhh.length': 'ИНН должен содержать {{length}} цифр',
    'hvhh.degenerate': 'ИНН недействителен',
    'hvhh.checkDigit': 'Контрольная цифра ИНН неверна',
  }),
});

// Stable, greppable sentinel for missing translations. Format lets an
// operator grep logs for `missing:en:` to find every untranslated string.
// Using DEFAULT_LOCALE in the marker (not the requested locale) so the
// "still missing in default" case is identifiable.
function missingMarker(key) {
  return `[[missing:${DEFAULT_LOCALE}:${key}]]`;
}

function interpolate(template, vars) {
  if (!vars) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => {
    return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match;
  });
}

function t(locale, key, vars) {
  const fromRequested = STRINGS[locale] && STRINGS[locale][key];
  if (fromRequested !== undefined) return interpolate(fromRequested, vars);
  const fromDefault = STRINGS[DEFAULT_LOCALE][key];
  if (fromDefault !== undefined) return interpolate(fromDefault, vars);
  return missingMarker(key);
}

export { t, LOCALES, DEFAULT_LOCALE, STRINGS, missingMarker };
