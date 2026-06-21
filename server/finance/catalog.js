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
