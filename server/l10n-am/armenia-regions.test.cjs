const test = require("node:test");
const assert = require("node:assert/strict");
const {
  REGIONS,
  REGION_CODES,
  regionByCode,
  isValidRegionCode,
  findRegion,
  citiesForRegion,
} = require("./armeniaRegions.cjs");

test("regions: Armenia has exactly 11 administrative divisions (marzes incl. Yerevan)", () => {
  assert.equal(REGIONS.length, 11);
  assert.equal(REGION_CODES.length, 11);
});

test("regions: every entry is well-formed with an ISO 3166-2:AM code", () => {
  const seen = new Set();
  for (const r of REGIONS) {
    assert.match(r.code, /^AM-[A-Z]{2}$/, `bad code ${r.code}`);
    assert.ok(r.hy && r.hy.length > 0, `missing hy for ${r.code}`);
    assert.ok(r.en && r.en.length > 0, `missing en for ${r.code}`);
    assert.ok(r.center && r.center.length > 0, `missing center for ${r.code}`);
    assert.ok(Array.isArray(r.cities) && r.cities.length > 0, `no cities for ${r.code}`);
    assert.equal(r.cities[0], r.center, `center must be first city for ${r.code}`);
    assert.ok(!seen.has(r.code), `duplicate code ${r.code}`);
    seen.add(r.code);
  }
});

test("regions: Yerevan (capital) and key marzes are present", () => {
  assert.ok(isValidRegionCode("AM-ER"));
  assert.equal(regionByCode("AM-ER").en, "Yerevan");
  assert.equal(regionByCode("AM-SH").en, "Shirak");
  assert.equal(regionByCode("AM-SU").en, "Syunik");
});

test("regions: regionByCode is case-insensitive and null-safe", () => {
  assert.equal(regionByCode("am-sh").en, "Shirak");
  assert.equal(regionByCode("AM-SH").hy, "Շիրակ");
  assert.equal(regionByCode("AM-ZZ"), null);
  assert.equal(regionByCode(""), null);
  assert.equal(regionByCode(null), null);
});

test("regions: isValidRegionCode", () => {
  assert.equal(isValidRegionCode("AM-LO"), true);
  assert.equal(isValidRegionCode("am-lo"), true);
  assert.equal(isValidRegionCode("AM-XX"), false);
  assert.equal(isValidRegionCode("LO"), false);
});

test("regions: findRegion matches by code, Armenian name, or English name", () => {
  assert.equal(findRegion("AM-SH").code, "AM-SH");
  assert.equal(findRegion("Շիրակ").code, "AM-SH");
  assert.equal(findRegion("shirak").code, "AM-SH");
  assert.equal(findRegion("  Gyumri-less unknown  "), null);
  assert.equal(findRegion("Սյունիք").en, "Syunik");
});

test("regions: citiesForRegion returns the marz center first", () => {
  const lori = citiesForRegion("AM-LO");
  assert.equal(lori[0], "Վանաձոր");
  assert.ok(lori.includes("Վանաձոր"));
  assert.deepEqual(citiesForRegion("AM-XX"), []);
  assert.equal(citiesForRegion("AM-SH")[0], "Գյումրի");
});
