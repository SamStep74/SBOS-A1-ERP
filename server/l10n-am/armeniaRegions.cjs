// Armenian administrative-region (marz) dictionary — part of the RA localization kernel.
//
// Armenia has 11 administrative divisions: 10 provinces (marzes) plus the capital
// Yerevan, which has special status. Keyed on the official ISO 3166-2:AM codes so
// addresses, SRC e-invoices, shipping, and analytics share stable identifiers; the
// hy/en labels are a presentation layer on top.
//
// `cities` lists the marz administrative center first, then other major cities
// (curated, not exhaustive). Pure data + lookups — no I/O.

const REGIONS = Object.freeze([
  { code: "AM-ER", hy: "Երևան", en: "Yerevan", center: "Երևան",
    cities: ["Երևան"] },
  { code: "AM-AG", hy: "Արագածոտն", en: "Aragatsotn", center: "Աշտարակ",
    cities: ["Աշտարակ", "Ապարան", "Թալին"] },
  { code: "AM-AR", hy: "Արարատ", en: "Ararat", center: "Արտաշատ",
    cities: ["Արտաշատ", "Մասիս", "Արարատ", "Վեդի"] },
  { code: "AM-AV", hy: "Արմավիր", en: "Armavir", center: "Արմավիր",
    cities: ["Արմավիր", "Վաղարշապատ", "Մեծամոր"] },
  { code: "AM-GR", hy: "Գեղարքունիք", en: "Gegharkunik", center: "Գավառ",
    cities: ["Գավառ", "Սևան", "Մարտունի", "Վարդենիս", "Ճամբարակ"] },
  { code: "AM-KT", hy: "Կոտայք", en: "Kotayk", center: "Հրազդան",
    cities: ["Հրազդան", "Աբովյան", "Չարենցավան", "Եղվարդ", "Ծաղկաձոր"] },
  { code: "AM-LO", hy: "Լոռի", en: "Lori", center: "Վանաձոր",
    cities: ["Վանաձոր", "Ալավերդի", "Սպիտակ", "Ստեփանավան", "Թումանյան"] },
  { code: "AM-SH", hy: "Շիրակ", en: "Shirak", center: "Գյումրի",
    cities: ["Գյումրի", "Արթիկ", "Մարալիկ"] },
  { code: "AM-SU", hy: "Սյունիք", en: "Syunik", center: "Կապան",
    cities: ["Կապան", "Գորիս", "Սիսիան", "Մեղրի", "Քաջարան"] },
  { code: "AM-TV", hy: "Տավուշ", en: "Tavush", center: "Իջևան",
    cities: ["Իջևան", "Դիլիջան", "Բերդ", "Նոյեմբերյան"] },
  { code: "AM-VD", hy: "Վայոց Ձոր", en: "Vayots Dzor", center: "Եղեգնաձոր",
    cities: ["Եղեգնաձոր", "Վայք", "Ջերմուկ"] },
]);

const REGION_CODES = Object.freeze(REGIONS.map((r) => r.code));

const _byCode = new Map(REGIONS.map((r) => [r.code, r]));

function regionByCode(code) {
  if (!code || typeof code !== "string") return null;
  return _byCode.get(code.trim().toUpperCase()) || null;
}

function isValidRegionCode(code) {
  return regionByCode(code) !== null;
}

function findRegion(query) {
  if (!query || typeof query !== "string") return null;
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const byCode = regionByCode(query);
  if (byCode) return byCode;
  return (
    REGIONS.find((r) => r.hy.toLowerCase() === q || r.en.toLowerCase() === q) || null
  );
}

function citiesForRegion(code) {
  const region = regionByCode(code);
  return region ? region.cities.slice() : [];
}

module.exports = {
  REGIONS,
  REGION_CODES,
  regionByCode,
  isValidRegionCode,
  findRegion,
  citiesForRegion,
};
