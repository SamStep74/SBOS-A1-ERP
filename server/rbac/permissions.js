// SBOS-A1-ERP Permission Catalog
//
// Catalog-driven RBAC: every gated action in the system maps to a permission key
// in the form `resource:action[:scope]`. Each permission belongs to a category
// (group) for UI grouping. Each permission has a default sensitivity tag
// (low | medium | high | critical) that drives MFA / approval requirements.
//
// Pattern: Salesforce-style permission catalog + NetSuite/Odoo record-rule hooks.
// This is the SINGLE SOURCE OF TRUTH — never check roles directly in route handlers;
// always check permissions via the guards module.
//
// Adding a new gated action:
//   1. Add the permission key to PERMISSIONS below.
//   2. Reference it from the route via requirePermission("crm.deal.approve").
//   3. Map it in server/rbac/matrix.js to the roles that should hold it.
//
// Renaming a permission is a breaking change; bump PERMISSIONS_VERSION when needed.
const PERMISSIONS_VERSION = 1;

// Permission categories — used for UI grouping in the admin panel.
const CATEGORIES = Object.freeze({
  system: { id: 'system', label: 'System & Administration', order: 100 },
  security: { id: 'security', label: 'Security & Access', order: 200 },
  finance: { id: 'finance', label: 'Finance & Accounting', order: 300 },
  crm: { id: 'crm', label: 'CRM & Sales', order: 400 },
  inv: { id: 'inv', label: 'Inventory & Warehouse', order: 500 },
  purchase: { id: 'purchase', label: 'Purchase & Procurement', order: 600 },
  pos: { id: 'pos', label: 'Point of Sale & Retail', order: 700 },
  hr: { id: 'hr', label: 'People & HR', order: 800 },
  projects: { id: 'projects', label: 'Projects & Time', order: 900 },
  desk: { id: 'desk', label: 'Helpdesk & Service', order: 1000 },
  docs: { id: 'docs', label: 'Documents & Sign', order: 1100 },
  portal: { id: 'portal', label: 'Customer Portal', order: 1200 },
  mrkt: { id: 'mrkt', label: 'Marketing & Campaigns', order: 1300 },
  mfg: { id: 'mfg', label: 'Manufacturing & Quality', order: 1400 },
  ai: { id: 'ai', label: 'AI & Copilot', order: 1500 },
  reports: { id: 'reports', label: 'Reports & Analytics', order: 1600 },
  analytics: { id: 'analytics', label: 'Analytics Snapshots & Reports', order: 1650 },
  studio: { id: 'studio', label: 'Studio & Automation', order: 1700 },
  pilot: { id: 'pilot', label: 'Pilot Engagements', order: 1750 },
  compliance: { id: 'compliance', label: 'Compliance & Audit', order: 1800 },
});

// Sensitivity tag — drives MFA enforcement, dual-control rules, and audit weight.
// low: routine, no extra auth. medium: routine, but action is logged.
// high: requires fresh auth or approval. critical: requires MFA + dual-control.
const SENSITIVITY = Object.freeze({
  low: { id: 'low', label: 'Low', mfa: false, dualControl: false, audit: 'standard' },
  medium: { id: 'medium', label: 'Medium', mfa: false, dualControl: false, audit: 'standard' },
  high: { id: 'high', label: 'High', mfa: false, dualControl: false, audit: 'detailed' },
  critical: { id: 'critical', label: 'Critical', mfa: true, dualControl: true, audit: 'forensic' },
});

// PERMISSIONS: the canonical permission catalog.
// Format: "<resource>.<action>[.<scope>]" → { category, sensitivity, label, description, scope? }
//
// resource: the domain object (deal, invoice, payroll, etc.)
// action:   one of {view, list, create, update, delete, approve, export, import, share, assign, run, configure}
// scope:    optional, e.g. "own", "team", "all", "fiscal", "pii"
const PERMISSIONS = Object.freeze({
  // ───────────── System & Administration ─────────────
  'system.org.read': {
    category: 'system',
    sensitivity: 'medium',
    label: 'View organization',
    description: 'Read organization profile, settings, and metadata.',
  },
  'system.org.update': {
    category: 'system',
    sensitivity: 'high',
    label: 'Update organization',
    description: 'Modify organization name, base currency, fiscal year, branding.',
  },
  'system.tenant.read': {
    category: 'system',
    sensitivity: 'high',
    label: 'View tenant',
    description: 'View a single tenant (profile, plan, status).',
  },
  'system.tenant.list': {
    category: 'system',
    sensitivity: 'high',
    label: 'List tenants',
    description: 'List all tenants on the instance (multi-tenant ops).',
  },
  'system.tenant.create': {
    category: 'system',
    sensitivity: 'critical',
    label: 'Create tenant',
    description: 'Provision a new tenant and its default admin.',
  },
  'system.tenant.update': {
    category: 'system',
    sensitivity: 'high',
    label: 'Update tenant',
    description: 'Edit a tenant (name, plan, region, locale, branding).',
  },
  'system.tenant.suspend': {
    category: 'system',
    sensitivity: 'critical',
    label: 'Suspend tenant',
    description: 'Suspend a tenant (block logins, freeze writes).',
  },
  'system.tenant.reactivate': {
    category: 'system',
    sensitivity: 'critical',
    label: 'Reactivate tenant',
    description: 'Lift a suspension and resume tenant service.',
  },
  'system.tenant.delete': {
    category: 'system',
    sensitivity: 'critical',
    label: 'Delete tenant',
    description: 'Permanently delete a tenant and all its data.',
  },
  'system.tenant.transfer': {
    category: 'system',
    sensitivity: 'critical',
    label: 'Transfer tenant ownership',
    description: 'Transfer tenant ownership to another org/instance.',
  },
  'system.tenant.plan.read': {
    category: 'system',
    sensitivity: 'medium',
    label: 'View tenant plan',
    description: 'View tenant plan, seat usage, and billing state.',
  },
  'system.tenant.plan.update': {
    category: 'system',
    sensitivity: 'high',
    label: 'Change tenant plan',
    description: 'Change a tenant plan, seat count, or add-on features.',
  },
  'system.tenant.billing.read': {
    category: 'system',
    sensitivity: 'medium',
    label: 'View tenant billing',
    description: 'View tenant invoices, payments, and credit balance.',
  },
  'system.tenant.billing.update': {
    category: 'system',
    sensitivity: 'high',
    label: 'Manage tenant billing',
    description: 'Issue credit, override invoice, or change billing email.',
  },
  'system.tenant.region.update': {
    category: 'system',
    sensitivity: 'high',
    label: 'Change tenant region',
    description: 'Move a tenant to a different data residency region.',
  },
  'system.tenant.domain.read': {
    category: 'system',
    sensitivity: 'medium',
    label: 'View tenant domains',
    description: 'View tenant custom domains and verification state.',
  },
  'system.tenant.domain.update': {
    category: 'system',
    sensitivity: 'high',
    label: 'Manage tenant domains',
    description: 'Add, verify, or remove tenant custom domains.',
  },
  'system.tenant.sso.read': {
    category: 'system',
    sensitivity: 'medium',
    label: 'View tenant SSO',
    description: 'View tenant SSO configuration and IdP metadata.',
  },
  'system.tenant.sso.update': {
    category: 'system',
    sensitivity: 'high',
    label: 'Manage tenant SSO',
    description: 'Configure tenant SSO (SAML/OIDC) and IdP.',
  },
  'system.tenant.isolation.read': {
    category: 'system',
    sensitivity: 'medium',
    label: 'View isolation policy',
    description: 'View tenant network/data isolation policies.',
  },
  'system.tenant.isolation.update': {
    category: 'system',
    sensitivity: 'critical',
    label: 'Update isolation policy',
    description: 'Update tenant network/data isolation policies.',
  },
  'system.settings.read': {
    category: 'system',
    sensitivity: 'medium',
    label: 'View settings',
    description: 'View system-wide settings and feature flags.',
  },
  'system.settings.update': {
    category: 'system',
    sensitivity: 'high',
    label: 'Update settings',
    description: 'Change system-wide settings and feature flags.',
  },
  'system.integrations.read': {
    category: 'system',
    sensitivity: 'medium',
    label: 'View integrations',
    description: 'View configured third-party integrations.',
  },
  'system.integrations.update': {
    category: 'system',
    sensitivity: 'high',
    label: 'Manage integrations',
    description: 'Add, update, or remove third-party integrations.',
  },
  'system.backup.read': {
    category: 'system',
    sensitivity: 'medium',
    label: 'View backups',
    description: 'List and inspect backups.',
  },
  'system.backup.run': {
    category: 'system',
    sensitivity: 'high',
    label: 'Run backup',
    description: 'Trigger an on-demand backup.',
  },
  'system.backup.restore': {
    category: 'system',
    sensitivity: 'critical',
    label: 'Restore from backup',
    description: 'Restore tenant data from a backup (destructive).',
  },

  // ───────────── Security & Access ─────────────
  'security.user.list': {
    category: 'security',
    sensitivity: 'medium',
    label: 'List users',
    description: 'List users in the organization.',
  },
  'security.user.read': {
    category: 'security',
    sensitivity: 'medium',
    label: 'View user',
    description: 'View user profile and assignments.',
  },
  'security.user.create': {
    category: 'security',
    sensitivity: 'high',
    label: 'Invite user',
    description: 'Invite a new user to the organization.',
  },
  'security.user.update': {
    category: 'security',
    sensitivity: 'high',
    label: 'Update user',
    description: 'Modify user profile, role, or app assignments.',
  },
  'security.user.deactivate': {
    category: 'security',
    sensitivity: 'high',
    label: 'Deactivate user',
    description: 'Disable a user account.',
  },
  'security.user.delete': {
    category: 'security',
    sensitivity: 'critical',
    label: 'Delete user',
    description: 'Permanently delete a user account.',
  },
  'security.user.reset_password': {
    category: 'security',
    sensitivity: 'high',
    label: 'Reset user password',
    description: 'Force a password reset for a user.',
  },
  'security.user.impersonate': {
    category: 'security',
    sensitivity: 'critical',
    label: 'Impersonate user',
    description: 'Log in as another user (heavily audited).',
  },
  'security.role.read': {
    category: 'security',
    sensitivity: 'medium',
    label: 'View roles',
    description: 'View role catalog and definitions.',
  },
  'security.role.create': {
    category: 'security',
    sensitivity: 'high',
    label: 'Create role',
    description: 'Define a new custom role.',
  },
  'security.role.update': {
    category: 'security',
    sensitivity: 'high',
    label: 'Update role',
    description: 'Modify role definition, parent, or default app set.',
  },
  'security.role.delete': {
    category: 'security',
    sensitivity: 'critical',
    label: 'Delete role',
    description: 'Delete a custom role (cannot delete system roles).',
  },
  'security.role.assign': {
    category: 'security',
    sensitivity: 'high',
    label: 'Assign role',
    description: 'Assign or revoke a role for a user.',
  },
  'security.permission_set.read': {
    category: 'security',
    sensitivity: 'medium',
    label: 'View permission sets',
    description: 'View permission set catalog.',
  },
  'security.permission_set.update': {
    category: 'security',
    sensitivity: 'high',
    label: 'Manage permission sets',
    description: 'Create or modify permission sets and their members.',
  },
  'security.profile.read': {
    category: 'security',
    sensitivity: 'medium',
    label: 'View profiles',
    description: 'View profiles (role + permission set bundles).',
  },
  'security.profile.create': {
    category: 'security',
    sensitivity: 'high',
    label: 'Create profile',
    description: 'Define a new profile (role + permission set bundle) in the tenant.',
  },
  'security.profile.update': {
    category: 'security',
    sensitivity: 'high',
    label: 'Manage profiles',
    description: 'Create or modify profiles.',
  },
  'security.profile.delete': {
    category: 'security',
    sensitivity: 'critical',
    label: 'Delete profile',
    description: 'Delete a profile (refused while any user still has it applied).',
  },
  'security.profile.assign': {
    category: 'security',
    sensitivity: 'high',
    label: 'Assign profile',
    description: 'Apply a profile (role + permission set bundle) to a user.',
  },
  'security.session.list': {
    category: 'security',
    sensitivity: 'medium',
    label: 'List sessions',
    description: 'View active and recent sessions.',
  },
  'security.session.revoke': {
    category: 'security',
    sensitivity: 'high',
    label: 'Revoke session',
    description: 'Force a session to log out.',
  },
  'security.mfa.configure': {
    category: 'security',
    sensitivity: 'high',
    label: 'Configure MFA',
    description: 'Set MFA policies, factor types, and required roles.',
  },
  'security.mfa.reset': {
    category: 'security',
    sensitivity: 'critical',
    label: 'Reset MFA',
    description: 'Reset MFA factors for a user.',
  },
  'security.audit.read': {
    category: 'security',
    sensitivity: 'medium',
    label: 'View audit log',
    description: 'View audit events.',
  },
  'security.audit.export': {
    category: 'security',
    sensitivity: 'high',
    label: 'Export audit log',
    description: 'Export audit events to CSV / JSON.',
  },
  'security.audit.retention.update': {
    category: 'security',
    sensitivity: 'high',
    label: 'Manage audit retention policy',
    description:
      'Set or run the per-tenant audit-log retention policy. Read of the config shares security.audit.read.',
  },
  'security.access.review': {
    category: 'security',
    sensitivity: 'high',
    label: 'Run access review',
    description: 'Run periodic user/role access reviews.',
  },
  'security.api_key.read': {
    category: 'security',
    sensitivity: 'medium',
    label: 'View API keys',
    description: 'List API keys and their scopes.',
  },
  'security.api_key.create': {
    category: 'security',
    sensitivity: 'high',
    label: 'Create API key',
    description: 'Mint a new API key for an integration.',
  },
  'security.api_key.revoke': {
    category: 'security',
    sensitivity: 'high',
    label: 'Revoke API key',
    description: 'Revoke an API key.',
  },

  // ───────────── Approval / Dual-control ─────────────
  //
  // These keys gate the dual-control workflow for "critical" actions
  // (sbos_rbac_approvals table). The approver must be a different user
  // than the requester — this is enforced inside server/rbac/approvals.js,
  // not via the permission check, so an Admin can't approve their own
  // request even with security.approval.decide.
  'security.approval.read': {
    category: 'security',
    sensitivity: 'medium',
    label: 'View approval queue',
    description: 'View pending and historical approval requests.',
  },
  'security.approval.request': {
    category: 'security',
    sensitivity: 'medium',
    label: 'Request approval',
    description: 'Submit a critical action for second-person approval.',
  },
  'security.approval.decide': {
    category: 'security',
    sensitivity: 'high',
    label: 'Decide approval',
    description: 'Approve or reject a pending approval (must be a different user).',
  },

  // ───────────── Finance & Accounting ─────────────
  'finance.coa.read': {
    category: 'finance',
    sensitivity: 'low',
    label: 'View chart of accounts',
    description: 'View the chart of accounts.',
  },
  'finance.coa.update': {
    category: 'finance',
    sensitivity: 'high',
    label: 'Edit chart of accounts',
    description: 'Create, edit, or close accounts.',
  },
  'finance.journal.read': {
    category: 'finance',
    sensitivity: 'low',
    label: 'View journal entries',
    description: 'View journal entries and ledger lines.',
  },
  'finance.journal.create': {
    category: 'finance',
    sensitivity: 'high',
    label: 'Create journal entry',
    description: 'Post a manual journal entry.',
  },
  'finance.journal.update': {
    category: 'finance',
    sensitivity: 'high',
    label: 'Edit journal entry',
    description: 'Edit an unposted journal entry.',
  },
  'finance.journal.post': {
    category: 'finance',
    sensitivity: 'critical',
    label: 'Post journal entry',
    description: 'Post a journal entry to the ledger (locked).',
  },
  'finance.journal.reverse': {
    category: 'finance',
    sensitivity: 'critical',
    label: 'Reverse journal entry',
    description: 'Reverse a posted journal entry (creates counter-entry).',
  },
  'finance.invoice.read': {
    category: 'finance',
    sensitivity: 'low',
    label: 'View invoices',
    description: 'View AR invoices and credit notes.',
  },
  'finance.invoice.create': {
    category: 'finance',
    sensitivity: 'medium',
    label: 'Create invoice',
    description: 'Draft a new AR invoice.',
  },
  'finance.invoice.update': {
    category: 'finance',
    sensitivity: 'medium',
    label: 'Edit invoice',
    description: 'Edit a draft invoice.',
  },
  'finance.customer.create': {
    category: 'finance',
    sensitivity: 'medium',
    label: 'Create customer',
    description: 'Create a new customer record.',
  },
  'finance.customer.update': {
    category: 'finance',
    sensitivity: 'medium',
    label: 'Edit customer',
    description: 'Edit a customer record (name, HVVH, address, email).',
  },
  'finance.customer.merge': {
    category: 'finance',
    sensitivity: 'high',
    label: 'Merge customers',
    description: 'Re-assign invoices + payments from one customer to another, archive the secondary, and record a merge audit row. Use with care — the merge is one-way and audit-logged.',
  },
  'finance.customer.read': {
    category: 'finance',
    sensitivity: 'low',
    label: 'View customers',
    description: 'List / read finance customer records.',
  },
  'finance.product.read': {
    category: 'finance',
    sensitivity: 'low',
    label: 'Read catalog item',
    description: 'View products (catalog items) and stock levels.',
  },
  'finance.product.create': {
    category: 'finance',
    sensitivity: 'medium',
    label: 'Create catalog item',
    description: 'Add a new product to the catalog.',
  },
  'finance.product.update': {
    category: 'finance',
    sensitivity: 'medium',
    label: 'Update catalog item',
    description: 'Edit an existing product (name, price, cost, UoM, etc.).',
  },
  // ─────────── Catalog v2 (Phase 2 W76/W77) ───────────
  // Categories: hierarchical (parent_id chain) for the
  // product catalog. Variants: per-item size/color
  // attribute dimensions.
  'finance.category.read': {
    category: 'finance',
    sensitivity: 'low',
    label: 'Read catalog category',
    description: 'View catalog categories (hierarchical) and breadcrumb paths.',
  },
  'finance.category.create': {
    category: 'finance',
    sensitivity: 'medium',
    label: 'Create catalog category',
    description: 'Add a new catalog category (with optional parent).',
  },
  'finance.variant.read': {
    category: 'finance',
    sensitivity: 'low',
    label: 'Read catalog variant',
    description: 'View catalog variants (per-item size/color attributes).',
  },
  'finance.variant.create': {
    category: 'finance',
    sensitivity: 'medium',
    label: 'Create catalog variant',
    description: 'Add a new variant (SKU + name + attributes) under a catalog item.',
  },
  // ─────────── Catalog v2 (Phase 2 W78/W79) — bundles ───────────
  // Bundles: compound catalog items (header + N child
  // rows referencing catalog_items). The 4 new perm
  // keys are 2 read + 2 create, split between the
  // bundle header and the bundle-item children.
  'finance.bundle.read': {
    category: 'finance',
    sensitivity: 'low',
    label: 'Read catalog bundle',
    description: 'View catalog bundles (compound items with a fixed price + recipe).',
  },
  'finance.bundle.create': {
    category: 'finance',
    sensitivity: 'medium',
    label: 'Create catalog bundle',
    description: 'Add a new catalog bundle (header row).',
  },
  'finance.bundle_item.read': {
    category: 'finance',
    sensitivity: 'low',
    label: 'Read catalog bundle item',
    description: 'View bundle items (the recipe rows that reference catalog items).',
  },
  'finance.bundle_item.create': {
    category: 'finance',
    sensitivity: 'medium',
    label: 'Create catalog bundle item',
    description: 'Add a new bundle item (a child row referencing a catalog item + quantity).',
  },
  'finance.pricing_rule.read': {
    category: 'finance',
    sensitivity: 'low',
    label: 'Read catalog pricing rule',
    description: 'View pricing rules (volume discounts, time-based discounts, category discounts).',
  },
  'finance.pricing_rule.create': {
    category: 'finance',
    sensitivity: 'medium',
    label: 'Create catalog pricing rule',
    description: 'Define a new pricing rule (volume discount, time-based discount, category discount).',
  },
  'finance.warehouse.read': {
    category: 'finance',
    sensitivity: 'low',
    label: 'Read warehouse',
    description: 'View warehouses and stock locations.',
  },
  'finance.warehouse.create': {
    category: 'finance',
    sensitivity: 'medium',
    label: 'Create warehouse',
    description: 'Add a new warehouse or stock location.',
  },
  'finance.warehouse.update': {
    category: 'finance',
    sensitivity: 'medium',
    label: 'Update warehouse',
    description: 'Edit an existing warehouse or location (rename, archive).',
  },
  'finance.stock.read': {
    category: 'finance',
    sensitivity: 'low',
    label: 'Read stock',
    description: 'View stock balances and the move history.',
  },
  'inventory.lot.read': {
    category: 'inv',
    sensitivity: 'low',
    label: 'Read lots',
    description: 'View lots + per-location lot quantities (FEFO-friendly).',
  },
  'inventory.serial.read': {
    category: 'inv',
    sensitivity: 'low',
    label: 'Read serials',
    description: 'View unit-level serials (location, status, lot binding).',
  },
  'inventory.lot.recall': {
    category: 'inv',
    sensitivity: 'high',
    label: 'Recall a lot',
    description: 'Flag a lot as recalled and cascade status=recalled to every serial in it. Regulatory compliance action; high-sensitivity because the cascade is irreversible without {force: true}.',
  },
  'finance.stock.move': {
    category: 'finance',
    sensitivity: 'high',
    label: 'Move stock',
    description: 'Receive, deliver, transfer, or adjust stock at a location.',
  },
  'finance.vendor.read': {
    category: 'finance',
    sensitivity: 'low',
    label: 'Read vendor',
    description: 'View suppliers (vendors).',
  },
  'finance.vendor.create': {
    category: 'finance',
    sensitivity: 'medium',
    label: 'Create vendor',
    description: 'Add a new supplier.',
  },
  'finance.vendor.update': {
    category: 'finance',
    sensitivity: 'medium',
    label: 'Update vendor',
    description: 'Edit an existing supplier (name, HVVH, address).',
  },
  'finance.purchase.read': {
    category: 'finance',
    sensitivity: 'low',
    label: 'Read purchase order',
    description: 'View purchase orders, receipts, and the order lifecycle.',
  },
  'finance.purchase.create': {
    category: 'finance',
    sensitivity: 'medium',
    label: 'Create purchase order',
    description: 'Create a new PO in rfq status.',
  },
  'finance.purchase.confirm': {
    category: 'finance',
    sensitivity: 'medium',
    label: 'Confirm purchase order',
    description: 'Move a PO from rfq to confirmed (locks in the price).',
  },
  'finance.purchase.receive': {
    category: 'finance',
    sensitivity: 'high',
    label: 'Receive purchase order',
    description: 'Record stock receipts against a PO and update inventory.',
  },
  'finance.purchase.cancel': {
    category: 'finance',
    sensitivity: 'medium',
    label: 'Cancel purchase order',
    description: 'Cancel a PO (allowed in rfq / confirmed / partial only).',
  },
  'finance.invoice.issue': {
    category: 'finance',
    sensitivity: 'high',
    label: 'Issue invoice',
    description: 'Mark an invoice as issued and assign a number.',
  },
  'finance.invoice.void': {
    category: 'finance',
    sensitivity: 'critical',
    label: 'Void invoice',
    description: 'Void an issued invoice.',
  },
  'finance.invoice.attach': {
    category: 'finance',
    sensitivity: 'medium',
    label: 'Attach document to invoice',
    description: 'Upload, list, or delete supporting documents on an invoice (PDF, photo, etc.).',
  },
  'finance.invoice.attach.read': {
    category: 'finance',
    sensitivity: 'low',
    label: 'View invoice attachments',
    description: 'List or download supporting documents on an invoice.',
  },
  'finance.bill.read': {
    category: 'finance',
    sensitivity: 'low',
    label: 'View bills',
    description: 'View AP bills.',
  },
  'finance.bill.create': {
    category: 'finance',
    sensitivity: 'medium',
    label: 'Create bill',
    description: 'Draft a new AP bill.',
  },
  'finance.bill.update': {
    category: 'finance',
    sensitivity: 'medium',
    label: 'Edit bill',
    description: 'Edit a draft bill.',
  },
  'finance.bill.approve': {
    category: 'finance',
    sensitivity: 'high',
    label: 'Approve bill',
    description: 'Approve a bill for payment.',
  },
  'finance.bill.pay': {
    category: 'finance',
    sensitivity: 'critical',
    label: 'Pay bill',
    description: 'Mark a bill as paid (settle AP).',
  },
  'finance.bill.void': {
    category: 'finance',
    sensitivity: 'critical',
    label: 'Void bill',
    description: 'Cancel a bill (only allowed before payment).',
  },
  'finance.payment.read': {
    category: 'finance',
    sensitivity: 'low',
    label: 'View payments',
    description: 'View payment records.',
  },
  'finance.payment.create': {
    category: 'finance',
    sensitivity: 'high',
    label: 'Record payment',
    description: 'Record a customer or vendor payment.',
  },
  'finance.bank.read': {
    category: 'finance',
    sensitivity: 'low',
    label: 'View bank accounts',
    description: 'View bank/cash account balances.',
  },
  'finance.bank.update': {
    category: 'finance',
    sensitivity: 'high',
    label: 'Manage bank accounts',
    description: 'Add or update bank/cash accounts.',
  },
  'finance.bank.reconcile': {
    category: 'finance',
    sensitivity: 'high',
    label: 'Reconcile bank',
    description: 'Perform bank reconciliation.',
  },
  'finance.tax.read': {
    category: 'finance',
    sensitivity: 'low',
    label: 'View tax setup',
    description: 'View tax codes, rates, and rules.',
  },
  'finance.tax.update': {
    category: 'finance',
    sensitivity: 'high',
    label: 'Manage tax setup',
    description: 'Modify tax codes and rates.',
  },
  'finance.vat_return.read': {
    category: 'finance',
    sensitivity: 'medium',
    label: 'View VAT return',
    description: 'View VAT return draft.',
  },
  'finance.vat_return.prepare': {
    category: 'finance',
    sensitivity: 'high',
    label: 'Prepare VAT return',
    description: 'Prepare and lock the VAT return for period.',
  },
  'finance.vat_return.file': {
    category: 'finance',
    sensitivity: 'critical',
    label: 'File VAT return',
    description: 'File the VAT return with the tax authority.',
  },
  'finance.period.lock': {
    category: 'finance',
    sensitivity: 'critical',
    label: 'Lock accounting period',
    description: 'Lock an accounting period against further postings.',
  },
  'finance.period.unlock': {
    category: 'finance',
    sensitivity: 'critical',
    label: 'Unlock period',
    description: 'Unlock a previously locked accounting period.',
  },
  'finance.year_end.close': {
    category: 'finance',
    sensitivity: 'critical',
    label: 'Close fiscal year',
    description: 'Run year-end closing procedure.',
  },
  'finance.budget.read': {
    category: 'finance',
    sensitivity: 'low',
    label: 'View budget',
    description: 'View budget vs actual.',
  },
  'finance.budget.update': {
    category: 'finance',
    sensitivity: 'high',
    label: 'Manage budget',
    description: 'Set or change budget targets.',
  },
  'finance.einvoice.read': {
    category: 'finance',
    sensitivity: 'medium',
    label: 'View e-invoices',
    description: 'View electronic invoices and submissions.',
  },
  'finance.einvoice.issue': {
    category: 'finance',
    sensitivity: 'high',
    label: 'Issue e-invoice',
    description: 'Issue an electronic invoice to the SRC gateway.',
  },

  // ───────────── CRM & Sales ─────────────
  'crm.lead.read': {
    category: 'crm',
    sensitivity: 'low',
    label: 'View leads',
    description: 'View leads.',
  },
  'crm.lead.create': {
    category: 'crm',
    sensitivity: 'low',
    label: 'Create lead',
    description: 'Add new lead.',
  },
  'crm.lead.update': {
    category: 'crm',
    sensitivity: 'low',
    label: 'Edit lead',
    description: 'Edit lead fields.',
  },
  'crm.lead.delete': {
    category: 'crm',
    sensitivity: 'medium',
    label: 'Delete lead',
    description: 'Delete a lead.',
  },
  'crm.lead.assign': {
    category: 'crm',
    sensitivity: 'medium',
    label: 'Assign lead',
    description: 'Assign a lead to an owner or team.',
  },
  'crm.lead.import': {
    category: 'crm',
    sensitivity: 'medium',
    label: 'Import leads',
    description: 'Bulk import leads.',
  },
  'crm.lead.export': {
    category: 'crm',
    sensitivity: 'medium',
    label: 'Export leads',
    description: 'Export leads to CSV.',
  },
  'crm.account.read': {
    category: 'crm',
    sensitivity: 'low',
    label: 'View accounts',
    description: 'View customer accounts.',
  },
  'crm.account.create': {
    category: 'crm',
    sensitivity: 'low',
    label: 'Create account',
    description: 'Create new customer account.',
  },
  'crm.account.update': {
    category: 'crm',
    sensitivity: 'low',
    label: 'Edit account',
    description: 'Edit customer account fields.',
  },
  'crm.account.delete': {
    category: 'crm',
    sensitivity: 'high',
    label: 'Delete account',
    description: 'Delete a customer account.',
  },
  'crm.account.merge': {
    category: 'crm',
    sensitivity: 'high',
    label: 'Merge accounts',
    description: 'Merge duplicate accounts.',
  },
  'crm.contact.read': {
    category: 'crm',
    sensitivity: 'low',
    label: 'View contacts',
    description: 'View contacts on accounts.',
  },
  'crm.contact.create': {
    category: 'crm',
    sensitivity: 'low',
    label: 'Create contact',
    description: 'Add new contact.',
  },
  'crm.contact.update': {
    category: 'crm',
    sensitivity: 'low',
    label: 'Edit contact',
    description: 'Edit contact fields.',
  },
  'crm.contact.delete': {
    category: 'crm',
    sensitivity: 'medium',
    label: 'Delete contact',
    description: 'Delete a contact.',
  },
  'crm.deal.read': {
    category: 'crm',
    sensitivity: 'low',
    label: 'View deals',
    description: 'View deals / opportunities.',
  },
  'crm.deal.create': {
    category: 'crm',
    sensitivity: 'low',
    label: 'Create deal',
    description: 'Create a new deal.',
  },
  'crm.deal.update': {
    category: 'crm',
    sensitivity: 'low',
    label: 'Edit deal',
    description: 'Edit a deal.',
  },
  'crm.deal.delete': {
    category: 'crm',
    sensitivity: 'medium',
    label: 'Delete deal',
    description: 'Delete a deal.',
  },
  'crm.deal.approve': {
    category: 'crm',
    sensitivity: 'high',
    label: 'Approve deal',
    description: 'Approve a deal requiring discount/exception approval.',
  },
  'crm.deal.assign': {
    category: 'crm',
    sensitivity: 'medium',
    label: 'Assign deal',
    description: 'Assign a deal owner.',
  },
  'crm.deal.export': {
    category: 'crm',
    sensitivity: 'medium',
    label: 'Export deals',
    description: 'Export deals to CSV.',
  },
  'crm.quote.read': {
    category: 'crm',
    sensitivity: 'low',
    label: 'View quotes',
    description: 'View sales quotes.',
  },
  'crm.quote.create': {
    category: 'crm',
    sensitivity: 'low',
    label: 'Create quote',
    description: 'Create a new quote.',
  },
  'crm.quote.update': {
    category: 'crm',
    sensitivity: 'low',
    label: 'Edit quote',
    description: 'Edit a draft quote.',
  },
  'crm.quote.delete': {
    category: 'crm',
    sensitivity: 'medium',
    label: 'Delete quote',
    description: 'Delete a draft quote.',
  },
  'crm.quote.send': {
    category: 'crm',
    sensitivity: 'medium',
    label: 'Send quote',
    description: 'Send quote to customer.',
  },
  'crm.quote.release': {
    category: 'crm',
    sensitivity: 'high',
    label: 'Release quote',
    description: 'Release a quote that requires approval.',
  },
  'crm.quote.accept': {
    category: 'crm',
    sensitivity: 'medium',
    label: 'Accept quote',
    description: 'Mark a quote as accepted by the customer.',
  },
  // ───────────── Sales Orders (post-acceptance) ─────────────
  // Distinct from `deals` (CRM pipeline, pre-acceptance) and `quotes` (pricing
  // documents). A sales order is the post-acceptance supply chain primitive:
  // it tracks fulfillment, billing, and shipping. Stock reservation is wired
  // in Phase 1; auto-invoicing on fulfillment is Phase 1 too.
  'sales.order.read': {
    category: 'crm',
    sensitivity: 'low',
    label: 'View sales orders',
    description: 'View sales orders and their lines.',
  },
  'sales.order.create': {
    category: 'crm',
    sensitivity: 'medium',
    label: 'Create sales order',
    description: 'Create a sales order (from a deal, a quote, or manually).',
  },
  'sales.order.update': {
    category: 'crm',
    sensitivity: 'medium',
    label: 'Edit sales order',
    description: 'Edit, confirm, cancel, or modify lines on a sales order.',
  },
  'sales.order.delete': {
    category: 'crm',
    sensitivity: 'high',
    label: 'Delete sales order',
    description: 'Delete a sales order (typically only in draft state).',
  },
  'crm.activity.read': {
    category: 'crm',
    sensitivity: 'low',
    label: 'View activities',
    description: 'View activities (calls, meetings, tasks).',
  },
  'crm.activity.create': {
    category: 'crm',
    sensitivity: 'low',
    label: 'Log activity',
    description: 'Log a call, meeting, or task.',
  },
  'crm.activity.update': {
    category: 'crm',
    sensitivity: 'low',
    label: 'Edit activity',
    description: 'Edit logged activities.',
  },
  'crm.activity.delete': {
    category: 'crm',
    sensitivity: 'medium',
    label: 'Delete activity',
    description: 'Delete an activity log.',
  },
  'crm.pipeline.read': {
    category: 'crm',
    sensitivity: 'low',
    label: 'View pipeline',
    description: 'View pipeline and forecasts.',
  },
  'crm.pipeline.update': {
    category: 'crm',
    sensitivity: 'medium',
    label: 'Configure pipeline',
    description: 'Configure pipeline stages and rules.',
  },
  'crm.customer_360.read': {
    category: 'crm',
    sensitivity: 'low',
    label: 'View Customer 360',
    description: 'View the unified customer profile.',
  },
  'crm.customer_360.export': {
    category: 'crm',
    sensitivity: 'high',
    label: 'Export Customer 360',
    description: 'Export the entire customer profile.',
  },

  // ───────────── Inventory & Warehouse ─────────────
  'inv.product.read': {
    category: 'inv',
    sensitivity: 'low',
    label: 'View products',
    description: 'View product catalog.',
  },
  'inv.product.create': {
    category: 'inv',
    sensitivity: 'medium',
    label: 'Create product',
    description: 'Add a new product.',
  },
  'inv.product.update': {
    category: 'inv',
    sensitivity: 'medium',
    label: 'Edit product',
    description: 'Edit product details.',
  },
  'inv.product.delete': {
    category: 'inv',
    sensitivity: 'high',
    label: 'Delete product',
    description: 'Delete or archive a product.',
  },
  'inv.product.import': {
    category: 'inv',
    sensitivity: 'medium',
    label: 'Import products',
    description: 'Bulk import products.',
  },
  'inv.product.export': {
    category: 'inv',
    sensitivity: 'low',
    label: 'Export products',
    description: 'Export product catalog.',
  },
  'inv.warehouse.read': {
    category: 'inv',
    sensitivity: 'low',
    label: 'View warehouses',
    description: 'View warehouses and locations.',
  },
  'inv.warehouse.update': {
    category: 'inv',
    sensitivity: 'high',
    label: 'Manage warehouses',
    description: 'Add or update warehouses and locations.',
  },
  'inv.stock.read': {
    category: 'inv',
    sensitivity: 'low',
    label: 'View stock',
    description: 'View stock balances and ledger.',
  },
  'inv.stock.receive': {
    category: 'inv',
    sensitivity: 'medium',
    label: 'Receive stock',
    description: 'Receive stock into a warehouse.',
  },
  'inv.stock.deliver': {
    category: 'inv',
    sensitivity: 'medium',
    label: 'Deliver stock',
    description: 'Issue stock out of a warehouse.',
  },
  'inv.stock.transfer': {
    category: 'inv',
    sensitivity: 'medium',
    label: 'Transfer stock',
    description: 'Transfer stock between locations.',
  },
  'inv.stock.adjust': {
    category: 'inv',
    sensitivity: 'high',
    label: 'Adjust stock',
    description: 'Adjust stock with reason code.',
  },
  'inv.stock.scrap': {
    category: 'inv',
    sensitivity: 'high',
    label: 'Scrap stock',
    description: 'Scrap stock with reason code.',
  },
  'inv.stock.count': {
    category: 'inv',
    sensitivity: 'high',
    label: 'Cycle count',
    description: 'Run cycle counts and adjust variances.',
  },
  'inv.valuation.read': {
    category: 'inv',
    sensitivity: 'medium',
    label: 'View stock valuation',
    description: 'View stock valuation reports.',
  },
  'inv.valuation.run': {
    category: 'inv',
    sensitivity: 'high',
    label: 'Run stock valuation',
    description: 'Recompute stock valuation.',
  },
  'inv.lot.read': {
    category: 'inv',
    sensitivity: 'low',
    label: 'View lots/serials',
    description: 'View lot and serial numbers.',
  },
  'inv.lot.update': {
    category: 'inv',
    sensitivity: 'medium',
    label: 'Edit lots/serials',
    description: 'Edit lot/serial data.',
  },

  // ───────────── Purchase & Procurement ─────────────
  'purchase.vendor.read': {
    category: 'purchase',
    sensitivity: 'low',
    label: 'View vendors',
    description: 'View vendor records.',
  },
  'purchase.vendor.create': {
    category: 'purchase',
    sensitivity: 'medium',
    label: 'Create vendor',
    description: 'Add a new vendor.',
  },
  'purchase.vendor.update': {
    category: 'purchase',
    sensitivity: 'medium',
    label: 'Edit vendor',
    description: 'Edit vendor data.',
  },
  'purchase.vendor.delete': {
    category: 'purchase',
    sensitivity: 'high',
    label: 'Delete vendor',
    description: 'Delete a vendor.',
  },
  'purchase.vendor_360.read': {
    category: 'purchase',
    sensitivity: 'low',
    label: 'View Vendor 360',
    description: 'View vendor 360 dashboard.',
  },
  'purchase.rfq.read': {
    category: 'purchase',
    sensitivity: 'low',
    label: 'View RFQs',
    description: 'View requests for quotation.',
  },
  'purchase.rfq.create': {
    category: 'purchase',
    sensitivity: 'medium',
    label: 'Create RFQ',
    description: 'Create an RFQ.',
  },
  'purchase.rfq.update': {
    category: 'purchase',
    sensitivity: 'medium',
    label: 'Edit RFQ',
    description: 'Edit a draft RFQ.',
  },
  'purchase.rfq.delete': {
    category: 'purchase',
    sensitivity: 'medium',
    label: 'Delete RFQ',
    description: 'Delete a draft RFQ.',
  },
  'purchase.rfq.send': {
    category: 'purchase',
    sensitivity: 'medium',
    label: 'Send RFQ',
    description: 'Send an RFQ to vendors.',
  },
  'purchase.po.read': {
    category: 'purchase',
    sensitivity: 'low',
    label: 'View purchase orders',
    description: 'View purchase orders.',
  },
  'purchase.po.create': {
    category: 'purchase',
    sensitivity: 'medium',
    label: 'Create PO',
    description: 'Create a purchase order.',
  },
  'purchase.po.update': {
    category: 'purchase',
    sensitivity: 'medium',
    label: 'Edit PO',
    description: 'Edit a draft PO.',
  },
  'purchase.po.approve': {
    category: 'purchase',
    sensitivity: 'high',
    label: 'Approve PO',
    description: 'Approve a purchase order.',
  },
  'purchase.po.send': {
    category: 'purchase',
    sensitivity: 'medium',
    label: 'Send PO',
    description: 'Send a purchase order to vendor.',
  },
  'purchase.po.cancel': {
    category: 'purchase',
    sensitivity: 'high',
    label: 'Cancel PO',
    description: 'Cancel a purchase order.',
  },
  'purchase.receipt.read': {
    category: 'purchase',
    sensitivity: 'low',
    label: 'View receipts',
    description: 'View goods receipts.',
  },
  'purchase.receipt.create': {
    category: 'purchase',
    sensitivity: 'medium',
    label: 'Create receipt',
    description: 'Record a goods receipt.',
  },
  'purchase.return.create': {
    category: 'purchase',
    sensitivity: 'medium',
    label: 'Create return',
    description: 'Create a supplier return.',
  },
  'purchase.pricelist.read': {
    category: 'purchase',
    sensitivity: 'low',
    label: 'View vendor pricelists',
    description: 'View vendor pricelists.',
  },
  'purchase.pricelist.update': {
    category: 'purchase',
    sensitivity: 'high',
    label: 'Manage vendor pricelists',
    description: 'Add or update vendor pricelist entries.',
  },
  'purchase.analytics.read': {
    category: 'purchase',
    sensitivity: 'low',
    label: 'View procurement analytics',
    description: 'View procurement analytics.',
  },

  // ───────────── Point of Sale & Retail ─────────────
  'pos.session.open': {
    category: 'pos',
    sensitivity: 'medium',
    label: 'Open POS session',
    description: 'Open a new POS register session.',
  },
  'pos.session.close': {
    category: 'pos',
    sensitivity: 'high',
    label: 'Close POS session',
    description: 'Close a POS register session.',
  },
  'pos.sale.create': {
    category: 'pos',
    sensitivity: 'medium',
    label: 'Record POS sale',
    description: 'Record a POS sale.',
  },
  'pos.sale.void': {
    category: 'pos',
    sensitivity: 'high',
    label: 'Void POS sale',
    description: 'Void a recorded POS sale.',
  },
  'pos.refund.create': {
    category: 'pos',
    sensitivity: 'high',
    label: 'Issue POS refund',
    description: 'Issue a refund for a POS sale.',
  },
  'pos.cash.read': {
    category: 'pos',
    sensitivity: 'medium',
    label: 'View cash movements',
    description: 'View cash in/out and drawer.',
  },
  'pos.cash.manage': {
    category: 'pos',
    sensitivity: 'high',
    label: 'Manage cash drawer',
    description: 'Cash in/out, drops, pickups.',
  },
  'pos.zreport.read': {
    category: 'pos',
    sensitivity: 'medium',
    label: 'View Z-report',
    description: 'View Z-report and session close evidence.',
  },
  'pos.fiscal.hdm': {
    category: 'pos',
    sensitivity: 'high',
    label: 'Fiscalize receipt (ՀԴՄ)',
    description: 'Submit receipt to the fiscal device (ՀԴՄ).',
  },

  // ───────────── People & HR ─────────────
  'hr.employee.read': {
    category: 'hr',
    sensitivity: 'low',
    label: 'View employees',
    description: 'View employee records.',
  },
  'hr.employee.create': {
    category: 'hr',
    sensitivity: 'high',
    label: 'Create employee',
    description: 'Add a new employee.',
  },
  'hr.employee.update': {
    category: 'hr',
    sensitivity: 'high',
    label: 'Edit employee',
    description: 'Edit employee master data.',
  },
  'hr.employee.delete': {
    category: 'hr',
    sensitivity: 'critical',
    label: 'Delete employee',
    description: 'Delete an employee record (anonymized).',
  },
  'hr.employee.pii.read': {
    category: 'hr',
    sensitivity: 'high',
    label: 'View PII',
    description: 'View employee PII (SSN, address, bank, medical).',
  },
  'hr.employee.pii.update': {
    category: 'hr',
    sensitivity: 'critical',
    label: 'Edit PII',
    description: 'Edit employee PII (SSN, address, bank, medical).',
  },
  'hr.contract.read': {
    category: 'hr',
    sensitivity: 'medium',
    label: 'View contracts',
    description: 'View employment contracts.',
  },
  'hr.contract.create': {
    category: 'hr',
    sensitivity: 'high',
    label: 'Create contract',
    description: 'Draft an employment contract.',
  },
  'hr.contract.update': {
    category: 'hr',
    sensitivity: 'high',
    label: 'Edit contract',
    description: 'Edit a draft contract.',
  },
  'hr.contract.approve': {
    category: 'hr',
    sensitivity: 'high',
    label: 'Approve contract',
    description: 'Approve and sign a contract.',
  },
  'hr.attendance.read': {
    category: 'hr',
    sensitivity: 'medium',
    label: 'View attendance',
    description: 'View attendance records.',
  },
  'hr.attendance.update': {
    category: 'hr',
    sensitivity: 'high',
    label: 'Edit attendance',
    description: 'Edit attendance records.',
  },
  'hr.leave.read': {
    category: 'hr',
    sensitivity: 'medium',
    label: 'View time off',
    description: 'View time off / leave balances.',
  },
  'hr.leave.request': {
    category: 'hr',
    sensitivity: 'low',
    label: 'Request time off',
    description: 'Request time off for self.',
  },
  'hr.leave.approve': {
    category: 'hr',
    sensitivity: 'high',
    label: 'Approve time off',
    description: 'Approve or reject time off requests.',
  },
  'hr.payroll.read': {
    category: 'hr',
    sensitivity: 'high',
    label: 'View payroll',
    description: 'View payroll runs and payslips.',
  },
  'hr.payroll.run': {
    category: 'hr',
    sensitivity: 'critical',
    label: 'Run payroll',
    description: 'Run a payroll cycle.',
  },
  'hr.payroll.approve': {
    category: 'hr',
    sensitivity: 'critical',
    label: 'Approve payroll',
    description: 'Approve a payroll run for posting.',
  },
  'hr.payroll.post': {
    category: 'hr',
    sensitivity: 'critical',
    label: 'Post payroll',
    description: 'Post payroll to the ledger.',
  },
  'hr.recruitment.read': {
    category: 'hr',
    sensitivity: 'medium',
    label: 'View recruitment',
    description: 'View job postings and applicants.',
  },
  'hr.recruitment.update': {
    category: 'hr',
    sensitivity: 'high',
    label: 'Manage recruitment',
    description: 'Manage job postings and applicant stages.',
  },
  'hr.performance.read': {
    category: 'hr',
    sensitivity: 'medium',
    label: 'View performance',
    description: 'View appraisals and performance reviews.',
  },
  'hr.performance.update': {
    category: 'hr',
    sensitivity: 'high',
    label: 'Edit performance',
    description: 'Create or update performance reviews.',
  },
  'hr.fleet.read': {
    category: 'hr',
    sensitivity: 'low',
    label: 'View fleet',
    description: 'View company vehicles.',
  },
  'hr.fleet.update': {
    category: 'hr',
    sensitivity: 'high',
    label: 'Manage fleet',
    description: 'Add or update fleet records.',
  },

  // ───────────── Projects & Time ─────────────
  'projects.project.read': {
    category: 'projects',
    sensitivity: 'low',
    label: 'View projects',
    description: 'View projects.',
  },
  'projects.project.create': {
    category: 'projects',
    sensitivity: 'medium',
    label: 'Create project',
    description: 'Create a new project.',
  },
  'projects.project.update': {
    category: 'projects',
    sensitivity: 'medium',
    label: 'Edit project',
    description: 'Edit project details.',
  },
  'projects.project.delete': {
    category: 'projects',
    sensitivity: 'high',
    label: 'Delete project',
    description: 'Delete or archive a project.',
  },
  'projects.task.read': {
    category: 'projects',
    sensitivity: 'low',
    label: 'View tasks',
    description: 'View project tasks.',
  },
  'projects.task.create': {
    category: 'projects',
    sensitivity: 'low',
    label: 'Create task',
    description: 'Create a task.',
  },
  'projects.task.update': {
    category: 'projects',
    sensitivity: 'low',
    label: 'Edit task',
    description: 'Edit a task.',
  },
  'projects.task.delete': {
    category: 'projects',
    sensitivity: 'medium',
    label: 'Delete task',
    description: 'Delete a task.',
  },
  'projects.task.assign': {
    category: 'projects',
    sensitivity: 'low',
    label: 'Assign task',
    description: 'Assign a task to a user.',
  },
  'projects.time.read': {
    category: 'projects',
    sensitivity: 'low',
    label: 'View time entries',
    description: 'View time entries.',
  },
  'projects.time.create': {
    category: 'projects',
    sensitivity: 'low',
    label: 'Log time',
    description: 'Log a time entry.',
  },
  'projects.time.update': {
    category: 'projects',
    sensitivity: 'low',
    label: 'Edit time',
    description: 'Edit own time entries.',
  },
  'projects.time.approve': {
    category: 'projects',
    sensitivity: 'medium',
    label: 'Approve time',
    description: 'Approve submitted time entries.',
  },
  'projects.billing.read': {
    category: 'projects',
    sensitivity: 'medium',
    label: 'View project billing',
    description: 'View project billing and invoices.',
  },
  'projects.billing.update': {
    category: 'projects',
    sensitivity: 'high',
    label: 'Manage project billing',
    description: 'Configure project billing rules.',
  },
  'projects.profitability.read': {
    category: 'projects',
    sensitivity: 'medium',
    label: 'View profitability',
    description: 'View project profitability.',
  },

  // ───────────── Helpdesk & Service ─────────────
  'desk.case.read': {
    category: 'desk',
    sensitivity: 'low',
    label: 'View service cases',
    description: 'View service cases.',
  },
  'desk.case.create': {
    category: 'desk',
    sensitivity: 'low',
    label: 'Create service case',
    description: 'Open a new service case.',
  },
  'desk.case.update': {
    category: 'desk',
    sensitivity: 'low',
    label: 'Edit service case',
    description: 'Edit a service case.',
  },
  'desk.case.delete': {
    category: 'desk',
    sensitivity: 'medium',
    label: 'Delete service case',
    description: 'Delete a service case.',
  },
  'desk.case.assign': {
    category: 'desk',
    sensitivity: 'low',
    label: 'Assign service case',
    description: 'Assign a service case to an agent.',
  },
  'desk.case.escalate': {
    category: 'desk',
    sensitivity: 'medium',
    label: 'Escalate case',
    description: 'Escalate a service case.',
  },
  'desk.case.resolve': {
    category: 'desk',
    sensitivity: 'medium',
    label: 'Resolve case',
    description: 'Mark a case as resolved.',
  },
  'desk.case.close': {
    category: 'desk',
    sensitivity: 'medium',
    label: 'Close case',
    description: 'Close a service case.',
  },
  'desk.reply.create': {
    category: 'desk',
    sensitivity: 'low',
    label: 'Reply to case',
    description: 'Reply to a service case.',
  },
  'desk.reply.read': {
    category: 'desk',
    sensitivity: 'low',
    label: 'View case replies',
    description: 'List / read service case replies.',
  },
  'desk.knowledge.read': {
    category: 'desk',
    sensitivity: 'low',
    label: 'View knowledge base',
    description: 'View knowledge base articles.',
  },
  'desk.knowledge.update': {
    category: 'desk',
    sensitivity: 'high',
    label: 'Manage knowledge base',
    description: 'Create or update knowledge articles.',
  },
  'desk.sla.read': {
    category: 'desk',
    sensitivity: 'medium',
    label: 'View SLA',
    description: 'View SLA rules and reports.',
  },
  'desk.sla.update': {
    category: 'desk',
    sensitivity: 'high',
    label: 'Manage SLA',
    description: 'Configure SLA rules.',
  },
  'desk.field_service.read': {
    category: 'desk',
    sensitivity: 'low',
    label: 'View field service',
    description: 'View field service schedules.',
  },
  'desk.field_service.update': {
    category: 'desk',
    sensitivity: 'high',
    label: 'Manage field service',
    description: 'Schedule and dispatch field service.',
  },

  // ───────────── Documents & Sign ─────────────
  'docs.document.read': {
    category: 'docs',
    sensitivity: 'low',
    label: 'View documents',
    description: 'View documents and templates.',
  },
  'docs.document.create': {
    category: 'docs',
    sensitivity: 'medium',
    label: 'Create document',
    description: 'Create a new document.',
  },
  'docs.document.update': {
    category: 'docs',
    sensitivity: 'medium',
    label: 'Edit document',
    description: 'Edit a document.',
  },
  'docs.document.delete': {
    category: 'docs',
    sensitivity: 'high',
    label: 'Delete document',
    description: 'Delete a document.',
  },
  'docs.document.export': {
    category: 'docs',
    sensitivity: 'medium',
    label: 'Export document',
    description: 'Export document to PDF.',
  },
  'docs.template.read': {
    category: 'docs',
    sensitivity: 'low',
    label: 'View templates',
    description: 'View document templates.',
  },
  'docs.template.update': {
    category: 'docs',
    sensitivity: 'high',
    label: 'Manage templates',
    description: 'Create or update document templates.',
  },
  'docs.signature.request': {
    category: 'docs',
    sensitivity: 'medium',
    label: 'Request signature',
    description: 'Request a signature on a document.',
  },
  'docs.signature.sign': {
    category: 'docs',
    sensitivity: 'high',
    label: 'Sign document',
    description: 'Apply a signature to a document.',
  },
  'docs.signature.decline': {
    category: 'docs',
    sensitivity: 'medium',
    label: 'Decline signature',
    description: 'Decline to sign a document.',
  },
  'docs.signature.override': {
    category: 'docs',
    sensitivity: 'critical',
    label: 'Override signature',
    description: 'Override signature evidence (Owner only).',
  },
  'docs.evidence.read': {
    category: 'docs',
    sensitivity: 'medium',
    label: 'View evidence packet',
    description: 'View signature/audit evidence packets.',
  },
  'docs.evidence.export': {
    category: 'docs',
    sensitivity: 'high',
    label: 'Export evidence',
    description: 'Export evidence packet to PDF/JSON.',
  },
  'docs.cabinet.read': {
    category: 'docs',
    sensitivity: 'low',
    label: 'View document cabinet',
    description: 'View document cabinet folders.',
  },
  'docs.cabinet.update': {
    category: 'docs',
    sensitivity: 'high',
    label: 'Manage document cabinet',
    description: 'Create folders and manage cabinet.',
  },
  'docs.request.read': {
    category: 'docs',
    sensitivity: 'low',
    label: 'View requested docs',
    description: 'View pending document requests.',
  },
  'docs.request.update': {
    category: 'docs',
    sensitivity: 'high',
    label: 'Manage requested docs',
    description: 'Send document requests to customers.',
  },

  // ───────────── Customer Portal ─────────────
  'portal.storefront.read': {
    category: 'portal',
    sensitivity: 'low',
    label: 'View storefront',
    description: 'View public storefront.',
  },
  'portal.storefront.update': {
    category: 'portal',
    sensitivity: 'high',
    label: 'Manage storefront',
    description: 'Configure public storefront.',
  },
  'portal.cart.create': {
    category: 'portal',
    sensitivity: 'low',
    label: 'Add to cart',
    description: 'Add items to cart (customer-facing).',
  },
  'portal.order.read': {
    category: 'portal',
    sensitivity: 'low',
    label: 'View own orders',
    description: 'Customer can view own orders.',
  },
  'portal.order.create': {
    category: 'portal',
    sensitivity: 'low',
    label: 'Place order',
    description: 'Customer places an order.',
  },
  'portal.invoice.read': {
    category: 'portal',
    sensitivity: 'low',
    label: 'View own invoices',
    description: 'Customer can view own invoices.',
  },
  'portal.payment.make': {
    category: 'portal',
    sensitivity: 'medium',
    label: 'Make payment',
    description: 'Customer makes a payment.',
  },
  'portal.ticket.create': {
    category: 'portal',
    sensitivity: 'low',
    label: 'Open portal ticket',
    description: 'Customer opens a portal ticket.',
  },
  'portal.document.read': {
    category: 'portal',
    sensitivity: 'low',
    label: 'View own documents',
    description: 'Customer views own documents.',
  },

  // ───────────── Marketing & Campaigns ─────────────
  'mrkt.campaign.read': {
    category: 'mrkt',
    sensitivity: 'low',
    label: 'View campaigns',
    description: 'View marketing campaigns.',
  },
  'mrkt.campaign.create': {
    category: 'mrkt',
    sensitivity: 'medium',
    label: 'Create campaign',
    description: 'Create a marketing campaign.',
  },
  'mrkt.campaign.update': {
    category: 'mrkt',
    sensitivity: 'medium',
    label: 'Edit campaign',
    description: 'Edit campaign content or schedule.',
  },
  'mrkt.campaign.delete': {
    category: 'mrkt',
    sensitivity: 'high',
    label: 'Delete campaign',
    description: 'Delete a campaign.',
  },
  'mrkt.campaign.send': {
    category: 'mrkt',
    sensitivity: 'high',
    label: 'Send campaign',
    description: 'Send or schedule a campaign.',
  },
  'mrkt.campaign.pause': {
    category: 'mrkt',
    sensitivity: 'medium',
    label: 'Pause campaign',
    description: 'Pause an in-flight campaign send.',
  },
  'mrkt.campaign.duplicate': {
    category: 'mrkt',
    sensitivity: 'medium',
    label: 'Duplicate campaign',
    description: 'Duplicate an existing campaign as a new draft.',
  },
  'mrkt.campaign.export': {
    category: 'mrkt',
    sensitivity: 'medium',
    label: 'Export campaign report',
    description: 'Export campaign performance reports.',
  },
  'mrkt.segment.read': {
    category: 'mrkt',
    sensitivity: 'low',
    label: 'View segments',
    description: 'View audience segments.',
  },
  'mrkt.segment.update': {
    category: 'mrkt',
    sensitivity: 'high',
    label: 'Manage segments',
    description: 'Build or edit audience segments.',
  },
  'mrkt.segment.preview': {
    category: 'mrkt',
    sensitivity: 'medium',
    label: 'Preview segment size',
    description: 'Run a count-only preview of a segment definition.',
  },
  'mrkt.template.read': {
    category: 'mrkt',
    sensitivity: 'low',
    label: 'View templates',
    description: 'View marketing templates.',
  },
  'mrkt.template.update': {
    category: 'mrkt',
    sensitivity: 'high',
    label: 'Manage templates',
    description: 'Edit marketing templates.',
  },
  'mrkt.consent.read': {
    category: 'mrkt',
    sensitivity: 'medium',
    label: 'View consent ledger',
    description: 'View consent records.',
  },
  'mrkt.consent.update': {
    category: 'mrkt',
    sensitivity: 'high',
    label: 'Manage consent',
    description: 'Record or update consent.',
  },
  'mrkt.unsubscribe.read': {
    category: 'mrkt',
    sensitivity: 'low',
    label: 'View unsubscribes',
    description: 'View unsubscribe / blacklist.',
  },
  'mrkt.unsubscribe.manage': {
    category: 'mrkt',
    sensitivity: 'high',
    label: 'Manage unsubscribes',
    description: 'Add/remove from blacklist.',
  },
  'mrkt.journey.read': {
    category: 'mrkt',
    sensitivity: 'low',
    label: 'View journeys',
    description: 'View automated marketing journeys / flows.',
  },
  'mrkt.journey.update': {
    category: 'mrkt',
    sensitivity: 'high',
    label: 'Manage journeys',
    description: 'Create or edit automated journeys.',
  },
  'mrkt.journey.publish': {
    category: 'mrkt',
    sensitivity: 'high',
    label: 'Publish journey',
    description: 'Publish or activate a journey.',
  },
  'mrkt.landing.read': {
    category: 'mrkt',
    sensitivity: 'low',
    label: 'View landing pages',
    description: 'View marketing landing pages.',
  },
  'mrkt.landing.update': {
    category: 'mrkt',
    sensitivity: 'high',
    label: 'Manage landing pages',
    description: 'Create or edit landing pages.',
  },
  'mrkt.form.read': {
    category: 'mrkt',
    sensitivity: 'low',
    label: 'View forms',
    description: 'View lead-capture forms.',
  },
  'mrkt.form.update': {
    category: 'mrkt',
    sensitivity: 'high',
    label: 'Manage forms',
    description: 'Create or edit lead-capture forms.',
  },
  'mrkt.subscription.read': {
    category: 'mrkt',
    sensitivity: 'low',
    label: 'View subscriptions',
    description: 'View recurring subscription campaigns.',
  },
  'mrkt.subscription.update': {
    category: 'mrkt',
    sensitivity: 'high',
    label: 'Manage subscriptions',
    description: 'Create or edit subscription campaigns.',
  },
  'mrkt.lead_score.read': {
    category: 'mrkt',
    sensitivity: 'medium',
    label: 'View lead scoring',
    description: 'View lead scoring rules and outputs.',
  },
  'mrkt.lead_score.update': {
    category: 'mrkt',
    sensitivity: 'high',
    label: 'Manage lead scoring',
    description: 'Create or update lead scoring rules.',
  },
  'mrkt.abtest.read': {
    category: 'mrkt',
    sensitivity: 'medium',
    label: 'View A/B tests',
    description: 'View A/B test results.',
  },
  'mrkt.abtest.update': {
    category: 'mrkt',
    sensitivity: 'high',
    label: 'Manage A/B tests',
    description: 'Create or update A/B tests.',
  },
  'mrkt.webhook.read': {
    category: 'mrkt',
    sensitivity: 'low',
    label: 'View marketing webhooks',
    description: 'View marketing automation webhooks.',
  },
  'mrkt.webhook.update': {
    category: 'mrkt',
    sensitivity: 'high',
    label: 'Manage marketing webhooks',
    description: 'Create or update marketing webhooks.',
  },

  // ───────────── Manufacturing & Quality ─────────────
  'mfg.bom.read': {
    category: 'mfg',
    sensitivity: 'low',
    label: 'View BoM',
    description: 'View bills of materials.',
  },
  'mfg.bom.update': {
    category: 'mfg',
    sensitivity: 'high',
    label: 'Manage BoM',
    description: 'Create or edit bills of materials.',
  },
  'mfg.bom.delete': {
    category: 'mfg',
    sensitivity: 'critical',
    label: 'Delete BoM',
    description: 'Delete a bill of materials (archived, not purged).',
  },
  'mfg.bom.version': {
    category: 'mfg',
    sensitivity: 'high',
    label: 'Version BoM',
    description: 'Create a new revision of a BoM and supersede the old one.',
  },
  'mfg.routing.read': {
    category: 'mfg',
    sensitivity: 'low',
    label: 'View routing',
    description: 'View routings (operation sequences for work orders).',
  },
  'mfg.routing.update': {
    category: 'mfg',
    sensitivity: 'high',
    label: 'Manage routing',
    description: 'Create or edit routings.',
  },
  'mfg.work_order.read': {
    category: 'mfg',
    sensitivity: 'low',
    label: 'View work orders',
    description: 'View manufacturing work orders.',
  },
  'mfg.work_order.create': {
    category: 'mfg',
    sensitivity: 'medium',
    label: 'Create work order',
    description: 'Create a work order.',
  },
  'mfg.work_order.update': {
    category: 'mfg',
    sensitivity: 'medium',
    label: 'Edit work order',
    description: 'Edit a work order.',
  },
  'mfg.work_order.cancel': {
    category: 'mfg',
    sensitivity: 'high',
    label: 'Cancel work order',
    description: 'Cancel a work order and reverse any stock postings.',
  },
  'mfg.work_order.complete': {
    category: 'mfg',
    sensitivity: 'high',
    label: 'Complete work order',
    description: 'Mark a work order complete and post stock.',
  },
  'mfg.work_order.release': {
    category: 'mfg',
    sensitivity: 'high',
    label: 'Release work order',
    description: 'Release a planned work order to the shop floor.',
  },
  'mfg.work_center.read': {
    category: 'mfg',
    sensitivity: 'low',
    label: 'View work centers',
    description: 'View work centers.',
  },
  'mfg.work_center.update': {
    category: 'mfg',
    sensitivity: 'high',
    label: 'Manage work centers',
    description: 'Configure work centers.',
  },
  'mfg.quality.read': {
    category: 'mfg',
    sensitivity: 'low',
    label: 'View quality alerts',
    description: 'View quality alerts and checks.',
  },
  'mfg.quality.update': {
    category: 'mfg',
    sensitivity: 'high',
    label: 'Manage quality',
    description: 'Record or close quality alerts.',
  },
  'mfg.quality.hold': {
    category: 'mfg',
    sensitivity: 'critical',
    label: 'Place lot on hold',
    description: 'Place a lot/serial on quality hold (blocks shipping).',
  },
  'mfg.quality.release': {
    category: 'mfg',
    sensitivity: 'critical',
    label: 'Release quality hold',
    description: 'Release a lot/serial from quality hold.',
  },
  'mfg.repair.read': {
    category: 'mfg',
    sensitivity: 'low',
    label: 'View repairs',
    description: 'View repair orders.',
  },
  'mfg.repair.update': {
    category: 'mfg',
    sensitivity: 'high',
    label: 'Manage repairs',
    description: 'Create or update repair orders.',
  },
  'mfg.repair.complete': {
    category: 'mfg',
    sensitivity: 'high',
    label: 'Complete repair',
    description: 'Mark a repair order complete and post stock.',
  },
  'mfg.mps.read': {
    category: 'mfg',
    sensitivity: 'medium',
    label: 'View MPS',
    description: 'View Master Production Schedule plans.',
  },
  'mfg.mps.update': {
    category: 'mfg',
    sensitivity: 'high',
    label: 'Manage MPS',
    description: 'Create or update MPS plans and run MRP.',
  },
  'mfg.mrp.run': {
    category: 'mfg',
    sensitivity: 'high',
    label: 'Run MRP',
    description: 'Run material requirements planning regeneration.',
  },
  'mfg.costing.read': {
    category: 'mfg',
    sensitivity: 'medium',
    label: 'View production cost',
    description: 'View production cost rollups.',
  },
  'mfg.costing.update': {
    category: 'mfg',
    sensitivity: 'high',
    label: 'Manage cost rollup',
    description: 'Trigger and adjust production cost rollups.',
  },

  // ───────────── AI & Copilot ─────────────
  'ai.copilot.use': {
    category: 'ai',
    sensitivity: 'low',
    label: 'Use Copilot',
    description: 'Send queries to the AI Copilot.',
  },
  'ai.copilot.legal': {
    category: 'ai',
    sensitivity: 'medium',
    label: 'Use legal Copilot',
    description: 'Use legal Copilot with source gating.',
  },
  'ai.copilot.accounting': {
    category: 'ai',
    sensitivity: 'medium',
    label: 'Use accounting Copilot',
    description: 'Use accounting Copilot with source gating.',
  },
  'ai.copilot.mutate': {
    category: 'ai',
    sensitivity: 'high',
    label: 'AI mutation actions',
    description: 'Allow Copilot to propose mutations (still requires approval).',
  },
  'ai.copilot.configure': {
    category: 'ai',
    sensitivity: 'high',
    label: 'Configure Copilot',
    description: 'Configure Copilot topics, tools, sources, models.',
  },
  'ai.agent.read': {
    category: 'ai',
    sensitivity: 'low',
    label: 'View AI agents',
    description: 'View the agent registry, versions, and metadata.',
  },
  'ai.agent.create': {
    category: 'ai',
    sensitivity: 'high',
    label: 'Create AI agent',
    description: 'Create a new agent definition (draft).',
  },
  'ai.agent.update': {
    category: 'ai',
    sensitivity: 'high',
    label: 'Edit AI agent',
    description: 'Edit an existing agent definition (system prompt, tools, scope).',
  },
  'ai.agent.delete': {
    category: 'ai',
    sensitivity: 'critical',
    label: 'Delete AI agent',
    description: 'Delete an agent definition and revoke all its tokens.',
  },
  'ai.agent.run': {
    category: 'ai',
    sensitivity: 'medium',
    label: 'Run AI agent',
    description: 'Run an AI agent within a governed scope.',
  },
  'ai.agent.schedule': {
    category: 'ai',
    sensitivity: 'high',
    label: 'Schedule AI agent',
    description: 'Schedule an agent to run on a cron or trigger.',
  },
  'ai.agent.pause': {
    category: 'ai',
    sensitivity: 'high',
    label: 'Pause AI agent',
    description: 'Pause an in-flight agent run or disable a scheduled agent.',
  },
  'ai.agent.version': {
    category: 'ai',
    sensitivity: 'high',
    label: 'Version AI agent',
    description: 'Cut a new version of an agent definition.',
  },
  'ai.agent.deploy': {
    category: 'ai',
    sensitivity: 'critical',
    label: 'Deploy AI agent',
    description: 'Deploy a new agent version to production.',
  },
  'ai.agent.rollback': {
    category: 'ai',
    sensitivity: 'critical',
    label: 'Rollback AI agent',
    description: 'Rollback a deployed agent to a prior version.',
  },
  'ai.agent.scope.read': {
    category: 'ai',
    sensitivity: 'medium',
    label: 'View agent scope',
    description: "View an agent's data scope and tool permissions.",
  },
  'ai.agent.scope.update': {
    category: 'ai',
    sensitivity: 'high',
    label: 'Edit agent scope',
    description: "Edit an agent's data scope and tool permissions.",
  },
  'ai.agent.runlog.read': {
    category: 'ai',
    sensitivity: 'medium',
    label: 'View agent run logs',
    description: 'View agent run history, traces, and tool calls.',
  },
  'ai.agent.runlog.export': {
    category: 'ai',
    sensitivity: 'high',
    label: 'Export agent run logs',
    description: 'Export agent run history as JSON/CSV.',
  },
  'ai.tool.read': {
    category: 'ai',
    sensitivity: 'medium',
    label: 'View agent tools',
    description: 'View tools available to agents.',
  },
  'ai.tool.update': {
    category: 'ai',
    sensitivity: 'high',
    label: 'Manage agent tools',
    description: 'Register or update tools an agent can call.',
  },
  'ai.evaluation.read': {
    category: 'ai',
    sensitivity: 'medium',
    label: 'View AI evaluations',
    description: 'View evaluation results and metrics.',
  },
  'ai.evaluation.run': {
    category: 'ai',
    sensitivity: 'high',
    label: 'Run AI evaluation',
    description: 'Run an evaluation suite against an agent.',
  },
  'ai.prompt.read': {
    category: 'ai',
    sensitivity: 'medium',
    label: 'View prompts',
    description: 'View prompt library.',
  },
  'ai.prompt.update': {
    category: 'ai',
    sensitivity: 'high',
    label: 'Manage prompts',
    description: 'Edit prompt library entries.',
  },
  'ai.fallback.read': {
    category: 'ai',
    sensitivity: 'medium',
    label: 'View AI fallbacks',
    description: 'View fallback rules and refusal tests.',
  },
  'ai.fallback.update': {
    category: 'ai',
    sensitivity: 'high',
    label: 'Manage AI fallbacks',
    description: 'Edit fallback rules and refusal tests.',
  },
  'ai.budget.read': {
    category: 'ai',
    sensitivity: 'medium',
    label: 'View AI budget',
    description: 'View AI token and cost budget consumption.',
  },
  'ai.budget.update': {
    category: 'ai',
    sensitivity: 'high',
    label: 'Manage AI budget',
    description: 'Set or change AI token and cost budgets.',
  },

  // ───────────── Reports & Analytics ─────────────
  'reports.dashboard.read': {
    category: 'reports',
    sensitivity: 'low',
    label: 'View dashboards',
    description: 'View dashboards.',
  },
  'finance.reports.execute': {
    category: 'reports',
    sensitivity: 'high',
    label: 'Execute scheduled reports',
    description: 'Manually trigger a scheduled report to run immediately. Use with care — manual runs are recorded in the audit log with triggered_by="manual".',
  },
  'reports.dashboard.update': {
    category: 'reports',
    sensitivity: 'medium',
    label: 'Manage dashboards',
    description: 'Create or update dashboards.',
  },
  'reports.financial.read': {
    category: 'reports',
    sensitivity: 'low',
    label: 'View financial reports',
    description: 'View financial reports.',
  },
  'reports.financial.export': {
    category: 'reports',
    sensitivity: 'high',
    label: 'Export financial reports',
    description: 'Export financial reports.',
  },
  'reports.tax.read': {
    category: 'reports',
    sensitivity: 'medium',
    label: 'View tax reports',
    description: 'View tax reports.',
  },
  'reports.tax.export': {
    category: 'reports',
    sensitivity: 'critical',
    label: 'Export tax reports',
    description: 'Export tax reports for filing.',
  },
  'reports.operational.read': {
    category: 'reports',
    sensitivity: 'low',
    label: 'View operational reports',
    description: 'View operational reports.',
  },
  'reports.operational.export': {
    category: 'reports',
    sensitivity: 'medium',
    label: 'Export operational reports',
    description: 'Export operational reports.',
  },
  'reports.builder.read': {
    category: 'reports',
    sensitivity: 'low',
    label: 'View report builder',
    description: 'View report builder.',
  },
  'reports.builder.update': {
    category: 'reports',
    sensitivity: 'high',
    label: 'Manage report builder',
    description: 'Create or update report definitions.',
  },
  'reports.spreadsheet.read': {
    category: 'reports',
    sensitivity: 'low',
    label: 'View spreadsheet',
    description: 'View spreadsheet-style analytics.',
  },
  'reports.spreadsheet.update': {
    category: 'reports',
    sensitivity: 'high',
    label: 'Manage spreadsheet',
    description: 'Edit spreadsheet formulas and layouts.',
  },

  // ───────────── Analytics Snapshots & Reports ─────────────
  'analytics.snapshot.create': {
    category: 'analytics',
    sensitivity: 'medium',
    label: 'Capture analytics snapshot',
    description: 'Freeze current operating metrics into a timestamped analytics snapshot.',
  },
  'analytics.report.read': {
    category: 'analytics',
    sensitivity: 'low',
    label: 'View analytics report',
    description: 'View a generated analytics report (owner or accountant packet).',
  },

  // ───────────── Studio & Automation ─────────────
  'studio.custom_field.read': {
    category: 'studio',
    sensitivity: 'low',
    label: 'View custom fields',
    description: 'View custom field definitions.',
  },
  'studio.custom_field.update': {
    category: 'studio',
    sensitivity: 'high',
    label: 'Manage custom fields',
    description: 'Create or update custom fields.',
  },
  'studio.workflow.read': {
    category: 'studio',
    sensitivity: 'low',
    label: 'View workflows',
    description: 'View workflow definitions.',
  },
  'studio.workflow.update': {
    category: 'studio',
    sensitivity: 'high',
    label: 'Manage workflows',
    description: 'Create or update workflows.',
  },
  'studio.workflow.run': {
    category: 'studio',
    sensitivity: 'medium',
    label: 'Run workflow',
    description: 'Trigger a workflow run.',
  },
  'studio.approval.read': {
    category: 'studio',
    sensitivity: 'low',
    label: 'View approvals',
    description: 'View approval rules.',
  },
  'studio.approval.update': {
    category: 'studio',
    sensitivity: 'high',
    label: 'Manage approvals',
    description: 'Create or update approval rules.',
  },
  'studio.webhook.read': {
    category: 'studio',
    sensitivity: 'low',
    label: 'View webhooks',
    description: 'View webhook definitions.',
  },
  'studio.webhook.update': {
    category: 'studio',
    sensitivity: 'high',
    label: 'Manage webhooks',
    description: 'Create or update webhooks.',
  },
  'studio.layout.read': {
    category: 'studio',
    sensitivity: 'low',
    label: 'View layouts',
    description: 'View custom layouts.',
  },
  'studio.layout.update': {
    category: 'studio',
    sensitivity: 'medium',
    label: 'Manage layouts',
    description: 'Create or update custom layouts.',
  },

  // ───────────── Pilot Engagements ─────────────
  // Pilot engagements (e.g. clinic-wellness) are template-driven engagements
  // that walk a tenant from launch readiness through paid handoff. Perms
  // here gate the templates, briefs, operator workbenches, and accountant
  // reviews. A future wave will grant these to the roles that should hold
  // them; for now the perms are system-defined but unassigned.
  'pilot.template.read': {
    category: 'pilot',
    sensitivity: 'low',
    label: 'View pilot templates',
    description: 'View a pilot engagement template (e.g. clinic-wellness) and its definition.',
  },
  'pilot.template.install': {
    category: 'pilot',
    sensitivity: 'medium',
    label: 'Install pilot template',
    description: 'Install a pilot engagement template into the current tenant.',
  },
  'pilot.brief.read': {
    category: 'pilot',
    sensitivity: 'low',
    label: 'View pilot owner briefs',
    description: 'View owner briefs prepared for a pilot engagement.',
  },
  'pilot.brief.create': {
    category: 'pilot',
    sensitivity: 'medium',
    label: 'Create pilot owner brief',
    description: 'Create an owner brief for a pilot engagement.',
  },
  'pilot.workbench.read': {
    category: 'pilot',
    sensitivity: 'low',
    label: 'View pilot operator workbenches',
    description: 'View operator workbenches for a pilot engagement.',
  },
  'pilot.workbench.create': {
    category: 'pilot',
    sensitivity: 'medium',
    label: 'Create pilot operator workbench',
    description: 'Create an operator workbench entry for a pilot engagement.',
  },
  'pilot.review.read': {
    category: 'pilot',
    sensitivity: 'low',
    label: 'View pilot accountant reviews',
    description: 'View accountant reviews for a pilot engagement.',
  },
  'pilot.review.create': {
    category: 'pilot',
    sensitivity: 'medium',
    label: 'Create pilot accountant review',
    description: 'Create an accountant review for a pilot engagement.',
  },

  // ───────────── Compliance & Audit ─────────────
  'compliance.policy.read': {
    category: 'compliance',
    sensitivity: 'low',
    label: 'View policies',
    description: 'View compliance policies.',
  },
  'compliance.policy.update': {
    category: 'compliance',
    sensitivity: 'high',
    label: 'Manage policies',
    description: 'Create or update policies.',
  },
  'compliance.policy.approve': {
    category: 'compliance',
    sensitivity: 'high',
    label: 'Approve policy',
    description: 'Approve a new or revised policy for publication.',
  },
  'compliance.policy.publish': {
    category: 'compliance',
    sensitivity: 'high',
    label: 'Publish policy',
    description: 'Publish a policy to the org and trigger acknowledgements.',
  },
  'compliance.control.read': {
    category: 'compliance',
    sensitivity: 'medium',
    label: 'View controls',
    description: 'View compliance controls and their maturity.',
  },
  'compliance.control.update': {
    category: 'compliance',
    sensitivity: 'high',
    label: 'Manage controls',
    description: 'Create or update compliance controls and tests.',
  },
  'compliance.risk.read': {
    category: 'compliance',
    sensitivity: 'medium',
    label: 'View risk register',
    description: 'View the risk register.',
  },
  'compliance.risk.update': {
    category: 'compliance',
    sensitivity: 'high',
    label: 'Manage risk register',
    description: 'Create or update risks and mitigations.',
  },
  'compliance.evidence.read': {
    category: 'compliance',
    sensitivity: 'medium',
    label: 'View control evidence',
    description: 'View evidence attached to compliance controls.',
  },
  'compliance.evidence.update': {
    category: 'compliance',
    sensitivity: 'high',
    label: 'Manage control evidence',
    description: 'Attach or remove evidence from controls.',
  },
  'compliance.vendor_assessment.read': {
    category: 'compliance',
    sensitivity: 'medium',
    label: 'View vendor assessments',
    description: 'View third-party vendor risk assessments.',
  },
  'compliance.vendor_assessment.update': {
    category: 'compliance',
    sensitivity: 'high',
    label: 'Manage vendor assessments',
    description: 'Create or update vendor assessments.',
  },
  'compliance.consent.read': {
    category: 'compliance',
    sensitivity: 'medium',
    label: 'View consent ledger',
    description: 'View consent records.',
  },
  'compliance.consent.update': {
    category: 'compliance',
    sensitivity: 'high',
    label: 'Manage consent ledger',
    description: 'Update consent records.',
  },
  'compliance.retention.read': {
    category: 'compliance',
    sensitivity: 'low',
    label: 'View retention rules',
    description: 'View data retention rules.',
  },
  'compliance.retention.update': {
    category: 'compliance',
    sensitivity: 'critical',
    label: 'Manage retention',
    description: 'Update data retention rules.',
  },
  'compliance.retention.run': {
    category: 'compliance',
    sensitivity: 'critical',
    label: 'Run retention purge',
    description: 'Execute a retention-driven purge job.',
  },
  'compliance.legal.read': {
    category: 'compliance',
    sensitivity: 'medium',
    label: 'View legal sources',
    description: 'View Armenian legal source registry.',
  },
  'compliance.legal.update': {
    category: 'compliance',
    sensitivity: 'high',
    label: 'Manage legal sources',
    description: 'Update Armenian legal source registry.',
  },
  'compliance.gdpr.read': {
    category: 'compliance',
    sensitivity: 'medium',
    label: 'View GDPR/PDPA tools',
    description: 'View GDPR / Armenian PDPA subject requests.',
  },
  'compliance.gdpr.fulfill': {
    category: 'compliance',
    sensitivity: 'high',
    label: 'Fulfill data subject request',
    description: 'Export or delete subject data.',
  },
  'compliance.breach.read': {
    category: 'compliance',
    sensitivity: 'high',
    label: 'View breach register',
    description: 'View data breach register.',
  },
  'compliance.breach.update': {
    category: 'compliance',
    sensitivity: 'critical',
    label: 'Manage breach register',
    description: 'Record or update a data breach entry.',
  },
  'compliance.audit.prepare': {
    category: 'compliance',
    sensitivity: 'high',
    label: 'Prepare audit packet',
    description: 'Prepare a regulator-ready audit packet.',
  },
  'compliance.audit.deliver': {
    category: 'compliance',
    sensitivity: 'critical',
    label: 'Deliver audit packet',
    description: 'Submit or hand over an audit packet externally.',
  },
  'compliance.sox.read': {
    category: 'compliance',
    sensitivity: 'medium',
    label: 'View SOX controls',
    description: 'View SOX financial controls and certifications.',
  },
  'compliance.sox.update': {
    category: 'compliance',
    sensitivity: 'high',
    label: 'Manage SOX controls',
    description: 'Update SOX controls and certifications.',
  },
});

// Index by category for UI rendering.
function byCategory() {
  const out = new Map();
  for (const [key, def] of Object.entries(PERMISSIONS)) {
    const cat = def.category;
    if (!out.has(cat)) out.set(cat, []);
    out.get(cat).push({ key, ...def });
  }
  for (const list of out.values()) list.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

// Validation helpers used by seeders and route guards.
function isValidKey(key) {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, key);
}

function getDefinition(key) {
  return PERMISSIONS[key] || null;
}

function listKeys() {
  return Object.freeze(Object.keys(PERMISSIONS));
}

function requireKey(key) {
  if (!isValidKey(key)) {
    const err = new Error(`Unknown permission: ${key}`);
    err.statusCode = 500;
    err.code = 'unknown_permission';
    throw err;
  }
  return PERMISSIONS[key];
}

export {
  PERMISSIONS_VERSION,
  CATEGORIES,
  SENSITIVITY,
  PERMISSIONS,
  byCategory,
  isValidKey,
  getDefinition,
  listKeys,
  requireKey,
};
