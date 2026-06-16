# SBOS-A1-ERP vs. A1-ERP-HY

This document clarifies the relationship between the two repositories
in the A1 ecosystem and the boundary between them for the
SBOS-A1-ERP open-core release.

## What SBOS-A1-ERP is

SBOS-A1-ERP is a fresh, clean-slate repository that will house the
**Armosphera One Claude** public release. The name follows the A1
brand system: "SBOS" is the Small-Business / Open-Suite designation,
the "A1" prefix ties it to the master brand, and "ERP" identifies the
product family.

It is the **open-core release target** for the Armosphera One Claude
Zoho-One-parity business suite, intended for self-hostable deployment
with offline + opt-in AI support.

## The public-private relationship

- **A1-ERP-HY** (`~/dev/A1-ERP-HY/`) is the **private R&D and
  hardening ground**. It contains tenant-specific operational
  hardening, paid-integration keys, and the brand-specific
  identifiers used by HayHashvapah and the Armosphera One tenants.
  The repo is internal-only.

- **SBOS-A1-ERP** (`~/dev/SBOS-A1-ERP/`, this repo) is the
  **public-facing open-core**. It will ship the domain logic,
  UI shells, and reference integrations that any operator can
  self-host.

Code ports flow **A1-ERP-HY → SBOS-A1-ERP** after
**de-private-ation**:

1. Secrets (API keys, tenant IDs, paid-integration credentials,
   personal phone numbers) are scrubbed.
2. Vendor-specific names are normalized (e.g. `hayhashvapah` →
   generic tenant name, `armosphera` → operator-configurable brand).
3. Tenant-hardening slices that are specific to a single
   deployment are stripped; only the generic, multi-tenant
   shape is carried over.
4. The canonical design docs (RBAC, dmux, ERP comparison,
   project status, HANDOFF summary) are mirrored as-is, with
   provenance headers, so all workers operate from the same
   north star.

## What is OUT of scope initially for SBOS-A1-ERP

- **Tenant / operational hardening**: per-tenant audit logging,
  network-isolation rules, and the deployment-specific hardening
  that A1-ERP-HY carries for the HayHashvapah production tenant.
- **Paid-integration keys**: any credential for a paid third-party
  service. Operators bring their own.
- **Brand identifiers**: the `armosphera` / `hayhashvapah` /
  `samvel` strings should not appear in source code shipped here.
  Operator branding is configured at deploy time, not compiled in.

## Initial module priority

Modules land in this order:

1. **RBAC** — domain-agnostic role-based access control. This is
   the foundation that every UI domain depends on. See
   `docs/RBAC_SYSTEM.md` (mirrored from A1-ERP-HY) for the
   canonical design: 13 baseline roles, permission catalog
   (GRANT / REVOKE), and the `rbac_canonical_grant.json`
   audit file.
2. **i18n** — internationalization with three locales out of the
   gate: `en` (English), `hy-Am` (Armenian, Eastern Armenian
   orthography), and `ru` (Russian). See `docs/LOCALIZATION_API.md`
   in A1-ERP-HY for the canonical API surface.
3. **Armenia-specific tax** — VAT return, chart of accounts, and
   the SRC e-invoice schema. These are the deepest country-specific
   modules and they ride on top of the RBAC + i18n foundation.

## Reference: A1-ERP-HY canonical implementations

The following files in A1-ERP-HY are the **canonical implementations**
of the Armenia-specific tax surface. They are the source of truth
for any port into SBOS-A1-ERP; do not re-derive from external specs
without checking these first:

- `armeniaChartOfAccounts.js` — the 623-account / 9-class chart of
  accounts from arlis.am/acts/75961 + accountant.am PDF.
- `vatReturn.js` — VAT return DRAFT builder (decree N 298-Ն,
  arlis.am/acts/136996, lines 7-23).
- `einvoice.js` — SRC-mappable e-invoice XML exporter (e-invoice.taxservice.am
  guide; no public XSD).

When porting any of these, the A1-ERP-HY file is the authoritative
reference. Spec drift between the law and the code should be
resolved in A1-ERP-HY first, then carried over.
