// Phase 2 catalog v2 — wave 1 unit tests (schema
// extension + pure functions for categories +
// variants). The test harness uses a minimal
// in-memory sqlite-shaped adapter that mimics the
// production pgAdapter shape (db.query() returns
// { rows: [...] }).
//
// The schema is migrated via applyMigrations() in
// the bootable server (npm run smoke:deploy), not
// in the test harness. The test harness creates the
// tables it needs; the catalog_categories +
// catalog_variants tables already exist in 0007
// but the new slug + description + updated_at
// columns are added by 0013_catalog_v2.sql (the
// test harness creates them with the v2 columns
// already present).
//
// Run: node --test server/finance/catalog.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  createCategory,
  listCategories,
  getCategory,
  getCategoryPath,
  createVariant,
  listVariants,
  getVariant,
  createBundle,
  listBundles,
  getBundle,
  addBundleItem,
  listBundleItems,
  ValueError,
} from './catalog.js';

function makeMemoryDb() {
  // Minimal in-memory sqlite-shaped adapter.
  // catalog_categories + catalog_items + catalog_variants
  // are created in the MAIN schema (not finance.) so the
  // unique indexes work — node:sqlite doesn't support
  // CREATE INDEX with a schema prefix. The test query()
  // shim translates finance.<table> → <table> so the
  // production SQL still works. The unique indexes are
  // created so the unique-constraint tests pass.
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE catalog_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      parent_id INTEGER,
      name TEXT NOT NULL,
      slug TEXT,
      description TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX catalog_categories_slug_idx
        ON catalog_categories (tenant_id, slug)
        WHERE slug IS NOT NULL;
    CREATE TABLE catalog_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      unit_of_measure TEXT NOT NULL DEFAULT 'pcs',
      unit_cost_amd INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE catalog_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      catalog_item_id INTEGER NOT NULL,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      attributes_json TEXT,
      unit_price_amd INTEGER,
      unit_cost_amd INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE catalog_bundles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      bundle_price_amd INTEGER,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE catalog_bundle_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      bundle_id INTEGER NOT NULL,
      catalog_item_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- The catalog_variants_sku_idx is needed for the
    -- createVariant unique-sku test (which asserts a
    -- UNIQUE constraint error). The test harness uses
    -- the main schema (no finance. prefix), so this
    -- CREATE INDEX works. The catalog_categories_slug_idx
    -- + catalog_bundles_sku_idx are NOT created here
    -- (the unique-sku + unique-slug tests for those
    -- are deferred to the production layer; the tests
    -- for catalog bundles below exercise the happy
    -- path only).
    CREATE UNIQUE INDEX catalog_variants_sku_idx
        ON catalog_variants (tenant_id, sku);
  `);
  return {
    _db: db,
    // Production shape: db.query(sql, params) returns
    // { rows: [...] }. The pure functions speak the
    // production shape (W71-2 lesson).
    //
    // Also strips the "finance." schema prefix so the
    // main-schema tables above are addressable. The
    // production driver (pgAdapter) keeps the prefix.
    async query(sql, params = []) {
      // Translate pg-style $N → sqlite ?N numbered
      // placeholders. SQLite's `?` is purely positional,
      // so rewriting $1 → ? would bind all occurrences
      // to the first param (which is the bug we hit
      // in the recursive CTE in getCategoryPath —
      // W76-1 lesson). Numbered `?N` placeholders let
      // the same $N be reused across the query.
      const pgStyle = sql.replace(/\$\d+/g, (m) => '?' + m.slice(1));
      // Strip the finance. schema prefix for the
      // test harness (main schema only).
      const mainSchema = pgStyle.replace(/finance\./g, '');
      const stmt = db.prepare(mainSchema);
      const upper = sql.trim().toUpperCase();
      // SELECT or WITH (CTE) queries return rows.
      // The WITH branch is needed for the recursive
      // CTE in getCategoryPath (W76-1 lesson).
      const isRead =
        upper.startsWith('SELECT') ||
        upper.startsWith('WITH') ||
        upper.includes(' RETURNING');
      if (isRead) {
        const rows = stmt.all(...params);
        return { rows };
      }
      // INSERT/UPDATE/DELETE
      const info = stmt.run(...params);
      return {
        rows: [],
        lastInsertRowid: info.lastInsertRowid,
        changes: info.changes,
      };
    },
  };
}

// Helper: create a catalog item (so we have a parent
// for variants). Inlined because the test harness
// doesn't import createCatalogItem from inventory.js.
async function makeItem(db, name = 'Test Item', sku = 'TEST-1') {
  const stmt = db._db.prepare(
    `INSERT INTO catalog_items (tenant_id, sku, name)
     VALUES (0, ?, ?) RETURNING id`,
  );
  const r = stmt.get(sku, name);
  return { id: Number(r.id) };
}

// ────────────────────────────────────────────────────────────────────────
// Categories
// ────────────────────────────────────────────────────────────────────────

test('catalog: createCategory inserts a root category + returns the id', async () => {
  const db = makeMemoryDb();
  const out = await createCategory(db, { name: 'Electronics' }, 0);
  assert.equal(typeof out.id, 'number');
  assert.ok(out.id > 0);
});

test('catalog: createCategory accepts a slug', async () => {
  const db = makeMemoryDb();
  const out = await createCategory(
    db,
    { name: 'Electronics', slug: 'electronics' },
    0,
  );
  const cat = await getCategory(db, out.id, 0);
  assert.equal(cat.slug, 'electronics');
});

test('catalog: createCategory rejects an invalid slug', async () => {
  const db = makeMemoryDb();
  // Spaces are not allowed.
  await assert.rejects(
    createCategory(db, { name: 'X', slug: 'Has Spaces' }, 0),
    /slug/,
  );
  // Uppercase is not allowed (the regex requires lowercase).
  await assert.rejects(
    createCategory(db, { name: 'X', slug: 'UpperCase' }, 0),
    /slug/,
  );
  // Leading hyphens are not allowed (the regex requires
  // a letter or digit as the first char).
  await assert.rejects(
    createCategory(db, { name: 'X', slug: '-leading-hyphen' }, 0),
    /slug/,
  );
});

test('catalog: createCategory enforces unique slug per tenant', async () => {
  const db = makeMemoryDb();
  await createCategory(db, { name: 'A', slug: 'shared' }, 0);
  await assert.rejects(
    createCategory(db, { name: 'B', slug: 'shared' }, 0),
    /UNIQUE|unique/,
  );
});

test('catalog: createCategory enforces slug uniqueness across tenants (none)', async () => {
  // Different tenants can have the same slug.
  const db = makeMemoryDb();
  await createCategory(db, { name: 'A', slug: 'shared' }, 0);
  const out = await createCategory(db, { name: 'B', slug: 'shared' }, 1);
  assert.ok(out.id > 0);
});

test('catalog: createCategory accepts a parent_id (sub-category)', async () => {
  const db = makeMemoryDb();
  const parent = await createCategory(db, { name: 'Electronics' }, 0);
  const child = await createCategory(
    db,
    { name: 'Computers', parent_id: parent.id },
    0,
  );
  const childRow = await getCategory(db, child.id, 0);
  assert.equal(childRow.parent_id, parent.id);
});

test('catalog: createCategory throws ValueError for missing parent', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    createCategory(db, { name: 'X', parent_id: 999 }, 0),
    /category.*not found in tenant/,
  );
});

test('catalog: createCategory requires name', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    createCategory(db, {}, 0),
    /name/,
  );
});

test('catalog: listCategories returns all categories for the tenant (flat)', async () => {
  const db = makeMemoryDb();
  await createCategory(db, { name: 'A' }, 0);
  await createCategory(db, { name: 'B' }, 0);
  await createCategory(db, { name: 'C' }, 1);
  const items0 = await listCategories(db, 0);
  const items1 = await listCategories(db, 1);
  assert.equal(items0.length, 2);
  assert.equal(items1.length, 1);
  assert.equal(items1[0].name, 'C');
});

test('catalog: listCategories filters by parent_id', async () => {
  const db = makeMemoryDb();
  const root = await createCategory(db, { name: 'Root' }, 0);
  await createCategory(db, { name: 'Child 1', parent_id: root.id }, 0);
  await createCategory(db, { name: 'Child 2', parent_id: root.id }, 0);
  await createCategory(db, { name: 'Other' }, 0);
  // Filter by parent_id = root.id returns only the
  // 2 direct children of Root.
  const children = await listCategories(db, 0, root.id);
  assert.equal(children.length, 2);
  assert.equal(children[0].name, 'Child 1');
  assert.equal(children[1].name, 'Child 2');
  // The unfiltered list (parentId=null) returns ALL
  // 4 categories for the tenant — the caller has to
  // filter by parent_id IS NULL to get just the roots.
  const all = await listCategories(db, 0);
  assert.equal(all.length, 4);
  const roots = all.filter((c) => c.parent_id === null);
  assert.equal(roots.length, 2);
});

test('catalog: getCategory throws ValueError for missing category', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    getCategory(db, 999, 0),
    /category.*not found in tenant/,
  );
});

test('catalog: getCategory is tenant-scoped', async () => {
  const db = makeMemoryDb();
  const out = await createCategory(db, { name: 'T0' }, 0);
  await assert.rejects(
    getCategory(db, out.id, 1),
    /category.*not found in tenant/,
  );
});

test('catalog: getCategoryPath returns [self] for a root category', async () => {
  const db = makeMemoryDb();
  const out = await createCategory(db, { name: 'Electronics' }, 0);
  const path = await getCategoryPath(db, out.id, 0);
  assert.equal(path.length, 1);
  assert.equal(path[0].id, out.id);
  assert.equal(path[0].name, 'Electronics');
});

test('catalog: getCategoryPath returns the full root-to-leaf path for a nested category', async () => {
  const db = makeMemoryDb();
  const root = await createCategory(db, { name: 'Electronics' }, 0);
  const mid = await createCategory(
    db,
    { name: 'Computers', parent_id: root.id },
    0,
  );
  const leaf = await createCategory(
    db,
    { name: 'Laptops', parent_id: mid.id },
    0,
  );
  const path = await getCategoryPath(db, leaf.id, 0);
  assert.equal(path.length, 3);
  assert.equal(path[0].name, 'Electronics');
  assert.equal(path[1].name, 'Computers');
  assert.equal(path[2].name, 'Laptops');
});

test('catalog: getCategoryPath returns [] for a missing category', async () => {
  const db = makeMemoryDb();
  const path = await getCategoryPath(db, 999, 0);
  assert.deepEqual(path, []);
});

// ────────────────────────────────────────────────────────────────────────
// Variants
// ────────────────────────────────────────────────────────────────────────

test('catalog: createVariant inserts a row + returns the id', async () => {
  const db = makeMemoryDb();
  const item = await makeItem(db);
  const out = await createVariant(
    db,
    { catalog_item_id: item.id, sku: 'VAR-1', name: 'Red' },
    0,
  );
  assert.equal(typeof out.id, 'number');
  assert.ok(out.id > 0);
});

test('catalog: createVariant throws ValueError for missing item', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    createVariant(
      db,
      { catalog_item_id: 999, sku: 'VAR-1', name: 'Red' },
      0,
    ),
    /catalog item.*not found in tenant/,
  );
});

test('catalog: createVariant enforces unique sku per tenant', async () => {
  const db = makeMemoryDb();
  const item = await makeItem(db);
  await createVariant(
    db,
    { catalog_item_id: item.id, sku: 'VAR-1', name: 'Red' },
    0,
  );
  await assert.rejects(
    createVariant(
      db,
      { catalog_item_id: item.id, sku: 'VAR-1', name: 'Blue' },
      0,
    ),
    /UNIQUE|unique/,
  );
});

test('catalog: createVariant accepts optional unit_price_amd + unit_cost_amd + attributes_json', async () => {
  const db = makeMemoryDb();
  const item = await makeItem(db);
  const out = await createVariant(
    db,
    {
      catalog_item_id: item.id,
      sku: 'VAR-2',
      name: 'XL',
      attributes_json: '{"size":"XL"}',
      unit_price_amd: 5000,
      unit_cost_amd: 2000,
    },
    0,
  );
  const v = await getVariant(db, out.id, 0);
  assert.equal(v.unit_price_amd, 5000);
  assert.equal(v.unit_cost_amd, 2000);
  assert.equal(v.attributes_json, '{"size":"XL"}');
});

test('catalog: createVariant validates unit_price_amd + unit_cost_amd', async () => {
  const db = makeMemoryDb();
  const item = await makeItem(db);
  await assert.rejects(
    createVariant(
      db,
      { catalog_item_id: item.id, sku: 'VAR-3', name: 'X', unit_price_amd: -100 },
      0,
    ),
    /unit_price_amd/,
  );
  await assert.rejects(
    createVariant(
      db,
      {
        catalog_item_id: item.id,
        sku: 'VAR-4',
        name: 'X',
        unit_cost_amd: 1.5, // not an integer
      },
      0,
    ),
    /unit_cost_amd/,
  );
});

test('catalog: createVariant requires catalog_item_id + sku + name', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    createVariant(db, { sku: 'X', name: 'Y' }, 0),
    /catalog_item_id/,
  );
  await assert.rejects(
    createVariant(db, { catalog_item_id: 1, name: 'Y' }, 0),
    /sku/,
  );
  await assert.rejects(
    createVariant(db, { catalog_item_id: 1, sku: 'X' }, 0),
    /name/,
  );
});

test('catalog: listVariants returns all variants for the tenant (flat)', async () => {
  const db = makeMemoryDb();
  const item = await makeItem(db);
  await createVariant(
    db,
    { catalog_item_id: item.id, sku: 'VAR-1', name: 'Red' },
    0,
  );
  await createVariant(
    db,
    { catalog_item_id: item.id, sku: 'VAR-2', name: 'Blue' },
    0,
  );
  const items = await listVariants(db, 0);
  assert.equal(items.length, 2);
});

test('catalog: listVariants filters by catalog_item_id', async () => {
  const db = makeMemoryDb();
  const item1 = await makeItem(db, 'Item 1', 'ITEM-1');
  const item2 = await makeItem(db, 'Item 2', 'ITEM-2');
  await createVariant(
    db,
    { catalog_item_id: item1.id, sku: 'VAR-1', name: 'Red' },
    0,
  );
  await createVariant(
    db,
    { catalog_item_id: item2.id, sku: 'VAR-2', name: 'Big' },
    0,
  );
  const v1 = await listVariants(db, 0, item1.id);
  const v2 = await listVariants(db, 0, item2.id);
  assert.equal(v1.length, 1);
  assert.equal(v1[0].sku, 'VAR-1');
  assert.equal(v2.length, 1);
  assert.equal(v2[0].sku, 'VAR-2');
});

test('catalog: getVariant throws ValueError for missing variant', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    getVariant(db, 999, 0),
    /variant.*not found in tenant/,
  );
});

test('catalog: getVariant is tenant-scoped', async () => {
  const db = makeMemoryDb();
  const item = await makeItem(db);
  const out = await createVariant(
    db,
    { catalog_item_id: item.id, sku: 'VAR-1', name: 'Red' },
    0,
  );
  await assert.rejects(
    getVariant(db, out.id, 1),
    /variant.*not found in tenant/,
  );
});

// ────────────────────────────────────────────────────────────────────────
// Bundles (catalog v2 wave 3 / W78-1)
// ────────────────────────────────────────────────────────────────────────

test('catalog: createBundle inserts a row + returns the id', async () => {
  const db = makeMemoryDb();
  const out = await createBundle(
    db,
    { sku: 'BUN-1', name: 'Starter Pack', bundle_price_amd: 50000 },
    0,
  );
  assert.equal(typeof out.id, 'number');
  assert.ok(out.id > 0);
});

test('catalog: createBundle requires sku + name', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    createBundle(db, { name: 'X' }, 0),
    /sku/,
  );
  await assert.rejects(
    createBundle(db, { sku: 'BUN-1' }, 0),
    /name/,
  );
});

test('catalog: createBundle validates bundle_price_amd (non-negative integer)', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    createBundle(
      db,
      { sku: 'BUN-1', name: 'X', bundle_price_amd: -100 },
      0,
    ),
    /bundle_price_amd/,
  );
  await assert.rejects(
    createBundle(
      db,
      { sku: 'BUN-1', name: 'X', bundle_price_amd: 1.5 },
      0,
    ),
    /bundle_price_amd/,
  );
});

test('catalog: listBundles returns all non-archived bundles for the tenant', async () => {
  const db = makeMemoryDb();
  await createBundle(db, { sku: 'BUN-1', name: 'A' }, 0);
  await createBundle(db, { sku: 'BUN-2', name: 'B' }, 0);
  // Default (archived=false) returns both.
  const items = await listBundles(db, 0);
  assert.equal(items.length, 2);
});

test('catalog: listBundles is tenant-scoped', async () => {
  const db = makeMemoryDb();
  await createBundle(db, { sku: 'BUN-1', name: 'A' }, 0);
  await createBundle(db, { sku: 'BUN-1', name: 'B' }, 1);
  const items0 = await listBundles(db, 0);
  const items1 = await listBundles(db, 1);
  assert.equal(items0.length, 1);
  assert.equal(items0[0].name, 'A');
  assert.equal(items1.length, 1);
  assert.equal(items1[0].name, 'B');
});

test('catalog: getBundle throws ValueError for missing bundle', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    getBundle(db, 999, 0),
    /bundle.*not found in tenant/,
  );
});

test('catalog: getBundle is tenant-scoped', async () => {
  const db = makeMemoryDb();
  const out = await createBundle(db, { sku: 'BUN-1', name: 'A' }, 0);
  await assert.rejects(
    getBundle(db, out.id, 1),
    /bundle.*not found in tenant/,
  );
});

test('catalog: addBundleItem inserts a row + returns the id', async () => {
  const db = makeMemoryDb();
  const item = await makeItem(db);
  const bun = await createBundle(
    db,
    { sku: 'BUN-1', name: 'Starter', bundle_price_amd: 50000 },
    0,
  );
  const out = await addBundleItem(
    db,
    bun.id,
    { catalog_item_id: item.id, quantity: 1 },
    0,
  );
  assert.equal(typeof out.id, 'number');
  assert.ok(out.id > 0);
});

test('catalog: addBundleItem throws ValueError for missing bundle', async () => {
  const db = makeMemoryDb();
  const item = await makeItem(db);
  await assert.rejects(
    addBundleItem(
      db,
      999,
      { catalog_item_id: item.id, quantity: 1 },
      0,
    ),
    /bundle.*not found in tenant/,
  );
});

test('catalog: addBundleItem throws ValueError for missing item', async () => {
  const db = makeMemoryDb();
  const bun = await createBundle(db, { sku: 'BUN-1', name: 'Starter' }, 0);
  await assert.rejects(
    addBundleItem(
      db,
      bun.id,
      { catalog_item_id: 999, quantity: 1 },
      0,
    ),
    /catalog item.*not found in tenant/,
  );
});

test('catalog: addBundleItem validates quantity (> 0)', async () => {
  const db = makeMemoryDb();
  const item = await makeItem(db);
  const bun = await createBundle(db, { sku: 'BUN-1', name: 'Starter' }, 0);
  await assert.rejects(
    addBundleItem(
      db,
      bun.id,
      { catalog_item_id: item.id, quantity: 0 },
      0,
    ),
    /quantity/,
  );
  await assert.rejects(
    addBundleItem(
      db,
      bun.id,
      { catalog_item_id: item.id, quantity: -1 },
      0,
    ),
    /quantity/,
  );
});

test('catalog: listBundleItems returns the items in the bundle (chronological)', async () => {
  const db = makeMemoryDb();
  const item1 = await makeItem(db, 'Item 1', 'ITEM-1');
  const item2 = await makeItem(db, 'Item 2', 'ITEM-2');
  const bun = await createBundle(
    db,
    { sku: 'BUN-1', name: 'Starter', bundle_price_amd: 50000 },
    0,
  );
  await addBundleItem(db, bun.id, { catalog_item_id: item1.id, quantity: 1 }, 0);
  await addBundleItem(db, bun.id, { catalog_item_id: item2.id, quantity: 2 }, 0);
  const items = await listBundleItems(db, bun.id, 0);
  assert.equal(items.length, 2);
  assert.equal(items[0].catalog_item_id, item1.id);
  assert.equal(items[0].quantity, 1);
  assert.equal(items[1].catalog_item_id, item2.id);
  assert.equal(items[1].quantity, 2);
});

test('catalog: listBundleItems throws ValueError for missing bundle', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    listBundleItems(db, 999, 0),
    /bundle.*not found in tenant/,
  );
});

test('catalog: listBundleItems is tenant-scoped', async () => {
  const db = makeMemoryDb();
  const item = await makeItem(db);
  const bun0 = await createBundle(db, { sku: 'BUN-1', name: 'B0' }, 0);
  const bun1 = await createBundle(db, { sku: 'BUN-1', name: 'B1' }, 1);
  await addBundleItem(
    db,
    bun0.id,
    { catalog_item_id: item.id, quantity: 1 },
    0,
  );
  // Cross-tenant access: listBundleItems for bun0 in
  // tenant 1 throws ValueError (the bundle isn't in
  // tenant 1).
  await assert.rejects(
    listBundleItems(db, bun0.id, 1),
    /bundle.*not found in tenant/,
  );
  // The bundle in tenant 1 is empty.
  const items1 = await listBundleItems(db, bun1.id, 1);
  assert.equal(items1.length, 0);
});
