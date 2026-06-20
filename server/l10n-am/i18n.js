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
    'hvhh.degenerate': 'ՀՎՀհ-ն անվավեր է',
    'hvhh.checkDigit': 'ՀՎՀՀ-ի ստուգիչ նիշը սխալ է',
    'amd.required': 'Գումարը պարտադիր է',
    'amd.notFinite': 'Գումարը պետք է լինի վերջավոր թիվ',
    'amd.notNumber': 'Գումարը վավեր թիվ չէ՝ {{raw}}',
    'vat.form.missingLine': "ԱԱՀ-ի հաշվարկում բացակայում է պարտադիր '{{id}}' տողը։",
    'vat.form.nonNumericAmount': '{{id}} տողի {{field}} դաշտը պետք է լինի թիվ։',
    'vat.form.nonIntegerAmount': '{{id}} տողի {{field}} դաշտը պետք է լինի ամբողջ դրամ։',
    'vat.form.negativeAmount': '{{id}} տողի {{field}} դաշտը չպետք է լինի բացասական։',
    'vat.form.line16BaseMismatch':
      '16-րդ տողի հիմքը ({{actual}}) պետք է հավասար լինի 7+9+12+13 տողերի հիմքերի գումարին ({{expected}})։',
    'vat.form.line16VatMismatch':
      '16-րդ տողի ԱԱՀ-ն ({{actual}}) պետք է հավասար լինի 7+9 տողերի ԱԱՀ-ների գումարին ({{expected}})։',
    'vat.form.line21VatMismatch':
      '21-րդ տողի ԱԱՀ-ն ({{actual}}) պետք է հավասար լինի 17+18 տողերի ԱԱՀ-ների գումարին ({{expected}})։',
    'vat.form.line23NetMismatch':
      '23-րդ տողը պետք է լինի վճարման ենթակա={{payable}}, հաշվելի={{recoverable}} (= տող 16 ԱԱՀ − տող 21 ԱԱՀ)։',
    'vat.form.rateMismatch':
      '{{id}} տողի ԱԱՀ-ն ({{actual}}) անհավանական է {{base}} հիմքի համար {{rate}}% դրույքաչափով (�պասվում է ≈{{expected}} ± {{tolerance}})։',
    'einv.validate.missingTransactionType':
      'Գործարքի տեսակը պարտադիր է ՍՀԿ էլեկտրոնային հաշիվ-ապրանքագրերի համար 2025-03-01-ից։',
    'einv.validate.missingNumber': 'Հաշիվ-ապրանքագրի համարը/սերիան պարտադիր է։',
    'einv.validate.missingIssueDate': 'Հաշվարկման ամսաթիվը պարտադիր է։',
    'einv.validate.invalidIssueDate': 'Հաշվարկման ամսաթիվը պետք է լինի ISO ձևաչափով (ՏՏՏՏ-ԱԱ-ՕՕ)։',
    'einv.validate.missingSupplierName': 'Մատակարարի անվանումը պարտադիր է։',
    'einv.validate.missingSupplierHvhh':
      'Մատակարարի ՀՎՀՀ-ն (հարկ վճարողի հաշվառման համարը) պարտադիր է։',
    'einv.validate.invalidSupplierHvhh': 'Մատակարարի ՀՎՀՀ-ն սխալ է (սպասվում է 8 թվանշան)։',
    'einv.validate.missingBuyerId':
      'Գնորդը պետք է նույնականացվի ՀՎՀՀ-ով (կազմակերպություն) կամ անձնագրով (ֆիզիկական անձ)։',
    'einv.validate.invalidBuyerHvhh': 'Գնորդի ՀՎՀՀ-ն սխալ է (սպասվում է 8 թվանշան)։',
    'einv.validate.noLines': 'Անհրաժեշտ է առնվազն մեկ հաշվարկման տող։',
    'einv.validate.invalidLineDescription':
      'Տողի նկարագրությունը պարտադիր է և չպետք է գերազանցի {{max}} նիշը։',
    'einv.validate.invalidLineQuantity': 'Տողի քանակը պետք է լինի դրական թիվ։',
    'einv.validate.invalidLineNet': 'Տողի զուտ գումարը պետք է լինի ոչ բացասական թիվ։',
    'einv.validate.invalidLineVatRate':
      'Տողի ԱԱՀ-ի դրույքաչափը պետք է լինի {{rates}} (16.67%-ը հաշվարկային է՝ միայն ԱԱՀ-ի հաշվարկի համար)։',
    'einv.validate.invalidLineVatAmount': 'Տողի ԱԱՀ-ի գումարը պետք է լինի թիվ։',
    'einv.validate.lineVatMismatch':
      'Տողի ԱԱՀ-ի գումարը {{actual}} չի համապատասխանում {{net}} զուտ գումարի {{rate}}%-ին (սպասվում է ≈{{expected}})։',
    // Dashboard UI — server-rendered CFO dashboard in server/finance/dashboard.js
    'dashboard.title': 'CFO Վահանակ',
    'dashboard.asOf': 'Տվյալները {{date}}-ի դրությամբ',
    'dashboard.generatedAt': 'Ստեղծվել է {{date}}-ին',
    'dashboard.section.arAging': 'Դեբիտորական պարտքերի ժամկետներ',
    'dashboard.section.overdue': 'Վճարման ժամկետը լրացած հաշիվ-ապրանքագրեր (top {{n}})',
    'dashboard.section.monthly': 'Այս ամսվա շրջանառություն',
    'dashboard.section.topCustomers': 'Լավագույն հաճախորդներ',
    'dashboard.section.vat': 'ԱԱՀ ամփոփում (տարեսկզբից)',
    'dashboard.meta.arAging': '{{date}} — չվճարված պարտքերը՝ ըստ ժամկետի բաց թողման օրերի։',
    'dashboard.meta.overdue': 'Վճարման ժամկետը լրացած հաշիվ-ապրանքագրերը ըստ ժամկետի բաց թողման օրերի (նվազման կարգով)։',
    'dashboard.meta.monthly': '{{yearMonth}} — ժամանակահատվածի շրջանառություն և հավաքագրում։',
    'dashboard.meta.topCustomers': 'Ըստ ընդհանուր գանձված գումարի ընտրված ժամանակահատվածում։',
    'dashboard.meta.vat': '{{since}} → {{until}} — ելքային ԱԱՀ-ի ամփոփում։',
    'dashboard.empty.overdue': 'Վճարման ժամկետը լրացած հաշիվ-ապրանքագիր չկա։ 🎉',
    'dashboard.empty.topCustomers': 'Ընտրված ժամանակահատվածում հաճախորդներ չկան։',
    'dashboard.bucket.0_30': '0–30 օր',
    'dashboard.bucket.31_60': '31–60 օր',
    'dashboard.bucket.61_90': '61–90 օր',
    'dashboard.bucket.90_plus': '90+ օր',
    'dashboard.bucket.total': 'Ընդամենը',
    'dashboard.th.invoiceNumber': 'Հաշիվ #',
    'dashboard.th.customer': 'Հաճախորդ',
    'dashboard.th.balance': 'Մնացորդ',
    'dashboard.th.daysOverdue': 'Օրերի ուշացում',
    'dashboard.th.invoiced': 'Գանձված',
    'dashboard.th.collected': 'Հավաքագրված',
    'dashboard.th.outstanding': 'Չվճարված',
    'dashboard.th.invoices': 'Հաշիվներ',
    'dashboard.th.paid': 'Վճարված',
    'dashboard.th.collectionRate': 'Հավաքագրման տոկոս',
    'dashboard.th.hvhh': 'ՀՎՀՀ',
    'dashboard.th.billed': 'Գանձված',
    'dashboard.th.paidAmount': 'Վճարված',
    'dashboard.th.invoiceCount': 'Հաշիվներ',
    'dashboard.th.vatInvoiced': 'Գանձված ԱԱՀ (ելքային)',
    'dashboard.th.vatPaid': 'Վճարված ԱԱՀ',
    'dashboard.th.netVatPosition': 'ԱԱՀ-ի զուտ դիրք',
  }),
  en: Object.freeze({
    'hvhh.required': 'HVHH is required',
    'hvhh.notNumeric': 'HVHH must contain only digits',
    'hvhh.length': 'HVHH must be {{length}} digits long',
    'hvhh.degenerate': 'HVHH is invalid',
    'hvhh.checkDigit': 'HVHH check digit is wrong',
    'amd.required': 'Amount is required.',
    'amd.notFinite': 'Amount must be a finite number.',
    'amd.notNumber': 'Amount is not a valid number: {{raw}}',
    'vat.form.missingLine': "VAT return is missing required line '{{id}}'.",
    'vat.form.nonNumericAmount': 'Line {{id}}.{{field}} must be a number.',
    'vat.form.nonIntegerAmount': 'Line {{id}}.{{field}} must be a whole-dram amount.',
    'vat.form.negativeAmount': 'Line {{id}}.{{field}} must not be negative.',
    'vat.form.line16BaseMismatch':
      'Line 16 base ({{actual}}) must equal 7+9+12+13 bases ({{expected}}).',
    'vat.form.line16VatMismatch': 'Line 16 VAT ({{actual}}) must equal 7+9 VAT ({{expected}}).',
    'vat.form.line21VatMismatch': 'Line 21 VAT ({{actual}}) must equal 17+18 VAT ({{expected}}).',
    'vat.form.line23NetMismatch':
      'Line 23 must be payable={{payable}}, recoverable={{recoverable}} (= line16.vat − line21.vat).',
    'vat.form.rateMismatch':
      'Line {{id}} VAT ({{actual}}) is implausible for base {{base}} at {{rate}}% (expected ~{{expected}} ± {{tolerance}}).',
    'einv.validate.missingTransactionType':
      'Գործարքի տեսակ (transaction type) is mandatory for SRC e-invoices since 2025-03-01.',
    'einv.validate.missingNumber': 'Invoice number/series is required.',
    'einv.validate.missingIssueDate': 'Issue date is required.',
    'einv.validate.invalidIssueDate': 'Issue date must be ISO format (YYYY-MM-DD).',
    'einv.validate.missingSupplierName': 'Supplier name is required.',
    'einv.validate.missingSupplierHvhh': 'Supplier ՀՎՀՀ (tax ID) is required.',
    'einv.validate.invalidSupplierHvhh': 'Supplier ՀՎՀՀ is malformed (expected 8 digits).',
    'einv.validate.missingBuyerId':
      'Buyer must be identified by ՀՎՀՀ (organization) or passport (individual).',
    'einv.validate.invalidBuyerHvhh': 'Buyer ՀՎՀՀ is malformed (expected 8 digits).',
    'einv.validate.noLines': 'At least one invoice line is required.',
    'einv.validate.invalidLineDescription':
      'Line description is required and must be ≤ {{max}} characters.',
    'einv.validate.invalidLineQuantity': 'Line quantity must be a positive number.',
    'einv.validate.invalidLineNet': 'Line net amount must be a non-negative number.',
    'einv.validate.invalidLineVatRate':
      'Line VAT rate must be {{rates}} (16.67% is imputed — VAT-return only).',
    'einv.validate.invalidLineVatAmount': 'Line VAT amount must be a number.',
    'einv.validate.lineVatMismatch':
      'Line VAT amount {{actual}} is inconsistent with {{rate}}% of net {{net}} (expected ~{{expected}}).',
    // Dashboard UI — server-rendered CFO dashboard in server/finance/dashboard.js
    'dashboard.title': 'CFO Dashboard',
    'dashboard.asOf': 'As of {{date}}',
    'dashboard.generatedAt': 'Generated at {{date}}',
    'dashboard.section.arAging': 'AR Aging',
    'dashboard.section.overdue': 'Overdue Invoices (top {{n}})',
    'dashboard.section.monthly': "This Month's Revenue",
    'dashboard.section.topCustomers': 'Top Customers',
    'dashboard.section.vat': 'VAT Summary (YTD)',
    'dashboard.meta.arAging': '{{date}} — outstanding receivables by days past due.',
    'dashboard.meta.overdue': 'Past-due as of the report date, sorted by days overdue DESC.',
    'dashboard.meta.monthly': '{{yearMonth}} — period revenue and collection.',
    'dashboard.meta.topCustomers': 'By gross billed amount in the selected window.',
    'dashboard.meta.vat': '{{since}} → {{until}} — output-VAT rollup.',
    'dashboard.empty.overdue': 'No overdue invoices. 🎉',
    'dashboard.empty.topCustomers': 'No customers in the selected window.',
    'dashboard.bucket.0_30': '0–30 days',
    'dashboard.bucket.31_60': '31–60 days',
    'dashboard.bucket.61_90': '61–90 days',
    'dashboard.bucket.90_plus': '90+ days',
    'dashboard.bucket.total': 'Total',
    'dashboard.th.invoiceNumber': 'Invoice #',
    'dashboard.th.customer': 'Customer',
    'dashboard.th.balance': 'Balance',
    'dashboard.th.daysOverdue': 'Days overdue',
    'dashboard.th.invoiced': 'Invoiced',
    'dashboard.th.collected': 'Collected',
    'dashboard.th.outstanding': 'Outstanding',
    'dashboard.th.invoices': 'Invoices',
    'dashboard.th.paid': 'Paid',
    'dashboard.th.collectionRate': 'Collection rate',
    'dashboard.th.hvhh': 'HVHH (tax ID)',
    'dashboard.th.billed': 'Billed',
    'dashboard.th.paidAmount': 'Paid',
    'dashboard.th.invoiceCount': 'Invoices',
    'dashboard.th.vatInvoiced': 'VAT invoiced (output)',
    'dashboard.th.vatPaid': 'VAT paid (on collected invoices)',
    'dashboard.th.netVatPosition': 'Net VAT position',
  }),
  ru: Object.freeze({
    'hvhh.required': 'ИНН обязателен',
    'hvhh.notNumeric': 'ИНН должен содержать только цифры',
    'hvhh.length': 'ИНН должен содержать {{length}} цифр',
    'hvhh.degenerate': 'ИНН недействителен',
    'hvhh.checkDigit': 'Контрольная цифра ИНН неверна',
    'amd.required': 'Сумма обязательна',
    'amd.notFinite': 'Сумма должна быть конечным числом',
    'amd.notNumber': 'Сумма не является допустимым числом: {{raw}}',
    'vat.form.missingLine': "В расчёте НДС отсутствует обязательная строка '{{id}}'.",
    'vat.form.nonNumericAmount': 'Поле {{field}} строки {{id}} должно быть числом.',
    'vat.form.nonIntegerAmount':
      'Поле {{field}} строки {{id}} должно быть целым числом (в драмах).',
    'vat.form.negativeAmount': 'Поле {{field}} строки {{id}} не должно быть отрицательным.',
    'vat.form.line16BaseMismatch':
      'База строки 16 ({{actual}}) должна равняться сумме баз строк 7+9+12+13 ({{expected}}).',
    'vat.form.line16VatMismatch':
      'НДС строки 16 ({{actual}}) должен равняться сумме НДС строк 7+9 ({{expected}}).',
    'vat.form.line21VatMismatch':
      'НДС строки 21 ({{actual}}) должен равняться сумме НДС строк 17+18 ({{expected}}).',
    'vat.form.line23NetMismatch':
      'Строка 23 должна иметь к_уплате={{payable}}, к_зачёту={{recoverable}} (= строка 16 НДС − строка 21 НДС).',
    'vat.form.rateMismatch':
      'НДС строки {{id}} ({{actual}}) неправдоподобен для базы {{base}} при ставке {{rate}}% (ожидается ≈{{expected}} ± {{tolerance}}).',
    'einv.validate.missingTransactionType':
      'Вид операции обязателен для электронных счетов-фактур SRC с 01.03.2025.',
    'einv.validate.missingNumber': 'Номер/серия счёта-фактуры обязательны.',
    'einv.validate.missingIssueDate': 'Дата выставления обязательна.',
    'einv.validate.invalidIssueDate': 'Дата выставления должна быть в формате ISO (ГГГГ-ММ-ДД).',
    'einv.validate.missingSupplierName': 'Наименование поставщика обязательно.',
    'einv.validate.missingSupplierHvhh': 'ИНН поставщика (учётный номер плательщика) обязателен.',
    'einv.validate.invalidSupplierHvhh': 'ИНН поставщика имеет неверный формат (ожидается 8 цифр).',
    'einv.validate.missingBuyerId':
      'Покупатель должен быть идентифицирован по ИНН (организация) или паспорту (физическое лицо).',
    'einv.validate.invalidBuyerHvhh': 'ИНН покупателя имеет неверный формат (ожидается 8 цифр).',
    'einv.validate.noLines': 'Требуется хотя бы одна строка счёта.',
    'einv.validate.invalidLineDescription':
      'Описание строки обязательно и не должно превышать {{max}} символов.',
    'einv.validate.invalidLineQuantity': 'Количество строки должно быть положительным числом.',
    'einv.validate.invalidLineNet': 'Сумма нетто строки должна быть неотрицательным числом.',
    'einv.validate.invalidLineVatRate':
      'Ставка НДС строки должна быть {{rates}} (16,67% — расчётная, только для расчёта НДС).',
    'einv.validate.invalidLineVatAmount': 'Сумма НДС строки должна быть числом.',
    'einv.validate.lineVatMismatch':
      'Сумма НДС строки {{actual}} не соответствует {{rate}}% от базы {{net}} (ожидается ≈{{expected}}).',
    // Dashboard UI — server-rendered CFO dashboard in server/finance/dashboard.js
    'dashboard.title': 'Панель CFO',
    'dashboard.asOf': 'По состоянию на {{date}}',
    'dashboard.generatedAt': 'Сформировано {{date}}',
    'dashboard.section.arAging': 'Дебиторская задолженность по срокам',
    'dashboard.section.overdue': 'Просроченные счета (top {{n}})',
    'dashboard.section.monthly': 'Выручка за месяц',
    'dashboard.section.topCustomers': 'Топ клиентов',
    'dashboard.section.vat': 'Сводка НДС (с начала года)',
    'dashboard.meta.arAging': '{{date}} — неоплаченная задолженность по дням просрочки.',
    'dashboard.meta.overdue': 'Просроченные счета, отсортированные по дням просрочки (по убыванию).',
    'dashboard.meta.monthly': '{{yearMonth}} — выручка и сборы за период.',
    'dashboard.meta.topCustomers': 'По общей выставленной сумме в выбранном окне.',
    'dashboard.meta.vat': '{{since}} → {{until}} — сводка исходящего НДС.',
    'dashboard.empty.overdue': 'Просроченных счетов нет. 🎉',
    'dashboard.empty.topCustomers': 'В выбранном окне клиентов нет.',
    'dashboard.bucket.0_30': '0–30 дней',
    'dashboard.bucket.31_60': '31–60 дней',
    'dashboard.bucket.61_90': '61–90 дней',
    'dashboard.bucket.90_plus': '90+ дней',
    'dashboard.bucket.total': 'Итого',
    'dashboard.th.invoiceNumber': 'Счёт #',
    'dashboard.th.customer': 'Клиент',
    'dashboard.th.balance': 'Остаток',
    'dashboard.th.daysOverdue': 'Дней просрочки',
    'dashboard.th.invoiced': 'Выставлено',
    'dashboard.th.collected': 'Собрано',
    'dashboard.th.outstanding': 'Не оплачено',
    'dashboard.th.invoices': 'Счетов',
    'dashboard.th.paid': 'Оплачено',
    'dashboard.th.collectionRate': 'Коэффициент сбора',
    'dashboard.th.hvhh': 'ИНН',
    'dashboard.th.billed': 'Выставлено',
    'dashboard.th.paidAmount': 'Оплачено',
    'dashboard.th.invoiceCount': 'Счетов',
    'dashboard.th.vatInvoiced': 'НДС выставленный (исходящий)',
    'dashboard.th.vatPaid': 'НДС уплаченный',
    'dashboard.th.netVatPosition': 'Чистая позиция НДС',
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
