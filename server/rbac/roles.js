// SBOS-A1-ERP Role Catalog
//
// Catalog-driven roles with hierarchy. Each role defines:
//   - parent: the role it inherits from (transitively)
//   - isSystem: true if it cannot be deleted or renamed
//   - appSet: the default apps visible in the sidebar
//   - description: who this role is for and what they typically do
//
// Inheritance model: a role inherits the permission sets of its ancestors.
// Conflict resolution: a permission is GRANTED if any ancestor grants it.
// DENY is not used; instead, roles are decomposed via finer-grained roles.
//
// Inspired by Salesforce role hierarchy + Odoo inheritance groups.
const ROLES_VERSION = 1;

// App IDs — keep aligned with server/app.js APP_ASSIGNMENT_ROLE_GUARDS and
// web navigation.
const APPS = Object.freeze({
  DASHBOARD:    'dashboard',
  CRM:          'crm',
  FINANCE:      'finance',
  INVENTORY:    'inventory',
  PURCHASE:     'purchase',
  POS:          'pos',
  HR:           'hr',
  PROJECTS:     'projects',
  DESK:         'desk',
  DOCS:         'docs',
  PORTAL:       'portal',
  MARKETING:    'marketing',
  MFG:          'mfg',
  AI:           'ai',
  REPORTS:      'reports',
  STUDIO:       'studio',
  COMPLIANCE:   'compliance',
  SETTINGS:     'settings',
  AUDIT:        'audit',
  SYSTEM:       'system',
});

// App set presets per role — used as default for new users of that role.
// Tenant admins can override per-user via app_assignments table.
const APP_PRESETS = Object.freeze({
  OWNER_ALL: [
    'dashboard', 'crm', 'finance', 'inventory', 'purchase', 'pos', 'hr',
    'projects', 'desk', 'docs', 'portal', 'marketing', 'mfg', 'ai',
    'reports', 'studio', 'compliance', 'settings', 'audit', 'system',
  ],
  ADMIN_ALL: [
    'dashboard', 'crm', 'finance', 'inventory', 'purchase', 'pos', 'hr',
    'projects', 'desk', 'docs', 'portal', 'marketing', 'mfg', 'ai',
    'reports', 'studio', 'compliance', 'settings', 'audit', 'system',
  ],
  FINANCE_FULL: ['dashboard', 'crm', 'finance', 'reports', 'compliance', 'audit', 'docs', 'settings'],
  SALES_FULL:   ['dashboard', 'crm', 'inventory', 'portal', 'reports', 'desk', 'docs'],
  PURCHASE_FULL:['dashboard', 'purchase', 'inventory', 'finance', 'reports', 'docs'],
  HR_FULL:      ['dashboard', 'hr', 'reports', 'docs', 'compliance'],
  INVENTORY_FULL:['dashboard', 'inventory', 'purchase', 'reports', 'docs'],
  PROJECT_FULL: ['dashboard', 'projects', 'desk', 'reports', 'docs'],
  POS_CASHIER:  ['dashboard', 'pos', 'crm', 'docs'],
  DESK_AGENT:   ['dashboard', 'desk', 'crm', 'docs', 'ai'],
  READ_ONLY:    ['dashboard', 'reports'],
  AUDITOR:      ['dashboard', 'reports', 'audit', 'compliance'],
  PORTAL_CUSTOMER: ['portal'],
});

// Role catalog
// Each role declares parent (single inheritance) and a default app set.
// The permission grants live in matrix.js, not here, so the role catalog
// stays decoupled from the permission catalog.
const ROLES = Object.freeze({
  // ───────── Top of the hierarchy ─────────
  Owner: {
    id: 'Owner',
    label: 'Owner',
    description: 'Top of the role hierarchy. Full control of the organization including billing, deletion, and privileged actions. Required for tenant creation, period unlock, and audit packet delivery.',
    parent: null,
    isSystem: true,
    appSet: APP_PRESETS.OWNER_ALL,
    mfaRequired: true,
    sessionHardLimitMinutes: 60,
    canBeImpersonated: false,
  },
  Admin: {
    id: 'Admin',
    label: 'Admin',
    description: 'Full administrative control except the most sensitive Owner-only actions (tenant delete, audit packet delivery).',
    parent: 'Owner',
    isSystem: true,
    appSet: APP_PRESETS.ADMIN_ALL,
    mfaRequired: true,
    sessionHardLimitMinutes: 60,
    canBeImpersonated: false,
  },

  // ───────── Functional leads ─────────
  FinanceLead: {
    id: 'FinanceLead',
    label: 'Finance Lead',
    description: 'Leads the finance function. Full read/write on finance, full read on operational modules for cross-functional context.',
    parent: 'Admin',
    isSystem: true,
    appSet: APP_PRESETS.FINANCE_FULL,
    mfaRequired: true,
    sessionHardLimitMinutes: 60,
    canBeImpersonated: false,
  },
  SalesLead: {
    id: 'SalesLead',
    label: 'Sales Lead',
    description: 'Leads sales/CRM. Full read/write on CRM and inventory (for quoting). Read-only on finance.',
    parent: 'Admin',
    isSystem: true,
    appSet: APP_PRESETS.SALES_FULL,
    mfaRequired: false,
    sessionHardLimitMinutes: 240,
    canBeImpersonated: true,
  },
  PurchaseLead: {
    id: 'PurchaseLead',
    label: 'Purchase Lead',
    description: 'Leads procurement. Full read/write on purchase and inventory. Read on finance.',
    parent: 'Admin',
    isSystem: true,
    appSet: APP_PRESETS.PURCHASE_FULL,
    mfaRequired: false,
    sessionHardLimitMinutes: 240,
    canBeImpersonated: true,
  },
  HRLead: {
    id: 'HRLead',
    label: 'HR Lead',
    description: 'Leads people operations. Full access to HR and read on finance for payroll context.',
    parent: 'Admin',
    isSystem: true,
    appSet: APP_PRESETS.HR_FULL,
    mfaRequired: true,
    sessionHardLimitMinutes: 60,
    canBeImpersonated: false,
  },
  InventoryLead: {
    id: 'InventoryLead',
    label: 'Inventory Lead',
    description: 'Leads warehouse operations. Full inventory and purchase read.',
    parent: 'Admin',
    isSystem: true,
    appSet: APP_PRESETS.INVENTORY_FULL,
    mfaRequired: false,
    sessionHardLimitMinutes: 240,
    canBeImpersonated: true,
  },
  ProjectLead: {
    id: 'ProjectLead',
    label: 'Project Lead',
    description: 'Manages projects and time. Read on finance for billing.',
    parent: 'Admin',
    isSystem: true,
    appSet: APP_PRESETS.PROJECT_FULL,
    mfaRequired: false,
    sessionHardLimitMinutes: 240,
    canBeImpersonated: true,
  },

  // ───────── Practitioners ─────────
  Accountant: {
    id: 'Accountant',
    label: 'Accountant',
    description: 'Day-to-day accounting: invoices, bills, payments, bank rec, VAT, period close. Read on operational modules.',
    parent: 'FinanceLead',
    isSystem: true,
    appSet: ['dashboard', 'finance', 'reports', 'crm', 'docs', 'compliance', 'audit'],
    mfaRequired: true,
    sessionHardLimitMinutes: 120,
    canBeImpersonated: true,
  },
  Bookkeeper: {
    id: 'Bookkeeper',
    label: 'Bookkeeper',
    description: 'Books daily transactions (AR/AP). Cannot post journal entries or close periods.',
    parent: 'Accountant',
    isSystem: true,
    appSet: ['dashboard', 'finance', 'docs'],
    mfaRequired: false,
    sessionHardLimitMinutes: 240,
    canBeImpersonated: true,
  },
  Lawyer: {
    id: 'Lawyer',
    label: 'Lawyer',
    description: 'Reviews contracts, e-signature workflows, and legal sources. Read-only on operational modules.',
    parent: 'ComplianceOfficer',
    isSystem: true,
    appSet: ['dashboard', 'docs', 'reports', 'compliance'],
    mfaRequired: true,
    sessionHardLimitMinutes: 120,
    canBeImpersonated: false,
  },
  SalesManager: {
    id: 'SalesManager',
    label: 'Sales Manager',
    description: 'Manages a sales team. Approves deals and quotes, can reassign leads/deals.',
    parent: 'SalesLead',
    isSystem: true,
    appSet: ['dashboard', 'crm', 'inventory', 'portal', 'reports', 'desk', 'docs'],
    mfaRequired: false,
    sessionHardLimitMinutes: 240,
    canBeImpersonated: true,
  },
  SalesRep: {
    id: 'SalesRep',
    label: 'Sales Rep',
    description: 'Frontline sales. Creates leads/deals/quotes, runs pipeline. Limited approvals.',
    parent: 'SalesManager',
    isSystem: true,
    appSet: ['dashboard', 'crm', 'inventory', 'docs', 'desk'],
    mfaRequired: false,
    sessionHardLimitMinutes: 480,
    canBeImpersonated: true,
  },
  Purchaser: {
    id: 'Purchaser',
    label: 'Purchaser',
    description: 'Manages RFQs, POs, receipts, returns. Read on finance for budget context.',
    parent: 'PurchaseLead',
    isSystem: true,
    appSet: ['dashboard', 'purchase', 'inventory', 'docs', 'reports'],
    mfaRequired: false,
    sessionHardLimitMinutes: 240,
    canBeImpersonated: true,
  },
  WarehouseClerk: {
    id: 'WarehouseClerk',
    label: 'Warehouse Clerk',
    description: 'Operates the warehouse: receive, deliver, transfer, adjust stock. Limited to inventory.',
    parent: 'InventoryLead',
    isSystem: true,
    appSet: ['dashboard', 'inventory', 'docs'],
    mfaRequired: false,
    sessionHardLimitMinutes: 480,
    canBeImpersonated: true,
  },
  HRSpecialist: {
    id: 'HRSpecialist',
    label: 'HR Specialist',
    description: 'Operates HR: employee records, contracts, attendance, leave. Cannot run payroll.',
    parent: 'HRLead',
    isSystem: true,
    appSet: ['dashboard', 'hr', 'docs', 'compliance'],
    mfaRequired: true,
    sessionHardLimitMinutes: 120,
    canBeImpersonated: true,
  },
  PayrollClerk: {
    id: 'PayrollClerk',
    label: 'Payroll Clerk',
    description: 'Runs payroll. Read on HR and finance. Cannot edit employee master data.',
    parent: 'Accountant',
    isSystem: true,
    appSet: ['dashboard', 'hr', 'finance', 'reports', 'docs'],
    mfaRequired: true,
    sessionHardLimitMinutes: 120,
    canBeImpersonated: true,
  },
  ProjectManager: {
    id: 'ProjectManager',
    label: 'Project Manager',
    description: 'Owns projects, tasks, time entries, and project billing.',
    parent: 'ProjectLead',
    isSystem: true,
    appSet: ['dashboard', 'projects', 'desk', 'reports', 'docs'],
    mfaRequired: false,
    sessionHardLimitMinutes: 240,
    canBeImpersonated: true,
  },
  ProjectMember: {
    id: 'ProjectMember',
    label: 'Project Member',
    description: 'Contributor on projects. Logs time and updates own tasks.',
    parent: 'ProjectManager',
    isSystem: true,
    appSet: ['dashboard', 'projects', 'docs'],
    mfaRequired: false,
    sessionHardLimitMinutes: 480,
    canBeImpersonated: true,
  },
  HelpdeskAgent: {
    id: 'HelpdeskAgent',
    label: 'Helpdesk Agent',
    description: 'Frontline support: cases, replies, knowledge base read.',
    parent: 'ProjectLead',
    isSystem: true,
    appSet: APP_PRESETS.DESK_AGENT,
    mfaRequired: false,
    sessionHardLimitMinutes: 240,
    canBeImpersonated: true,
  },
  POSCashier: {
    id: 'POSCashier',
    label: 'POS Cashier',
    description: 'Operates the POS register: sales, refunds, cash drawer.',
    parent: 'InventoryLead',
    isSystem: true,
    appSet: APP_PRESETS.POS_CASHIER,
    mfaRequired: false,
    sessionHardLimitMinutes: 480,
    canBeImpersonated: true,
  },

  // ───────── Specialists ─────────
  CopilotReviewer: {
    id: 'CopilotReviewer',
    label: 'Copilot Reviewer',
    description: 'Reviews AI-proposed mutations. Approves or rejects Copilot actions that touch critical data.',
    parent: 'Admin',
    isSystem: true,
    appSet: ['dashboard', 'ai', 'compliance', 'audit', 'reports'],
    mfaRequired: true,
    sessionHardLimitMinutes: 120,
    canBeImpersonated: false,
  },
  ComplianceOfficer: {
    id: 'ComplianceOfficer',
    label: 'Compliance Officer',
    description: 'Manages compliance policies, legal sources, retention, and data subject requests.',
    parent: 'Admin',
    isSystem: true,
    appSet: ['dashboard', 'compliance', 'audit', 'docs', 'reports'],
    mfaRequired: true,
    sessionHardLimitMinutes: 120,
    canBeImpersonated: false,
  },
  Auditor: {
    id: 'Auditor',
    label: 'Auditor',
    description: 'Read-only across the org with full audit access. No mutations. Used for internal/external audits.',
    parent: 'Admin',
    isSystem: true,
    appSet: APP_PRESETS.AUDITOR,
    mfaRequired: true,
    sessionHardLimitMinutes: 60,
    canBeImpersonated: false,
  },

  // ───────── Operator (legacy) ─────────
  Operator: {
    id: 'Operator',
    label: 'Operator',
    description: 'General operator role for pilot workbenches and cross-functional tasks. Limited scoped permissions.',
    parent: 'Admin',
    isSystem: true,
    appSet: ['dashboard', 'crm', 'desk', 'docs'],
    mfaRequired: false,
    sessionHardLimitMinutes: 480,
    canBeImpersonated: true,
  },
  ServiceManager: {
    id: 'ServiceManager',
    label: 'Service Manager',
    description: 'Manages helpdesk, escalations, and SLAs.',
    parent: 'Operator',
    isSystem: true,
    appSet: ['dashboard', 'desk', 'crm', 'docs', 'reports'],
    mfaRequired: false,
    sessionHardLimitMinutes: 240,
    canBeImpersonated: true,
  },

  // ───────── External / Customer ─────────
  CustomerPortal: {
    id: 'CustomerPortal',
    label: 'Customer Portal',
    description: 'External customer. Limited to portal-only access. Tenant-scoped to a single customer account.',
    parent: null,
    isSystem: true,
    appSet: APP_PRESETS.PORTAL_CUSTOMER,
    mfaRequired: false,
    sessionHardLimitMinutes: 1440,
    canBeImpersonated: true,
  },
  VendorPortal: {
    id: 'VendorPortal',
    label: 'Vendor Portal',
    description: 'External vendor. Limited to vendor portal (POs, RFQs, returns).',
    parent: null,
    isSystem: true,
    appSet: ['portal'],
    mfaRequired: false,
    sessionHardLimitMinutes: 1440,
    canBeImpersonated: true,
  },
});

// Default role for a newly invited user when the inviter does not pick one.
const DEFAULT_INVITED_ROLE = 'SalesRep';

function isSystemRole(id) {
  const r = ROLES[id];
  return Boolean(r && r.isSystem);
}

function getRole(id) {
  return ROLES[id] || null;
}

function listRoleIds() {
  return Object.freeze(Object.keys(ROLES));
}

function roleExists(id) {
  return Object.prototype.hasOwnProperty.call(ROLES, id);
}

function getAppSet(id) {
  const r = ROLES[id];
  return r ? Object.freeze([...r.appSet]) : Object.freeze([]);
}

function getParentChain(id) {
  const chain = [];
  let cur = ROLES[id];
  while (cur) {
    chain.push(cur.id);
    cur = cur.parent ? ROLES[cur.parent] : null;
  }
  return chain;
}

function getEffectiveAppSet(id) {
  // Apps unioned up the parent chain so a child always sees parent's apps.
  const seen = new Set();
  for (const rid of getParentChain(id)) {
    for (const app of getAppSet(rid)) seen.add(app);
  }
  return Object.freeze([...seen]);
}

function mfaRequiredFor(id) {
  const chain = getParentChain(id);
  // The first role in the chain with mfaRequired=true wins.
  for (const rid of chain) {
    if (ROLES[rid] && ROLES[rid].mfaRequired) return true;
  }
  return false;
}

function sessionHardLimitMinutesFor(id) {
  // The most restrictive (lowest) limit in the chain wins.
  let limit = Number.POSITIVE_INFINITY;
  for (const rid of getParentChain(id)) {
    const v = ROLES[rid] && ROLES[rid].sessionHardLimitMinutes;
    if (typeof v === 'number' && v < limit) limit = v;
  }
  return limit === Number.POSITIVE_INFINITY ? 480 : limit;
}

function canBeImpersonated(id) {
  // The user's own role decides impersonation. We do NOT propagate from
  // ancestors — Owner/Admin in the chain are impersonable-able (their own
  // role says so), but a Practitioner (Accountant) is impersonable because
  // their role says so, not because of any ancestor. This keeps the policy
  // predictable and makes "can be impersonated" a per-role property.
  const r = ROLES[id];
  if (!r) return false;
  return r.canBeImpersonated !== false;
}

// Validation for tenant-defined custom roles (created via security.role.create).
// Custom roles must declare a parent that is a system role.
function validateCustomRole(input) {
  if (!isPlainObject(input)) {
    const err = new Error('Role body must be an object'); err.statusCode = 400; throw err;
  }
  const id = String(input.id || '').trim();
  if (!id) {
    const err = new Error('Role id is required'); err.statusCode = 400; throw err;
  }
  if (id.length > 80 || !/^[A-Za-z][A-Za-z0-9_]*$/.test(id)) {
    const err = new Error('Role id must start with a letter and use letters, digits, underscores');
    err.statusCode = 400; throw err;
  }
  if (ROLES[id]) {
    const err = new Error('Role id already exists'); err.statusCode = 409; throw err;
  }
  const parent = String(input.parent || '').trim();
  if (!parent || !ROLES[parent]) {
    const err = new Error(`Parent role references unknown role: ${input.parent || '(empty)'}`); err.statusCode = 400; throw err;
  }
  const appSet = Array.isArray(input.appSet) ? input.appSet : [];
  for (const app of appSet) {
    if (typeof app !== 'string' || app.length > 40) {
      const err = new Error('Invalid app id in appSet'); err.statusCode = 400; throw err;
    }
  }
  return {
    id,
    label: String(input.label || id).slice(0, 80),
    description: String(input.description || '').slice(0, 400),
    parent,
    isSystem: false,
    appSet: Object.freeze([...new Set(appSet)]),
    mfaRequired: Boolean(input.mfaRequired),
    sessionHardLimitMinutes: clampInt(input.sessionHardLimitMinutes, 30, 1440, 240),
    canBeImpersonated: input.canBeImpersonated !== false,
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clampInt(value, min, max, fallback) {
  const n = Number.isFinite(Number(value)) ? Math.floor(Number(value)) : fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export {ROLES_VERSION,
  APPS,
  APP_PRESETS,
  ROLES,
  DEFAULT_INVITED_ROLE,
  isSystemRole,
  getRole,
  listRoleIds,
  roleExists,
  getAppSet,
  getParentChain,
  getEffectiveAppSet,
  mfaRequiredFor,
  sessionHardLimitMinutesFor,
  canBeImpersonated,
  validateCustomRole,};