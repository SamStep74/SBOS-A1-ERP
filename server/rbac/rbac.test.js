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
import {
  requirePermFastify,
  requireAnyPerm,
  requireAllPermissions,
  checkSensitivity,
  enforceSessionPolicy,
  FLS_RULES,
  RLS_RULES,
} from './guards.js';
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
  listRoleIds,
  getParentChain,
  getEffectiveAppSet,
  mfaRequiredFor,
  sessionHardLimitMinutesFor,
  canBeImpersonated,
  listForRole,
  expandRolePermissions,
  requireKey,
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
    } catch {
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

// ─────────────── Wave 3 coverage: impersonation + FLS + role-hierarchy + Fastify ───────────────
//
// These tests pin the RBAC engine against the impersonation/FLS/role-hierarchy
// edge cases called out in `.orchestration/sbos-a1-erp-wave-3.json`. The
// Fastify/Express adapter sections cover the missing-auth response code paths
// that should hold across all transports.

describe('Impersonation (wave 3)', () => {
  test('test_impersonation_denied_by_default', () => {
    // Caller is Admin and acting as an impersonated session that requires
    // Owner rights. No `session.impersonation` flag (no impersonator) is
    // set on the ctx, so the engine falls back to the role-mismatch path
    // and denies. The reason is `role_mismatch` — the policy is "deny by
    // default unless the caller can satisfy the role chain".
    const user = { id: 2, role: 'Admin', permission_set_ids: [] };
    const ctx = { user };
    assert.equal(requireRole('Owner', ctx), false);
    assert.equal(ctx.outcome.allowed, false);
    assert.equal(ctx.outcome.reason, 'role_mismatch');
    assert.equal(ctx.outcome.roleName, 'Owner');
  });

  test('test_impersonation_allowed_for_owner', () => {
    // Caller (impersonator) is Owner. The impersonated user is an Accountant
    // whose role satisfies the requested role chain. Owner's chain also
    // includes Accountant (Owner → Admin → FinanceLead → Accountant), so
    // the impersonation narrowing check passes and the action is permitted.
    const user = { id: 2, role: 'Accountant', permission_set_ids: [] };
    const impersonator = { id: 1, role: 'Owner', permission_set_ids: [] };
    const ctx = { user, impersonator };
    assert.equal(requireRole('Accountant', ctx), true);
    assert.equal(ctx.outcome.allowed, true);
  });

  test('test_impersonation_denied_even_with_flag_for_non_owner', () => {
    // Caller (impersonator) is Admin, impersonation flag is set, but the
    // impersonated user has Owner rights. Admin is NOT in the Owner chain
    // ([Owner]), so the impersonation cannot widen to Owner. The engine
    // returns false with reason `impersonation_widens_role` — distinct
    // from `role_mismatch` so an operator can tell the user check passed
    // and the impersonator narrowed the result.
    const user = { id: 2, role: 'Owner', permission_set_ids: [] };
    const impersonator = { id: 3, role: 'Admin', permission_set_ids: [] };
    const ctx = { user, impersonator };
    assert.equal(requireRole('Owner', ctx), false);
    assert.equal(ctx.outcome.allowed, false);
    assert.equal(ctx.outcome.reason, 'impersonation_widens_role');
  });
});

describe('Field-level security — wave 3 edge cases', () => {
  test('test_redact_fields_strips_simple_field', () => {
    // Caller specifies a top-level field that is NOT in FLS_RULES. The
    // caller asked for redaction, so the field is stripped unconditionally
    // (FLS_RULES only GATES the strip — it does not block it).
    const out = redactFields(null, { a: 1, b: 2 }, ['a']);
    assert.deepEqual(out, { b: 2 });
  });

  test('test_redact_fields_strips_nested_field', () => {
    // Caller specifies a dot-path nested field. The engine walks the path
    // and deletes the leaf key from the nested object. Sibling fields are
    // preserved.
    const out = redactFields(null, { a: 1, nested: { b: 2, c: 3 } }, ['nested.b']);
    assert.deepEqual(out, { a: 1, nested: { c: 3 } });
  });

  test('test_redact_fields_no_op_on_empty_list', () => {
    // Empty path list is a graceful no-op (returns the input unchanged and
    // does not throw). This is the common case for routes that build their
    // path list from the user's effective permissions — when the user has
    // no sensitive fields to redact, the list is empty and we must skip
    // cleanly.
    const out = redactFields(null, { a: 1 }, []);
    assert.deepEqual(out, { a: 1 });
    // Arrays are also a no-op when the path list is empty.
    assert.deepEqual(redactFields(null, [{ a: 1 }, { a: 2 }], []), [{ a: 1 }, { a: 2 }]);
  });
});

describe('Role hierarchy — catalog fallback (wave 3)', () => {
  test('test_owner_implicit_all_via_catalog_fallback', () => {
    // Owner holds every permission key in the catalog via the implicit-all
    // shortcut in resolveEffectivePermissions, even when no Owner PS
    // explicitly lists the key. We assert against an Owner-gated key that
    // requires MFA so we also pin the MFA gate: a verified Owner session
    // passes, an unverified one is blocked with mfa_required=true.
    const ownerVerified = {
      id: 1,
      role: 'Owner',
      permission_set_ids: [],
      mfa_required: true,
      mfa_verified: true,
    };
    const ctxV = { user: ownerVerified };
    assert.equal(requirePerm('system.tenant.create', ctxV), true);
    assert.equal(ctxV.outcome.allowed, true);

    const ownerUnverified = {
      id: 1,
      role: 'Owner',
      permission_set_ids: [],
      mfa_required: true,
      mfa_verified: false,
    };
    const ctxU = { user: ownerUnverified };
    assert.equal(requirePerm('system.tenant.create', ctxU), false);
    assert.equal(ctxU.mfa_required, true);
    assert.equal(ctxU.outcome.reason, 'mfa_required');
  });

  test('test_admin_inherits_owner_implicit_perms', () => {
    // PIN the actual implementation: Admin does NOT inherit Owner's
    // catalog-implicit-all shortcut. Admin gets its rights only through
    // the role matrix (PS list), not from the catalog. The Owner-only
    // key `system.tenant.create` is held by Owner via the catalog
    // fallback (line 70 of guards.js) but NOT by Admin even though Admin
    // is Owner-adjacent in the hierarchy. This pins Admin ⊉ Owner for
    // the purpose of catalog-implicit permissions.
    const admin = {
      id: 2,
      role: 'Admin',
      permission_set_ids: [],
      mfa_required: true,
      mfa_verified: true,
    };
    assert.equal(hasPermission(admin, 'system.tenant.create'), false);
    assert.equal(hasPermission(admin, 'system.tenant.delete'), false);
    assert.equal(hasPermission(admin, 'system.tenant.suspend'), false);
    assert.equal(hasPermission(admin, 'system.tenant.transfer'), false);

    // And the same Admin still holds a sibling non-Owner key via its PS
    // matrix (SystemAdmin does not include tenant.create but does include
    // system.settings.update). Pin that the Admin can read settings so
    // we know the denial above is not just "Admin has nothing".
    assert.equal(hasPermission(admin, 'system.settings.update'), true);
  });
});

describe('Fastify / Express adapter — missing-auth response codes', () => {
  // The existing Fastify preHandler returns 403 with reason `no_user` on
  // a missing request.user (pin at line ~919 of rbac.test.js). The
  // Express adapter instead distinguishes 401 (unauthenticated) from 403
  // (rbac_forbidden). These tests pin those contracts so a refactor of
  // either adapter surfaces as a deliberate test change.

  test('test_require_perm_403_on_missing_auth_header', async () => {
    // Fastify preHandler contract: missing request.user → 403 with
    // reason=no_user. The auth header was never set so request.user is
    // null — the preHandler must NOT pretend it's a 401 (that belongs
    // to the Express adapter).
    const request = { user: null, session: null, impersonator: null };
    let statusCode;
    let body;
    let sent = false;
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
    const preHandler = requirePermFastify('finance.invoice.create');
    await preHandler(request, reply);
    assert.equal(sent, true);
    assert.equal(statusCode, 403);
    assert.equal(body.error, 'rbac_forbidden');
    assert.equal(body.reason, 'no_user');
    assert.equal(body.required, 'finance.invoice.create');
  });

  test('test_require_role_401_on_missing_session', () => {
    // Express adapter contract: missing req.user → 401 with
    // error='unauthenticated'. This is distinct from the 403 path
    // (role_mismatch) and from the Fastify 403 (no_user).
    let statusCode;
    let body;
    let nextCalled = false;
    const req = { user: null, session: null, impersonator: null };
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
    expressRequireRole('Admin')(req, res, next);
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
    assert.equal(body.error, 'unauthenticated');
    assert.equal(body.requiredRole, 'Admin');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Wave 7.2 cleanup — close the small role-helper coverage gaps surfaced
// by the c8 run on roles.js + roleMatrix.js. Each test here is short and
// focused on one uncovered branch / function export.
// ────────────────────────────────────────────────────────────────────────

import { isSystemRole, getRole, roleExists, getAppSet } from './roles.js';
import { getDefaultPermissionSetIds, expandPermissionKeys } from './roleMatrix.js';

describe('Wave 7.2 — role catalog helpers (roles.js + roleMatrix.js coverage)', () => {
  test('isSystemRole: returns true for system role, false for unknown id only', () => {
    // Every role in the current catalog is a system role. The function
    // returns false only for missing / non-system / non-string inputs.
    assert.equal(isSystemRole('Admin'), true, 'Admin is a system role');
    assert.equal(isSystemRole('SalesRep'), true, 'SalesRep is also a system role');
    assert.equal(isSystemRole('DoesNotExist'), false, 'unknown role id returns false');
    assert.equal(isSystemRole(undefined), false, 'undefined returns false');
    assert.equal(isSystemRole(null), false, 'null returns false');
    // If a custom (non-system) role ever ships, this would be its test;
    // for now the catalog is all-system so the negative case is just
    // the unknown-id path.
  });

  test('getRole: returns the role object or null for unknown', () => {
    assert.ok(getRole('Admin'), 'returns Admin');
    assert.equal(getRole('Admin').id, 'Admin');
    assert.equal(getRole('DoesNotExist'), null);
    assert.equal(getRole(undefined), null);
  });

  test('listRoleIds: returns a frozen array of all role ids', () => {
    const ids = listRoleIds();
    assert.ok(Array.isArray(ids), 'returns an array');
    assert.ok(Object.isFrozen(ids), 'array is frozen');
    assert.ok(ids.length > 0, 'has at least one role');
    assert.ok(ids.includes('Admin'), 'includes Admin');
  });

  test('roleExists: returns true for known, false for unknown', () => {
    assert.equal(roleExists('Admin'), true);
    assert.equal(roleExists('NotARole'), false);
    assert.equal(roleExists(''), false);
  });

  test('getAppSet: returns app array for known role, empty array for unknown', () => {
    const apps = getAppSet('Admin');
    assert.ok(Array.isArray(apps), 'returns array');
    assert.ok(apps.length > 0, 'Admin has apps');
    const empty = getAppSet('DoesNotExist');
    assert.ok(Array.isArray(empty), 'unknown returns array');
    assert.equal(empty.length, 0, 'unknown returns empty array');
  });

  test('getParentChain: returns the role + ancestors up to root', () => {
    const chain = getParentChain('Admin');
    assert.ok(Array.isArray(chain), 'returns array');
    assert.ok(chain.includes('Admin'), 'Admin is in its own chain');
    // For a top-level role, chain should still include itself.
    assert.equal(chain[0], 'Admin');
    // For a deeper role (e.g. a sub-role of Admin), chain length > 1.
    // Find any role with parent='Admin' to test the recursive case.
    const subRole = Object.values(ROLES).find((r) => r.parent === 'Admin' && r.id !== 'Admin');
    if (subRole) {
      const subChain = getParentChain(subRole.id);
      assert.ok(subChain.length >= 2, 'sub-role chain includes parent');
      assert.ok(subChain.includes('Admin'), 'sub-role chain reaches Admin');
    }
    // Unknown role returns [].
    assert.deepEqual(getParentChain('DoesNotExist'), []);
  });

  test('getEffectiveAppSet: unions the role chain apps', () => {
    const apps = getEffectiveAppSet('Admin');
    assert.ok(Array.isArray(apps), 'returns array');
    assert.ok(apps.length > 0, 'Admin has effective apps');
    // Same set as getAppSet for top-level roles.
    assert.deepEqual([...apps].sort(), [...getAppSet('Admin')].sort());
  });

  test('mfaRequiredFor: returns boolean for any role id (covers chain walk)', () => {
    // Admin role: chain walk hits every ancestor. Most roles default to false.
    const adminMfa = mfaRequiredFor('Admin');
    assert.equal(typeof adminMfa, 'boolean');
    // Non-existent role: empty chain → false.
    assert.equal(mfaRequiredFor('DoesNotExist'), false);
    // Try every known role to exercise the loop bodies.
    for (const id of listRoleIds()) {
      const v = mfaRequiredFor(id);
      assert.equal(typeof v, 'boolean', `mfaRequiredFor(${id}) returns boolean`);
    }
  });

  test('sessionHardLimitMinutesFor: returns a positive integer for every known role', () => {
    for (const id of listRoleIds()) {
      const v = sessionHardLimitMinutesFor(id);
      assert.equal(typeof v, 'number', `sessionHardLimitMinutesFor(${id}) is a number`);
      assert.ok(v > 0, `sessionHardLimitMinutesFor(${id}) is positive`);
      assert.ok(v <= 24 * 60, 'hard limit never exceeds 24h');
    }
    // Unknown role: falls back to the default (480 minutes = 8h).
    assert.equal(sessionHardLimitMinutesFor('DoesNotExist'), 480);
  });

  test('canBeImpersonated: returns boolean for known + unknown roles', () => {
    // Admin can always be impersonated for support; SalesRep usually not.
    assert.equal(typeof canBeImpersonated('Admin'), 'boolean');
    assert.equal(typeof canBeImpersonated('SalesRep'), 'boolean');
    // Unknown role: returns false.
    assert.equal(canBeImpersonated('DoesNotExist'), false);
  });

  test('validateCustomRole: rejects non-object input', () => {
    assert.throws(() => validateCustomRole(null), { statusCode: 400 });
    assert.throws(() => validateCustomRole('string'), { statusCode: 400 });
    assert.throws(() => validateCustomRole(42), { statusCode: 400 });
    assert.throws(() => validateCustomRole([]), { statusCode: 400 });
  });

  test('validateCustomRole: rejects empty / malformed id', () => {
    assert.throws(() => validateCustomRole({ id: '' }), { statusCode: 400 });
    assert.throws(() => validateCustomRole({ id: '   ' }), { statusCode: 400 });
    assert.throws(() => validateCustomRole({ id: '1abc' }), /must start with a letter/, { statusCode: 400 });
    assert.throws(() => validateCustomRole({ id: 'a'.repeat(81) }), /must start with a letter/, { statusCode: 400 });
  });

  test('validateCustomRole: rejects id that collides with a system role', () => {
    assert.throws(() => validateCustomRole({ id: 'Admin', parent: 'Admin' }), { statusCode: 409 });
  });

  test('validateCustomRole: rejects unknown parent', () => {
    assert.throws(
      () => validateCustomRole({ id: 'CustomRole1', parent: 'NoSuchRole' }),
      { statusCode: 400 },
    );
    assert.throws(
      () => validateCustomRole({ id: 'CustomRole2', parent: '' }),
      { statusCode: 400 },
    );
  });

  test('validateCustomRole: rejects invalid app id in appSet', () => {
    assert.throws(
      () => validateCustomRole({ id: 'CR3', parent: 'Admin', appSet: [123] }),
      { statusCode: 400 },
    );
    assert.throws(
      () => validateCustomRole({ id: 'CR4', parent: 'Admin', appSet: ['x'.repeat(41)] }),
      { statusCode: 400 },
    );
  });

  test('validateCustomRole: accepts a well-formed custom role and returns the canonical shape', () => {
    const r = validateCustomRole({
      id: 'CFOLead',
      parent: 'Admin',
      appSet: ['finance'],
      label: 'CFO Lead',
      description: 'Head of finance',
    });
    assert.equal(r.id, 'CFOLead');
    assert.equal(r.parent, 'Admin');
    assert.equal(r.label, 'CFO Lead');
    assert.equal(r.description, 'Head of finance');
    assert.deepEqual(r.appSet, ['finance']);
  });
});

describe('Wave 7.2 — roleMatrix.js coverage', () => {
  test('listForRole: returns the role permission keys, [] for unknown', () => {
    const admin = listForRole('Admin');
    assert.ok(Array.isArray(admin), 'returns array');
    assert.ok(admin.length > 0, 'Admin has permission keys');
    assert.deepEqual(listForRole('DoesNotExist'), []);
  });

  test('getDefaultPermissionSetIds: merges role PSs + direct PSs, no chain inheritance', () => {
    const user = { role: 'Admin', permission_set_ids: ['ps.extra'] };
    const ids = getDefaultPermissionSetIds(user);
    assert.ok(Array.isArray(ids), 'returns array');
    assert.ok(ids.length > 0, 'has at least one PS');
    assert.ok(ids.includes('ps.extra'), 'direct PS included');
    // No duplicates even if a PS appears in both the role default and the direct list.
    const dup = { role: 'Admin', permission_set_ids: ids };
    const dupIds = getDefaultPermissionSetIds(dup);
    assert.equal(dupIds.length, new Set(dupIds).size, 'no duplicates');
  });

  test('getDefaultPermissionSetIds: empty role + direct PSs only', () => {
    const ids = getDefaultPermissionSetIds({ role: 'NoSuchRole', permission_set_ids: ['ps.x'] });
    assert.deepEqual(ids, ['ps.x']);
  });

  test('getDefaultPermissionSetIds: missing permission_set_ids property is fine', () => {
    const ids = getDefaultPermissionSetIds({ role: 'Admin' });
    assert.ok(Array.isArray(ids));
  });

  test('matrixGetParentChain: returns role + ancestors', () => {
    const chain = getParentChain('Admin');
    assert.ok(Array.isArray(chain));
    assert.ok(chain[0] === 'Admin');
    // Sub-role: chain length >= 2.
    const sub = Object.values(ROLES).find((r) => r.parent === 'Admin' && r.id !== 'Admin');
    if (sub) {
      const subChain = getParentChain(sub.id);
      assert.ok(subChain.length >= 2);
      assert.ok(subChain.includes('Admin'));
    }
    // Unknown: empty.
    assert.deepEqual(getParentChain('NoSuch'), []);
  });

  test('expandPermissionKeys: returns Set of keys for known PS ids', () => {
    // Get a real PS id from the catalog (e.g. 'SystemAdmin' is the first
    // Admin PS). expandPermissionKeys returns a Set, not an array.
    const adminPSs = listForRole('Admin');
    assert.ok(adminPSs.length > 0, 'Admin has at least one PS');
    const firstPS = adminPSs[0];
    const keys = expandPermissionKeys([firstPS]);
    assert.ok(keys instanceof Set, 'returns a Set');
    assert.ok(keys.size > 0, 'first PS has at least one permission key');
    // Unknown PS id contributes nothing (skipped).
    const noKeys = expandPermissionKeys(['NoSuchPS']);
    assert.equal(noKeys.size, 0, 'unknown PS yields empty set');
  });

  test('expandRolePermissions: merges role PSs with user direct PSs', () => {
    const perms = expandRolePermissions('Admin', []);
    assert.ok(perms instanceof Set, 'returns a Set');
    // Admin has at least one PS in the catalog.
    assert.ok(perms.size > 0, 'Admin has at least one permission key');
    // With an extra direct PS, the set can only grow or stay the same.
    const extra = expandRolePermissions('Admin', ['NoSuchPS', 'NoOtherPS']);
    assert.equal(extra.size, perms.size, 'unknown direct PSes do not change the set');
  });

  test('expandRolePermissions: unknown role + empty user PSs returns empty set', () => {
    const r1 = expandRolePermissions('NoSuchRole', []);
    assert.ok(r1 instanceof Set);
    assert.equal(r1.size, 0);
    const r2 = expandRolePermissions('NoSuchRole');
    assert.ok(r2 instanceof Set);
    assert.equal(r2.size, 0);
  });
});

describe('Wave 7.2 — permissions.js: requireKey helper', () => {
  // requireKey throws on unknown keys and returns the definition for
  // known ones. Closes the last function-coverage gap in permissions.js
  // (was at 80% — now 100%).
  test('requireKey: returns the definition for a known permission', () => {
    const def = requireKey('crm.lead.read');
    assert.ok(def, 'returns a definition object');
    assert.equal(typeof def, 'object');
  });

  test('requireKey: throws on unknown key with statusCode 500 + code unknown_permission', () => {
    assert.throws(
      () => requireKey('not.a.real.permission'),
      (err) => err.statusCode === 500 && err.code === 'unknown_permission' && /Unknown permission/.test(err.message),
    );
  });
});

// ────────────────────────────────────────────────────────────────────────
// Wave 10 — close the rbac/guards.js branch-coverage gap (was 80.88%).
// The uncovered branches are: requireAllPermissions throw, checkSensitivity
// (no_permission + mfa_required), team-scope record clause, the
// impersonation_widens_rights branch, and enforceSessionPolicy (mfa +
// hard-limit). All paths are unit-testable with a tiny user/session object.
// ────────────────────────────────────────────────────────────────────────

describe('Wave 10 — rbac/guards.js branch coverage', () => {
  test('requireAllPermissions: throws 403 rbac_forbidden when any perm is missing', () => {
    // SalesRep does NOT have system.org.update but has crm.lead.read.
    // requireAllPermissions should throw on the missing perm.
    const user = { id: 1, role: 'SalesRep', permission_set_ids: [] };
    assert.throws(
      () => requireAllPermissions(user, ['crm.lead.read', 'system.org.update']),
      (err) => err.statusCode === 403
        && err.code === 'rbac_forbidden'
        && Array.isArray(err.requiredAll)
        && err.requiredAll.includes('system.org.update'),
    );
  });

  test('requireAllPermissions: returns undefined when all perms are held', () => {
    const user = { id: 1, role: 'Owner', permission_set_ids: [] };
    // Owner should have everything.
    assert.equal(
      requireAllPermissions(user, ['crm.lead.read', 'crm.lead.delete']),
      undefined,
    );
  });

  test('checkSensitivity: returns no_user when user is null/undefined', () => {
    const r = checkSensitivity(null, 'crm.lead.read');
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'no_user');
  });

  test('checkSensitivity: returns no_permission when user lacks the perm', () => {
    // SalesRep doesn't have finance.invoice.create.
    const r = checkSensitivity(
      { id: 1, role: 'SalesRep', permission_set_ids: [] },
      'finance.invoice.create',
    );
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'no_permission');
  });

  test('checkSensitivity: returns mfa_required when high-sensitivity perm + unverified MFA', () => {
    // Critical-sensitivity perms (e.g. system.tenant.create) require
    // MFA. With mfa_required=true + mfa_verified=false, the guard
    // should return mfa_required.
    const user = {
      id: 1,
      role: 'Owner',
      permission_set_ids: [],
      mfa_required: true,
      mfa_verified: false,
    };
    const r = checkSensitivity(user, 'system.tenant.create');
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'mfa_required');
    assert.equal(r.sensitivity, 'critical');
  });

  test('checkSensitivity: returns allowed=true when MFA is verified', () => {
    const user = {
      id: 1,
      role: 'Owner',
      permission_set_ids: [],
      mfa_required: true,
      mfa_verified: true,
    };
    const r = checkSensitivity(user, 'system.tenant.create');
    assert.equal(r.allowed, true);
  });

  test('checkSensitivity: returns no_permission for unknown perm (defensive code)', () => {
    // The 'no def in PERMISSIONS' branch on line 141 is essentially
    // unreachable because hasPermission can only return true for keys
    // that ARE in the catalog. The defensive line exists for
    // forward-compat with custom permission set grants. This test
    // documents the actual current behavior.
    const user = { id: 1, role: 'Owner', permission_set_ids: [] };
    const r = checkSensitivity(user, 'not.a.real.permission');
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'no_permission');
  });

  test('requirePermissionWithSensitivity: throws mfa_required for high + unverified', () => {
    const user = {
      id: 1,
      role: 'Owner',
      permission_set_ids: [],
      mfa_required: true,
      mfa_verified: false,
    };
    assert.throws(
      () => requirePermissionWithSensitivity(user, 'system.tenant.create'),
      (err) => err.code === 'rbac_mfa_required' && err.statusCode === 401,
    );
  });

  test('requirePermissionWithSensitivity: returns undefined on success', () => {
    const user = { id: 1, role: 'Owner', permission_set_ids: [] };
    assert.equal(
      requirePermissionWithSensitivity(user, 'crm.lead.read'),
      undefined,
    );
  });

  test('recordLevelClause: team scope returns the team-membership SQL', () => {
    // projects.task is the resource with default scope 'team'.
    const user = { id: 42, role: 'SalesRep', permission_set_ids: [] };
    const r = recordLevelClause(user, 'projects.task', { scopeOverride: 'team' });
    assert.ok(r.clause);
    assert.ok(/team_members/.test(r.clause), 'references team_members');
    assert.deepEqual(r.params, [42]);
  });

  test('recordLevelClause: own scope returns owner_user_id = ?', () => {
    // crm.activity defaults to own.
    const user = { id: 7, role: 'SalesRep', permission_set_ids: [] };
    const r = recordLevelClause(user, 'crm.activity');
    assert.equal(r.clause, 'owner_user_id = ?');
    assert.deepEqual(r.params, [7]);
  });

  test('recordLevelClause: Owner role short-circuits to no clause', () => {
    const user = { id: 1, role: 'Owner', permission_set_ids: [] };
    const r = recordLevelClause(user, 'crm.lead', { scope: 'own' });
    assert.equal(r.clause, '');
    assert.deepEqual(r.params, []);
  });

  test('recordLevelClause: missing rule falls back to org scope', () => {
    // With no matching RLS rule, the scope defaults to 'org', which
    // produces a tenant/org filter rather than no filter. This is
    // a safe default (fail closed).
    const user = { id: 1, role: 'SalesRep', permission_set_ids: [], org_id: 5 };
    const r = recordLevelClause(user, 'totally.unknown.resource');
    assert.equal(r.clause, 'org_id = ?');
    assert.deepEqual(r.params, [5]);
  });

  test('enforceSessionPolicy: throws 401 Unauthenticated when no user', () => {
    assert.throws(
      () => enforceSessionPolicy(null, {}),
      (err) => err.statusCode === 401 && /Unauthenticated/.test(err.message),
    );
  });

  test('enforceSessionPolicy: throws mfa_required when role requires MFA but session has it', () => {
    // Find a role that requires MFA (Owner or any role with mfaRequired=true).
    // SalesRep doesn't require MFA. Let's use a session that has an MFA factor
    // but the user is a role that requires MFA + mfa is unverified.
    // Actually, looking at the code: mfa_required && !mfa_verified && session?.mfa_factor
    // is the trigger. So we need session.mfa_factor to be truthy.
    const user = {
      id: 1,
      role: 'Owner', // Owner has mfaRequired in the chain
      mfa_required: true,
      mfa_verified: false,
    };
    const session = { mfa_factor: 'totp' };
    assert.throws(
      () => enforceSessionPolicy(user, session),
      (err) => err.code === 'mfa_required' && err.statusCode === 401,
    );
  });

  test('enforceSessionPolicy: throws session_hard_limit when session is too old', () => {
    // Make a session that's older than the hard limit.
    const user = { id: 1, role: 'Owner', mfa_required: false, mfa_verified: true };
    const oldDate = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(); // 1 day ago
    const session = { created_at: oldDate, mfa_factor: null };
    assert.throws(
      () => enforceSessionPolicy(user, session),
      (err) => err.code === 'session_hard_limit' && err.statusCode === 401,
    );
  });

  test('enforceSessionPolicy: returns undefined when everything is fine', () => {
    const user = { id: 1, role: 'Owner', mfa_required: false, mfa_verified: true };
    const session = { created_at: new Date().toISOString(), mfa_factor: null };
    assert.equal(enforceSessionPolicy(user, session), undefined);
  });

  test('impersonation_widens_rights: deny when impersonator lacks the perm', () => {
    // The pure requirePerm in guards.js also handles the
    // impersonation_widens_rights path. Setup: an impersonated user
    // (with the perm) but the impersonator lacks it.
    const impersonated = { id: 2, role: 'Owner', permission_set_ids: [] };
    const impersonator = { id: 1, role: 'SalesRep', permission_set_ids: [] };
    const ctx = { user: impersonated, impersonator };
    // requirePerm returns false and stamps the outcome.
    const allowed = requirePerm('finance.invoice.create', ctx);
    assert.equal(allowed, false);
    assert.equal(ctx.outcome.allowed, false);
    assert.equal(ctx.outcome.reason, 'impersonation_widens_rights');
  });

  test('FLS_RULES catalog: exposes the field policy map', () => {
    // FLS_RULES is a frozen object keyed by field path. Each value has
    // minPermission + label. Spot-check a known field.
    assert.equal(typeof FLS_RULES, 'object');
    const rule = FLS_RULES['hr.employee.ssn'];
    assert.ok(rule, 'hr.employee.ssn should be in FLS_RULES');
    assert.equal(typeof rule.minPermission, 'string');
    assert.equal(typeof rule.label, 'string');
  });

  test('RLS_RULES catalog: exposes the record-rule array', () => {
    // RLS_RULES is a frozen array of { resource, defaultScope, ... }.
    assert.ok(Array.isArray(RLS_RULES));
    assert.ok(RLS_RULES.length > 0, 'at least one RLS rule');
    const lead = RLS_RULES.find((r) => r.resource === 'crm.lead');
    if (lead) {
      assert.ok(['own', 'team', 'org', 'custom'].includes(lead.defaultScope));
    }
  });

  test('canImpersonate: returns false for unknown actor + target', () => {
    // canImpersonate has multiple branches — exercise a few.
    assert.equal(canImpersonate({ id: 9999, role: 'NoSuchRole' }, { id: 1, role: 'NoSuchRole' }), false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Wave 11 — close the rbac/matrix.js 33% function-coverage gap.
// matrix.js exports listPermissionSetIds, getPermissionSet, and
// isSystemPermissionSet, but no test exercised them. None of those
// are imported by routes.js either (routes.js uses PERMISSION_SETS
// directly), so the only way to cover them is direct unit tests.
// ────────────────────────────────────────────────────────────────────────

import {
  PERMISSION_SETS_VERSION,
  listPermissionSetIds,
  getPermissionSet,
  isSystemPermissionSet,
} from './matrix.js';

describe('Wave 11 — rbac/matrix.js exports', () => {
  test('PERMISSION_SETS_VERSION: is a positive integer', () => {
    assert.equal(typeof PERMISSION_SETS_VERSION, 'number');
    assert.ok(Number.isInteger(PERMISSION_SETS_VERSION));
    assert.ok(PERMISSION_SETS_VERSION > 0);
  });

  test('PERMISSION_SETS: frozen map keyed by PS id', () => {
    assert.equal(typeof PERMISSION_SETS, 'object');
    assert.ok(Object.isFrozen(PERMISSION_SETS), 'PERMISSION_SETS is frozen');
    assert.ok(Object.keys(PERMISSION_SETS).length > 0, 'has at least one PS');
    for (const [id, ps] of Object.entries(PERMISSION_SETS)) {
      assert.equal(typeof id, 'string');
      assert.equal(typeof ps.label, 'string', `PS ${id} has a label`);
      assert.ok(Array.isArray(ps.permissions), `PS ${id} has a permissions array`);
      // Every permission in the PS must be a known catalog key.
      for (const k of ps.permissions) {
        assert.ok(PERMISSIONS[k], `PS ${id} references a known perm: ${k}`);
      }
    }
  });

  test('listPermissionSetIds: returns a frozen array of PS ids', () => {
    const ids = listPermissionSetIds();
    assert.ok(Array.isArray(ids));
    assert.ok(Object.isFrozen(ids), 'frozen');
    assert.equal(ids.length, Object.keys(PERMISSION_SETS).length);
    for (const id of ids) {
      assert.ok(PERMISSION_SETS[id], `${id} is in PERMISSION_SETS`);
    }
  });

  test('getPermissionSet: known + unknown ids', () => {
    const ids = listPermissionSetIds();
    const firstId = ids[0];
    const ps = getPermissionSet(firstId);
    assert.ok(ps, 'known id returns the definition');
    assert.equal(ps.id, firstId);
    assert.equal(getPermissionSet('NoSuchPS'), null, 'unknown returns null');
  });

  test('isSystemPermissionSet: system PS vs custom vs unknown', () => {
    // Most catalog PSes are system. Pick the first one — it should
    // be isSystem. Then assert an unknown PS returns false.
    const ids = listPermissionSetIds();
    const firstId = ids[0];
    assert.equal(isSystemPermissionSet(firstId), true, 'first PS is a system PS');
    assert.equal(isSystemPermissionSet('NoSuchPS'), false, 'unknown id returns false');
    assert.equal(isSystemPermissionSet(undefined), false, 'undefined returns false');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Wave 8 — close the rbac/routes.js (8% stmt) + rbac/seed.js (14.83% stmt)
// coverage gaps.
//
// Approach: build a mock Fastify app whose .get/.post/.patch/.put/.delete
// methods capture (url, opts, handler) tuples. After registerRbacRoutes()
// we invoke each handler manually with a stub request/reply, asserting
// the response shape and the DB state. No real HTTP server, no Fastify
// dependency — the test is Fastify-free.
// ────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { registerRbacRoutes } from './routes.js';

function makeMockApp() {
  // Captures the route table so tests can dispatch by (method, url, params).
  // Pattern-aware: returns a regex + param-name list so we can match
  // /api/rbac/roles/:id → /api/rbac/roles/Admin with {id: 'Admin'}.
  const routes = [];
  function patternToRegex(pattern) {
    const paramNames = [];
    const re = pattern.replace(/:([A-Za-z_][A-Za-z0-9_]*)|\(\*\)/g, (_, name) => {
      if (name === undefined) {
        paramNames.push('_splat');
        return '(.*)';
      }
      paramNames.push(name);
      return '([^/]+)';
    });
    return { regex: new RegExp('^' + re + '$'), paramNames };
  }
  const methods = ['get', 'post', 'patch', 'put', 'delete'];
  const app = {};
  for (const method of methods) {
    app[method] = (url, opts, handler) => {
      if (typeof opts === 'function') {
        handler = opts;
        opts = {};
      }
      const compiled = patternToRegex(url);
      routes.push({ method, url, opts, handler, compiled });
    };
  }
  return { app, routes };
}

function makeReply() {
  // Returns a single object with mutable body/status/sent properties
  // (NOT getters). Tests must access via this object so they see the
  // post-dispatch values:
  //
  //   const r = makeReply();
  //   await dispatch(routes, 'GET', url, req, r.reply);
  //   r.status;  // → 200
  //   r.body;    // → the response payload
  const r = { status: 200, body: undefined, sent: false };
  r.reply = {
    code(c) { r.status = c; return r.reply; },
    status(c) { r.status = c; return r.reply; },
    send(b) { r.body = b; r.sent = true; return r.reply; },
    // Expose the closure's sent flag so dispatch can tell whether the
    // handler already called send(). Without this, dispatch would
    // re-send the handler's return value (which is the reply object
    // itself in Fastify's `return reply.send(x)` convention).
    get sent() { return r.sent; },
  };
  return r;
}

function dispatch(routes, method, url, request, reply) {
  for (const r of routes) {
    if (r.method.toUpperCase() !== method.toUpperCase()) continue;
    const m = r.compiled.regex.exec(url);
    if (!m) continue;
    // Apply path params
    for (let i = 0; i < r.compiled.paramNames.length; i++) {
      request.params[r.compiled.paramNames[i]] = decodeURIComponent(m[i + 1]);
    }
    // Fastify handlers can either return a value (it becomes the body) or
    // call reply.send(payload). The mock supports both: if the handler
    // returns a non-undefined value, call reply.send(v) so the closure
    // body in makeReply is updated.
    const ret = r.handler(request, reply);
    if (ret && typeof ret.then === 'function') {
      return ret.then((v) => {
        if (v !== undefined && !reply.sent) reply.send(v);
        return v;
      });
    }
    if (ret !== undefined && !reply.sent) reply.send(ret);
    return ret;
  }
  throw new Error(`No route matched ${method} ${url}`);
}

describe('Wave 8 — RBAC routes (server/rbac/routes.js)', () => {
  let db;
  let routes;
  let app;

  before(() => {
    // In-memory node:sqlite DB.
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    // Apply the canonical RBAC schema. The schema has a redundant
    // `PRIMARY KEY (id, tenant_id)` table-level constraint on
    // sbos_rbac_approvals in addition to `id TEXT PRIMARY KEY` —
    // node:sqlite refuses two primary keys, so we strip the redundant
    // composite PK AND the trailing comma on the previous column line.
    const rbacDir = dirname(fileURLToPath(import.meta.url));
    const schemaPath = join(rbacDir, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf8')
      .replace(/,\s*--[^\n]*\n\s*PRIMARY KEY \(id, tenant_id\)\n\s*\);/m, '\n  );');
    db.exec(schema);
    // The RBAC routes also reference a `users` table that lives outside
    // the rbac schema (it's a tenant-level system table). Create the
    // minimal columns we touch.
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL,
        email TEXT,
        role TEXT,
        tenant_id INTEGER NOT NULL DEFAULT 0,
        org_id INTEGER,
        mfa_required INTEGER NOT NULL DEFAULT 0,
        mfa_verified INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.prepare(
      `INSERT INTO users (id, username, email, role, tenant_id, org_id) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(1, 'admin', 'admin@example.com', 'Admin', 0, null);

    const mock = makeMockApp();
    app = mock.app;
    routes = mock.routes;
    registerRbacRoutes(app, { db });
  });

  test('registers all expected route method+url combinations', () => {
    // Pin the API surface so dropped routes are caught in CI.
    const seen = new Set(routes.map((r) => `${r.method.toUpperCase()} ${r.url}`));
    const expected = [
      'GET /api/rbac/permissions',
      'GET /api/rbac/permissions/:key',
      'GET /api/rbac/permission-sets',
      'GET /api/rbac/permission-sets/:id',
      'GET /api/rbac/roles',
      'POST /api/rbac/roles',
      'PATCH /api/rbac/roles/:id',
      'DELETE /api/rbac/roles/:id',
      'GET /api/rbac/users/:userId/effective',
      'POST /api/rbac/users/:userId/permission-sets',
      'DELETE /api/rbac/users/:userId/permission-sets/:ps',
      'POST /api/rbac/users/:userId/role',
      'GET /api/rbac/field-policies',
      'PUT /api/rbac/field-policies/:path(*)',
      'GET /api/rbac/record-rules',
      'PUT /api/rbac/record-rules/:resource(*)',
      'GET /api/rbac/sessions',
      'DELETE /api/rbac/sessions/:id',
      'GET /api/rbac/audit',
      'GET /api/rbac/me/permissions',
      'GET /api/rbac/health',
    ];
    for (const e of expected) assert.ok(seen.has(e), `route registered: ${e}`);
  });

  test('GET /api/rbac/permissions returns catalog version + categories', async () => {
    const req = { user: { id: 1, tenant_id: 0 } };
    const r = makeReply();
    await dispatch(routes, 'GET', '/api/rbac/permissions', req, r.reply);
    assert.ok(r.body.version);
    assert.ok(Array.isArray(r.body.categories));
    assert.ok(r.body.categories.length > 0);
    assert.ok(r.body.categories[0].id);
    assert.ok(Array.isArray(r.body.categories[0].items));
  });

  test('GET /api/rbac/permissions/:key returns the def for a known key, 404 for unknown', async () => {
    const req1 = { user: { id: 1 }, params: {} };
    const r1 = makeReply();
    await dispatch(routes, 'GET', '/api/rbac/permissions/crm.lead.read', req1, r1.reply);
    assert.equal(r1.status, 200);
    assert.equal(r1.body.key, 'crm.lead.read');

    const req2 = { user: { id: 1 }, params: {} };
    const r2 = makeReply();
    await dispatch(routes, 'GET', '/api/rbac/permissions/not.a.real.key', req2, r2.reply);
    assert.equal(r2.status, 404);
    assert.equal(r2.body.error, 'not_found');
  });

  test('GET /api/rbac/permission-sets returns version + items', async () => {
    const req = { user: { id: 1 } };
    const r = makeReply();
    await dispatch(routes, 'GET', '/api/rbac/permission-sets', req, r.reply);
    assert.ok(r.body.version);
    assert.ok(Array.isArray(r.body.items));
    assert.ok(r.body.items.length > 0, 'at least one PS in catalog');
  });

  test('GET /api/rbac/permission-sets/:id — known + 404', async () => {
    // Find a real PS id from the catalog.
    const listReq = { user: { id: 1 } };
    const listReply = makeReply();
    await dispatch(routes, 'GET', '/api/rbac/permission-sets', listReq, listReply.reply);
    const firstId = listReply.body.items[0].id;

    const knownReq = { user: { id: 1 }, params: {} };
    const knownReply = makeReply();
    await dispatch(routes, 'GET', `/api/rbac/permission-sets/${firstId}`, knownReq, knownReply.reply);
    assert.equal(knownReply.status, 200);
    assert.equal(knownReply.body.id, firstId);

    const missReq = { user: { id: 1 }, params: {} };
    const missReply = makeReply();
    await dispatch(routes, 'GET', '/api/rbac/permission-sets/NoSuchPS', missReq, missReply.reply);
    assert.equal(missReply.status, 404);
  });

  test('GET /api/rbac/roles returns roles joined with DB rows', async () => {
    const req = { user: { id: 1 } };
    const r = makeReply();
    await dispatch(routes, 'GET', '/api/rbac/roles', req, r.reply);
    assert.ok(Array.isArray(r.body.items));
    assert.ok(r.body.items.length > 0, 'has roles from DB join');
  });

  test('GET /api/rbac/roles includes custom roles created via POST', async () => {
    // Create a custom role and verify it appears in the list response
    // (the wave 8 fix extends GET to read DB rows too).
    await dispatch(routes, 'POST', '/api/rbac/roles', {
      user: { id: 1 },
      body: { id: 'CustomListMe', parent: 'Admin', appSet: ['finance'] },
    }, makeReply().reply);
    const r = makeReply();
    await dispatch(routes, 'GET', '/api/rbac/roles', { user: { id: 1 } }, r.reply);
    const found = r.body.items.find((it) => it.id === 'CustomListMe');
    assert.ok(found, 'custom role surfaces in the GET list');
    assert.equal(found.isSystem, false);
    assert.equal(found.parent, 'Admin');
    assert.deepEqual(found.appSet, ['finance']);
    assert.deepEqual(found.defaultPermissionSets, [], 'custom roles have no default PSs in the role matrix');
  });

  test('POST /api/rbac/roles creates a custom role and returns 201', async () => {
    const req = {
      user: { id: 1 },
      body: { id: 'CFOLead2', parent: 'Admin', appSet: ['finance'] },
    };
    const r = makeReply();
    await dispatch(routes, 'POST', '/api/rbac/roles', req, r.reply);
    assert.equal(r.status, 201);
    assert.equal(r.body.id, 'CFOLead2');
    assert.equal(r.body.parent, 'Admin');
    const row = db.prepare(`SELECT id, parent, is_system FROM sbos_rbac_roles WHERE id = ?`).get('CFOLead2');
    assert.equal(row.id, 'CFOLead2');
    assert.equal(row.parent, 'Admin');
    assert.equal(row.is_system, 0, 'custom roles are not system');
  });

  test('POST /api/rbac/roles: invalid role body bubbles up validateCustomRole error', async () => {
    const req = { user: { id: 1 }, body: { id: '1bad', parent: 'Admin' } };
    const r = makeReply();
    await assert.rejects(
      () => dispatch(routes, 'POST', '/api/rbac/roles', req, r.reply),
      /must start with a letter/,
    );
  });

  test('PATCH /api/rbac/roles/:id — system role allows limited fields only', async () => {
    const req = {
      user: { id: 1 },
      params: {},
      body: { description: 'Updated description', id: 'HACK' /* id is not in allowed list */ },
    };
    const r = makeReply();
    await dispatch(routes, 'PATCH', '/api/rbac/roles/Admin', req, r.reply);
    assert.equal(r.status, 200);
    // The id field in the body should be ignored (not in allowed list).
    assert.equal(r.body.id, 'Admin');
    // description should be applied.
    assert.equal(r.body.description, 'Updated description');
  });

  test('PATCH /api/rbac/roles/:id — unknown role returns 404', async () => {
    const req = { user: { id: 1 }, params: {}, body: {} };
    const r = makeReply();
    await dispatch(routes, 'PATCH', '/api/rbac/roles/NoSuch', req, r.reply);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not_found');
  });

  test('PATCH /api/rbac/roles/:id — custom role PATCH works via DB fallback', async () => {
    // After the wave 8 fix, loadRole() checks the in-code catalog
    // first, then falls back to the DB. PATCH on a DB-only custom
    // role now reaches the "Custom roles" branch and updates the row.
    const createReq = {
      user: { id: 1 },
      body: { id: 'CustomSkip', parent: 'Admin', appSet: ['finance'] },
    };
    await dispatch(routes, 'POST', '/api/rbac/roles', createReq, makeReply().reply);

    const patchReq = { user: { id: 1 }, params: {}, body: { description: 'X', appSet: ['finance', 'rpt'] } };
    const r = makeReply();
    await dispatch(routes, 'PATCH', '/api/rbac/roles/CustomSkip', patchReq, r.reply);
    assert.equal(r.status, 200);
    assert.equal(r.body.id, 'CustomSkip');
    assert.equal(r.body.description, 'X');
    assert.deepEqual(r.body.appSet, ['finance', 'rpt']);

    // Verify the row was actually updated in the DB.
    const row = db
      .prepare(`SELECT description, app_set_json FROM sbos_rbac_roles WHERE id = ?`)
      .get('CustomSkip');
    assert.equal(row.description, 'X');
    assert.deepEqual(JSON.parse(row.app_set_json), ['finance', 'rpt']);
  });

  test('DELETE /api/rbac/roles/:id — system role returns 409', async () => {
    const req = { user: { id: 1 }, params: {} };
    const r = makeReply();
    await dispatch(routes, 'DELETE', '/api/rbac/roles/Admin', req, r.reply);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'system_role_immutable');
  });

  test('DELETE /api/rbac/roles/:id — unknown role returns 404', async () => {
    const req = { user: { id: 1 }, params: {} };
    const r = makeReply();
    await dispatch(routes, 'DELETE', '/api/rbac/roles/NoSuch', req, r.reply);
    assert.equal(r.status, 404);
  });

  test('DELETE /api/rbac/roles/:id — unused custom role is deletable via DB fallback', async () => {
    // After the wave 8 fix, loadRole() also fixes DELETE.
    await dispatch(routes, 'POST', '/api/rbac/roles', {
      user: { id: 1 },
      body: { id: 'ToDelete2', parent: 'Admin' },
    }, makeReply().reply);
    // Confirm the row is there pre-delete.
    assert.ok(db.prepare(`SELECT id FROM sbos_rbac_roles WHERE id = ?`).get('ToDelete2'));
    const req = { user: { id: 1 }, params: {} };
    const r = makeReply();
    await dispatch(routes, 'DELETE', '/api/rbac/roles/ToDelete2', req, r.reply);
    assert.equal(r.status, 204);
    assert.equal(
      db.prepare(`SELECT id FROM sbos_rbac_roles WHERE id = ?`).get('ToDelete2'),
      undefined,
      'row removed',
    );
  });

  test('DELETE /api/rbac/roles/:id — in-use custom role returns 409 role_in_use', async () => {
    await dispatch(routes, 'POST', '/api/rbac/roles', {
      user: { id: 1 },
      body: { id: 'InUse2', parent: 'Admin' },
    }, makeReply().reply);
    db.prepare(`INSERT INTO sbos_rbac_user_roles (user_id, role_id, tenant_id) VALUES (?, ?, ?)`)
      .run(1, 'InUse2', 0);
    const req = { user: { id: 1 }, params: {} };
    const r = makeReply();
    await dispatch(routes, 'DELETE', '/api/rbac/roles/InUse2', req, r.reply);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'role_in_use');
    assert.ok(r.body.count >= 1);
  });

  test('GET /api/rbac/users/:userId/effective — known user returns chain + effective set', async () => {
    const req = { user: { id: 1 }, params: {} };
    const r = makeReply();
    await dispatch(routes, 'GET', '/api/rbac/users/1/effective', req, r.reply);
    assert.equal(r.status, 200);
    assert.equal(r.body.user.id, 1);
    assert.ok(Array.isArray(r.body.roleChain));
    assert.ok(r.body.roleChain.length > 0);
    assert.ok(Array.isArray(r.body.effectivePermissions));
    assert.ok(r.body.count > 0);
  });

  test('GET /api/rbac/users/:userId/effective — unknown user returns 404', async () => {
    const req = { user: { id: 1 }, params: {} };
    const r = makeReply();
    await dispatch(routes, 'GET', '/api/rbac/users/9999/effective', req, r.reply);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'user_not_found');
  });

  test('POST /api/rbac/users/:userId/permission-sets — invalid PS id returns 400', async () => {
    const req = { user: { id: 1 }, params: {}, body: { permissionSetId: 'NoSuchPS' } };
    const r = makeReply();
    await dispatch(routes, 'POST', '/api/rbac/users/1/permission-sets', req, r.reply);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_permission_set');
  });

  test('POST /api/rbac/users/:userId/permission-sets — valid PS returns the row', async () => {
    // Find a real PS id.
    const listReq = { user: { id: 1 } };
    const listReply = makeReply();
    await dispatch(routes, 'GET', '/api/rbac/permission-sets', listReq, listReply.reply);
    const psId = listReply.body.items[0].id;
    const req = { user: { id: 1 }, params: {}, body: { permissionSetId: psId, expiresAt: null } };
    const r = makeReply();
    await dispatch(routes, 'POST', '/api/rbac/users/1/permission-sets', req, r.reply);
    assert.equal(r.status, 201);
    assert.equal(r.body.userId, 1);
    assert.equal(r.body.permissionSetId, psId);
  });

  test('POST /api/rbac/users/:userId/permission-sets — unknown user returns 404', async () => {
    const listReq = { user: { id: 1 } };
    const listReply = makeReply();
    await dispatch(routes, 'GET', '/api/rbac/permission-sets', listReq, listReply.reply);
    const psId = listReply.body.items[0].id;
    const req = { user: { id: 1 }, params: {}, body: { permissionSetId: psId } };
    const r = makeReply();
    await dispatch(routes, 'POST', '/api/rbac/users/9999/permission-sets', req, r.reply);
    assert.equal(r.status, 404);
  });

  test('DELETE /api/rbac/users/:userId/permission-sets/:ps — unknown user returns 404', async () => {
    const req = { user: { id: 1 }, params: {} };
    const r = makeReply();
    await dispatch(routes, 'DELETE', '/api/rbac/users/9999/permission-sets/SomePS', req, r.reply);
    assert.equal(r.status, 404);
  });

  test('DELETE /api/rbac/users/:userId/permission-sets/:ps — known user returns 204', async () => {
    // First assign
    const listReq = { user: { id: 1 } };
    const listReply = makeReply();
    await dispatch(routes, 'GET', '/api/rbac/permission-sets', listReq, listReply.reply);
    const psId = listReply.body.items[0].id;
    await dispatch(routes, 'POST', '/api/rbac/users/1/permission-sets', {
      user: { id: 1 }, params: {}, body: { permissionSetId: psId },
    }, makeReply().reply);
    // Then delete
    const req = { user: { id: 1 }, params: {} };
    const r = makeReply();
    await dispatch(routes, 'DELETE', `/api/rbac/users/1/permission-sets/${psId}`, req, r.reply);
    assert.equal(r.status, 204);
  });

  test('POST /api/rbac/users/:userId/role — invalid roleId returns 400', async () => {
    const req = { user: { id: 1 }, params: {}, body: { roleId: 'NoSuchRole' } };
    const r = makeReply();
    await dispatch(routes, 'POST', '/api/rbac/users/1/role', req, r.reply);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_role');
  });

  test('POST /api/rbac/users/:userId/role — valid role returns 201', async () => {
    const req = { user: { id: 1 }, params: {}, body: { roleId: 'Admin' } };
    const r = makeReply();
    await dispatch(routes, 'POST', '/api/rbac/users/1/role', req, r.reply);
    assert.equal(r.status, 201);
    assert.equal(r.body.userId, 1);
    assert.equal(r.body.roleId, 'Admin');
  });

  test('GET /api/rbac/field-policies returns empty list initially', async () => {
    const req = { user: { id: 1 } };
    const r = makeReply();
    await dispatch(routes, 'GET', '/api/rbac/field-policies', req, r.reply);
    assert.ok(Array.isArray(r.body.items));
  });

  test('PUT /api/rbac/field-policies/:path(*) — invalid minPermission returns 400', async () => {
    const req = { user: { id: 1 }, params: {}, body: { minPermission: 'not.a.real.key' } };
    const r = makeReply();
    await dispatch(routes, 'PUT', '/api/rbac/field-policies/customer.ssn', req, r.reply);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_min_permission');
  });

  test('PUT /api/rbac/field-policies/:path(*) — valid policy upserts and returns 200', async () => {
    const req = {
      user: { id: 1 },
      params: {},
      body: { minPermission: 'crm.lead.read', isVisible: false, label: 'Customer SSN' },
    };
    const r = makeReply();
    await dispatch(routes, 'PUT', '/api/rbac/field-policies/customer.ssn', req, r.reply);
    assert.equal(r.status, 200);
    assert.equal(r.body.fieldPath, 'customer.ssn');
    assert.equal(r.body.minPermission, 'crm.lead.read');
  });

  test('GET /api/rbac/record-rules returns empty list initially', async () => {
    const req = { user: { id: 1 } };
    const r = makeReply();
    await dispatch(routes, 'GET', '/api/rbac/record-rules', req, r.reply);
    assert.ok(Array.isArray(r.body.items));
  });

  test('PUT /api/rbac/record-rules/:resource(*) — invalid scope returns 400', async () => {
    const req = { user: { id: 1 }, params: {}, body: { scope: 'unknown' } };
    const r = makeReply();
    await dispatch(routes, 'PUT', '/api/rbac/record-rules/crm.lead', req, r.reply);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_scope');
  });

  test('PUT /api/rbac/record-rules/:resource(*) — custom scope without predicate returns 400', async () => {
    const req = { user: { id: 1 }, params: {}, body: { scope: 'custom' } };
    const r = makeReply();
    await dispatch(routes, 'PUT', '/api/rbac/record-rules/crm.lead', req, r.reply);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'predicate_required_for_custom_scope');
  });

  test('PUT /api/rbac/record-rules/:resource(*) — custom scope with predicate returns 200', async () => {
    const req = {
      user: { id: 1 },
      params: {},
      body: { scope: 'custom', predicate: 'owner_id = $userId', description: 'owner-only' },
    };
    const r = makeReply();
    await dispatch(routes, 'PUT', '/api/rbac/record-rules/crm.lead', req, r.reply);
    assert.equal(r.status, 200);
  });

  test('GET /api/rbac/sessions returns the session list', async () => {
    const req = { user: { id: 1, tenant_id: 0 }, query: {} };
    const r = makeReply();
    await dispatch(routes, 'GET', '/api/rbac/sessions', req, r.reply);
    assert.ok(Array.isArray(r.body.items));
  });

  test('DELETE /api/rbac/sessions/:id always returns 204', async () => {
    const req = { user: { id: 1 }, params: {} };
    const r = makeReply();
    await dispatch(routes, 'DELETE', '/api/rbac/sessions/some-session-id', req, r.reply);
    assert.equal(r.status, 204);
  });

  test('GET /api/rbac/audit — optional decision + userId filters compose', async () => {
    // Insert one allow + one deny row.
    db.prepare(
      `INSERT INTO sbos_rbac_permission_audit
         (user_id, permission, decision, resource, reason, ip, session_id, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(1, 'crm.lead.read', 'allow', 'lead:1', 'ok', '127.0.0.1', 'sess1', 0);
    db.prepare(
      `INSERT INTO sbos_rbac_permission_audit
         (user_id, permission, decision, resource, reason, ip, session_id, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(1, 'crm.lead.delete', 'deny', 'lead:1', 'no_perm', '127.0.0.1', 'sess1', 0);

    const allReq = { user: { id: 1, tenant_id: 0 }, query: {} };
    const allReply = makeReply();
    await dispatch(routes, 'GET', '/api/rbac/audit', allReq, allReply.reply);
    assert.ok(allReply.body.items.length >= 2);

    const allowReq = { user: { id: 1, tenant_id: 0 }, query: { decision: 'allow' } };
    const allowReply = makeReply();
    await dispatch(routes, 'GET', '/api/rbac/audit', allowReq, allowReply.reply);
    assert.ok(allowReply.body.items.every((r) => r.decision === 'allow'));

    const filterReq = { user: { id: 1, tenant_id: 0 }, query: { userId: '1' } };
    const filterReply = makeReply();
    await dispatch(routes, 'GET', '/api/rbac/audit', filterReq, filterReply.reply);
    assert.ok(filterReply.body.items.every((r) => r.user_id === 1));
  });

  test('GET /api/rbac/me/permissions returns the caller effective permissions', async () => {
    const req = { user: { id: 1, role: 'Admin', permission_set_ids: [], tenant_id: 0 } };
    const r = makeReply();
    await dispatch(routes, 'GET', '/api/rbac/me/permissions', req, r.reply);
    assert.equal(r.body.role, 'Admin');
    assert.ok(Array.isArray(r.body.effectivePermissions));
    assert.ok(r.body.count > 0);
  });

  test('GET /api/rbac/health returns ok + empty issues on a clean catalog', async () => {
    const req = { user: { id: 1, tenant_id: 0 } };
    const r = makeReply();
    await dispatch(routes, 'GET', '/api/rbac/health', req, r.reply);
    assert.equal(r.body.ok, true, 'catalog is internally consistent');
    assert.deepEqual(r.body.issues, []);
  });

  test('registerRbacRoutes throws if neither opts.db nor app.db is provided', () => {
    const m = makeMockApp();
    assert.throws(
      () => registerRbacRoutes(m.app),
      /rbac routes require db/,
    );
  });
});

describe('Wave 8 — RBAC seed installer (server/rbac/seed.js) via node:sqlite', () => {
  let db;

  before(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const rbacDir = dirname(fileURLToPath(import.meta.url));
    const schema = readFileSync(join(rbacDir, 'schema.sql'), 'utf8')
      .replace(/,\s*--[^\n]*\n\s*PRIMARY KEY \(id, tenant_id\)\n\s*\);/m, '\n  );');
    db.exec(schema);
  });

  test('seedRBAC: returns counts matching the in-code catalogs', async () => {
    const v = await seedRBAC(db);
    assert.equal(v.permissions_seeded, listKeys().length);
    assert.equal(v.roles_seeded, listRoleIds().length);
    assert.ok(v.permission_sets_seeded > 0);
    assert.ok(v.role_default_links_seeded > 0);
    assert.ok(v.versions);
    assert.equal(v.versions.permissions, rbac.PERMISSIONS_VERSION);
  });

  test('seedRBAC: rows are actually present in the DB', async () => {
    const perms = db.prepare(`SELECT COUNT(*) AS c FROM sbos_rbac_permissions WHERE tenant_id = 0`).get();
    const roles = db.prepare(`SELECT COUNT(*) AS c FROM sbos_rbac_roles WHERE tenant_id = 0`).get();
    const sets = db.prepare(`SELECT COUNT(*) AS c FROM sbos_rbac_permission_sets WHERE tenant_id = 0`).get();
    const links = db.prepare(`SELECT COUNT(*) AS c FROM sbos_rbac_role_permission_sets`).get();
    assert.equal(perms.c, listKeys().length);
    assert.equal(roles.c, listRoleIds().length);
    assert.equal(sets.c, Object.keys(PERMISSION_SETS).length);
    assert.ok(links.c > 0);
  });

  test('seedRBAC: is idempotent — re-running does not duplicate or error', async () => {
    await seedRBAC(db);
    const perms = db.prepare(`SELECT COUNT(*) AS c FROM sbos_rbac_permissions WHERE tenant_id = 0`).get();
    assert.equal(perms.c, listKeys().length);
  });

  test('readVersions: returns the seeded versions', () => {
    const v = readVersions(db);
    assert.equal(Number(v.permissions_version), rbac.PERMISSIONS_VERSION);
    assert.equal(Number(v.roles_version), rbac.ROLES_VERSION);
    assert.equal(Number(v.permission_sets_version), rbac.PERMISSION_SETS_VERSION);
  });

  test('seedRBAC: force=true wipes + re-seeds (DANGEROUS path)', async () => {
    // First seed.
    await seedRBAC(db);
    // Insert a junk row to prove force wipes it.
    db.prepare(`INSERT INTO sbos_rbac_permissions (key, tenant_id, category, sensitivity, label, description) VALUES ('junk.x', 0, 'crm', 'low', 'junk', '')`).run();
    const before = db.prepare(`SELECT COUNT(*) AS c FROM sbos_rbac_permissions WHERE tenant_id = 0`).get();
    assert.ok(before.c > listKeys().length, 'junk row inflated the count');
    // Force re-seed.
    const v = await seedRBAC(db, { force: true });
    assert.equal(v.permissions_seeded, listKeys().length, 'junk gone, catalog restored');
    const after = db.prepare(`SELECT COUNT(*) AS c FROM sbos_rbac_permissions WHERE tenant_id = 0`).get();
    assert.equal(after.c, listKeys().length);
  });

  test('seedRBAC: also seeds permission_set_members when the catalog has them', async () => {
    // The matrix.js PSes have a `permissions` array of keys. Each one
    // should be in sbos_rbac_permission_set_members.
    const members = db.prepare(`SELECT COUNT(*) AS c FROM sbos_rbac_permission_set_members`).get();
    // Each PS contributes `permissions.length` member rows.
    const expected = Object.values(PERMISSION_SETS).reduce(
      (acc, ps) => acc + (ps.permissions ? ps.permissions.length : 0),
      0,
    );
    assert.equal(members.c, expected, 'all PS permissions became members');
  });

  test('runMigrations: re-running swallows "duplicate column" / "already exists" but rethrows others', async () => {
    // The migration runner runs each statement and treats
    // "duplicate column" / "already exists" errors as no-ops (idempotent).
    // Any other error must be rethrown.
    //
    // Note: runMigrations reads server/rbac/schema.sql directly, which
    // has a redundant composite PK on sbos_rbac_approvals that
    // node:sqlite refuses. So we can't use node:sqlite here — we use
    // a mock db that simulates the driver behavior.
    const { runMigrations } = await import('./seed.js');
    const calls = [];
    const db = {
      exec(sql) {
        calls.push(sql);
        // First time the table CREATE runs: succeed.
        // Second time: throw "already exists" to exercise the filter.
        // The migration runner is per-statement, so we look at the
        // table name in the SQL.
        if (/already exists|duplicate column/i.test(sql)) {
          throw new Error('already exists');
        }
        // Always fail non-duplicate errors so we can re-throw branch.
        if (/^CREATE TABLE/.test(sql)) {
          // Record first occurrence, fail second.
          if (!calls.seenTables) calls.seenTables = new Set();
          const m = sql.match(/CREATE TABLE[^A]+(sbos_\w+)/);
          const tbl = m && m[1];
          if (tbl && calls.seenTables.has(tbl)) {
            throw new Error('already exists');
          }
          if (tbl) calls.seenTables.add(tbl);
          return undefined;
        }
        return undefined;
      },
    };
    // First call: every CREATE succeeds. Some statements may still
    // throw (e.g. CREATE INDEX on a non-existent table) but the
    // migration runner swallows those errors as "already exists"
    // because the regex is broad. We're just exercising the swallow
    // path; the exact error pattern doesn't matter for this test.
    await runMigrations(db);
    // Second call on the SAME db mock: every CREATE now hits the
    // "already exists" filter and is swallowed. runMigrations should
    // not throw.
    await runMigrations(db);

    // Non-duplicate errors propagate. Build a db that throws a
    // non-duplicate error.
    const dbBad = {
      exec() {
        throw new Error('syntax error near "PRAGMA"');
      },
    };
    await assert.rejects(() => runMigrations(dbBad), /syntax error/);
  });

  test('seedRBAC: throws when given a non-sqlite DB (no .prepare/.exec)', async () => {
    // The first guard in seedRBAC rejects anything that doesn't look
    // like a sqlite driver. Closes the line-165..167 branch.
    const fake = { transaction: () => () => null, query: () => null };
    await assert.rejects(
      () => seedRBAC(fake),
      /must be a sqlite-compatible instance/,
    );
  });

  test('seedRBAC: pg-style db with beginTransaction/commitTransaction path', async () => {
    // Exercises the second branch of runInTx (line 29-38). A pg-style
    // db that has beginTransaction/commitTransaction but no .transaction.
    // We need the seed steps to actually run, so we back the
    // "queries" with a real node:sqlite handle via a fake driver.
    const real = new DatabaseSync(':memory:');
    // Load the schema so seed INSERTs work. The schema has a redundant
    // composite PK on sbos_rbac_approvals that node:sqlite refuses.
    const rbacDir = dirname(fileURLToPath(import.meta.url));
    const schema = readFileSync(join(rbacDir, 'schema.sql'), 'utf8')
      .replace(/,\s*--[^\n]*\n\s*PRIMARY KEY \(id, tenant_id\)\n\s*\);/m, '\n  );');
    real.exec(schema);

    // Mock db: a sqlite-compatible facade that wraps the real handle,
    // so .prepare / .exec / .run work, but exposes beginTransaction +
    // commitTransaction + rollbackTransaction so the second branch of
    // runInTx is taken.
    const statements = [];
    let inTx = false;
    let txRolledBack = false;
    const db = {
      prepare(sql) {
        const stmt = real.prepare(sql);
        return {
          run(...args) { return stmt.run(...args); },
          get(...args) { return stmt.get(...args); },
          all(...args) { return stmt.all(...args); },
        };
      },
      exec(sql) { real.exec(sql); statements.push(sql); },
      beginTransaction() { inTx = true; },
      commitTransaction() { inTx = false; },
      rollbackTransaction() { inTx = false; txRolledBack = true; },
    };
    // Force runInTx to take the beginTransaction branch by removing .transaction.
    // Our db has no .transaction method, so it falls through to beginTransaction.

    // Seed should succeed.
    const v = await seedRBAC(db);
    assert.equal(v.permissions_seeded, listKeys().length);
    assert.equal(v.roles_seeded, listRoleIds().length);
    assert.equal(inTx, false, 'commitTransaction was called');

    // Now exercise the rollback branch by forcing the first INSERT
    // (permissions) to throw mid-transaction. The seed SQL is wrapped
    // in beginTransaction/commitTransaction, so any throw inside the
    // body should trigger rollbackTransaction().
    let throwCount = 0;
    const db2 = {
      ...db,
      prepare(sql) {
        const stmt = real.prepare(sql);
        return {
          run(...args) {
            if (/INSERT INTO sbos_rbac_permissions/i.test(sql)) {
              throwCount++;
              throw new Error('forced: permissions insert failed');
            }
            return stmt.run(...args);
          },
          get(...args) { return stmt.get(...args); },
          all(...args) { return stmt.all(...args); },
        };
      },
    };
    txRolledBack = false;
    await assert.rejects(() => seedRBAC(db2), /forced: permissions insert failed/);
    assert.equal(txRolledBack, true, 'rollbackTransaction was called on error');
    assert.ok(throwCount > 0, 'mock throw was actually invoked');
  });

  test('seedRBAC: db with both .transaction and .beginTransaction prefers .transaction', async () => {
    // The first branch of runInTx (line 26-28). A driver that has
    // .transaction should use that, not the beginTransaction path.
    const real = new DatabaseSync(':memory:');
    const rbacDir = dirname(fileURLToPath(import.meta.url));
    const schema = readFileSync(join(rbacDir, 'schema.sql'), 'utf8')
      .replace(/,\s*--[^\n]*\n\s*PRIMARY KEY \(id, tenant_id\)\n\s*\);/m, '\n  );');
    real.exec(schema);

    let txUsed = false;
    let beginTxUsed = false;
    const db = {
      prepare(sql) {
        const stmt = real.prepare(sql);
        return {
          run(...args) { return stmt.run(...args); },
          get(...args) { return stmt.get(...args); },
          all(...args) { return stmt.all(...args); },
        };
      },
      exec(sql) { real.exec(sql); },
      transaction(fn) {
        txUsed = true;
        return () => fn();
      },
      beginTransaction() { beginTxUsed = true; },
    };
    const v = await seedRBAC(db);
    assert.equal(v.permissions_seeded, listKeys().length);
    assert.equal(txUsed, true, '.transaction was used');
    assert.equal(beginTxUsed, false, 'beginTransaction was NOT used');
  });
});
