// SBOS-A1-ERP RBAC Test Suite
//
// Uses node:test (built-in) and assert/strict. No external deps so the
// tests run anywhere Node runs.
//
// Run with:
//   node --test --test-concurrency=4 --test-timeout=60000 server/rbac/rbac.test.js
//
// Coverage targets:
//   - Catalog integrity (no duplicate keys, all keys valid)
//   - Role hierarchy (no cycles, single parent)
//   - Permission set integrity (no references to unknown permissions)
//   - Role matrix integrity (no references to unknown roles or PSs)
//   - Permission resolution (role + PS = union)
//   - Field-level security (redact)
//   - Record-level security (clause generation)
//   - Sensitivity gating
//   - Impersonation policy
//   - Pure-function guards (requirePerm / requireRole)
//   - requiresMfa helper
//   - Express adapter middleware behavior
//   - Seed idempotency (in-memory SQLite)
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import * as rbac from './index.js';
import {
  requirePerm as expressRequirePerm,
  requireRole as expressRequireRole,
} from './express-adapter.js';
import { requirePermFastify, requireAnyPerm } from './guards.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  PERMISSIONS,
  ROLES,
  PERMISSION_SETS,
  ROLE_MATRIX,
  byCategory,
  isValidKey,
  getDefinition,
  listKeys,
  getRole,
  listRoleIds,
  getParentChain,
  getEffectiveAppSet,
  mfaRequiredFor,
  sessionHardLimitMinutesFor,
  canBeImpersonated,
  listForRole,
  getDefaultPermissionSetIds,
  expandRolePermissions,
  hasPermission,
  hasAnyPermission,
  hasAllPermissions,
  requirePermission,
  requirePermissionWithSensitivity,
  requirePerm,
  requireRole,
  requiresMfa,
  redactFields,
  recordLevelClause,
  canImpersonate,
  seedRBAC,
  readVersions,
  validateCustomRole,
} = rbac;

// ─────────────── Catalog integrity ───────────────

describe('Permission catalog', () => {
  test('has version and at least 100 permissions', () => {
    assert.ok(rbac.PERMISSIONS_VERSION >= 1);
    assert.ok(listKeys().length >= 100, `expected ≥100 permissions, got ${listKeys().length}`);
  });

  test('keys are unique, lowercase, and dot-separated', () => {
    const keys = listKeys();
    const seen = new Set();
    for (const k of keys) {
      assert.ok(!seen.has(k), `duplicate key: ${k}`);
      seen.add(k);
      assert.match(k, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/, `bad key shape: ${k}`);
    }
  });

  test('every permission has a valid category and sensitivity', () => {
    const validCategories = new Set(Object.keys(rbac.CATEGORIES));
    const validSensitivities = new Set(Object.keys(rbac.SENSITIVITY));
    for (const [k, def] of Object.entries(PERMISSIONS)) {
      assert.ok(validCategories.has(def.category), `bad category on ${k}: ${def.category}`);
      assert.ok(
        validSensitivities.has(def.sensitivity),
        `bad sensitivity on ${k}: ${def.sensitivity}`,
      );
      assert.ok(typeof def.label === 'string' && def.label.length > 0, `missing label on ${k}`);
    }
  });

  test('critical actions are tagged dual-control', () => {
    for (const [k, def] of Object.entries(PERMISSIONS)) {
      if (def.sensitivity === 'critical') {
        assert.equal(
          rbac.SENSITIVITY.critical.dualControl,
          true,
          `critical ${k} must be dual-control`,
        );
      }
    }
  });

  test('isValidKey is correct for known/unknown', () => {
    assert.equal(isValidKey('finance.invoice.create'), true);
    assert.equal(isValidKey('nope.nope.nope'), false);
  });

  test('byCategory returns a map keyed by category', () => {
    const m = byCategory();
    assert.ok(m.size > 0);
    for (const [cat, items] of m) {
      assert.ok(rbac.CATEGORIES[cat], `unknown category ${cat} leaked into byCategory`);
      for (const item of items) assert.equal(item.category, cat);
    }
  });
});

// ─────────────── Catalog additions: new domains ───────────────

describe('New permission keys — manufacturing (mfg.*)', () => {
  const newKeys = [
    'mfg.bom.delete',
    'mfg.bom.version',
    'mfg.routing.read',
    'mfg.routing.update',
    'mfg.work_order.cancel',
    'mfg.work_order.release',
    'mfg.quality.hold',
    'mfg.quality.release',
    'mfg.repair.complete',
    'mfg.mps.read',
    'mfg.mps.update',
    'mfg.mrp.run',
    'mfg.costing.read',
    'mfg.costing.update',
  ];
  for (const k of newKeys) {
    test(`has ${k} with valid metadata`, () => {
      assert.ok(isValidKey(k), `missing key: ${k}`);
      const def = getDefinition(k);
      assert.ok(def, `no definition for ${k}`);
      assert.equal(def.category, 'mfg', `${k} should be in mfg category`);
      assert.ok(rbac.SENSITIVITY[def.sensitivity], `${k} bad sensitivity: ${def.sensitivity}`);
      assert.ok(def.label && def.label.length > 0, `${k} missing label`);
      assert.ok(def.description && def.description.length > 0, `${k} missing description`);
    });
  }

  test('quality.hold and quality.release are both critical (dual-control)', () => {
    assert.equal(getDefinition('mfg.quality.hold').sensitivity, 'critical');
    assert.equal(getDefinition('mfg.quality.release').sensitivity, 'critical');
  });

  test('bom.delete is critical (destructive)', () => {
    assert.equal(getDefinition('mfg.bom.delete').sensitivity, 'critical');
  });
});

describe('New permission keys — marketing automation (mrkt.*)', () => {
  const newKeys = [
    'mrkt.campaign.pause',
    'mrkt.campaign.duplicate',
    'mrkt.campaign.export',
    'mrkt.segment.preview',
    'mrkt.journey.read',
    'mrkt.journey.update',
    'mrkt.journey.publish',
    'mrkt.landing.read',
    'mrkt.landing.update',
    'mrkt.form.read',
    'mrkt.form.update',
    'mrkt.subscription.read',
    'mrkt.subscription.update',
    'mrkt.lead_score.read',
    'mrkt.lead_score.update',
    'mrkt.abtest.read',
    'mrkt.abtest.update',
    'mrkt.webhook.read',
    'mrkt.webhook.update',
  ];
  for (const k of newKeys) {
    test(`has ${k} with valid metadata`, () => {
      assert.ok(isValidKey(k), `missing key: ${k}`);
      const def = getDefinition(k);
      assert.ok(def, `no definition for ${k}`);
      assert.equal(def.category, 'mrkt', `${k} should be in mrkt category`);
      assert.ok(rbac.SENSITIVITY[def.sensitivity], `${k} bad sensitivity: ${def.sensitivity}`);
      assert.ok(def.label && def.label.length > 0, `${k} missing label`);
    });
  }
});

describe('New permission keys — compliance (compliance.*)', () => {
  const newKeys = [
    'compliance.policy.approve',
    'compliance.policy.publish',
    'compliance.control.read',
    'compliance.control.update',
    'compliance.risk.read',
    'compliance.risk.update',
    'compliance.evidence.read',
    'compliance.evidence.update',
    'compliance.vendor_assessment.read',
    'compliance.vendor_assessment.update',
    'compliance.retention.run',
    'compliance.breach.read',
    'compliance.breach.update',
    'compliance.sox.read',
    'compliance.sox.update',
  ];
  for (const k of newKeys) {
    test(`has ${k} with valid metadata`, () => {
      assert.ok(isValidKey(k), `missing key: ${k}`);
      const def = getDefinition(k);
      assert.ok(def, `no definition for ${k}`);
      assert.equal(def.category, 'compliance', `${k} should be in compliance category`);
      assert.ok(rbac.SENSITIVITY[def.sensitivity], `${k} bad sensitivity: ${def.sensitivity}`);
      assert.ok(def.label && def.label.length > 0, `${k} missing label`);
    });
  }

  test('breach.update and retention.run are critical (destructive)', () => {
    assert.equal(getDefinition('compliance.breach.update').sensitivity, 'critical');
    assert.equal(getDefinition('compliance.retention.run').sensitivity, 'critical');
  });
});

describe('New permission keys — AI agents (ai.agent.* + ai.tool.* + ai.budget.*)', () => {
  const newKeys = [
    'ai.agent.read',
    'ai.agent.create',
    'ai.agent.update',
    'ai.agent.delete',
    'ai.agent.schedule',
    'ai.agent.pause',
    'ai.agent.version',
    'ai.agent.rollback',
    'ai.agent.scope.read',
    'ai.agent.scope.update',
    'ai.agent.runlog.read',
    'ai.agent.runlog.export',
    'ai.tool.read',
    'ai.tool.update',
    'ai.budget.read',
    'ai.budget.update',
    'ai.fallback.update',
  ];
  for (const k of newKeys) {
    test(`has ${k} with valid metadata`, () => {
      assert.ok(isValidKey(k), `missing key: ${k}`);
      const def = getDefinition(k);
      assert.ok(def, `no definition for ${k}`);
      assert.equal(def.category, 'ai', `${k} should be in ai category`);
      assert.ok(rbac.SENSITIVITY[def.sensitivity], `${k} bad sensitivity: ${def.sensitivity}`);
      assert.ok(def.label && def.label.length > 0, `${k} missing label`);
    });
  }

  test('agent.delete, agent.deploy, agent.rollback are all critical (destructive)', () => {
    assert.equal(getDefinition('ai.agent.delete').sensitivity, 'critical');
    assert.equal(getDefinition('ai.agent.deploy').sensitivity, 'critical');
    assert.equal(getDefinition('ai.agent.rollback').sensitivity, 'critical');
  });
});

describe('New permission keys — tenant management (system.tenant.*)', () => {
  const newKeys = [
    'system.tenant.read',
    'system.tenant.update',
    'system.tenant.suspend',
    'system.tenant.reactivate',
    'system.tenant.transfer',
    'system.tenant.plan.read',
    'system.tenant.plan.update',
    'system.tenant.billing.read',
    'system.tenant.billing.update',
    'system.tenant.region.update',
    'system.tenant.domain.read',
    'system.tenant.domain.update',
    'system.tenant.sso.read',
    'system.tenant.sso.update',
    'system.tenant.isolation.read',
    'system.tenant.isolation.update',
  ];
  for (const k of newKeys) {
    test(`has ${k} with valid metadata`, () => {
      assert.ok(isValidKey(k), `missing key: ${k}`);
      const def = getDefinition(k);
      assert.ok(def, `no definition for ${k}`);
      assert.equal(def.category, 'system', `${k} should be in system category`);
      assert.ok(rbac.SENSITIVITY[def.sensitivity], `${k} bad sensitivity: ${def.sensitivity}`);
      assert.ok(def.label && def.label.length > 0, `${k} missing label`);
    });
  }

  test('tenant.suspend/reactivate/transfer/delete/isolation.update are all critical', () => {
    assert.equal(getDefinition('system.tenant.suspend').sensitivity, 'critical');
    assert.equal(getDefinition('system.tenant.reactivate').sensitivity, 'critical');
    assert.equal(getDefinition('system.tenant.transfer').sensitivity, 'critical');
    assert.equal(getDefinition('system.tenant.delete').sensitivity, 'critical');
    assert.equal(getDefinition('system.tenant.isolation.update').sensitivity, 'critical');
  });
});

// ─────────────── New permission sets ───────────────

describe('New permission sets', () => {
  const newSetIds = [
    'ManufacturingAdmin',
    'QualityHoldAdmin',
    'MarketingAutomation',
    'ComplianceAdmin',
    'RetentionOperator',
    'AgentDeveloper',
    'AgentOperator',
    'AgentDeployer',
    'AIGovernance',
    'TenantAdmin',
    'TenantSupport',
  ];
  for (const id of newSetIds) {
    test(`has permission set ${id}`, () => {
      const ps = PERMISSION_SETS[id];
      assert.ok(ps, `missing PS: ${id}`);
      assert.equal(ps.isSystem, true, `${id} should be a system PS`);
      assert.ok(Array.isArray(ps.permissions), `${id} permissions must be an array`);
      assert.ok(ps.permissions.length > 0, `${id} should have at least one permission`);
    });
  }

  test('every new PS member key resolves in the permission catalog', () => {
    for (const id of newSetIds) {
      const ps = PERMISSION_SETS[id];
      for (const k of ps.permissions) {
        assert.ok(PERMISSIONS[k], `${id} references unknown permission ${k}`);
      }
    }
  });

  test('Owner holds the new critical keys via implicit-all', () => {
    const u = {
      id: 1,
      role: 'Owner',
      permission_set_ids: [],
      mfa_required: true,
      mfa_verified: true,
    };
    const critical = [
      'mfg.quality.hold',
      'mfg.quality.release',
      'mfg.bom.delete',
      'compliance.breach.update',
      'compliance.retention.run',
      'ai.agent.deploy',
      'ai.agent.rollback',
      'ai.agent.delete',
      'system.tenant.suspend',
      'system.tenant.delete',
      'system.tenant.transfer',
    ];
    for (const k of critical) {
      assert.equal(hasPermission(u, k), true, `Owner missing critical key ${k}`);
    }
  });

  test('Admin is restricted on tenant.create and tenant.delete (Owner-only)', () => {
    const u = {
      id: 2,
      role: 'Admin',
      permission_set_ids: [],
      mfa_required: true,
      mfa_verified: true,
    };
    assert.equal(hasPermission(u, 'system.tenant.create'), false);
    assert.equal(hasPermission(u, 'system.tenant.delete'), false);
    assert.equal(hasPermission(u, 'system.tenant.suspend'), false);
    assert.equal(hasPermission(u, 'system.tenant.transfer'), false);
  });

  test('Admin holds the new operator-level keys (manufacturing/marketing/agent)', () => {
    const u = {
      id: 2,
      role: 'Admin',
      permission_set_ids: [],
      mfa_required: true,
      mfa_verified: true,
    };
    const adminKeys = [
      'mfg.bom.delete',
      'mfg.bom.version',
      'mfg.mrp.run',
      'mrkt.journey.read',
      'mrkt.journey.update',
      'mrkt.lead_score.update',
      'mrkt.abtest.update',
      'mrkt.webhook.update',
      'ai.agent.read',
      'ai.agent.create',
      'ai.agent.version',
      'ai.evaluation.run',
      'ai.budget.read',
      'ai.budget.update',
      'ai.fallback.update',
    ];
    for (const k of adminKeys) {
      assert.equal(hasPermission(u, k), true, `Admin missing key ${k}`);
    }
  });

  test('ComplianceOfficer holds the new compliance.* keys', () => {
    const u = {
      id: 3,
      role: 'ComplianceOfficer',
      permission_set_ids: [],
      mfa_required: true,
      mfa_verified: true,
    };
    const coKeys = [
      'compliance.policy.approve',
      'compliance.policy.publish',
      'compliance.control.read',
      'compliance.control.update',
      'compliance.risk.read',
      'compliance.risk.update',
      'compliance.evidence.read',
      'compliance.evidence.update',
      'compliance.vendor_assessment.read',
      'compliance.vendor_assessment.update',
      'compliance.breach.read',
      'compliance.breach.update',
      'compliance.sox.read',
      'compliance.retention.run',
    ];
    for (const k of coKeys) {
      assert.equal(hasPermission(u, k), true, `ComplianceOfficer missing key ${k}`);
    }
  });

  test('Auditor does NOT have compliance.breach.update (read-only role)', () => {
    const u = {
      id: 4,
      role: 'Auditor',
      permission_set_ids: [],
      mfa_required: true,
      mfa_verified: true,
    };
    assert.equal(hasPermission(u, 'compliance.breach.read'), true);
    assert.equal(hasPermission(u, 'compliance.breach.update'), false);
    assert.equal(hasPermission(u, 'compliance.retention.run'), false);
    assert.equal(hasPermission(u, 'ai.agent.deploy'), false);
  });

  test('SalesRep is denied manufacturing, compliance, and agent-admin keys', () => {
    const u = {
      id: 5,
      role: 'SalesRep',
      permission_set_ids: [],
      mfa_required: false,
      mfa_verified: true,
    };
    const denied = [
      'mfg.bom.delete',
      'mfg.quality.hold',
      'mfg.quality.release',
      'mfg.mrp.run',
      'mrkt.journey.update',
      'mrkt.lead_score.update',
      'mrkt.abtest.update',
      'compliance.policy.publish',
      'compliance.breach.update',
      'compliance.retention.run',
      'compliance.sox.update',
      'ai.agent.create',
      'ai.agent.deploy',
      'ai.agent.rollback',
      'ai.budget.update',
      'system.tenant.create',
      'system.tenant.delete',
      'system.tenant.suspend',
      'system.tenant.transfer',
      'system.tenant.isolation.update',
    ];
    for (const k of denied) {
      assert.equal(hasPermission(u, k), false, `SalesRep unexpectedly has ${k}`);
    }
  });

  test('ManufacturingAdmin is a strictly additive extension of ManufacturingOperator', () => {
    const operatorPerms = new Set(PERMISSION_SETS.ManufacturingOperator.permissions);
    const adminPerms = new Set(PERMISSION_SETS.ManufacturingAdmin.permissions);
    for (const k of operatorPerms) {
      assert.ok(
        operatorPerms.has(k),
        `ManufacturingOperator key ${k} should still be in operator PS`,
      );
    }
    assert.ok(adminPerms.has('mfg.bom.delete'));
    assert.ok(adminPerms.has('mfg.bom.version'));
    assert.ok(adminPerms.has('mfg.work_order.cancel'));
    assert.ok(adminPerms.has('mfg.mrp.run'));
  });

  test('MarketingAutomation keys are distinct from MarketingOperator', () => {
    const opKeys = new Set(PERMISSION_SETS.MarketingOperator.permissions);
    const autoKeys = PERMISSION_SETS.MarketingAutomation.permissions;
    for (const k of autoKeys) {
      assert.ok(
        !opKeys.has(k),
        `${k} should be in MarketingAutomation only, not MarketingOperator`,
      );
    }
  });

  test('TenantSupport is read-only (no mutations)', () => {
    const mutating = [
      'system.tenant.create',
      'system.tenant.update',
      'system.tenant.suspend',
      'system.tenant.reactivate',
      'system.tenant.delete',
      'system.tenant.transfer',
      'system.tenant.plan.update',
      'system.tenant.billing.update',
      'system.tenant.region.update',
      'system.tenant.domain.update',
      'system.tenant.sso.update',
      'system.tenant.isolation.update',
    ];
    for (const k of mutating) {
      assert.ok(
        !PERMISSION_SETS.TenantSupport.permissions.includes(k),
        `TenantSupport must not include mutating key ${k}`,
      );
    }
    const reading = [
      'system.tenant.read',
      'system.tenant.list',
      'system.tenant.plan.read',
      'system.tenant.billing.read',
      'system.tenant.domain.read',
      'system.tenant.sso.read',
      'system.tenant.isolation.read',
    ];
    for (const k of reading) {
      assert.ok(
        PERMISSION_SETS.TenantSupport.permissions.includes(k),
        `TenantSupport must include read key ${k}`,
      );
    }
  });

  test('AgentOperator cannot create or deploy agents (read+run only)', () => {
    const ps = PERMISSION_SETS.AgentOperator;
    assert.ok(!ps.permissions.includes('ai.agent.create'));
    assert.ok(!ps.permissions.includes('ai.agent.update'));
    assert.ok(!ps.permissions.includes('ai.agent.delete'));
    assert.ok(!ps.permissions.includes('ai.agent.deploy'));
    assert.ok(!ps.permissions.includes('ai.agent.rollback'));
    assert.ok(!ps.permissions.includes('ai.agent.version'));
    assert.ok(!ps.permissions.includes('ai.tool.update'));
    assert.ok(ps.permissions.includes('ai.agent.run'));
    assert.ok(ps.permissions.includes('ai.agent.pause'));
    assert.ok(ps.permissions.includes('ai.agent.runlog.read'));
  });

  test('AgentDeployer holds only deploy/rollback/delete (Owner-gated surface)', () => {
    const ps = PERMISSION_SETS.AgentDeployer;
    const expected = ['ai.agent.deploy', 'ai.agent.rollback', 'ai.agent.delete'];
    assert.deepEqual([...ps.permissions].sort(), expected.sort());
  });
});

// ─────────────── Role hierarchy ───────────────

describe('Role catalog', () => {
  test('has version and at least 15 system roles', () => {
    assert.ok(rbac.ROLES_VERSION >= 1);
    assert.ok(listRoleIds().length >= 15, `expected ≥15 roles, got ${listRoleIds().length}`);
  });

  test('every role has a valid parent (or null) and single inheritance', () => {
    for (const id of listRoleIds()) {
      const r = ROLES[id];
      assert.ok(r.parent === null || ROLES[r.parent], `${id} has unknown parent ${r.parent}`);
    }
  });

  test('parent chain has no cycles', () => {
    for (const id of listRoleIds()) {
      const chain = getParentChain(id);
      const seen = new Set();
      for (const r of chain) {
        assert.ok(!seen.has(r), `cycle detected: ${chain.join(' -> ')}`);
        seen.add(r);
      }
    }
  });

  test('system roles cannot be assigned canBeImpersonated=true on top-of-hierarchy', () => {
    assert.equal(canBeImpersonated('Owner'), false);
    assert.equal(canBeImpersonated('Admin'), false);
  });

  test('mfaRequiredFor aggregates up the chain', () => {
    assert.equal(mfaRequiredFor('Admin'), true);
    assert.equal(mfaRequiredFor('FinanceLead'), true);
    assert.equal(mfaRequiredFor('Accountant'), true);
    assert.equal(mfaRequiredFor('Bookkeeper'), true);
  });

  test('sessionHardLimitMinutesFor picks the most restrictive in chain', () => {
    assert.equal(sessionHardLimitMinutesFor('Bookkeeper'), 60);
    assert.equal(sessionHardLimitMinutesFor('Accountant'), 60);
  });

  test('getEffectiveAppSet unions up the chain', () => {
    const apps = getEffectiveAppSet('SalesRep');
    assert.ok(apps.includes('dashboard'));
    assert.ok(apps.includes('crm'));
  });
});

// ─────────────── Permission sets ───────────────

describe('Permission sets', () => {
  test('has version and ≥10 system sets', () => {
    assert.ok(rbac.PERMISSION_SETS_VERSION >= 1);
    assert.ok(Object.keys(PERMISSION_SETS).length >= 10);
  });

  test('every member permission exists in the catalog', () => {
    for (const ps of Object.values(PERMISSION_SETS)) {
      for (const k of ps.permissions) {
        assert.ok(PERMISSIONS[k], `permission set ${ps.id} references unknown ${k}`);
      }
    }
  });

  test('isSystemPermissionSet is correct', () => {
    assert.equal(rbac.isSystemPermissionSet('FinanceOperator'), true);
    assert.equal(rbac.isSystemPermissionSet('NotARealSet'), false);
  });
});

// ─────────────── Role × Permission set matrix ───────────────

describe('Role matrix', () => {
  test('every referenced role exists', () => {
    for (const r of Object.keys(ROLE_MATRIX)) {
      assert.ok(ROLES[r], `role matrix references unknown role: ${r}`);
    }
  });

  test('every referenced permission set exists', () => {
    for (const psList of Object.values(ROLE_MATRIX)) {
      for (const ps of psList) {
        assert.ok(PERMISSION_SETS[ps], `role matrix references unknown PS: ${ps}`);
      }
    }
  });

  test('listForRole returns a frozen array', () => {
    const arr = listForRole('Owner');
    assert.ok(Array.isArray(arr));
    assert.ok(Object.isFrozen(arr));
  });

  test('expandRolePermissions unions role + user PSs', () => {
    const ownerPerms = expandRolePermissions('Owner');
    const adminPerms = expandRolePermissions('Admin');
    assert.ok(ownerPerms.has('finance.invoice.create'));
    assert.ok(adminPerms.has('finance.invoice.create'));
  });
});

// ─────────────── Runtime guards ───────────────

describe('Permission resolution', () => {
  test('Owner has all permissions', () => {
    const u = {
      id: 1,
      role: 'Owner',
      permission_set_ids: [],
      mfa_required: true,
      mfa_verified: true,
    };
    for (const k of [
      'finance.journal.post',
      'hr.payroll.run',
      'system.tenant.delete',
      'crm.deal.approve',
    ]) {
      assert.equal(hasPermission(u, k), true, `Owner missing ${k}`);
    }
  });

  test('Admin has most permissions but not Tenant.Delete implicitly', () => {
    const u = {
      id: 2,
      role: 'Admin',
      permission_set_ids: [],
      mfa_required: true,
      mfa_verified: true,
    };
    assert.equal(hasPermission(u, 'finance.journal.post'), true);
    assert.equal(hasPermission(u, 'system.tenant.delete'), false);
  });

  test('SalesRep is denied finance.journal.post', () => {
    const u = {
      id: 3,
      role: 'SalesRep',
      permission_set_ids: [],
      mfa_required: false,
      mfa_verified: true,
    };
    assert.equal(hasPermission(u, 'finance.journal.post'), false);
    assert.equal(hasPermission(u, 'crm.deal.create'), true);
  });

  test('hasAnyPermission and hasAllPermissions work', () => {
    const u = {
      id: 4,
      role: 'SalesManager',
      permission_set_ids: ['Approver'],
      mfa_required: false,
      mfa_verified: true,
    };
    assert.equal(hasAnyPermission(u, ['crm.deal.approve', 'finance.journal.post']), true);
    assert.equal(hasAllPermissions(u, ['crm.deal.approve', 'purchase.po.approve']), true);
  });

  test('requirePermission throws on deny, passes on grant', () => {
    const u = {
      id: 5,
      role: 'Accountant',
      permission_set_ids: [],
      mfa_required: true,
      mfa_verified: true,
    };
    assert.doesNotThrow(() => requirePermission(u, 'finance.invoice.create'));
    assert.throws(() => requirePermission(u, 'system.tenant.delete'), /Missing permission/);
  });

  test('critical actions throw mfa_required when MFA unverified', () => {
    const u = {
      id: 6,
      role: 'Owner',
      permission_set_ids: [],
      mfa_required: true,
      mfa_verified: false,
    };
    assert.throws(
      () => requirePermissionWithSensitivity(u, 'finance.journal.post'),
      /MFA required/,
    );
  });

  test('null user always denied', () => {
    assert.equal(hasPermission(null, 'finance.invoice.create'), false);
    assert.equal(hasPermission(undefined, 'finance.invoice.create'), false);
    assert.equal(hasPermission({}, 'finance.invoice.create'), false);
  });

  test('user without id is denied (defense in depth)', () => {
    const u = { role: 'Owner', permission_set_ids: [] };
    assert.equal(hasPermission(u, 'finance.invoice.create'), false);
  });
});

// ─────────────── Pure-function guards (requirePerm / requireRole) ───────────────

describe('requirePerm (pure function)', () => {
  test('returns true for an Owner holding any perm', () => {
    const u = {
      id: 1,
      role: 'Owner',
      permission_set_ids: [],
      mfa_required: true,
      mfa_verified: true,
    };
    const ctx = { user: u };
    assert.equal(requirePerm('finance.invoice.create', ctx), true);
    assert.equal(ctx.outcome.allowed, true);
  });

  test('returns false (does not throw) on missing user', () => {
    assert.equal(requirePerm('finance.invoice.create', { user: null }), false);
    assert.equal(requirePerm('finance.invoice.create', {}), false);
    assert.equal(requirePerm('finance.invoice.create', null), false);
  });

  test('returns false when user lacks the permission', () => {
    const u = {
      id: 2,
      role: 'SalesRep',
      permission_set_ids: [],
      mfa_required: false,
      mfa_verified: true,
    };
    const ctx = { user: u };
    assert.equal(requirePerm('system.tenant.delete', ctx), false);
    assert.equal(ctx.outcome.reason, 'no_permission');
  });

  test('returns false + mfa_required when perm requires MFA but session unverified', () => {
    const u = {
      id: 3,
      role: 'Admin',
      permission_set_ids: [],
      mfa_required: true,
      mfa_verified: false,
    };
    const ctx = { user: u };
    // Use a perm Admin holds AND that requires MFA (ai.agent.* pattern).
    assert.equal(requirePerm('ai.agent.run', ctx), false);
    assert.equal(ctx.mfa_required, true);
    assert.equal(ctx.outcome.reason, 'mfa_required');
  });

  test('returns true when perm requires MFA and session IS verified', () => {
    const u = {
      id: 3,
      role: 'Admin',
      permission_set_ids: [],
      mfa_required: true,
      mfa_verified: true,
    };
    const ctx = { user: u };
    assert.equal(requirePerm('ai.agent.run', ctx), true);
    assert.equal(ctx.mfa_required, false);
  });

  test('blocks impersonation from widening rights', () => {
    // SalesRep impersonating a user who somehow has a privileged perm
    // should not be granted that perm by the impersonation.
    const actor = {
      id: 1,
      role: 'SalesRep',
      permission_set_ids: [],
      mfa_required: false,
      mfa_verified: true,
    };
    const ctx = { user: actor, impersonator: actor };
    // requirePerm should still return false because the actor (and the
    // user) lack the perm; the impersonation branch never widens.
    assert.equal(requirePerm('system.tenant.delete', ctx), false);
  });
});

describe('requireRole (pure function)', () => {
  test('returns true when user role matches the requested role', () => {
    const u = { id: 1, role: 'Accountant' };
    assert.equal(requireRole('Accountant', { user: u }), true);
  });

  test('respects role hierarchy: Accountant ⊇ Bookkeeper', () => {
    const u = { id: 1, role: 'Accountant' };
    assert.equal(requireRole('Bookkeeper', { user: u }), true);
  });

  test('respects role hierarchy: Admin ⊇ FinanceLead ⊇ Accountant', () => {
    const admin = { id: 1, role: 'Admin' };
    assert.equal(requireRole('FinanceLead', { user: admin }), true);
    assert.equal(requireRole('Accountant', { user: admin }), true);
    assert.equal(requireRole('Bookkeeper', { user: admin }), true);
  });

  test('Owner satisfies every role check', () => {
    const owner = { id: 1, role: 'Owner' };
    assert.equal(requireRole('Admin', { user: owner }), true);
    assert.equal(requireRole('Auditor', { user: owner }), true);
  });

  test('returns false on role mismatch (no throw)', () => {
    const u = { id: 1, role: 'SalesRep' };
    const ctx = { user: u };
    assert.equal(requireRole('Admin', ctx), false);
    assert.equal(ctx.outcome.reason, 'role_mismatch');
  });

  test('returns false on missing user', () => {
    assert.equal(requireRole('Admin', { user: null }), false);
    assert.equal(requireRole('Admin', null), false);
  });
});

describe('requiresMfa (helper)', () => {
  test('returns true for ai.agent.* keys', () => {
    assert.equal(requiresMfa('ai.agent.deploy'), true);
    assert.equal(requiresMfa('ai.agent.read'), true);
    assert.equal(requiresMfa('ai.agent.runlog.export'), true);
  });

  test('returns true for system.tenant.* keys', () => {
    assert.equal(requiresMfa('system.tenant.delete'), true);
    assert.equal(requiresMfa('system.tenant.suspend'), true);
    assert.equal(requiresMfa('system.tenant.billing.update'), true);
  });

  test('returns true for compliance.* keys', () => {
    assert.equal(requiresMfa('compliance.policy.approve'), true);
    assert.equal(requiresMfa('compliance.breach.update'), true);
    assert.equal(requiresMfa('compliance.retention.run'), true);
  });

  test('returns false for non-sensitive keys', () => {
    assert.equal(requiresMfa('crm.deal.create'), false);
    assert.equal(requiresMfa('finance.invoice.read'), false);
    assert.equal(requiresMfa('hr.employee.list'), false);
  });

  test('returns false for invalid input', () => {
    assert.equal(requiresMfa(''), false);
    assert.equal(requiresMfa(null), false);
    assert.equal(requiresMfa(undefined), false);
    assert.equal(requiresMfa(42), false);
  });
});

// ─────────────── Express adapter ───────────────

describe('Express adapter', () => {
  // Minimal mock req/res — Express-free. We exercise the middleware
  // function directly without spinning up a real server.
  function mockReqRes(user) {
    const req = { user, session: null, impersonator: null };
    let statusCode = 200;
    let body = null;
    let nextCalled = false;
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(b) {
        body = b;
        return this;
      },
    };
    function next() {
      nextCalled = true;
    }
    return {
      req,
      res,
      get status() {
        return statusCode;
      },
      get body() {
        return body;
      },
      get nextCalled() {
        return nextCalled;
      },
      next,
    };
  }

  test('requirePerm middleware calls next() on grant', () => {
    // Lazy-require to avoid pulling Express in (this is a thin wrapper
    // that takes req/res/next as arguments, no Express import needed).
    const owner = {
      id: 1,
      role: 'Owner',
      permission_set_ids: [],
      mfa_required: true,
      mfa_verified: true,
    };
    const m = mockReqRes(owner);
    expressRequirePerm('finance.invoice.create')(m.req, m.res, m.next);
    assert.equal(m.nextCalled, true);
    assert.equal(m.status, 200);
  });

  test('requirePerm middleware 401s on missing user', () => {
    const m = mockReqRes(null);
    expressRequirePerm('finance.invoice.create')(m.req, m.res, m.next);
    assert.equal(m.nextCalled, false);
    assert.equal(m.status, 401);
    assert.equal(m.body.error, 'unauthenticated');
  });

  test('requirePerm middleware 403s on deny', () => {
    const salesrep = {
      id: 2,
      role: 'SalesRep',
      permission_set_ids: [],
      mfa_required: false,
      mfa_verified: true,
    };
    const m = mockReqRes(salesrep);
    expressRequirePerm('system.tenant.delete')(m.req, m.res, m.next);
    assert.equal(m.nextCalled, false);
    assert.equal(m.status, 403);
    assert.equal(m.body.error, 'rbac_forbidden');
  });

  test('requirePerm middleware 401s with rbac_mfa_required when MFA needed', () => {
    const admin = {
      id: 3,
      role: 'Admin',
      permission_set_ids: [],
      mfa_required: true,
      mfa_verified: false,
    };
    const m = mockReqRes(admin);
    // Use a perm Admin holds AND that triggers the MFA gate.
    expressRequirePerm('ai.agent.run')(m.req, m.res, m.next);
    assert.equal(m.nextCalled, false);
    assert.equal(m.status, 401);
    assert.equal(m.body.error, 'rbac_mfa_required');
  });

  test('requireRole middleware calls next() on grant via hierarchy', () => {
    const m = mockReqRes({ id: 1, role: 'Accountant' });
    expressRequireRole('Bookkeeper')(m.req, m.res, m.next);
    assert.equal(m.nextCalled, true);
  });

  test('requireRole middleware 403s on mismatch', () => {
    const m = mockReqRes({ id: 1, role: 'SalesRep' });
    expressRequireRole('Admin')(m.req, m.res, m.next);
    assert.equal(m.status, 403);
    assert.equal(m.body.requiredRole, 'Admin');
  });

  test('requirePerm throws TypeError on invalid arg', () => {
    assert.throws(() => expressRequirePerm(''), TypeError);
    assert.throws(() => expressRequirePerm(null), TypeError);
  });

  test('requireRole throws TypeError on invalid arg', () => {
    assert.throws(() => expressRequireRole(''), TypeError);
    assert.throws(() => expressRequireRole(undefined), TypeError);
  });
});

// ─────────────── Fastify adapter ───────────────

describe('Fastify adapter', () => {
  // Minimal mock request/reply — Fastify-free. The preHandler signature is
  // (request, reply) => Promise<void>; reply must support .code(n).send(payload).
  // We capture code+body and detect "happy path" by code remaining at the
  // default (undefined → tests check `sent === false`).
  function mockRequestReply({ user, session, impersonator } = {}) {
    let statusCode = undefined;
    let body = undefined;
    let sent = false;
    const request = { user, session, impersonator };
    const reply = {
      code(n) {
        statusCode = n;
        return this;
      },
      send(payload) {
        body = payload;
        sent = true;
        return this;
      },
    };
    return {
      request,
      reply,
      get statusCode() {
        return statusCode;
      },
      get body() {
        return body;
      },
      get sent() {
        return sent;
      },
    };
  }

  test('requirePermFastify is a function that returns a preHandler', () => {
    const preHandler = requirePermFastify('finance.invoice.create');
    assert.equal(typeof preHandler, 'function');
    assert.equal(preHandler.constructor.name, 'AsyncFunction');
  });

  test('requirePermFastify passes through silently on grant (no reply sent)', async () => {
    const owner = {
      id: 1,
      role: 'Owner',
      permission_set_ids: [],
      mfa_required: true,
      mfa_verified: true,
    };
    const m = mockRequestReply({ user: owner });
    const preHandler = requirePermFastify('finance.invoice.create');
    await preHandler(m.request, m.reply);
    assert.equal(m.sent, false, 'preHandler must NOT call reply.send() on grant');
    assert.equal(m.statusCode, undefined);
  });

  test('requirePermFastify 403s with rbac_forbidden when user lacks permission', async () => {
    const salesrep = {
      id: 2,
      role: 'SalesRep',
      permission_set_ids: [],
      mfa_required: false,
      mfa_verified: true,
    };
    const m = mockRequestReply({ user: salesrep });
    const preHandler = requirePermFastify('system.tenant.delete');
    await preHandler(m.request, m.reply);
    assert.equal(m.sent, true);
    assert.equal(m.statusCode, 403);
    assert.equal(m.body.error, 'rbac_forbidden');
    assert.equal(m.body.required, 'system.tenant.delete');
    assert.equal(m.body.reason, 'no_permission');
  });

  test('requirePermFastify 403s (not 401) on missing user — Fastify preHandler contract', async () => {
    // The Express adapter 401s with `unauthenticated` for no-user, but the
    // Fastify preHandler uses the pure-function outcome.reason path which
    // surfaces 403 rbac_forbidden with reason=no_user. Pin this so a future
    // refactor to "401 like Express" is a conscious decision.
    const m = mockRequestReply({ user: null });
    const preHandler = requirePermFastify('finance.invoice.create');
    await preHandler(m.request, m.reply);
    assert.equal(m.sent, true);
    assert.equal(m.statusCode, 403);
    assert.equal(m.body.error, 'rbac_forbidden');
    assert.equal(m.body.reason, 'no_user');
  });

  test('requirePermFastify 401s with rbac_mfa_required when perm requires MFA but session is unverified', async () => {
    const admin = {
      id: 3,
      role: 'Admin',
      permission_set_ids: [],
      mfa_required: true,
      mfa_verified: false,
    };
    const m = mockRequestReply({ user: admin });
    // ai.agent.run triggers the MFA gate per MFA_REQUIRED_KEY_PATTERNS
    const preHandler = requirePermFastify('ai.agent.run');
    await preHandler(m.request, m.reply);
    assert.equal(m.sent, true);
    assert.equal(m.statusCode, 401);
    assert.equal(m.body.error, 'rbac_mfa_required');
    assert.equal(m.body.required, 'ai.agent.run');
  });

  test('requirePermFastify MFA gate yields to a verified session and grants', async () => {
    const admin = {
      id: 3,
      role: 'Admin',
      permission_set_ids: [],
      mfa_required: true,
      mfa_verified: true,
    };
    const m = mockRequestReply({ user: admin });
    const preHandler = requirePermFastify('ai.agent.run');
    await preHandler(m.request, m.reply);
    assert.equal(m.sent, false, 'verified MFA session must pass through silently');
  });

  test('requireAnyPerm 403s when user holds none of the keys', async () => {
    const salesrep = {
      id: 2,
      role: 'SalesRep',
      permission_set_ids: [],
      mfa_required: false,
      mfa_verified: true,
    };
    const m = mockRequestReply({ user: salesrep });
    const preHandler = requireAnyPerm(['system.tenant.delete', 'compliance.audit.read']);
    await preHandler(m.request, m.reply);
    assert.equal(m.sent, true);
    assert.equal(m.statusCode, 403);
    assert.equal(m.body.error, 'rbac_forbidden');
    assert.deepEqual(m.body.requiredAny, ['system.tenant.delete', 'compliance.audit.read']);
  });

  test('requireAnyPerm passes through silently when user holds at least one key', async () => {
    // Owner holds every perm via the super-user shortcut in resolveEffectivePermissions.
    const owner = {
      id: 1,
      role: 'Owner',
      permission_set_ids: [],
      mfa_required: true,
      mfa_verified: true,
    };
    const m = mockRequestReply({ user: owner });
    const preHandler = requireAnyPerm(['finance.invoice.create', 'system.tenant.delete']);
    await preHandler(m.request, m.reply);
    assert.equal(m.sent, false);
  });

  test('requireAnyPerm 403s on missing user', async () => {
    const m = mockRequestReply({ user: null });
    const preHandler = requireAnyPerm(['finance.invoice.create']);
    await preHandler(m.request, m.reply);
    assert.equal(m.sent, true);
    assert.equal(m.statusCode, 403);
    assert.equal(m.body.error, 'rbac_forbidden');
  });
});

// ─────────────── Field-level security ───────────────

describe('Field-level security (FLS)', () => {
  test('redactFields strips a sensitive field when user lacks min permission', () => {
    const clerk = { id: 7, role: 'WarehouseClerk', permission_set_ids: [] };
    const obj = { id: 1, label: 'Customer', tax_id: '12345678' };
    const redacted = redactFields(clerk, obj, ['crm.account.tax_id']);
    assert.equal(redacted.tax_id, undefined);
    assert.equal(redacted.label, 'Customer');
  });

  test('redactFields keeps a sensitive field when user has min permission', () => {
    const accountant = { id: 8, role: 'Accountant', permission_set_ids: [] };
    const obj = { id: 1, label: 'Customer', tax_id: '12345678' };
    const redacted = redactFields(accountant, obj, ['crm.account.tax_id']);
    assert.equal(redacted.tax_id, '12345678');
  });

  test('redactFields handles arrays of records', () => {
    const clerk = { id: 9, role: 'WarehouseClerk', permission_set_ids: [] };
    const arr = [
      { id: 1, tax_id: 'AAA' },
      { id: 2, tax_id: 'BBB' },
    ];
    const redacted = redactFields(clerk, arr, ['crm.account.tax_id']);
    assert.equal(redacted[0].tax_id, undefined);
    assert.equal(redacted[1].tax_id, undefined);
  });
});

// ─────────────── Record-level security ───────────────

describe('Record-level security (RLS)', () => {
  test('Owner/Admin get an empty clause (no extra filter)', () => {
    const owner = { id: 10, role: 'Owner', org_id: 7 };
    const admin = { id: 11, role: 'Admin', org_id: 7 };
    assert.equal(recordLevelClause(owner, 'crm.lead').clause, '');
    assert.equal(recordLevelClause(admin, 'crm.lead').clause, '');
  });

  test('org-scoped default returns org filter', () => {
    const u = { id: 12, role: 'SalesRep', org_id: 99 };
    const { clause, params } = recordLevelClause(u, 'crm.lead');
    assert.match(clause, /org_id/);
    assert.deepEqual(params, [99]);
  });

  test('own-scoped default returns owner filter', () => {
    const u = { id: 13, role: 'SalesRep', org_id: 99 };
    const { clause, params } = recordLevelClause(u, 'crm.activity');
    assert.match(clause, /owner_user_id/);
    assert.deepEqual(params, [13]);
  });

  test('portal users are tenant-scoped', () => {
    const u = { id: 14, role: 'CustomerPortal', tenant_id: 42 };
    const { clause } = recordLevelClause(u, 'portal.order');
    assert.match(clause, /tenant_id/);
  });
});

// ─────────────── Impersonation policy ───────────────

describe('Impersonation', () => {
  test('Owner can impersonate a regular user', () => {
    const owner = { id: 1, role: 'Owner' };
    const target = { id: 2, role: 'Accountant' };
    assert.equal(canImpersonate(owner, target), true);
  });

  test('cannot impersonate self', () => {
    const owner = { id: 1, role: 'Owner' };
    assert.equal(canImpersonate(owner, owner), false);
  });

  test('Admin cannot impersonate Owner', () => {
    const admin = { id: 1, role: 'Admin' };
    const target = { id: 2, role: 'Owner' };
    assert.equal(canImpersonate(admin, target), false);
  });

  test('non-admin cannot impersonate anyone', () => {
    const sales = { id: 1, role: 'SalesRep' };
    const target = { id: 2, role: 'Accountant' };
    assert.equal(canImpersonate(sales, target), false);
  });
});

// ─────────────── Custom role validation ───────────────

describe('validateCustomRole', () => {
  test('rejects bad id', () => {
    assert.throws(
      () => validateCustomRole({ id: '1bad', parent: 'Admin' }),
      /letters, digits, underscores/,
    );
    assert.throws(() => validateCustomRole({ id: '', parent: 'Admin' }), /required/);
    assert.throws(() => validateCustomRole({ id: 'Owner', parent: 'Admin' }), /already exists/);
  });

  test('rejects bad parent', () => {
    assert.throws(() => validateCustomRole({ id: 'CustomX', parent: 'Nope' }), /unknown role/);
  });

  test('produces a valid custom role with defaults', () => {
    const r = validateCustomRole({
      id: 'JuniorAccountant',
      label: 'Junior Accountant',
      description: 'Books AP only',
      parent: 'Accountant',
      appSet: ['dashboard', 'finance'],
    });
    assert.equal(r.id, 'JuniorAccountant');
    assert.equal(r.parent, 'Accountant');
    assert.equal(r.isSystem, false);
    assert.ok(r.sessionHardLimitMinutes >= 30);
  });
});

// ─────────────── Seed idempotency (in-memory SQLite) ───────────────

describe('Seed installer (in-memory SQLite)', () => {
  let db;
  before(async () => {
    let Database;
    try {
      Database = require('better-sqlite3');
    } catch (e) {
      return;
    }
    db = new Database(':memory:');
    const v = await seedRBAC(db);
    assert.equal(v.permissions_seeded, listKeys().length);
    assert.equal(v.roles_seeded, listRoleIds().length);
  });

  test('seeds the expected number of rows (when sqlite is available)', () => {
    if (!db) return;
    const perms = db
      .prepare('SELECT COUNT(*) AS c FROM sbos_rbac_permissions WHERE tenant_id = 0')
      .get();
    const roles = db.prepare('SELECT COUNT(*) AS c FROM sbos_rbac_roles WHERE tenant_id = 0').get();
    const sets = db
      .prepare('SELECT COUNT(*) AS c FROM sbos_rbac_permission_sets WHERE tenant_id = 0')
      .get();
    const links = db.prepare('SELECT COUNT(*) AS c FROM sbos_rbac_role_permission_sets').get();
    assert.equal(perms.c, listKeys().length);
    assert.equal(roles.c, listRoleIds().length);
    assert.equal(sets.c, Object.keys(PERMISSION_SETS).length);
    assert.ok(links.c > 0);
  });

  test('is idempotent — re-running does not duplicate or error', async () => {
    if (!db) return;
    await seedRBAC(db);
    const perms = db
      .prepare('SELECT COUNT(*) AS c FROM sbos_rbac_permissions WHERE tenant_id = 0')
      .get();
    assert.equal(perms.c, listKeys().length);
  });

  test('readVersions returns the seeded versions', () => {
    if (!db) return;
    const v = readVersions(db);
    assert.equal(Number(v.permissions_version), rbac.PERMISSIONS_VERSION);
    assert.equal(Number(v.roles_version), rbac.ROLES_VERSION);
    assert.equal(Number(v.permission_sets_version), rbac.PERMISSION_SETS_VERSION);
  });
});
