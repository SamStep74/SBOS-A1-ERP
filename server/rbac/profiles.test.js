// SBOS-A1-ERP RBAC Profiles — TDD test suite
//
// Phase 0.3: profiles are reusable role+permission-set bundles that
// admin can apply to a user in one shot. The catalog (roles.js,
// matrix.js) stays in code; profiles are tenant data.
//
// Public API under test (server/rbac/profiles.js):
//   createProfile(db, profile)   → row
//   getProfile(db, id)           → row | null
//   listProfiles(db)             → row[]
//   applyProfile(db, id, userId) → { role_assigned: bool, ps_assigned: [psId, ...] }
//   deleteProfile(db, id)        → void; throws ConflictError if applied
//
// Run with the project's standard command:
//   node --test --test-concurrency=4 --test-timeout=60000 server/rbac/profiles.test.js
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  createProfile,
  getProfile,
  listProfiles,
  applyProfile,
  deleteProfile,
  ValueError,
  ConflictError,
} from './profiles.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ───────────── Test harness ─────────────
//
// Each test gets a fresh in-memory node:sqlite DB with the rbac schema
// loaded from server/rbac/schema.sql. This is the same harness the wave
// 8 routes test uses, so the schema stays consistent with the routes
// tests, and profiles.js can read user_roles / user_permission_sets
// without any other setup.

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const schemaPath = join(__dirname, 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf8').replace(
    /,\s*--[^\n]*\n\s*PRIMARY KEY \(id, tenant_id\)\n\s*\);/m,
    '\n  );',
  );
  db.exec(schema);
  // Minimal users table — applyProfile's idempotency check needs to know
  // a user's tenant_id when writing user_roles / user_permission_sets.
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      email TEXT,
      role TEXT,
      tenant_id INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare(`INSERT INTO users (id, username, email, role, tenant_id) VALUES (?, ?, ?, ?, ?)`).run(
    1,
    'alice',
    'alice@example.com',
    'SalesRep',
    0,
  );
  db.prepare(`INSERT INTO users (id, username, email, role, tenant_id) VALUES (?, ?, ?, ?, ?)`).run(
    2,
    'bob',
    'bob@example.com',
    'SalesRep',
    7,
  );
  return db;
}

describe('createProfile — happy path + validation', () => {
  let db;
  before(() => {
    db = freshDb();
  });

  test('returns the inserted row with the supplied fields', () => {
    const row = createProfile(db, {
      id: 'SalesFloor',
      label: 'Sales Floor',
      description: 'Default for new sales reps',
      role_id: 'SalesRep',
      permission_set_ids: ['UserAdmin'],
    });
    assert.equal(row.id, 'SalesFloor');
    assert.equal(row.label, 'Sales Floor');
    assert.equal(row.description, 'Default for new sales reps');
    assert.equal(row.role_id, 'SalesRep');
    assert.deepEqual(row.permission_set_ids, ['UserAdmin']);
    assert.equal(row.tenant_id, 0);
    assert.equal(row.is_system, false);

    // And it's actually in the DB.
    const re = db
      .prepare(
        `SELECT id, label, description, role_id, permission_set_ids_json
         FROM sbos_rbac_profiles WHERE id = ?`,
      )
      .get('SalesFloor');
    assert.ok(re, 'row landed in sbos_rbac_profiles');
    assert.deepEqual(JSON.parse(re.permission_set_ids_json), ['UserAdmin']);
  });

  test('description is optional and defaults to empty string', () => {
    const row = createProfile(db, {
      id: 'BareBones',
      label: 'Bare Bones',
      role_id: 'SalesRep',
      permission_set_ids: [],
    });
    assert.equal(row.description, '');
    assert.deepEqual(row.permission_set_ids, []);
  });

  test('rejects a bad id (regex /^[A-Za-z][A-Za-z0-9_]{0,79}$/)', () => {
    const cases = [
      { id: '1starts-with-digit', why: 'must start with a letter' },
      { id: '-leading-dash', why: 'must start with a letter' },
      { id: 'has space', why: 'no whitespace' },
      { id: 'has.dot', why: 'no dot' },
      { id: 'has/slash', why: 'no slash' },
      { id: 'has$dollar', why: 'no special chars' },
      { id: '', why: 'empty' },
      { id: 'x'.repeat(81), why: 'too long (>80 chars)' },
    ];
    for (const c of cases) {
      assert.throws(
        () =>
          createProfile(db, {
            id: c.id,
            label: 'x',
            role_id: 'SalesRep',
            permission_set_ids: [],
          }),
        (err) => {
          assert.ok(
            err instanceof ValueError,
            `${c.why}: expected ValueError, got ${err && err.constructor && err.constructor.name}`,
          );
          return true;
        },
        `case "${c.why}" should throw`,
      );
    }
  });

  test('accepts uppercase, digits, and underscores in the id', () => {
    const row = createProfile(db, {
      id: 'CFO_v2_BACKUP',
      label: 'CFO backup',
      role_id: 'SalesRep',
      permission_set_ids: [],
    });
    assert.equal(row.id, 'CFO_v2_BACKUP');
  });

  test('rejects an unknown role_id', () => {
    assert.throws(
      () =>
        createProfile(db, {
          id: 'BogusRole',
          label: 'Bogus',
          role_id: 'NotARole',
          permission_set_ids: [],
        }),
      (err) => {
        assert.ok(err instanceof ValueError, 'should be ValueError');
        assert.match(err.message, /role/i);
        return true;
      },
    );
  });

  test('rejects an unknown permission_set_id', () => {
    assert.throws(
      () =>
        createProfile(db, {
          id: 'BogusPS',
          label: 'Bogus PS',
          role_id: 'SalesRep',
          permission_set_ids: ['NoSuchPS', 'UserAdmin'],
        }),
      (err) => {
        assert.ok(err instanceof ValueError, 'should be ValueError');
        assert.match(err.message, /permission.?set/i);
        return true;
      },
    );
  });

  test('rejects duplicate id (PK collision) with a ValueError', () => {
    createProfile(db, {
      id: 'DuplicateMe',
      label: 'first',
      role_id: 'SalesRep',
      permission_set_ids: [],
    });
    assert.throws(
      () =>
        createProfile(db, {
          id: 'DuplicateMe',
          label: 'second',
          role_id: 'SalesRep',
          permission_set_ids: [],
        }),
      (err) => {
        assert.ok(err instanceof ValueError, 'should be ValueError');
        return true;
      },
    );
  });

  test('rejects null, non-object, and array inputs', () => {
    for (const bad of [null, undefined, 'string', 42, ['array']]) {
      assert.throws(
        () => createProfile(db, bad),
        (err) => {
          assert.ok(err instanceof ValueError, `${JSON.stringify(bad)} → ValueError`);
          return true;
        },
      );
    }
  });

  test('rejects a missing label', () => {
    assert.throws(
      () =>
        createProfile(db, {
          id: 'NoLabel',
          role_id: 'SalesRep',
          permission_set_ids: [],
        }),
      (err) => {
        assert.ok(err instanceof ValueError);
        assert.match(err.message, /label/i);
        return true;
      },
    );
  });

  test('rejects a missing role_id', () => {
    assert.throws(
      () =>
        createProfile(db, {
          id: 'NoRole',
          label: 'No role',
          permission_set_ids: [],
        }),
      (err) => {
        assert.ok(err instanceof ValueError);
        assert.match(err.message, /role_id/i);
        return true;
      },
    );
  });

  test('rejects a non-string entry in permission_set_ids', () => {
    assert.throws(
      () =>
        createProfile(db, {
          id: 'NonStringPS',
          label: 'Non-string PS',
          role_id: 'SalesRep',
          permission_set_ids: ['UserAdmin', 42],
        }),
      (err) => {
        assert.ok(err instanceof ValueError);
        assert.match(err.message, /permission_set_ids/i);
        return true;
      },
    );
  });

  test('rejects when id+label+description total exceeds 200 chars', () => {
    // id: 10 + label: 100 + description: 100 = 210 > 200
    const bigLabel = 'L'.repeat(100);
    const bigDesc = 'D'.repeat(100);
    assert.throws(
      () =>
        createProfile(db, {
          id: 'TenCharsXX',
          label: bigLabel,
          description: bigDesc,
          role_id: 'SalesRep',
          permission_set_ids: [],
        }),
      (err) => {
        assert.ok(err instanceof ValueError);
        assert.match(err.message, /total/i);
        return true;
      },
    );
  });
});

describe('getProfile', () => {
  let db;
  before(() => {
    db = freshDb();
    createProfile(db, {
      id: 'GetMe',
      label: 'Get me',
      role_id: 'SalesRep',
      permission_set_ids: ['UserAdmin'],
    });
  });

  test('returns the row when it exists', () => {
    const row = getProfile(db, 'GetMe');
    assert.ok(row);
    assert.equal(row.id, 'GetMe');
    assert.equal(row.label, 'Get me');
    assert.deepEqual(row.permission_set_ids, ['UserAdmin']);
  });

  test('returns null when the id is unknown', () => {
    assert.equal(getProfile(db, 'NoSuch'), null);
  });
});

describe('listProfiles', () => {
  let db;
  before(() => {
    db = freshDb();
    createProfile(db, { id: 'A1', label: 'A1', role_id: 'SalesRep', permission_set_ids: [] });
    createProfile(db, { id: 'A2', label: 'A2', role_id: 'SalesRep', permission_set_ids: [] });
  });

  test('returns all rows for the tenant', () => {
    const rows = listProfiles(db);
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes('A1'));
    assert.ok(ids.includes('A2'));
    assert.equal(rows.length, 2);
  });

  test('rows include parsed permission_set_ids array', () => {
    const rows = listProfiles(db);
    for (const r of rows) {
      assert.ok(Array.isArray(r.permission_set_ids), `${r.id} has permission_set_ids array`);
    }
  });
});

describe('applyProfile', () => {
  let db;
  before(() => {
    db = freshDb();
    createProfile(db, {
      id: 'ApplyMe',
      label: 'Apply Me',
      role_id: 'SalesRep',
      permission_set_ids: ['UserAdmin'],
    });
  });

  test('assigns the profile role and PS to the user', () => {
    const result = applyProfile(db, 'ApplyMe', 1);
    assert.equal(result.role_assigned, true);
    assert.deepEqual(result.ps_assigned, ['UserAdmin']);

    // Role landed in sbos_rbac_user_roles.
    const role = db
      .prepare(`SELECT role_id, tenant_id FROM sbos_rbac_user_roles WHERE user_id = ?`)
      .get(1);
    assert.equal(role.role_id, 'SalesRep');
    assert.equal(role.tenant_id, 0);

    // PS landed in sbos_rbac_user_permission_sets.
    const ps = db
      .prepare(
        `SELECT permission_set_id, tenant_id FROM sbos_rbac_user_permission_sets WHERE user_id = ?`,
      )
      .get(1);
    assert.equal(ps.permission_set_id, 'UserAdmin');
    assert.equal(ps.tenant_id, 0);

    // Bookkeeping: sbos_rbac_user_profile has the link.
    const link = db
      .prepare(`SELECT profile_id, applied_by FROM sbos_rbac_user_profile WHERE user_id = ?`)
      .get(1);
    assert.equal(link.profile_id, 'ApplyMe');
    assert.equal(link.applied_by, 1);
  });

  test('is idempotent — re-applying does not duplicate or error', () => {
    // Use a fresh profile + a fresh user so the first apply in this
    // test really is the first apply (the prior test already applied
    // ApplyMe to user 1, so re-using it would skip the role grant).
    createProfile(db, {
      id: 'Idempotent',
      label: 'Idempotent',
      role_id: 'Accountant',
      permission_set_ids: ['UserAdmin'],
    });
    // Fresh user with no prior role/PS grants.
    db.prepare(
      `INSERT INTO users (id, username, email, role, tenant_id) VALUES (?, ?, ?, ?, ?)`,
    ).run(3, 'carol', 'carol@example.com', null, 0);
    const r1 = applyProfile(db, 'Idempotent', 3);
    const r2 = applyProfile(db, 'Idempotent', 3);
    // First call: role_assigned=true, ps_assigned has the new id.
    // Second call: ON CONFLICT DO NOTHING, so role_assigned=false and
    // ps_assigned is empty (no new grants).
    assert.equal(r1.role_assigned, true);
    assert.equal(r2.role_assigned, false);
    assert.deepEqual(r2.ps_assigned, []);

    // And there's only one row in user_roles / user_permission_sets.
    const roleCount = db
      .prepare(
        `SELECT COUNT(*) AS c FROM sbos_rbac_user_roles
          WHERE user_id = ? AND role_id = ?`,
      )
      .get(3, 'Accountant').c;
    assert.equal(roleCount, 1);
    const psCount = db
      .prepare(
        `SELECT COUNT(*) AS c FROM sbos_rbac_user_permission_sets
          WHERE user_id = ? AND permission_set_id = 'UserAdmin'`,
      )
      .get(3).c;
    assert.equal(psCount, 1);
  });

  test('returns ps_assigned = [] for role-only profile (no PSs)', () => {
    createProfile(db, {
      id: 'RoleOnly',
      label: 'Role only',
      role_id: 'SalesRep',
      permission_set_ids: [],
    });
    const r = applyProfile(db, 'RoleOnly', 2);
    assert.equal(r.role_assigned, true);
    assert.deepEqual(r.ps_assigned, []);
  });

  test("uses the user's tenant_id (not the profile tenant_id) for the link tables", () => {
    // user 2 has tenant_id = 7
    createProfile(db, {
      id: 'TenantHop',
      label: 'Tenant hop',
      role_id: 'SalesRep',
      permission_set_ids: ['UserAdmin'],
    });
    applyProfile(db, 'TenantHop', 2);
    const role = db.prepare(`SELECT tenant_id FROM sbos_rbac_user_roles WHERE user_id = ?`).get(2);
    assert.equal(role.tenant_id, 7, 'role row inherits user tenant_id');
    const link = db
      .prepare(`SELECT tenant_id FROM sbos_rbac_user_profile WHERE user_id = ?`)
      .get(2);
    assert.equal(link.tenant_id, 7, 'profile link inherits user tenant_id');
  });

  test('throws on unknown profile id', () => {
    assert.throws(() => applyProfile(db, 'NoSuchProfile', 1), /not.found|unknown/i);
  });

  test('throws on unknown user id', () => {
    assert.throws(() => applyProfile(db, 'ApplyMe', 99999), /user/i);
  });
});

describe('deleteProfile', () => {
  let db;
  before(() => {
    db = freshDb();
  });

  test('deletes the row when nobody has it applied', () => {
    createProfile(db, {
      id: 'Doomed',
      label: 'Doomed',
      role_id: 'SalesRep',
      permission_set_ids: [],
    });
    assert.ok(getProfile(db, 'Doomed'));
    deleteProfile(db, 'Doomed');
    assert.equal(getProfile(db, 'Doomed'), null);
  });

  test('refuses (409) when a user currently has the profile applied', () => {
    createProfile(db, {
      id: 'InUse',
      label: 'In use',
      role_id: 'SalesRep',
      permission_set_ids: ['UserAdmin'],
    });
    applyProfile(db, 'InUse', 1);
    let caught = null;
    try {
      deleteProfile(db, 'InUse');
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'should have thrown');
    assert.ok(
      caught instanceof ConflictError,
      'should be ConflictError, got ' + (caught && caught.constructor && caught.constructor.name),
    );
    assert.equal(caught.statusCode, 409);
    // Row is still there.
    assert.ok(getProfile(db, 'InUse'));
  });

  test('throws NotFound for an unknown id', () => {
    assert.throws(() => deleteProfile(db, 'NoSuch'), /not.found|unknown/i);
  });
});
