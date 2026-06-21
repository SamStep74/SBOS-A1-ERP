// Catalog v2 — Phase 2 wave 1.
//
// Extends the existing catalog module (Wave 7) with:
//   - Categories: createCategory / listCategories /
//     getCategory / getCategoryPath
//   - Variants: createVariant / listVariants /
//     getVariant
//
// The existing catalog_categories table already has
// parent_id (hierarchical structure); this module
// exposes the CRUD operations. The catalog_variants
// table is fully exposed (the table existed in 0007
// but had no pure functions).
//
// Phase 2 catalog v2 wave 1 (W76-1): schema + pure
// functions + tests. Wave 2 (future): route wiring +
// smoke check.

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// DB adapter helper (matches the pattern in customer.js /
// inventory.js / crm.js / desk.js / projects.js)
// ────────────────────────────────────────────────────────────────────────

async function runQuery(db, sql, params) {
  // The production adapter is a pg-style adapter (rows
  // property, $N placeholders). The test adapter uses
  // $N too (the test helper translates $N → ?). The
  // catalog pure functions speak the production shape.
  const result = await db.query(sql, params || []);
  if (result && Array.isArray(result.rows)) return result;
  return { rows: [] };
}

// ────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────

// Slug pattern: lowercase letters, digits, hyphens.
// Minimum 1 char, maximum 64 chars.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function assertString(value, name, { min = 1, max = 8192 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new ValueError(`${name} must be a string of ${min}-${max} characters`);
  }
}

function assertOptionalString(value, name, { max = 8192 } = {}) {
  if (value === null || value === undefined) return;
  if (typeof value !== 'string' || value.length > max) {
    throw new ValueError(`${name} must be a string up to ${max} characters or null`);
  }
}

function assertPositiveInt(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValueError(`${name} must be a positive integer`);
  }
}

function assertDateString(value, name) {
  if (value === null || value === undefined) return;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValueError(`${name} must be a date string in YYYY-MM-DD format`);
  }
}

function assertSlug(value, name = 'slug') {
  if (typeof value !== 'string' || !SLUG_RE.test(value)) {
    throw new ValueError(
      `${name} must be lowercase letters, digits, and hyphens (1-64 chars, starting with a letter or digit)`,
    );
  }
}

function validateCreateCategoryInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('category input is required');
  }
  assertString(input.name, 'name', { min: 1, max: 255 });
  if (input.slug !== null && input.slug !== undefined) {
    assertSlug(input.slug);
  }
  assertOptionalString(input.description, 'description', { max: 8192 });
  if (input.parent_id !== null && input.parent_id !== undefined) {
    assertPositiveInt(input.parent_id, 'parent_id');
  }
}

function validateCreateVariantInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('variant input is required');
  }
  assertPositiveInt(input.catalog_item_id, 'catalog_item_id');
  assertString(input.sku, 'sku', { min: 1, max: 64 });
  assertString(input.name, 'name', { min: 1, max: 255 });
  assertOptionalString(input.attributes_json, 'attributes_json', { max: 8192 });
  // unit_price_amd and unit_cost_amd are optional; when
  // present they must be non-negative integers (the
  // existing catalog_items convention).
  if (input.unit_price_amd !== null && input.unit_price_amd !== undefined) {
    if (!Number.isInteger(input.unit_price_amd) || input.unit_price_amd < 0) {
      throw new ValueError('unit_price_amd must be a non-negative integer');
    }
  }
  if (input.unit_cost_amd !== null && input.unit_cost_amd !== undefined) {
    if (!Number.isInteger(input.unit_cost_amd) || input.unit_cost_amd < 0) {
      throw new ValueError('unit_cost_amd must be a non-negative integer');
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Categories
// ────────────────────────────────────────────────────────────────────────

export async function createCategory(db, input, tenantId = 0) {
  validateCreateCategoryInput(input);
  // Verify the parent exists in the tenant (if specified).
  // The parent_id may be null (root category).
  if (input.parent_id !== null && input.parent_id !== undefined) {
    const existing = await runQuery(
      db,
      `SELECT id FROM finance.catalog_categories
        WHERE id = $1 AND tenant_id = $2`,
      [input.parent_id, tenantId],
    );
    if (!existing.rows || existing.rows.length === 0) {
      throw new ValueError(`category ${input.parent_id} not found in tenant ${tenantId}`);
    }
  }
  const ins = await runQuery(
    db,
    `INSERT INTO finance.catalog_categories
       (tenant_id, parent_id, name, slug, description)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      tenantId,
      input.parent_id ?? null,
      input.name,
      input.slug ?? null,
      input.description ?? null,
    ],
  );
  let id;
  if (ins.rows && ins.rows.length > 0 && ins.rows[0].id != null) {
    id = Number(ins.rows[0].id);
  } else {
    const lastId = await runQuery(
      db,
      'SELECT LAST_INSERT_ROWID()',
      [],
    );
    id = Number(lastId.rows[0].id);
  }
  return { id };
}

export async function listCategories(db, tenantId = 0, parentId = null) {
  // Order by id ASC (insertion order; stable for UI
  // tree rendering). parentId=null returns ALL
  // categories for the tenant (flat list); parentId=N
  // returns only direct children of category N.
  let result;
  if (parentId !== null) {
    result = await runQuery(
      db,
      `SELECT id, parent_id, name, slug, description,
              created_at, updated_at
         FROM finance.catalog_categories
        WHERE tenant_id = $1 AND parent_id = $2
        ORDER BY id ASC`,
      [tenantId, parentId],
    );
  } else {
    result = await runQuery(
      db,
      `SELECT id, parent_id, name, slug, description,
              created_at, updated_at
         FROM finance.catalog_categories
        WHERE tenant_id = $1
        ORDER BY id ASC`,
      [tenantId],
    );
  }
  return result.rows;
}

export async function getCategory(db, categoryId, tenantId = 0) {
  assertPositiveInt(categoryId, 'categoryId');
  const result = await runQuery(
    db,
    `SELECT id, parent_id, name, slug, description,
            created_at, updated_at
       FROM finance.catalog_categories
      WHERE id = $1 AND tenant_id = $2`,
    [categoryId, tenantId],
  );
  if (!result.rows || result.rows.length === 0) {
    throw new ValueError(`category ${categoryId} not found in tenant ${tenantId}`);
  }
  return result.rows[0];
}

export async function getCategoryPath(db, categoryId, tenantId = 0) {
  // Returns the full path from the root category to
  // the given category, as an array of {id, name}
  // objects in root-to-leaf order. Uses a recursive
  // CTE to traverse the parent_id chain. The leaf
  // category is the last element. The result is
  // empty for a missing category (the SQL returns
  // no rows; the function returns []).
  //
  // This is the "breadcrumb" pattern: UI components
  // can join the path elements with " > " to
  // produce a "Electronics > Computers > Laptops"
  // display string.
  assertPositiveInt(categoryId, 'categoryId');
  const result = await runQuery(
    db,
    `WITH RECURSIVE path(id, parent_id, name, depth) AS (
       SELECT id, parent_id, name, 0
         FROM finance.catalog_categories
        WHERE id = $1 AND tenant_id = $2
       UNION ALL
       SELECT c.id, c.parent_id, c.name, p.depth + 1
         FROM finance.catalog_categories c
         JOIN path p ON c.id = p.parent_id
        WHERE c.tenant_id = $2
     )
     SELECT id, name, depth FROM path ORDER BY depth DESC`,
    [categoryId, tenantId],
  );
  // ORDER BY depth DESC puts the root first (highest
  // depth = furthest ancestor), so the result is
  // already in root-to-leaf order — no reversal
  // needed. (Initial W76-1 attempt had a .reverse()
  // here that produced leaf-first order, which was
  // the W76-1 bug.)
  return (result.rows || []).map((r) => ({
    id: Number(r.id),
    name: String(r.name),
  }));
}

// ────────────────────────────────────────────────────────────────────────
// Variants
// ────────────────────────────────────────────────────────────────────────

export async function createVariant(db, input, tenantId = 0) {
  validateCreateVariantInput(input);
  // Verify the parent item exists in the tenant.
  const existing = await runQuery(
    db,
    `SELECT id FROM finance.catalog_items
      WHERE id = $1 AND tenant_id = $2`,
    [input.catalog_item_id, tenantId],
  );
  if (!existing.rows || existing.rows.length === 0) {
    throw new ValueError(
      `catalog item ${input.catalog_item_id} not found in tenant ${tenantId}`,
    );
  }
  const ins = await runQuery(
    db,
    `INSERT INTO finance.catalog_variants
       (tenant_id, catalog_item_id, sku, name,
        attributes_json, unit_price_amd, unit_cost_amd)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      tenantId,
      input.catalog_item_id,
      input.sku,
      input.name,
      input.attributes_json ?? null,
      input.unit_price_amd ?? null,
      input.unit_cost_amd ?? null,
    ],
  );
  let id;
  if (ins.rows && ins.rows.length > 0 && ins.rows[0].id != null) {
    id = Number(ins.rows[0].id);
  } else {
    const lastId = await runQuery(
      db,
      'SELECT LAST_INSERT_ROWID()',
      [],
    );
    id = Number(lastId.rows[0].id);
  }
  return { id };
}

export async function listVariants(db, tenantId = 0, catalogItemId = null) {
  // Order by id ASC. catalogItemId=null returns ALL
  // variants for the tenant; catalogItemId=N returns
  // only variants of item N.
  let result;
  if (catalogItemId !== null) {
    result = await runQuery(
      db,
      `SELECT id, catalog_item_id, sku, name,
              attributes_json, unit_price_amd, unit_cost_amd,
              created_at, updated_at
         FROM finance.catalog_variants
        WHERE tenant_id = $1 AND catalog_item_id = $2
        ORDER BY id ASC`,
      [tenantId, catalogItemId],
    );
  } else {
    result = await runQuery(
      db,
      `SELECT id, catalog_item_id, sku, name,
              attributes_json, unit_price_amd, unit_cost_amd,
              created_at, updated_at
         FROM finance.catalog_variants
        WHERE tenant_id = $1
        ORDER BY id ASC`,
      [tenantId],
    );
  }
  return result.rows;
}

export async function getVariant(db, variantId, tenantId = 0) {
  assertPositiveInt(variantId, 'variantId');
  const result = await runQuery(
    db,
    `SELECT id, catalog_item_id, sku, name,
            attributes_json, unit_price_amd, unit_cost_amd,
            created_at, updated_at
       FROM finance.catalog_variants
      WHERE id = $1 AND tenant_id = $2`,
    [variantId, tenantId],
  );
  if (!result.rows || result.rows.length === 0) {
    throw new ValueError(`variant ${variantId} not found in tenant ${tenantId}`);
  }
  return result.rows[0];
}

// ────────────────────────────────────────────────────────────────────────
// Bundles (catalog v2 wave 3 / W78-1)
// ────────────────────────────────────────────────────────────────────────
//
// Bundles are compound catalog items: a bundle has a
// header row (sku + name + description +
// bundle_price_amd) + N child rows (one per
// catalog_item with a quantity). The total cost of
// the bundle is the bundle_price_amd (a single
// integer); the child rows are the recipe (e.g.
// "1x Chair + 1x Desk + 1x Lamp").
//
// This module ships the minimum-viable bundles:
//   - createBundle / listBundles / getBundle
//   - addBundleItem / listBundleItems
// (removeBundleItem + updateBundle are deferred
// to a future wave — the operator can soft-archive
// the bundle via the archived flag for now.)
//
// Phase 2 catalog v2 wave 3a (W78-1): schema +
// pure functions + tests. Wave 3b (future): route
// wiring + perm keys + smoke check.

function assertBundlePrice(value) {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || value < 0) {
    throw new ValueError('bundle_price_amd must be a non-negative integer');
  }
}

function assertQuantity(value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValueError('quantity must be a positive integer');
  }
}

function validateCreateBundleInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('bundle input is required');
  }
  assertString(input.sku, 'sku', { min: 1, max: 64 });
  assertString(input.name, 'name', { min: 1, max: 255 });
  assertOptionalString(input.description, 'description', { max: 8192 });
  assertBundlePrice(input.bundle_price_amd);
}

function validateAddBundleItemInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('bundle item input is required');
  }
  assertPositiveInt(input.catalog_item_id, 'catalog_item_id');
  assertQuantity(input.quantity);
}

export async function createBundle(db, input, tenantId = 0) {
  validateCreateBundleInput(input);
  const ins = await runQuery(
    db,
    `INSERT INTO finance.catalog_bundles
       (tenant_id, sku, name, description, bundle_price_amd)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      tenantId,
      input.sku,
      input.name,
      input.description ?? null,
      input.bundle_price_amd ?? null,
    ],
  );
  let id;
  if (ins.rows && ins.rows.length > 0 && ins.rows[0].id != null) {
    id = Number(ins.rows[0].id);
  } else {
    const lastId = await runQuery(
      db,
      'SELECT LAST_INSERT_ROWID()',
      [],
    );
    id = Number(lastId.rows[0].id);
  }
  return { id };
}

export async function listBundles(db, tenantId = 0, { archived = false } = {}) {
  // Order by id DESC (most recent first; consistent
  // with listProjects / listCases). When
  // archived=false (default), only non-archived
  // bundles are returned. When archived=true, all
  // bundles (including archived) are returned —
  // useful for cleanup views.
  let result;
  if (archived) {
    result = await runQuery(
      db,
      `SELECT id, sku, name, description, bundle_price_amd,
              archived, created_at, updated_at
         FROM finance.catalog_bundles
        WHERE tenant_id = $1
        ORDER BY id DESC`,
      [tenantId],
    );
  } else {
    result = await runQuery(
      db,
      `SELECT id, sku, name, description, bundle_price_amd,
              archived, created_at, updated_at
         FROM finance.catalog_bundles
        WHERE tenant_id = $1 AND archived = 0
        ORDER BY id DESC`,
      [tenantId],
    );
  }
  return result.rows;
}

export async function getBundle(db, bundleId, tenantId = 0) {
  assertPositiveInt(bundleId, 'bundleId');
  const result = await runQuery(
    db,
    `SELECT id, sku, name, description, bundle_price_amd,
            archived, created_at, updated_at
       FROM finance.catalog_bundles
      WHERE id = $1 AND tenant_id = $2`,
    [bundleId, tenantId],
  );
  if (!result.rows || result.rows.length === 0) {
    throw new ValueError(`bundle ${bundleId} not found in tenant ${tenantId}`);
  }
  return result.rows[0];
}

export async function addBundleItem(db, bundleId, input, tenantId = 0) {
  assertPositiveInt(bundleId, 'bundleId');
  validateAddBundleItemInput(input);
  // Verify the bundle exists in the tenant.
  const bundleExisting = await runQuery(
    db,
    `SELECT id FROM finance.catalog_bundles
      WHERE id = $1 AND tenant_id = $2`,
    [bundleId, tenantId],
  );
  if (!bundleExisting.rows || bundleExisting.rows.length === 0) {
    throw new ValueError(`bundle ${bundleId} not found in tenant ${tenantId}`);
  }
  // Verify the catalog item exists in the tenant
  // (the bundle item references the catalog item;
  // we don't have a real FK because the items are
  // in a different migration).
  const itemExisting = await runQuery(
    db,
    `SELECT id FROM finance.catalog_items
      WHERE id = $1 AND tenant_id = $2`,
    [input.catalog_item_id, tenantId],
  );
  if (!itemExisting.rows || itemExisting.rows.length === 0) {
    throw new ValueError(
      `catalog item ${input.catalog_item_id} not found in tenant ${tenantId}`,
    );
  }
  const ins = await runQuery(
    db,
    `INSERT INTO finance.catalog_bundle_items
       (tenant_id, bundle_id, catalog_item_id, quantity)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      tenantId,
      bundleId,
      input.catalog_item_id,
      input.quantity,
    ],
  );
  let id;
  if (ins.rows && ins.rows.length > 0 && ins.rows[0].id != null) {
    id = Number(ins.rows[0].id);
  } else {
    const lastId = await runQuery(
      db,
      'SELECT LAST_INSERT_ROWID()',
      [],
    );
    id = Number(lastId.rows[0].id);
  }
  return { id };
}

export async function listBundleItems(db, bundleId, tenantId = 0) {
  assertPositiveInt(bundleId, 'bundleId');
  // Verify the bundle exists in the tenant
  // (consistent with the listReplies /
  // listProjectTasks pattern; existence check
  // prevents an empty-array response on a missing
  // bundle from masking a real client bug).
  const bundleExisting = await runQuery(
    db,
    `SELECT id FROM finance.catalog_bundles
      WHERE id = $1 AND tenant_id = $2`,
    [bundleId, tenantId],
  );
  if (!bundleExisting.rows || bundleExisting.rows.length === 0) {
    throw new ValueError(`bundle ${bundleId} not found in tenant ${tenantId}`);
  }
  const result = await runQuery(
    db,
    `SELECT id, bundle_id, catalog_item_id, quantity, created_at
       FROM finance.catalog_bundle_items
      WHERE bundle_id = $1 AND tenant_id = $2
      ORDER BY id ASC`,
    [bundleId, tenantId],
  );
  return result.rows;
}

// ────────────────────────────────────────────────────────────────────────
// Pricing rules (catalog v2 wave 3c / W80-1)
// ────────────────────────────────────────────────────────────────────────
//
// Pricing rules are tenant-scoped configuration
// records that describe price overrides. The rule
// itself is just a record (header + config_json
// blob); the actual price-application logic (which
// rule applies to which item, how to compute the
// final price) is a future concern (a follow-up
// wave that integrates the rules with the catalog
// + invoice flow).
//
// This module ships the minimum-viable pricing
// rules CRUD:
//   - createPricingRule
//   - listPricingRules
//   - getPricingRule
//
// Phase 2 catalog v2 wave 3c (W80-1): schema +
// pure functions + tests. Wave 3d (future): route
// wiring + perm keys + smoke check.

const PRICING_RULE_TYPES = ['volume_discount', 'time_based', 'category_discount'];

function assertPricingRuleType(value) {
  // Type is required (no default — the operator must
  // explicitly choose the rule type).
  if (value === null || value === undefined) {
    throw new ValueError(
      `pricing rule type is required (one of: ${PRICING_RULE_TYPES.join(', ')})`,
    );
  }
  if (!PRICING_RULE_TYPES.includes(value)) {
    throw new ValueError(
      `pricing rule type must be one of: ${PRICING_RULE_TYPES.join(', ')}`,
    );
  }
}

function assertPricingRulePriority(value) {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value)) {
    throw new ValueError('priority must be an integer');
  }
}

function validateCreatePricingRuleInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('pricing rule input is required');
  }
  assertString(input.name, 'name', { min: 1, max: 255 });
  assertPricingRuleType(input.type);
  assertOptionalString(input.config_json, 'config_json', { max: 8192 });
  assertPricingRulePriority(input.priority);
  assertDateString(input.valid_from, 'valid_from');
  assertDateString(input.valid_to, 'valid_to');
}

export async function createPricingRule(db, input, tenantId = 0) {
  validateCreatePricingRuleInput(input);
  const ins = await runQuery(
    db,
    `INSERT INTO finance.catalog_pricing_rules
       (tenant_id, name, type, config_json, priority,
        valid_from, valid_to)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      tenantId,
      input.name,
      input.type,
      input.config_json ?? null,
      input.priority ?? 100,
      input.valid_from ?? null,
      input.valid_to ?? null,
    ],
  );
  let id;
  if (ins.rows && ins.rows.length > 0 && ins.rows[0].id != null) {
    id = Number(ins.rows[0].id);
  } else {
    const lastId = await runQuery(
      db,
      'SELECT LAST_INSERT_ROWID()',
      [],
    );
    id = Number(lastId.rows[0].id);
  }
  return { id };
}

export async function listPricingRules(
  db,
  tenantId = 0,
  { archived = false, type = null } = {},
) {
  // Order by priority ASC (lower priority value =
  // higher priority; the most-applicable rule
  // appears first). Then by id ASC for stable
  // ordering when priorities tie.
  //
  // When archived=false (default), only non-
  // archived rules are returned. When
  // archived=true, all rules (including archived)
  // are returned.
  //
  // When type is set, only rules of that type are
  // returned (e.g. { type: 'volume_discount' } for
  // the "show me all volume discounts" view).
  let result;
  if (archived && type !== null) {
    result = await runQuery(
      db,
      `SELECT id, name, type, config_json, priority,
              valid_from, valid_to, archived,
              created_at, updated_at
         FROM finance.catalog_pricing_rules
        WHERE tenant_id = $1 AND type = $2
        ORDER BY priority ASC, id ASC`,
      [tenantId, type],
    );
  } else if (archived) {
    result = await runQuery(
      db,
      `SELECT id, name, type, config_json, priority,
              valid_from, valid_to, archived,
              created_at, updated_at
         FROM finance.catalog_pricing_rules
        WHERE tenant_id = $1
        ORDER BY priority ASC, id ASC`,
      [tenantId],
    );
  } else if (type !== null) {
    result = await runQuery(
      db,
      `SELECT id, name, type, config_json, priority,
              valid_from, valid_to, archived,
              created_at, updated_at
         FROM finance.catalog_pricing_rules
        WHERE tenant_id = $1 AND archived = 0 AND type = $2
        ORDER BY priority ASC, id ASC`,
      [tenantId, type],
    );
  } else {
    result = await runQuery(
      db,
      `SELECT id, name, type, config_json, priority,
              valid_from, valid_to, archived,
              created_at, updated_at
         FROM finance.catalog_pricing_rules
        WHERE tenant_id = $1 AND archived = 0
        ORDER BY priority ASC, id ASC`,
      [tenantId],
    );
  }
  return result.rows;
}

export async function getPricingRule(db, ruleId, tenantId = 0) {
  assertPositiveInt(ruleId, 'ruleId');
  const result = await runQuery(
    db,
    `SELECT id, name, type, config_json, priority,
            valid_from, valid_to, archived,
            created_at, updated_at
       FROM finance.catalog_pricing_rules
      WHERE id = $1 AND tenant_id = $2`,
    [ruleId, tenantId],
  );
  if (!result.rows || result.rows.length === 0) {
    throw new ValueError(`pricing rule ${ruleId} not found in tenant ${tenantId}`);
  }
  return result.rows[0];
}
