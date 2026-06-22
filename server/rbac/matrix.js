// SBOS-A1-ERP Permission Sets
//
// Salesforce-style permission sets: a permission set is a named, reusable bundle
// of permissions. A user holds:
//   - exactly one role (which inherits from its parent chain), AND
//   - zero or more permission sets (additive, never subtractive)
//
// Use permission sets for cross-functional needs (e.g. "Approver" can be added
// to any user regardless of role). Use roles for the primary org-position
// hierarchy.
const PERMISSION_SETS_VERSION = 1;

const PERMISSION_SETS = Object.freeze({
  // ─────────── Foundation ───────────
  StandardUser: {
    id: 'StandardUser',
    label: 'Standard User',
    description:
      'Default set for any signed-in user. Read own profile, view dashboards, log time, view own tasks.',
    isSystem: true,
    permissions: Object.freeze([
      'system.org.read',
      'security.user.read',
      'projects.task.read',
      'projects.task.update',
      'projects.time.read',
      'projects.time.create',
      'projects.time.update',
      'reports.dashboard.read',
    ]),
  },
  MobileAccess: {
    id: 'MobileAccess',
    label: 'Mobile App Access',
    description: 'Allow login from mobile devices.',
    isSystem: true,
    permissions: Object.freeze([]),
  },

  // ─────────── Cross-functional capability sets ───────────
  Approver: {
    id: 'Approver',
    label: 'Approver',
    description:
      'Approve deals, quotes, POs, bills, payroll, time off, contracts. This is a capability set, not a role.',
    isSystem: true,
    permissions: Object.freeze([
      'crm.deal.approve',
      'crm.quote.release',
      'purchase.po.approve',
      'finance.bill.approve',
      'hr.leave.approve',
      'hr.contract.approve',
      'hr.payroll.approve',
      'projects.time.approve',
    ]),
  },
  AIEnabled: {
    id: 'AIEnabled',
    label: 'AI Enabled',
    description: 'Allow the user to invoke the AI Copilot and run agents within a governed scope.',
    isSystem: true,
    permissions: Object.freeze([
      'ai.copilot.use',
      'ai.copilot.legal',
      'ai.copilot.accounting',
      'ai.agent.run',
    ]),
  },
  AIMutator: {
    id: 'AIMutator',
    label: 'AI Mutator',
    description:
      'Allow Copilot to propose mutations. Still requires a human approver with the matching action permission.',
    isSystem: true,
    permissions: Object.freeze(['ai.copilot.mutate']),
  },
  AIPowerUser: {
    id: 'AIPowerUser',
    label: 'AI Power User',
    description:
      'AI Enabled + AI Mutator + ability to configure Copilot topics and run evaluations.',
    isSystem: true,
    permissions: Object.freeze([
      'ai.copilot.use',
      'ai.copilot.legal',
      'ai.copilot.accounting',
      'ai.copilot.mutate',
      'ai.copilot.configure',
      'ai.agent.read',
      'ai.agent.run',
      'ai.agent.runlog.read',
      'ai.evaluation.read',
      'ai.evaluation.run',
      'ai.prompt.read',
      'ai.prompt.update',
      'ai.fallback.read',
      'ai.budget.read',
    ]),
  },
  AgentDeveloper: {
    id: 'AgentDeveloper',
    label: 'Agent Developer',
    description:
      'Create, edit, and version AI agent definitions, register tools, and run evaluations. Cannot deploy to production.',
    isSystem: true,
    permissions: Object.freeze([
      'ai.agent.read',
      'ai.agent.create',
      'ai.agent.update',
      'ai.agent.version',
      'ai.agent.schedule',
      'ai.agent.pause',
      'ai.agent.scope.read',
      'ai.agent.scope.update',
      'ai.agent.runlog.read',
      'ai.agent.runlog.export',
      'ai.tool.read',
      'ai.tool.update',
      'ai.evaluation.read',
      'ai.evaluation.run',
      'ai.prompt.read',
      'ai.prompt.update',
      'ai.fallback.read',
      'ai.fallback.update',
      'ai.budget.read',
    ]),
  },
  AgentOperator: {
    id: 'AgentOperator',
    label: 'Agent Operator',
    description: 'Run, pause, and inspect AI agent runs. Read-only on definitions and tools.',
    isSystem: true,
    permissions: Object.freeze([
      'ai.agent.read',
      'ai.agent.run',
      'ai.agent.pause',
      'ai.agent.scope.read',
      'ai.agent.runlog.read',
      'ai.tool.read',
      'ai.evaluation.read',
      'ai.budget.read',
    ]),
  },
  AgentDeployer: {
    id: 'AgentDeployer',
    label: 'Agent Deployer',
    description: 'Deploy and rollback AI agent versions to production (critical, dual-control).',
    isSystem: true,
    permissions: Object.freeze(['ai.agent.deploy', 'ai.agent.rollback', 'ai.agent.delete']),
  },
  AIGovernance: {
    id: 'AIGovernance',
    label: 'AI Governance',
    description: 'Manage AI token/cost budgets and fallback rules org-wide.',
    isSystem: true,
    permissions: Object.freeze([
      'ai.budget.read',
      'ai.budget.update',
      'ai.fallback.read',
      'ai.fallback.update',
      'ai.prompt.read',
      'ai.prompt.update',
    ]),
  },
  SensitiveDataReader: {
    id: 'SensitiveDataReader',
    label: 'Sensitive Data Reader',
    description:
      'Read access to PII and confidential fields. Use sparingly; required for HR, finance close, and compliance investigations.',
    isSystem: true,
    permissions: Object.freeze([
      'hr.employee.pii.read',
      'docs.evidence.read',
      'compliance.legal.read',
    ]),
  },
  PIIEditor: {
    id: 'PIIEditor',
    label: 'PII Editor',
    description: 'Edit employee PII. Highly sensitive — restricted to HR and compliance.',
    isSystem: true,
    permissions: Object.freeze(['hr.employee.pii.read', 'hr.employee.pii.update']),
  },

  // ─────────── Finance sets ───────────
  //
  // finance.journal.create is intentionally NOT in FinanceOperator —
  // the legacy requireFinanceOperator helper only allows Owner, Admin,
  // Accountant, so it lives in its own dedicated perm set (JournalWriter)
  // that mirrors the legacy allow-list exactly.
  // finance.bill.create is also intentionally NOT in FinanceOperator —
  // the legacy requireFinanceOperator helper (used by
  // POST /api/purchase/orders/:id/bill) only allows Owner, Admin,
  // Accountant, so it lives in its own dedicated perm set (FinanceBillWriter)
  // that mirrors the legacy allow-list exactly. The rest of the
  // FinanceOperator grants (read/update/post, bill.read, bill.update,
  // payment.*, bank.*, tax.*, vat_return.*, budget.read, einvoice.*) are
  // non-broad and stay here.
  FinanceOperator: {
    id: 'FinanceOperator',
    label: 'Finance Operator',
    description:
      'Day-to-day finance: invoices, bills (read/update), payments, bank, journal, tax. The two create perms the Wave 5 + Wave 7 narrow-grant workers split out (finance.journal.create, finance.bill.create) live in dedicated narrow perm sets (JournalWriter, FinanceBillWriter) so the catalog can mirror the legacy requireFinanceOperator allow-list exactly.',
    isSystem: true,
    permissions: Object.freeze([
      'finance.coa.read',
      'finance.journal.read',
      'finance.journal.update',
      'finance.journal.post',
      'finance.invoice.read',
      'finance.invoice.create',
      'finance.invoice.update',
      'finance.invoice.issue',
      'finance.invoice.void',
      'finance.invoice.attach',
      'finance.invoice.attach.read',
      'finance.bill.read',
      'finance.bill.update',
      'finance.payment.read',
      'finance.payment.create',
      'finance.bank.read',
      'finance.bank.reconcile',
      'finance.tax.read',
      'finance.vat_return.read',
      'finance.vat_return.prepare',
      'finance.budget.read',
      'finance.einvoice.read',
      'finance.einvoice.issue',
      // Phase 1 ERP — inventory + purchase module perms.
      'finance.product.read',
      'finance.product.create',
      'finance.product.update',
      'finance.warehouse.read',
      'finance.warehouse.create',
      'finance.warehouse.update',
      'finance.stock.read',
      'finance.stock.move',
      // Phase 2 lots + serials (W37 / W39 / W41).
      'inventory.lot.read',
      'inventory.serial.read',
      'inventory.lot.recall',
      // Phase 2 catalog v2 (W77) — categories +
      // variants. The admin user (who has the
      // FinanceOperator set) gets these keys too.
      'finance.category.read',
      'finance.category.create',
      'finance.variant.read',
      'finance.variant.create',
      // Phase 2 catalog v2 wave 3b (W79) — bundles
      'finance.bundle.read',
      'finance.bundle.create',
      'finance.bundle_item.read',
      'finance.bundle_item.create',
      'finance.vendor.read',
      'finance.vendor.create',
      'finance.vendor.update',
      'finance.purchase.read',
      'finance.purchase.create',
      'finance.purchase.confirm',
      'finance.purchase.receive',
      'finance.purchase.cancel',
      'finance.bill.void',
      // Phase 2 catalog v2 wave 3d (f7fba19) — pricing
      // rules. Read is the common case; create is the
      // 'define a new discount' path (medium-sensitivity).
      'finance.pricing_rule.read',
      'finance.pricing_rule.create',
    ]),
  },
  FinancePeriodAdmin: {
    id: 'FinancePeriodAdmin',
    label: 'Finance Period Admin',
    description: 'Lock/unlock accounting periods and close fiscal year.',
    isSystem: true,
    permissions: Object.freeze([
      'finance.period.lock',
      'finance.period.unlock',
      'finance.year_end.close',
    ]),
  },
  TaxFiler: {
    id: 'TaxFiler',
    label: 'Tax Filer',
    description: 'Permission to file the VAT return with the tax authority.',
    isSystem: true,
    permissions: Object.freeze([
      'finance.vat_return.file',
      'finance.tax.update',
      'reports.tax.read',
      'reports.tax.export',
    ]),
  },

  // ─────────── CRM sets ───────────
  CRMOperator: {
    id: 'CRMOperator',
    label: 'CRM Operator',
    description: 'Leads, deals, accounts, contacts, activities, pipeline.',
    isSystem: true,
    permissions: Object.freeze([
      'crm.lead.read',
      'crm.lead.create',
      'crm.lead.update',
      'crm.lead.delete',
      'crm.lead.assign',
      'crm.lead.import',
      'crm.lead.export',
      'crm.account.read',
      'crm.account.create',
      'crm.account.update',
      'crm.account.delete',
      'crm.account.merge',
      'crm.contact.read',
      'crm.contact.create',
      'crm.contact.update',
      'crm.contact.delete',
      'crm.deal.read',
      'crm.deal.update',
      'crm.deal.delete',
      'finance.customer.create',
      'finance.customer.update',
      'finance.customer.merge',
      'finance.reports.execute',
      'finance.customer.read',
      'crm.deal.assign',
      'crm.deal.export',
      'crm.quote.read',
      'crm.quote.create',
      'crm.quote.update',
      'crm.quote.delete',
      'crm.quote.accept',
      'crm.activity.read',
      'crm.activity.create',
      'crm.activity.update',
      'crm.activity.delete',
      'crm.pipeline.read',
      'crm.pipeline.update',
      'crm.customer_360.read',
      'sales.order.read',
      'sales.order.create',
      'sales.order.update',
    ]),
  },

  // ─────────── Inventory sets ───────────
  InventoryOperator: {
    id: 'InventoryOperator',
    label: 'Inventory Operator',
    description: 'Stock, products, warehouses, lots.',
    isSystem: true,
    permissions: Object.freeze([
      'inv.product.read',
      'inv.product.create',
      'inv.product.update',
      'inv.product.import',
      'inv.product.export',
      'inv.warehouse.read',
      'inv.stock.read',
      'inv.stock.receive',
      'inv.stock.deliver',
      'inv.stock.transfer',
      'inv.stock.adjust',
      'inv.stock.scrap',
      'inv.stock.count',
      'inv.valuation.read',
      'inv.lot.read',
      'inv.lot.update',
    ]),
  },
  InventoryAdmin: {
    id: 'InventoryAdmin',
    label: 'Inventory Admin',
    description: 'Manage warehouses and run valuation.',
    isSystem: true,
    permissions: Object.freeze(['inv.product.delete', 'inv.warehouse.update', 'inv.valuation.run']),
  },

  // ─────────── Catalog v2 sets (Phase 2 W76/W77/W78/W79) ───────────
  // Catalog v2 adds hierarchical categories + per-item
  // variants + compound bundles on top of the existing
  // flat catalog (Wave 7). The 8 new perm keys
  // (finance.category.read/create + finance.variant.read/create
  // + finance.bundle.read/create + finance.bundle_item.read/create)
  // are bundled here. The existing InventoryOperator set
  // keeps the flat catalog (finance.product.*) and
  // inventory (inv.*) keys.
  CatalogOperator: {
    id: 'CatalogOperator',
    label: 'Catalog Operator',
    description: 'Categories (hierarchical), variants (per-item attributes), bundles (compound items).',
    isSystem: true,
    permissions: Object.freeze([
      'finance.category.read',
      'finance.category.create',
      'finance.variant.read',
      'finance.variant.create',
      // Phase 2 catalog v2 wave 3b (W79-1) — bundles
      'finance.bundle.read',
      'finance.bundle.create',
      'finance.bundle_item.read',
      'finance.bundle_item.create',
    ]),
  },

  // ─────────── Purchase sets ───────────
  //
  // The 8 perms the Wave 7 narrow-grant worker split out (purchase.vendor.read,
  // purchase.vendor.create, purchase.po.read, purchase.po.create,
  // purchase.po.update, purchase.receipt.create, purchase.return.create,
  // purchase.analytics.read) are intentionally NOT in PurchaseOperator. They
  // live in dedicated narrow perm sets (PurchaseVendorReader, PurchaseOrderReader,
  // PurchaseAnalyticsReader, PurchaseVendorWriter, PurchaseOrderWriter,
  // PurchaseReceiptWriter, PurchaseReturnWriter) granted only to the roles
  // the legacy requirePurchaseReader / requirePurchaseWriter helpers allowed
  // (Owner, Admin, Operator, Accountant, Auditor for the read perms;
  // Owner, Admin, Operator, Accountant for the write perms). Without this
  // split the PurchaseOperator grant would silently widen access beyond
  // the legacy allow-list for the 8 purchase routes flagged in
  // .orchestration/sbos-a1-erp-wave7/wave7-plan.md. The rest of the
  // PurchaseOperator grants (rfq.*, po.send, po.cancel, receipt.read,
  // pricelist.*, vendor.update, vendor_360.read) are non-broad and stay
  // here so FinanceLead / PurchaseLead / InventoryLead / Purchaser can
  // still run their day-to-day purchase operations.
  PurchaseOperator: {
    id: 'PurchaseOperator',
    label: 'Purchase Operator',
    description:
      'RFQs, POs, receipts, returns, vendor master. The 8 perm keys the Wave 7 narrow-grant worker split out (vendor/po read+create+update+receipt+return+analytics) live in dedicated narrow perm sets so the catalog can mirror the legacy requirePurchaseReader / requirePurchaseWriter allow-lists exactly.',
    isSystem: true,
    permissions: Object.freeze([
      'purchase.vendor.update',
      'purchase.vendor_360.read',
      'purchase.rfq.read',
      'purchase.rfq.create',
      'purchase.rfq.update',
      'purchase.rfq.delete',
      'purchase.rfq.send',
      'purchase.po.send',
      'purchase.po.cancel',
      'purchase.receipt.read',
      'purchase.pricelist.read',
    ]),
  },
  PurchaseAdmin: {
    id: 'PurchaseAdmin',
    label: 'Purchase Admin',
    description: 'Vendor master hard-delete and pricelist management.',
    isSystem: true,
    permissions: Object.freeze(['purchase.vendor.delete', 'purchase.pricelist.update']),
  },

  // ─────────── POS sets ───────────
  POSOperator: {
    id: 'POSOperator',
    label: 'POS Operator',
    description: 'Operate the register, record sales, manage cash drawer.',
    isSystem: true,
    permissions: Object.freeze([
      'pos.session.open',
      'pos.sale.create',
      'pos.cash.read',
      'pos.cash.manage',
      'pos.zreport.read',
      'pos.fiscal.hdm',
    ]),
  },
  POSSupervisor: {
    id: 'POSSupervisor',
    label: 'POS Supervisor',
    description: 'Close sessions, void sales, issue refunds.',
    isSystem: true,
    permissions: Object.freeze(['pos.session.close', 'pos.sale.void', 'pos.refund.create']),
  },

  // ─────────── HR sets ───────────
  //
  // hr.employee.create is intentionally NOT in HROperator — the legacy
  // requirePeopleWriter helper only allows Owner, Admin, Accountant, so it
  // lives in its own dedicated perm set (PeopleWriter) that mirrors the
  // legacy allow-list exactly. The rest of the HROperator grants stay
  // here so HRLead / HRSpecialist / PayrollClerk can still read/update
  // employee records and run HR processes.
  HROperator: {
    id: 'HROperator',
    label: 'HR Operator',
    description: 'Employee master, contracts, attendance, leave.',
    isSystem: true,
    permissions: Object.freeze([
      'hr.employee.read',
      'hr.employee.update',
      'hr.contract.read',
      'hr.contract.create',
      'hr.contract.update',
      'hr.attendance.read',
      'hr.attendance.update',
      'hr.leave.read',
      'hr.leave.request',
      'hr.recruitment.read',
      'hr.recruitment.update',
      'hr.performance.read',
      'hr.performance.update',
      'hr.fleet.read',
      'hr.fleet.update',
    ]),
  },
  PayrollOperator: {
    id: 'PayrollOperator',
    label: 'Payroll Operator',
    description: 'Run and post payroll.',
    isSystem: true,
    permissions: Object.freeze(['hr.payroll.read', 'hr.payroll.run', 'hr.payroll.post']),
  },

  // ─────────── Projects sets ───────────
  ProjectsOperator: {
    id: 'ProjectsOperator',
    label: 'Projects Operator',
    description: 'Projects, tasks, time, billing.',
    isSystem: true,
    permissions: Object.freeze([
      'projects.project.read',
      'projects.project.create',
      'projects.project.update',
      'projects.project.delete',
      'projects.task.read',
      'projects.task.create',
      'projects.task.update',
      'projects.task.delete',
      'projects.task.assign',
      'projects.time.read',
      'projects.time.create',
      'projects.time.update',
      'projects.billing.read',
      'projects.billing.update',
      'projects.profitability.read',
    ]),
  },

  // ─────────── Helpdesk sets ───────────
  DeskOperator: {
    id: 'DeskOperator',
    label: 'Helpdesk Operator',
    description: 'Service cases, replies, knowledge, SLAs.',
    isSystem: true,
    permissions: Object.freeze([
      'desk.case.read',
      'desk.case.create',
      'desk.case.update',
      'desk.case.delete',
      'desk.case.assign',
      'desk.case.escalate',
      'desk.case.resolve',
      'desk.case.close',
      'desk.reply.create',
      'desk.reply.read',
      'desk.knowledge.read',
      'desk.sla.read',
      'desk.field_service.read',
    ]),
  },
  DeskAdmin: {
    id: 'DeskAdmin',
    label: 'Helpdesk Admin',
    description: 'Knowledge base and SLA configuration, field service dispatch.',
    isSystem: true,
    permissions: Object.freeze([
      'desk.knowledge.update',
      'desk.sla.update',
      'desk.field_service.update',
    ]),
  },

  // ─────────── Docs sets ───────────
  DocsOperator: {
    id: 'DocsOperator',
    label: 'Docs Operator',
    description: 'Document lifecycle, signatures, evidence.',
    isSystem: true,
    permissions: Object.freeze([
      'docs.document.read',
      'docs.document.create',
      'docs.document.update',
      'docs.document.export',
      'docs.template.read',
      'docs.signature.request',
      'docs.signature.sign',
      'docs.signature.decline',
      'docs.evidence.read',
      'docs.cabinet.read',
      'docs.request.read',
    ]),
  },
  DocsAdmin: {
    id: 'DocsAdmin',
    label: 'Docs Admin',
    description: 'Templates, cabinet, requested docs, signature override.',
    isSystem: true,
    permissions: Object.freeze([
      'docs.template.update',
      'docs.cabinet.update',
      'docs.request.update',
      'docs.document.delete',
      'docs.signature.override',
      'docs.evidence.export',
    ]),
  },

  // ─────────── Portal / External ───────────
  PortalCustomer: {
    id: 'PortalCustomer',
    label: 'Portal Customer',
    description: 'External customer with portal access.',
    isSystem: true,
    permissions: Object.freeze([
      'portal.storefront.read',
      'portal.cart.create',
      'portal.order.read',
      'portal.order.create',
      'portal.invoice.read',
      'portal.payment.make',
      'portal.ticket.create',
      'portal.document.read',
    ]),
  },
  // ─────────── Portal / External ───────────
  //
  // purchase.po.read is intentionally NOT in PortalVendor — the legacy
  // requirePurchaseReader helper (used by GET /api/purchase/orders) only
  // allows Owner, Admin, Operator, Accountant, Auditor, so it lives in
  // its own dedicated perm set (PurchaseOrderReader) that mirrors the
  // legacy allow-list exactly. The rest of the PortalVendor grants
  // (purchase.rfq.read) stay here so external vendors can still browse
  // their RFQs in the portal.
  PortalVendor: {
    id: 'PortalVendor',
    label: 'Portal Vendor',
    description:
      'External vendor with portal access. The purchase.po.read perm the Wave 7 narrow-grant worker split out lives in the dedicated PurchaseOrderReader perm set so the catalog can mirror the legacy requirePurchaseReader allow-list exactly.',
    isSystem: true,
    permissions: Object.freeze(['purchase.rfq.read']),
  },

  // ─────────── Marketing sets ───────────
  MarketingOperator: {
    id: 'MarketingOperator',
    label: 'Marketing Operator',
    description: 'Campaigns, segments, templates, consent.',
    isSystem: true,
    permissions: Object.freeze([
      'mrkt.campaign.read',
      'mrkt.campaign.create',
      'mrkt.campaign.update',
      'mrkt.campaign.delete',
      'mrkt.campaign.send',
      'mrkt.campaign.pause',
      'mrkt.campaign.duplicate',
      'mrkt.campaign.export',
      'mrkt.segment.read',
      'mrkt.segment.update',
      'mrkt.segment.preview',
      'mrkt.template.read',
      'mrkt.template.update',
      'mrkt.consent.read',
      'mrkt.consent.update',
      'mrkt.unsubscribe.read',
      'mrkt.unsubscribe.manage',
      'mrkt.landing.read',
      'mrkt.landing.update',
      'mrkt.form.read',
      'mrkt.form.update',
    ]),
  },
  MarketingAutomation: {
    id: 'MarketingAutomation',
    label: 'Marketing Automation',
    description: 'Journeys, subscriptions, lead scoring, A/B tests, marketing webhooks.',
    isSystem: true,
    permissions: Object.freeze([
      'mrkt.journey.read',
      'mrkt.journey.update',
      'mrkt.journey.publish',
      'mrkt.subscription.read',
      'mrkt.subscription.update',
      'mrkt.lead_score.read',
      'mrkt.lead_score.update',
      'mrkt.abtest.read',
      'mrkt.abtest.update',
      'mrkt.webhook.read',
      'mrkt.webhook.update',
    ]),
  },

  // ─────────── Manufacturing sets ───────────
  ManufacturingOperator: {
    id: 'ManufacturingOperator',
    label: 'Manufacturing Operator',
    description: 'BoM, work orders, work centers, quality, repairs.',
    isSystem: true,
    permissions: Object.freeze([
      'mfg.bom.read',
      'mfg.bom.update',
      'mfg.routing.read',
      'mfg.work_order.read',
      'mfg.work_order.create',
      'mfg.work_order.update',
      'mfg.work_order.release',
      'mfg.work_order.complete',
      'mfg.work_center.read',
      'mfg.work_center.update',
      'mfg.quality.read',
      'mfg.quality.update',
      'mfg.repair.read',
      'mfg.repair.update',
      'mfg.mps.read',
      'mfg.costing.read',
    ]),
  },
  ManufacturingAdmin: {
    id: 'ManufacturingAdmin',
    label: 'Manufacturing Admin',
    description:
      'Destructive manufacturing actions: BoM delete/version, work order cancel, MRP, MPS, costing rollup, repair complete.',
    isSystem: true,
    permissions: Object.freeze([
      'mfg.bom.delete',
      'mfg.bom.version',
      'mfg.routing.update',
      'mfg.work_order.cancel',
      'mfg.mps.update',
      'mfg.mrp.run',
      'mfg.costing.update',
      'mfg.repair.complete',
    ]),
  },
  QualityHoldAdmin: {
    id: 'QualityHoldAdmin',
    label: 'Quality Hold Admin',
    description: 'Place lots on hold and release them (critical, dual-control).',
    isSystem: true,
    permissions: Object.freeze(['mfg.quality.hold', 'mfg.quality.release']),
  },

  // ─────────── Compliance sets ───────────
  ComplianceOperator: {
    id: 'ComplianceOperator',
    label: 'Compliance Operator',
    description:
      'Policies, consent, retention, legal sources, GDPR/PDPA. Read + high-sensitivity mutations only (no breach/SOX/retention-purge).',
    isSystem: true,
    permissions: Object.freeze([
      'compliance.policy.read',
      'compliance.policy.update',
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
      'compliance.consent.read',
      'compliance.consent.update',
      'compliance.retention.read',
      'compliance.legal.read',
      'compliance.legal.update',
      'compliance.gdpr.read',
      'compliance.gdpr.fulfill',
      'compliance.breach.read',
      'compliance.sox.read',
    ]),
  },
  ComplianceAdmin: {
    id: 'ComplianceAdmin',
    label: 'Compliance Admin',
    description:
      'Destructive compliance ops: breach register update, retention purge, SOX control updates. Granted only to ComplianceOfficer + Owner, NOT to Auditor.',
    isSystem: true,
    permissions: Object.freeze([
      'compliance.retention.update',
      'compliance.retention.run',
      'compliance.breach.update',
      'compliance.sox.update',
    ]),
  },
  RetentionAdmin: {
    id: 'RetentionAdmin',
    label: 'Retention Admin',
    description: 'Update data retention rules.',
    isSystem: true,
    permissions: Object.freeze(['compliance.retention.update']),
  },
  RetentionOperator: {
    id: 'RetentionOperator',
    label: 'Retention Operator',
    description: 'Run retention purges (Owner-approval gated).',
    isSystem: true,
    permissions: Object.freeze(['compliance.retention.run']),
  },
  // AuditOperator keeps only the "prepare" perm (compliance.audit.prepare)
  // which has no broad-grant audit findings. The audit/security/integration
  // perms (security.audit.read, security.audit.export, security.access.review,
  // security.session.list, security.session.revoke, system.integrations.read)
  // live in their own dedicated perm sets so the catalog can mirror each
  // legacy requireXxx allow-list exactly. Without this split, AuditOperator
  // would grant compliance.audit.prepare to roles that the legacy
  // requireAuditReader/requireSessionAdmin/requireAccessReviewer
  // /requireIntegrationReader helpers explicitly deny.
  AuditOperator: {
    id: 'AuditOperator',
    label: 'Audit Operator',
    description:
      'Prepare audit packets; deliver via AuditDeliver. Read/export/list/revoke are split into dedicated perm sets so the catalog can mirror the legacy allow-lists exactly.',
    isSystem: true,
    permissions: Object.freeze(['compliance.audit.prepare']),
  },
  AuditDeliver: {
    id: 'AuditDeliver',
    label: 'Audit Deliver',
    description: 'Permission to deliver an audit packet externally (Owner-level).',
    isSystem: true,
    permissions: Object.freeze(['compliance.audit.deliver']),
  },

  // ─────────── Studio / Builder sets ───────────
  StudioBuilder: {
    id: 'StudioBuilder',
    label: 'Studio Builder',
    description: 'Custom fields, workflows, approvals, webhooks, layouts.',
    isSystem: true,
    permissions: Object.freeze([
      'studio.custom_field.read',
      'studio.custom_field.update',
      'studio.workflow.read',
      'studio.workflow.update',
      'studio.workflow.run',
      'studio.approval.read',
      'studio.approval.update',
      'studio.webhook.read',
      'studio.webhook.update',
      'studio.layout.read',
      'studio.layout.update',
    ]),
  },
  ReportBuilder: {
    id: 'ReportBuilder',
    label: 'Report Builder',
    description: 'Dashboards, reports, spreadsheet builder.',
    isSystem: true,
    permissions: Object.freeze([
      'reports.dashboard.read',
      'reports.dashboard.update',
      'reports.builder.read',
      'reports.builder.update',
      'reports.spreadsheet.read',
      'reports.spreadsheet.update',
    ]),
  },

  // ─────────── System admin sets ───────────
  //
  // system.integrations.read is intentionally NOT in SystemAdmin — the
  // legacy requireIntegrationReader helper (used by
  // GET /api/integrations/connectors) only allows Owner, Admin, Auditor,
  // so the perm lives in the dedicated IntegrationsReader set. The
  // system.integrations.update perm stays here because SystemAdmin is
  // Owner-only and requireIntegrationWriter matches that exactly.
  SystemAdmin: {
    id: 'SystemAdmin',
    label: 'System Admin',
    description:
      'Full system control except the most destructive Owner-only operations (tenant create/delete, system restore). Owner gets those via the implicit-all shortcut.',
    isSystem: true,
    permissions: Object.freeze([
      'system.org.read',
      'system.org.update',
      'system.tenant.read',
      'system.tenant.list',
      'system.tenant.update',
      'system.tenant.plan.read',
      'system.tenant.plan.update',
      'system.tenant.billing.read',
      'system.tenant.billing.update',
      'system.tenant.domain.read',
      'system.tenant.domain.update',
      'system.tenant.sso.read',
      'system.tenant.sso.update',
      'system.tenant.isolation.read',
      'system.tenant.region.update',
      'system.settings.read',
      'system.settings.update',
      'system.integrations.update',
      'system.backup.read',
      'system.backup.run',
    ]),
  },
  TenantAdmin: {
    id: 'TenantAdmin',
    label: 'Tenant Admin',
    description:
      'Owner-level tenant lifecycle: create, suspend, reactivate, delete, transfer, isolation policy. Composes on top of SystemAdmin.',
    isSystem: true,
    permissions: Object.freeze([
      'system.tenant.create',
      'system.tenant.suspend',
      'system.tenant.reactivate',
      'system.tenant.delete',
      'system.tenant.transfer',
      'system.tenant.isolation.update',
    ]),
  },
  TenantSupport: {
    id: 'TenantSupport',
    label: 'Tenant Support',
    description: 'Read-only tenant visibility for customer support staff. No mutations.',
    isSystem: true,
    permissions: Object.freeze([
      'system.tenant.read',
      'system.tenant.list',
      'system.tenant.plan.read',
      'system.tenant.billing.read',
      'system.tenant.domain.read',
      'system.tenant.sso.read',
      'system.tenant.isolation.read',
    ]),
  },
  // UserAdmin keeps user/role/profile management perms. The session
  // perms (security.session.list, security.session.revoke) live in
  // dedicated perm sets (SessionReader, SessionAdmin) so the catalog
  // mirrors the legacy requireSessionReviewer / requireSessionAdmin
  // allow-lists exactly.
  UserAdmin: {
    id: 'UserAdmin',
    label: 'User Admin',
    description: 'User CRUD, role/permission set/profile assignment, MFA, API keys.',
    isSystem: true,
    permissions: Object.freeze([
      'security.user.list',
      'security.user.read',
      'security.user.create',
      'security.user.update',
      'security.user.deactivate',
      'security.user.delete',
      'security.user.reset_password',
      'security.user.impersonate',
      'security.role.read',
      'security.role.create',
      'security.role.update',
      'security.role.delete',
      'security.role.assign',
      'security.permission_set.read',
      'security.permission_set.update',
      'security.profile.read',
      'security.profile.create',
      'security.profile.update',
      'security.profile.delete',
      'security.profile.assign',
      'security.mfa.configure',
      'security.mfa.reset',
      'security.api_key.read',
      'security.api_key.create',
      'security.api_key.revoke',
    ]),
  },
  // SecurityAdmin keeps only user-read perms. The session and audit
  // perms (security.session.list, security.session.revoke,
  // security.audit.read, security.access.review) live in dedicated
  // perm sets (SessionReader, SessionAdmin, AuditReader, AccessReviewer)
  // so the catalog mirrors the legacy allow-lists exactly.
  SecurityAdmin: {
    id: 'SecurityAdmin',
    label: 'Security Admin',
    description:
      'Read-only user lookups for incident triage. Session/audit perms live in dedicated sets. Approval queue access is in here because approvals are a security-domain concern (dual-control workflow for sensitive actions).',
    isSystem: true,
    permissions: Object.freeze([
      'security.user.list',
      'security.user.read',
      'security.approval.read',
      'security.approval.request',
      'security.approval.decide',
    ]),
  },

  // ─────────── Read-only sets ───────────
  ReadOnly: {
    id: 'ReadOnly',
    label: 'Read Only',
    description: 'Read-only access to operational modules.',
    isSystem: true,
    permissions: Object.freeze([
      'crm.lead.read',
      'crm.account.read',
      'crm.contact.read',
      'crm.deal.read',
      'crm.quote.read',
      'crm.activity.read',
      'crm.pipeline.read',
      'crm.customer_360.read',
      'sales.order.read',
      'inv.product.read',
      'inv.warehouse.read',
      'inv.stock.read',
      'inv.lot.read',
      'inv.valuation.read',
      'purchase.vendor.read',
      'purchase.vendor_360.read',
      'purchase.rfq.read',
      'purchase.po.read',
      'purchase.receipt.read',
      'purchase.pricelist.read',
      'purchase.analytics.read',
      'finance.coa.read',
      'finance.journal.read',
      'finance.invoice.read',
      'finance.bill.read',
      'finance.payment.read',
      'finance.bank.read',
      'finance.tax.read',
      'finance.budget.read',
      'finance.vat_return.read',
      'finance.einvoice.read',
      'projects.project.read',
      'projects.task.read',
      'projects.time.read',
      'projects.billing.read',
      'projects.profitability.read',
      'desk.case.read',
      'desk.knowledge.read',
      'desk.sla.read',
      'docs.document.read',
      'docs.template.read',
      'docs.evidence.read',
      'docs.cabinet.read',
      'docs.request.read',
      'hr.employee.read',
      'hr.contract.read',
      'hr.attendance.read',
      'hr.leave.read',
      'hr.recruitment.read',
      'mrkt.campaign.read',
      'mrkt.segment.read',
      'mrkt.template.read',
      'mrkt.consent.read',
      'mrkt.unsubscribe.read',
      'mfg.bom.read',
      'mfg.work_order.read',
      'mfg.work_center.read',
      'mfg.quality.read',
      'mfg.repair.read',
      'reports.dashboard.read',
      'reports.financial.read',
      'reports.tax.read',
      'reports.operational.read',
      'reports.builder.read',
      'reports.spreadsheet.read',
    ]),
  },

  // ─────────── Wave 5 narrow grant sets ───────────
  //
  // These perm sets were added in Wave 5 (narrow-broad-grants) to
  // collapse the 11 BROAD GRANT findings flagged by
  // scripts/lint-rbac-broad-grants.js. Each set holds a single perm
  // (or a tiny tightly-coupled pair) and is granted only to the
  // roles the legacy `requireXxx` helper allowed. This way the
  // catalog-driven preHandler: requirePerm(...) migration can never
  // silently widen access beyond the original allow-list.
  //
  // The relationship to the legacy allow-lists is:
  //   PeopleWriter       → requirePeopleWriter      (Owner, Admin, Accountant)
  //   AccessReviewer     → requireAccessReviewer    (Owner, Admin, Auditor)
  //   SessionReader      → requireSessionReviewer   (Owner, Admin, Auditor)
  //   SessionAdmin       → requireSessionAdmin      (Owner, Admin)
  //   AuditReader        → requireAuditReader       (Owner, Admin, Auditor)
  //   AuditExportWriter  → requireAuditExportWriter (Owner, Admin)
  //   DealCreator        → requireCrmEditor         (Owner, Admin, Operator, SalesLead, SalesManager, SalesRep, ServiceManager)
  //   QuoteSender        → requireCollectionEditor  (Owner, Admin, Operator, SalesLead, SalesManager, SalesRep, ServiceManager, Accountant)
  //   JournalWriter      → requireFinanceOperator   (Owner, Admin, Accountant)
  //   IntegrationsReader → requireIntegrationReader (Owner, Admin, Auditor) — wired via the GET /api/integrations/connectors route
  //
  // Do not add extra perms or roles to these sets without re-running
  // scripts/lint-rbac-broad-grants.js and re-locking the snapshot.

  PeopleWriter: {
    id: 'PeopleWriter',
    label: 'People Writer',
    description:
      'Write employee master data. Narrow grant — only Owner, Admin, Accountant (mirrors the legacy requirePeopleWriter allow-list).',
    isSystem: true,
    permissions: Object.freeze(['hr.employee.create']),
  },

  AccessReviewer: {
    id: 'AccessReviewer',
    label: 'Access Reviewer',
    description:
      'Run access reviews. Narrow grant — only Owner, Admin, Auditor (mirrors the legacy requireAccessReviewer allow-list).',
    isSystem: true,
    permissions: Object.freeze(['security.access.review']),
  },

  SessionReader: {
    id: 'SessionReader',
    label: 'Session Reader',
    description:
      'List active sessions. Narrow grant — only Owner, Admin, Auditor (mirrors the legacy requireSessionReviewer allow-list).',
    isSystem: true,
    permissions: Object.freeze(['security.session.list']),
  },

  SessionAdmin: {
    id: 'SessionAdmin',
    label: 'Session Admin',
    description:
      'Revoke active sessions. Narrow grant — only Owner, Admin (mirrors the legacy requireSessionAdmin allow-list).',
    isSystem: true,
    permissions: Object.freeze(['security.session.revoke']),
  },

  AuditReader: {
    id: 'AuditReader',
    label: 'Audit Reader',
    description:
      'Read audit trail. Narrow grant — only Owner, Admin, Auditor (mirrors the legacy requireAuditReader / requireAuditExportReader allow-lists).',
    isSystem: true,
    permissions: Object.freeze(['security.audit.read']),
  },

  AuditExportWriter: {
    id: 'AuditExportWriter',
    label: 'Audit Export Writer',
    description:
      'Export the audit trail. Narrow grant — only Owner, Admin (mirrors the legacy requireAuditExportWriter allow-list).',
    isSystem: true,
    permissions: Object.freeze(['security.audit.export']),
  },

  AuditRetentionManager: {
    id: 'AuditRetentionManager',
    label: 'Audit Retention Manager',
    description:
      'Set the per-tenant audit-log retention window and trigger manual purges. Read of the current config shares security.audit.read. Narrow grant — only Owner, Admin.',
    isSystem: true,
    permissions: Object.freeze(['security.audit.retention.update']),
  },

  RateLimitManager: {
    id: 'RateLimitManager',
    label: 'Rate Limit Manager',
    description:
      'Override the global login rate limit for a specific tenant. Read of the effective limits is open to any caller with security.audit.read. Narrow grant — only Owner, Admin.',
    isSystem: true,
    permissions: Object.freeze(['security.rate_limit.update']),
  },

  DealCreator: {
    id: 'DealCreator',
    label: 'Deal Creator',
    description:
      'Create CRM deals. Narrow grant — sales + service roles (mirrors the legacy requireCrmEditor allow-list of Owner, Admin, Operator, Salesperson, Service Manager, where Salesperson now maps to SalesLead/SalesManager/SalesRep).',
    isSystem: true,
    permissions: Object.freeze(['crm.deal.create']),
  },

  SalesOrderDeleter: {
    id: 'SalesOrderDeleter',
    label: 'Sales Order Deleter',
    description:
      'Delete sales orders. Narrow grant — only Owner, Admin (mirrors the legacy requireCrmEditor allow-list for the destructive sales-order.delete perm).',
    isSystem: true,
    permissions: Object.freeze(['sales.order.delete']),
  },

  QuoteSender: {
    id: 'QuoteSender',
    label: 'Quote Sender',
    description:
      'Send CRM quotes to customers. Narrow grant — sales, service, and accountant roles (mirrors the legacy requireCollectionEditor allow-list of Owner, Admin, Operator, Salesperson, Service Manager, Accountant).',
    isSystem: true,
    permissions: Object.freeze(['crm.quote.send']),
  },

  JournalWriter: {
    id: 'JournalWriter',
    label: 'Journal Writer',
    description:
      'Create accounting journal entries. Narrow grant — only Owner, Admin, Accountant (mirrors the legacy requireFinanceOperator allow-list).',
    isSystem: true,
    permissions: Object.freeze(['finance.journal.create']),
  },

  IntegrationsReader: {
    id: 'IntegrationsReader',
    label: 'Integrations Reader',
    description:
      'View configured third-party integrations. Narrow grant — only Owner, Admin, Auditor (mirrors the legacy requireIntegrationReader allow-list used by GET /api/integrations/connectors).',
    isSystem: true,
    permissions: Object.freeze(['system.integrations.read']),
  },

  // ─────────── Wave 7 narrow grant sets ───────────
  //
  // These perm sets were added in Wave 7 to collapse the 21 BROAD GRANT
  // findings flagged by scripts/lint-rbac-broad-grants.js. The catalog +
  // inventory branch (narrow-catalog-permissions) added 4 sets
  // (CatalogReader, CatalogEditor, StockReader, StockReceiver) and the
  // purchase + finance branch (extract-purchase-narrow-sets) added 8
  // sets (PurchaseVendorReader/Writer, PurchaseOrderReader/Writer,
  // PurchaseAnalyticsReader, PurchaseReceiptWriter, PurchaseReturnWriter,
  // FinanceBillWriter). Each set holds a single perm (or a tightly-
  // coupled read/write pair) and is granted only to the roles the
  // plan's grant_to_roles list specifies. The legacy `requireXxx`
  // helpers continue to enforce the same allow-list at runtime, but
  // the catalog-driven preHandler: requirePerm(...) migration can now
  // mirror the allow-list exactly without silently widening access.
  //
  // Catalog/Inventory branch relationship to the legacy allow-lists:
  //   CatalogReader   → requireCatalogReader   (Owner, Admin, Accountant, Auditor, Operator, SalesLead, SalesManager, SalesRep, ServiceManager)
  //   CatalogEditor   → requireCatalogWriter   (Owner, Admin, Operator, SalesLead, SalesManager, SalesRep, ServiceManager)
  //   StockReader     → requireInventoryReader (Owner, Admin, Accountant, Auditor, Operator, FinanceLead, InventoryLead, PurchaseLead, Purchaser, WarehouseClerk)
  //   StockReceiver   → requireInventoryWriter (Owner, Admin, Accountant, Operator, InventoryLead, PurchaseLead, Purchaser, WarehouseClerk)
  //
  // Purchase/Finance branch relationship to the legacy allow-lists:
  //   PurchaseVendorReader    → requirePurchaseReader  (Owner, Admin, Operator, Accountant, Auditor) — GET /api/purchase/vendors
  //   PurchaseOrderReader     → requirePurchaseReader  (Owner, Admin, Operator, Accountant, Auditor) — GET /api/purchase/orders
  //   PurchaseAnalyticsReader → requirePurchaseReader  (Owner, Admin, Operator, Accountant, Auditor) — GET /api/purchase/analytics
  //   PurchaseVendorWriter    → requirePurchaseWriter  (Owner, Admin, Operator, Accountant)             — POST /api/purchase/vendors
  //   PurchaseOrderWriter     → requirePurchaseWriter  (Owner, Admin, Operator, Accountant)             — POST /api/purchase/orders, POST /api/purchase/orders/:id/confirm
  //   PurchaseReceiptWriter   → requirePurchaseWriter  (Owner, Admin, Operator, Accountant)             — POST /api/purchase/orders/:id/receive
  //   PurchaseReturnWriter    → requirePurchaseWriter  (Owner, Admin, Operator, Accountant)             — POST /api/purchase/orders/:id/return
  //   FinanceBillWriter       → requireFinanceOperator (Owner, Admin, Accountant)                      — POST /api/purchase/orders/:id/bill
  //
  // Do not add extra perms or roles to these sets without re-running
  // scripts/lint-rbac-broad-grants.js and re-locking the snapshot.

  // --- Wave 7 catalog/inventory branch ---
  CatalogReader: {
    id: 'CatalogReader',
    label: 'Catalog Reader',
    description:
      'Read catalog items, categories, price lists, margin rules. Narrow grant — Owner, Admin, Accountant, Auditor, Operator, SalesLead, SalesManager, SalesRep, ServiceManager (mirrors the legacy requireCatalogReader allow-list mapped to current role names).',
    isSystem: true,
    permissions: Object.freeze(['inv.product.read']),
  },

  CatalogEditor: {
    id: 'CatalogEditor',
    label: 'Catalog Editor',
    description:
      'Create and update catalog items. Narrow grant — Owner, Admin, Operator, SalesLead, SalesManager, SalesRep, ServiceManager (mirrors the legacy requireCatalogWriter allow-list mapped to current role names).',
    isSystem: true,
    permissions: Object.freeze(['inv.product.create', 'inv.product.update']),
  },

  StockReader: {
    id: 'StockReader',
    label: 'Stock Reader',
    description:
      'Read stock locations, quantities, and movements. Narrow grant — Owner, Admin, Accountant, Auditor, Operator, FinanceLead, InventoryLead, PurchaseLead, Purchaser, WarehouseClerk (mirrors the legacy requireInventoryReader allow-list plus the inventory/purchase functional leads).',
    isSystem: true,
    permissions: Object.freeze(['inv.stock.read']),
  },

  StockReceiver: {
    id: 'StockReceiver',
    label: 'Stock Receiver',
    description:
      'Receive stock movements (inbound, adjustments). Narrow grant — Owner, Admin, Accountant, Operator, InventoryLead, PurchaseLead, Purchaser, WarehouseClerk (mirrors the legacy requireInventoryWriter allow-list plus the inventory/purchase functional leads).',
    isSystem: true,
    permissions: Object.freeze(['inv.stock.receive']),
  },

  // --- Wave 7 purchase/finance branch ---
  PurchaseVendorReader: {
    id: 'PurchaseVendorReader',
    label: 'Purchase Vendor Reader',
    description:
      'Read vendor master data. Narrow grant — Owner, Admin, Operator, Accountant, Auditor (mirrors the legacy requirePurchaseReader allow-list used by GET /api/purchase/vendors).',
    isSystem: true,
    permissions: Object.freeze(['purchase.vendor.read']),
  },

  PurchaseOrderReader: {
    id: 'PurchaseOrderReader',
    label: 'Purchase Order Reader',
    description:
      'Read purchase orders. Narrow grant — Owner, Admin, Operator, Accountant, Auditor (mirrors the legacy requirePurchaseReader allow-list used by GET /api/purchase/orders).',
    isSystem: true,
    permissions: Object.freeze(['purchase.po.read']),
  },

  PurchaseAnalyticsReader: {
    id: 'PurchaseAnalyticsReader',
    label: 'Purchase Analytics Reader',
    description:
      'Read purchase analytics / KPIs. Narrow grant — Owner, Admin, Operator, Accountant, Auditor (mirrors the legacy requirePurchaseReader allow-list used by GET /api/purchase/analytics).',
    isSystem: true,
    permissions: Object.freeze(['purchase.analytics.read']),
  },

  PurchaseVendorWriter: {
    id: 'PurchaseVendorWriter',
    label: 'Purchase Vendor Writer',
    description:
      'Create vendor master records. Narrow grant — Owner, Admin, Operator, Accountant (mirrors the legacy requirePurchaseWriter allow-list used by POST /api/purchase/vendors).',
    isSystem: true,
    permissions: Object.freeze(['purchase.vendor.create']),
  },

  PurchaseOrderWriter: {
    id: 'PurchaseOrderWriter',
    label: 'Purchase Order Writer',
    description:
      'Create and update purchase orders. Narrow grant — Owner, Admin, Operator, Accountant (mirrors the legacy requirePurchaseWriter allow-list used by POST /api/purchase/orders and POST /api/purchase/orders/:id/confirm).',
    isSystem: true,
    permissions: Object.freeze(['purchase.po.create', 'purchase.po.update']),
  },

  PurchaseReceiptWriter: {
    id: 'PurchaseReceiptWriter',
    label: 'Purchase Receipt Writer',
    description:
      'Record purchase order receipts. Narrow grant — Owner, Admin, Operator, Accountant (mirrors the legacy requirePurchaseWriter allow-list used by POST /api/purchase/orders/:id/receive).',
    isSystem: true,
    permissions: Object.freeze(['purchase.receipt.create']),
  },

  PurchaseReturnWriter: {
    id: 'PurchaseReturnWriter',
    label: 'Purchase Return Writer',
    description:
      'Create purchase returns. Narrow grant — Owner, Admin, Operator, Accountant (mirrors the legacy requirePurchaseWriter allow-list used by POST /api/purchase/orders/:id/return).',
    isSystem: true,
    permissions: Object.freeze(['purchase.return.create']),
  },

  FinanceBillWriter: {
    id: 'FinanceBillWriter',
    label: 'Finance Bill Writer',
    description:
      'Create supplier bills. Narrow grant — Owner, Admin, Accountant (mirrors the legacy requireFinanceOperator allow-list used by POST /api/purchase/orders/:id/bill).',
    isSystem: true,
    permissions: Object.freeze(['finance.bill.create']),
  },
});

function listPermissionSetIds() {
  return Object.freeze(Object.keys(PERMISSION_SETS));
}

function getPermissionSet(id) {
  return PERMISSION_SETS[id] || null;
}

function isSystemPermissionSet(id) {
  const ps = PERMISSION_SETS[id];
  return Boolean(ps && ps.isSystem);
}

export {
  PERMISSION_SETS_VERSION,
  PERMISSION_SETS,
  listPermissionSetIds,
  getPermissionSet,
  isSystemPermissionSet,
};
