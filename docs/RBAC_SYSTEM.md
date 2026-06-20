<!-- Mirrored from A1-ERP-HY @ 50f5f44d632f8a3112ae5579060b768f0028c5da on 2026-06-16 -->

# A1 ERP-HY RBAC System

> Catalog-driven Role-Based Access Control for the A1 ERP-HY platform.
> Inspired by Salesforce role hierarchy + permission sets, NetSuite
> permission levels, and Odoo 19 inheritance groups.

---

## Table of Contents

1. [Goals & Non-Goals](#1-goals--non-goals)
2. [Core Concepts](#2-core-concepts)
3. [Hierarchy Model](#3-hierarchy-model)
4. [Permission Catalog](#4-permission-catalog)
5. [Permission Sets](#5-permission-sets)
6. [Roles](#6-roles)
7. [Sensitivity & MFA](#7-sensitivity--mfa)
8. [Field-Level Security](#8-field-level-security)
9. [Record-Level Security](#9-record-level-security)
10. [Session Policy & Impersonation](#10-session-policy--impersonation)
11. [API Reference](#11-api-reference)
12. [Custom Roles](#12-custom-roles)
13. [Migration From Ad-Hoc Checks](#13-migration-from-ad-hoc-checks)
14. [Comparison With Industry Systems](#14-comparison-with-industry-systems)
15. [Operational Runbook](#15-operational-runbook)

---

## 1. Goals & Non-Goals

### Goals

- **Single source of truth.** All gated actions map to a permission key in
  `server/rbac/permissions.js`. Route handlers never check role names
  directly — they call `hasPermission(user, "crm.deal.approve")`.
- **Catalog-driven, not hard-coded.** Permissions, roles, and permission
  sets are data structures in code, mirrored into the DB on boot. Admins
  can override per-tenant through the admin API.
- **Salesforce-style composition.** Each user has exactly one role (for
  org position / hierarchy) and zero or more permission sets (additive
  capabilities). Effective permissions are the union.
- **Defense in depth.** Field-level redaction + record-level scoping +
  sensitivity-aware step-up auth + dual-control for critical actions +
  per-action audit trail.
- **Multi-tenant safe.** Every row is scoped by `tenant_id`. System
  rows (id=0) are mirrored from the catalog; tenant rows override.
- **Immutable catalogs.** System permissions/roles/permission sets
  cannot be deleted or renamed through the admin API. They can only be
  supplemented with tenant-scoped permission set members.

### Non-Goals

- ABAC (attribute-based) policies. We deliberately keep policies simple
  — sensitivity, role hierarchy, and a small set of FLS/RLS overrides.
  ABAC can be layered later via the `studio.workflow` framework without
  touching this module.
- Per-resource policy DSLs. We do not expose a SQL editor; admins use
  the catalog + RLS_RULES.
- Cross-tenant role inheritance. Roles are tenant-local; system roles
  exist in every tenant as seeds.

---

## 2. Core Concepts

| Concept                   | What it is                                                                | Where it lives               |
| ------------------------- | ------------------------------------------------------------------------- | ---------------------------- |
| **Permission**            | A single gated action, e.g. `finance.invoice.create`                      | `server/rbac/permissions.js` |
| **Permission Set**        | A named bundle of permissions, e.g. `FinanceOperator`                     | `server/rbac/matrix.js`      |
| **Role**                  | An org-position in a hierarchy, e.g. `Accountant`                         | `server/rbac/roles.js`       |
| **Role Matrix**           | Which permission sets each role gets by default                           | `server/rbac/roleMatrix.js`  |
| **Profile**               | (Planned) A reusable bundle of role + permission sets for new users       | _Phase 0.3_                  |
| **Effective permissions** | The union of role-default PSs + direct PSs, computed per request          | `server/rbac/guards.js`      |
| **Sensitivity**           | `low` / `medium` / `high` / `critical` tag that drives MFA + dual-control | `permissions.js`             |
| **FLS rule**              | A field that is hidden unless the user holds a minimum permission         | `guards.js` FLS_RULES        |
| **RLS rule**              | A scope (own / team / org / custom) applied to a resource                 | `guards.js` RLS_RULES        |

### Mental model

```
┌──────────────┐         ┌────────────────────┐         ┌─────────────────┐
│  Permission  │   n:n   │  Permission Set    │   n:n   │      Role       │
│  (key)       │────────▶│  (e.g. FinanceOp)  │◀────────│  (e.g. Acctnt)  │
└──────────────┘         └────────────────────┘         └─────────────────┘
                                  ▲                              ▲
                                  │ 1 user has many PSs         │ 1 user has 1 role
                                  │                              │
                                  └────────────┬─────────────────┘
                                               ▼
                                       ┌──────────────┐
                                       │     User     │
                                       │  (id, role,  │
                                       │   perm_set_ids)│
                                       └──────────────┘
                                               │
                                       resolveEffectivePermissions(user)
                                               │
                                               ▼
                                       Set<permissionKey>
```

---

## 3. Hierarchy Model

A1-ERP-HY uses **single-inheritance role hierarchy** à la Salesforce:

```
Owner
└── Admin
    ├── FinanceLead
    │   └── Accountant
    │       ├── Bookkeeper
    │       └── PayrollClerk
    ├── SalesLead
    │   └── SalesManager
    │       └── SalesRep
    ├── PurchaseLead
    │   └── Purchaser
    ├── HRLead
    │   └── HRSpecialist
    ├── InventoryLead
    │   ├── WarehouseClerk
    │   └── POSCashier
    ├── ProjectLead
    │   ├── ProjectManager
    │   │   └── ProjectMember
    │   └── HelpdeskAgent
    ├── CopilotReviewer       (specialist)
    ├── ComplianceOfficer     (specialist)
    ├── Auditor               (specialist)
    └── Operator
        └── ServiceManager

CustomerPortal            (no parent, tenant-scoped only)
VendorPortal              (no parent, tenant-scoped only)
```

Inheritance rules:

- A role inherits the permission sets of its parent chain (transitively).
- A permission is **granted** if any ancestor in the chain grants it.
- There is **no deny** model. To restrict, use a more granular role.
- Top-of-tree (Owner) holds every permission by virtue of the
  `resolveEffectivePermissions` shortcut, but the audit log still
  records the grant path.

---

## 4. Permission Catalog

Permissions follow a strict shape:

```
<resource>.<action>[.<scope>]
```

- `resource`: the domain object (`finance.invoice`, `crm.deal`, …)
- `action`: one of `view | list | create | update | delete | approve |
export | import | share | assign | run | configure`
- `scope`: optional, e.g. `own`, `pii`, `fiscal`

Total: **315 permissions** across 18 categories (system, security,
finance, crm, inv, purchase, pos, hr, projects, desk, docs, portal,
mrkt, mfg, ai, reports, studio, compliance).

### Adding a new permission

1. Add the key to `PERMISSIONS` in `server/rbac/permissions.js` with its
   category, sensitivity, label, and description.
2. Reference it from a route via `requirePerm("crm.deal.approve")`.
3. Add the key to one or more permission sets in `matrix.js` so the
   role matrix can pick it up.
4. Bump `PERMISSIONS_VERSION` (only if the change is breaking — i.e.,
   you renamed or removed a key).

### Categories

| ID           | Label                   | Order |
| ------------ | ----------------------- | ----- |
| `system`     | System & Administration | 100   |
| `security`   | Security & Access       | 200   |
| `finance`    | Finance & Accounting    | 300   |
| `crm`        | CRM & Sales             | 400   |
| `inv`        | Inventory & Warehouse   | 500   |
| `purchase`   | Purchase & Procurement  | 600   |
| `pos`        | Point of Sale & Retail  | 700   |
| `hr`         | People & HR             | 800   |
| `projects`   | Projects & Time         | 900   |
| `desk`       | Helpdesk & Service      | 1000  |
| `docs`       | Documents & Sign        | 1100  |
| `portal`     | Customer Portal         | 1200  |
| `mrkt`       | Marketing & Campaigns   | 1300  |
| `mfg`        | Manufacturing & Quality | 1400  |
| `ai`         | AI & Copilot            | 1500  |
| `reports`    | Reports & Analytics     | 1600  |
| `studio`     | Studio & Automation     | 1700  |
| `compliance` | Compliance & Audit      | 1800  |

---

## 5. Permission Sets

A permission set is a named, reusable bundle of permissions. Examples:

| Set                     | Purpose                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `StandardUser`          | Default for any signed-in user (own profile, dashboards, time)                        |
| `Approver`              | Cross-functional approval capabilities (deals, quotes, POs, bills, payroll, time off) |
| `AIEnabled`             | Use Copilot and run agents within a governed scope                                    |
| `AIMutator`             | Let Copilot propose mutations (still requires human approver)                         |
| `AIPowerUser`           | AI Enabled + Mutator + Configure + Evaluation                                         |
| `SensitiveDataReader`   | Read sensitive PII / fiscal fields                                                    |
| `PIIEditor`             | Edit PII (requires MFA, dual-control)                                                 |
| `FinanceOperator`       | All finance read/write; AR/AP/Journal; no period admin                                |
| `FinancePeriodAdmin`    | Lock/unlock periods, year-end close                                                   |
| `TaxFiler`              | File VAT return with the tax authority                                                |
| `CRMOperator`           | Full CRM (leads, accounts, deals, quotes, activities)                                 |
| `InventoryOperator`     | Stock receive/deliver/transfer/adjust/scrap                                           |
| `InventoryAdmin`        | Warehouses, valuation, cycle counts                                                   |
| `PurchaseOperator`      | RFQ, PO, receipts, returns, vendors                                                   |
| `PurchaseAdmin`         | Pricelist, cancel PO, vendor delete                                                   |
| `POSOperator`           | Open/close session, sale, void, refund                                                |
| `POSSupervisor`         | Cash drawer, fiscalize, z-report                                                      |
| `HROperator`            | Employee records, attendance, leave, contracts                                        |
| `PayrollOperator`       | Run/approve/post payroll                                                              |
| `ProjectsOperator`      | Projects, tasks, time, billing                                                        |
| `DeskOperator`          | Service cases, replies, knowledge                                                     |
| `DeskAdmin`             | SLA, knowledge update, field service                                                  |
| `DocsOperator`          | Documents, templates, sign, evidence                                                  |
| `DocsAdmin`             | Cabinet, requests, evidence export                                                    |
| `PortalCustomer`        | Customer-facing portal only                                                           |
| `PortalVendor`          | Vendor-facing portal only                                                             |
| `MarketingOperator`     | Campaigns, segments, templates, consent                                               |
| `ManufacturingOperator` | BoM, work orders, quality, repair                                                     |
| `ComplianceOperator`    | Policies, consent, legal sources, retention, GDPR                                     |
| `RetentionAdmin`        | Manage retention rules (critical)                                                     |
| `AuditOperator`         | View audit events; export, prepare packets                                            |
| `AuditDeliver`          | Deliver audit packet externally (Owner only)                                          |
| `StudioBuilder`         | Custom fields, workflows, approvals, webhooks, layouts                                |
| `ReportBuilder`         | Dashboards, financial/operational/spreadsheet                                         |
| `SystemAdmin`           | Tenant, org, settings, integrations, backup                                           |
| `UserAdmin`             | Invite, update, deactivate, reset password                                            |
| `SecurityAdmin`         | Roles, PSs, profiles, MFA, API keys, sessions, audit                                  |
| `ReadOnly`              | Read-only across operational modules                                                  |

---

## 6. Roles

27 system roles seeded on every tenant. New users default to `SalesRep`
unless the inviter specifies otherwise (`DEFAULT_INVITED_ROLE`).

Each role declares:

```js
{
  id: 'Accountant',
  label: 'Accountant',
  description: 'Day-to-day accounting: …',
  parent: 'FinanceLead',
  isSystem: true,
  appSet: ['dashboard', 'finance', 'reports', 'crm', 'docs', ...],
  mfaRequired: true,
  sessionHardLimitMinutes: 120,
  canBeImpersonated: true,
}
```

| Field                     | Meaning                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `parent`                  | Single-inheritance parent. `null` for top-of-hierarchy.                                                                                      |
| `appSet`                  | Default app visibility in the sidebar. Effective app set = union up the parent chain.                                                        |
| `mfaRequired`             | When true, the user must verify an MFA factor in the current session to perform any `critical` action.                                       |
| `sessionHardLimitMinutes` | Hard timeout. The most restrictive limit in the parent chain wins.                                                                           |
| `canBeImpersonated`       | When false, only Owner can impersonate this role (e.g. Owner, Admin, HR Lead, Payroll Clerk, Compliance Officer, Auditor, Copilot Reviewer). |

### Default role matrix

| Role                | Default Permission Sets                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Owner`             | All 39 system sets (including `AuditDeliver`, `AIPowerUser`, `PIIEditor`)                                                                                                                                           |
| `Admin`             | All 39 except `AuditDeliver` + `AIPowerUser` → `AIMutator`, `AIEnabled`                                                                                                                                             |
| `FinanceLead`       | `FinanceOperator`, `FinancePeriodAdmin`, `TaxFiler`, `CRMOperator`, `InventoryOperator`, `PurchaseOperator`, `DocsOperator`, `ReportBuilder`, `AuditOperator`, `AIPowerUser`, `SensitiveDataReader`, `StandardUser` |
| `SalesLead`         | `CRMOperator`, `InventoryOperator`, `DeskOperator`, `DocsOperator`, `ReportBuilder`, `MarketingOperator`, `AIEnabled`, `StandardUser`                                                                               |
| `PurchaseLead`      | `PurchaseOperator`, `PurchaseAdmin`, `InventoryOperator`, `DocsOperator`, `ReportBuilder`, `FinanceOperator`, `AIEnabled`, `StandardUser`                                                                           |
| `HRLead`            | `HROperator`, `PayrollOperator`, `DocsOperator`, `ReportBuilder`, `ComplianceOperator`, `AIEnabled`, `PIIEditor`, `SensitiveDataReader`, `StandardUser`                                                             |
| `InventoryLead`     | `InventoryOperator`, `InventoryAdmin`, `PurchaseOperator`, `POSOperator`, `POSSupervisor`, `DocsOperator`, `ReportBuilder`, `AIEnabled`, `StandardUser`                                                             |
| `ProjectLead`       | `ProjectsOperator`, `DeskOperator`, `DeskAdmin`, `DocsOperator`, `ReportBuilder`, `AIEnabled`, `StandardUser`                                                                                                       |
| `Accountant`        | `FinanceOperator`, `CRMOperator`, `InventoryOperator`, `PurchaseOperator`, `DocsOperator`, `ReportBuilder`, `ComplianceOperator`, `AIEnabled`, `SensitiveDataReader`, `StandardUser`                                |
| `Bookkeeper`        | `FinanceOperator`, `CRMOperator`, `DocsOperator`, `StandardUser`                                                                                                                                                    |
| `SalesManager`      | `CRMOperator`, `InventoryOperator`, `DeskOperator`, `DocsOperator`, `ReportBuilder`, `MarketingOperator`, `AIEnabled`, `Approver`, `StandardUser`                                                                   |
| `SalesRep`          | `CRMOperator`, `InventoryOperator`, `DocsOperator`, `AIEnabled`, `StandardUser`                                                                                                                                     |
| `Purchaser`         | `PurchaseOperator`, `InventoryOperator`, `DocsOperator`, `ReportBuilder`, `AIEnabled`, `StandardUser`                                                                                                               |
| `WarehouseClerk`    | `InventoryOperator`, `DocsOperator`, `StandardUser`                                                                                                                                                                 |
| `HRSpecialist`      | `HROperator`, `DocsOperator`, `ComplianceOperator`, `AIEnabled`, `PIIEditor`, `StandardUser`                                                                                                                        |
| `PayrollClerk`      | `PayrollOperator`, `FinanceOperator`, `HROperator`, `DocsOperator`, `ReportBuilder`, `AIEnabled`, `SensitiveDataReader`, `StandardUser`                                                                             |
| `ProjectManager`    | `ProjectsOperator`, `DeskOperator`, `DeskAdmin`, `DocsOperator`, `ReportBuilder`, `AIEnabled`, `Approver`, `StandardUser`                                                                                           |
| `ProjectMember`     | `ProjectsOperator`, `DocsOperator`, `AIEnabled`, `StandardUser`                                                                                                                                                     |
| `HelpdeskAgent`     | `DeskOperator`, `CRMOperator`, `DocsOperator`, `AIEnabled`, `StandardUser`                                                                                                                                          |
| `POSCashier`        | `POSOperator`, `CRMOperator`, `DocsOperator`, `StandardUser`                                                                                                                                                        |
| `CopilotReviewer`   | `AIEnabled`, `AIMutator`, `ComplianceOperator`, `AuditOperator`, `ReportBuilder`, `StandardUser`                                                                                                                    |
| `ComplianceOfficer` | `ComplianceOperator`, `RetentionAdmin`, `AuditOperator`, `ReportBuilder`, `AIEnabled`, `PIIEditor`, `StandardUser`                                                                                                  |
| `Auditor`           | `ReadOnly`, `AuditOperator`, `AuditDeliver`, `ComplianceOperator`, `ReportBuilder`, `SensitiveDataReader`, `StandardUser`                                                                                           |
| `Operator`          | `CRMOperator`, `DeskOperator`, `DocsOperator`, `AIEnabled`, `StandardUser`                                                                                                                                          |
| `ServiceManager`    | `DeskOperator`, `DeskAdmin`, `CRMOperator`, `DocsOperator`, `ReportBuilder`, `AIEnabled`, `StandardUser`                                                                                                            |
| `CustomerPortal`    | `PortalCustomer`                                                                                                                                                                                                    |
| `VendorPortal`      | `PortalVendor`                                                                                                                                                                                                      |

---

## 7. Sensitivity & MFA

Each permission is tagged `low` / `medium` / `high` / `critical`.

| Tag        | MFA     | Dual control | Audit    |
| ---------- | ------- | ------------ | -------- |
| `low`      | no      | no           | standard |
| `medium`   | no      | no           | standard |
| `high`     | no      | no           | detailed |
| `critical` | **yes** | **yes**      | forensic |

When a user attempts a `critical` action and their role has
`mfaRequired = true`, the route returns `401 rbac_mfa_required` with the
permission key and sensitivity. The client should prompt for MFA and
retry.

Dual-control means the action must be approved by a second user with
the same permission. Approvals live in `rbac_approvals` (status:
`pending` → `approved` / `rejected` / `expired`).

---

## 8. Field-Level Security

Some fields are sensitive even if the resource is readable. Examples
defined in `guards.js` `FLS_RULES`:

| Field path                    | Min permission         | Label                  |
| ----------------------------- | ---------------------- | ---------------------- |
| `finance.bank.account_number` | `finance.bank.read`    | Bank account number    |
| `finance.bank.routing`        | `finance.bank.read`    | Bank routing code      |
| `hr.employee.ssn`             | `hr.employee.pii.read` | Employee SSN           |
| `hr.employee.bank_account`    | `hr.employee.pii.read` | Employee bank account  |
| `hr.employee.medical_notes`   | `hr.employee.pii.read` | Employee medical notes |
| `crm.account.tax_id`          | `crm.account.read`     | Customer tax ID        |
| `security.user.password_hash` | `security.user.read`   | Password hash          |
| `security.user.mfa_secret`    | `security.user.read`   | MFA secret             |

`redactFields(user, obj, paths)` strips the field if the user lacks
the min permission. Routes that return sensitive records should call
this before serialization.

```js
const safe = redactFields(request.user, account, [
  'crm.account.tax_id',
  'finance.bank.account_number',
]);
return safe;
```

---

## 9. Record-Level Security

`recordLevelClause(user, resource, opts)` returns a `{ clause, params }`
splice for SELECT queries.

| Scope    | SQL fragment                                      | Notes                                      |
| -------- | ------------------------------------------------- | ------------------------------------------ |
| `own`    | `owner_user_id = ?`                               | User's own records only                    |
| `team`   | `owner_user_id IN (SELECT … FROM team_members …)` | Records owned by user's team               |
| `org`    | `org_id = ?`                                      | All records in the user's org              |
| `custom` | Caller-supplied SQL                               | Audit-reviewed; only Owner/Admin can write |

Built-in `RLS_RULES` define the default scope per resource. Most
modules default to `org`; activities default to `own`; portal modules
are tenant-scoped; HR/finance are org-wide.

```js
const { clause, params } = recordLevelClause(user, 'crm.lead');
const sql = `SELECT * FROM crm_leads WHERE 1=1 ${clause ? 'AND ' + clause : ''}`;
db.prepare(sql).all(...params);
```

Owner and Admin always get an empty clause.

---

## 10. Session Policy & Impersonation

### Session policy

- `mfaRequiredFor(role)` walks the parent chain; if any ancestor has
  `mfaRequired = true`, the user must verify MFA in the current session.
- `sessionHardLimitMinutesFor(role)` returns the most restrictive
  (lowest) limit in the chain. Sessions older than this are revoked
  with `401 session_hard_limit`.
- `enforceSessionPolicy(user, session)` is the Fastify preHandler
  for endpoints that need both checks.

### Impersonation

`canImpersonate(actor, target)` returns `true` when:

- actor is `Owner` or `Admin`,
- target is not self,
- if target is `Owner`/`Admin`, actor is `Owner`,
- target role has `canBeImpersonated = true`.

All impersonation sessions are logged in `rbac_impersonation_log` with
start/end timestamps, the actor, the target, and the reason.

---

## 11. API Reference

All routes live under `/api/rbac/`. Every route requires the caller to
hold the relevant permission. Errors follow the standard A1 envelope:

```json
{ "error": "rbac_forbidden", "message": "...", "required": "finance.invoice.create" }
```

### Catalog

| Method | Path                            | Permission                     |
| ------ | ------------------------------- | ------------------------------ |
| GET    | `/api/rbac/permissions`         | `security.permission_set.read` |
| GET    | `/api/rbac/permissions/:key`    | `security.permission_set.read` |
| GET    | `/api/rbac/permission-sets`     | `security.permission_set.read` |
| GET    | `/api/rbac/permission-sets/:id` | `security.permission_set.read` |

### Roles

| Method | Path                  | Permission             |
| ------ | --------------------- | ---------------------- |
| GET    | `/api/rbac/roles`     | `security.role.read`   |
| POST   | `/api/rbac/roles`     | `security.role.create` |
| PATCH  | `/api/rbac/roles/:id` | `security.role.update` |
| DELETE | `/api/rbac/roles/:id` | `security.role.delete` |

### User management

| Method | Path                                          | Permission             |
| ------ | --------------------------------------------- | ---------------------- |
| GET    | `/api/rbac/users/:userId/effective`           | `security.user.read`   |
| POST   | `/api/rbac/users/:userId/permission-sets`     | `security.role.assign` |
| DELETE | `/api/rbac/users/:userId/permission-sets/:ps` | `security.role.assign` |
| POST   | `/api/rbac/users/:userId/role`                | `security.role.assign` |
| GET    | `/api/rbac/me/permissions`                    | (auth required)        |

### FLS / RLS overrides

| Method | Path                               | Permission                       |
| ------ | ---------------------------------- | -------------------------------- |
| GET    | `/api/rbac/field-policies`         | `security.permission_set.read`   |
| PUT    | `/api/rbac/field-policies/:path`   | `security.permission_set.update` |
| GET    | `/api/rbac/record-rules`           | `security.permission_set.read`   |
| PUT    | `/api/rbac/record-rules/:resource` | `security.permission_set.update` |

### Sessions & audit

| Method | Path                     | Permission                                          |
| ------ | ------------------------ | --------------------------------------------------- |
| GET    | `/api/rbac/sessions`     | `security.session.list`                             |
| DELETE | `/api/rbac/sessions/:id` | `security.session.revoke`                           |
| GET    | `/api/rbac/audit`        | `security.audit.read`                               |
| GET    | `/api/rbac/health`       | any of role.read / permission_set.read / audit.read |

### Examples

```bash
# Get my effective permissions
curl -H "Authorization: Bearer $TOKEN" https://app/api/rbac/me/permissions

# List roles
curl -H "Authorization: Bearer $TOKEN" https://app/api/rbac/roles

# Create a custom role
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"id":"JuniorAccountant","label":"Junior Accountant","parent":"Accountant",
       "appSet":["dashboard","finance"]}' \
  https://app/api/rbac/roles

# Grant Approver to a user
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"permissionSetId":"Approver"}' \
  https://app/api/rbac/users/42/permission-sets

# Restrict a CRM resource to "own" only
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"scope":"own","description":"Sales reps see only their own activities"}' \
  https://app/api/rbac/record-rules/crm.activity
```

---

## 12. Custom Roles

Tenant admins can create custom roles via `POST /api/rbac/roles`. The
role must declare a parent that is a known (system or custom) role.
Custom roles cannot have `parent = null` — they must hang off a system
role to keep the hierarchy tree-shaped.

`validateCustomRole` enforces:

- ID must start with a letter, use `[A-Za-z0-9_]`, ≤ 80 chars.
- ID must be unique across system and custom.
- `parent` must reference a known role.
- `appSet` is an array of strings ≤ 40 chars each.
- `mfaRequired` defaults to `false`.
- `sessionHardLimitMinutes` clamps to `[30, 1440]`, default 240.
- `canBeImpersonated` defaults to `true`.

Custom roles are stored with `is_system = 0` and can be deleted only
when no user holds them (`DELETE /api/rbac/roles/:id` returns
`409 role_in_use` otherwise).

---

## 13. Migration From Ad-Hoc Checks

A1-Suite-Local contains ad-hoc role checks in `server/app.js`. Mapping:

| Old check                     | New check                                                             |
| ----------------------------- | --------------------------------------------------------------------- |
| `requireOwner(req)`           | `requirePerm("security.user.update")` + role check at the route level |
| `requireFinanceOperator(req)` | `requirePerm("finance.invoice.create")` (or whichever action)         |
| `requireAccountant(req)`      | `requirePerm("finance.journal.post")`                                 |
| `requirePayrollClerk(req)`    | `requirePerm("hr.payroll.run")`                                       |
| `if (user.role === 'Admin')`  | `if (hasPermission(user, "system.org.update"))`                       |

Search-and-replace recipe:

```bash
# Find every hard-coded role comparison
grep -nE "user\\.role\\s*===?\\s*['\"]" server/app.js
# Replace with permission checks against the appropriate key from
# server/rbac/permissions.js.
```

The goal is **zero hard-coded role strings outside `server/rbac/roles.js`**.

---

## 14. Comparison With Industry Systems

| Feature                | A1-ERP-HY                   | Salesforce             | NetSuite           | Odoo 19                  |
| ---------------------- | --------------------------- | ---------------------- | ------------------ | ------------------------ |
| Role hierarchy         | Single-inheritance          | Single-inheritance     | Tree               | Multi-inheritance groups |
| Permission sets        | Yes (additive)              | Yes (additive)         | Permission levels  | Inherited groups         |
| Profiles               | Planned                     | Yes                    | n/a                | n/a                      |
| Field-level security   | Catalog + overrides         | Yes                    | Custom fields      | `groups=` attribute      |
| Record-level security  | Scope (own/team/org/custom) | Sharing rules          | Role-based filters | Record rules             |
| Sensitivity-driven MFA | Yes (critical)              | Yes (high)             | Yes                | n/a                      |
| Dual control           | Yes (critical)              | Approval processes     | Approval routing   | Approvals module         |
| Audit log              | Per-action + global         | Field-history + events | System notes       | mail.thread              |
| Custom roles           | Yes, parent-required        | Yes                    | Yes                | Groups                   |
| Impersonation policy   | Catalog-driven              | Delegated Admin        | n/a                | Super-user flag          |
| Multi-tenant scoping   | `tenant_id` on every row    | OrgId                  | Subsidiary         | Company                  |

---

## 15. Operational Runbook

### Rotate an exposed API key

1. `DELETE /api/rbac/sessions?userId=<u>` to revoke all of the user's
   sessions (key leaked through one of them?).
2. `POST /api/rbac/users/<u>/role` to set a temporary restrictive role.
3. Investigate. Once clean, restore the role.

### Break-glass admin access

If the Owner is locked out:

1. An Owner-equivalent DBA connects to the SQLite DB.
2. `UPDATE rbac_user_roles SET role_id='Owner' WHERE user_id = <recovery-user>;`
3. `UPDATE users SET role='Owner' WHERE id = <recovery-user>;`
4. The recovery user logs in; they are Owner.
5. All such mutations are captured in the change log; review the
   `rbac_audit` table the next business day.

### Quarterly access review

1. `GET /api/rbac/users/<u>/effective` for each user in a department.
2. Cross-check their role and direct permission sets against the
   business need.
3. Revoke direct PS grants that are no longer needed.
4. Archive the report (PDF) under `compliance/access-reviews/YYYY-Qn/`.

### Audit log retention

`rbac_permission_audit` rows are kept for 365 days by default. The
cleanup job in `server/jobs/audit-retention.js` (planned) deletes rows
older than the retention window nightly.

---

_This document is the canonical reference for the RBAC system. Any
change to permissions, roles, or permission sets must update both the
catalog source and this document._

## Provenance

- **Source path:** `/Users/samvelstepanyan/dev/A1-ERP-HY/docs/RBAC_SYSTEM.md`
- **Source commit SHA:** `50f5f44d632f8a3112ae5579060b768f0028c5da`
- **Source blob SHA1:** `a4cc1dd8687870d43eb5f5188cd8a18998e682f6`
- **Mirror date:** 2026-06-16
- **Worktree:** `/Users/samvelstepanyan/dev/SBOS-A1-ERP/.claude/worktrees/seed-from-a1-erp-hy`
- **Bytes (mirrored body, pre-provenance):** 25963
