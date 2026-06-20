# AGENTS.md — Agent Conventions for SBOS-A1-ERP

This file applies to every agent (human or AI) that touches the SBOS-A1-ERP
repository. It extends, and never weakens, the global rules in
`~/.claude/rules/common/`.

## 1. Workflow: Test-Driven Development (TDD)

**Mandatory for every non-trivial change.**

1. Write the test first (RED). The test must fail for the right reason.
2. Run the test and confirm it fails.
3. Write the minimum implementation that makes it pass (GREEN).
4. Run the test and confirm it passes.
5. Refactor (IMPROVE) while keeping tests green.
6. Verify coverage stays at or above the **80% floor** for any touched module.

If you are tempted to skip the failing-test step, you are about to write
dead code. Stop and write the test first.

## 2. Coverage Floor — 80%

- Unit tests, integration tests, and (for critical paths) E2E tests are all
  required.
- Coverage is measured per touched module, not just repo-wide.
- PRs that drop coverage below 80% for any modified file are blocked.

## 3. Immutability by Default

Prefer `const`, frozen objects, and "update returns a new value" helpers over
in-place mutation. Pure functions are easier to test, easier to reason about,
and safer under concurrency.

```ts
// WRONG
function setStatus(invoice, status) {
  invoice.status = status;
  return invoice;
}

// RIGHT
function withStatus(invoice, status) {
  return { ...invoice, status };
}
```

## 4. Conventional Commits

```
<type>: <description>

<optional body>
```

Allowed types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`,
`build`.

- Subject line ≤72 chars, imperative mood, no trailing period.
- Body explains **why**, not **what** (the diff shows the what).
- Attribution is disabled globally; do not add `Co-Authored-By` trailers.

## 5. No Hardcoded Secrets

- API keys, passwords, tokens, private URLs, and customer data must never
  appear in source.
- Use environment variables, read at process start, and validated for presence.
- A `SECURITY.md` policy governs rotation; if a secret leaks, rotate first,
  fix second.

## 6. Porting over Net-New Invention

`~/dev/A1-ERP-HY/` is a battle-tested reference for an Armenian SME ERP.
**Before** writing a new module, search that repo for an equivalent
implementation. If one exists and is well-tested, port it. If a partial
match exists, fork and adapt. Only invent from scratch when the reference
is clearly inadequate — and document why in the commit body.

## 7. Files, Functions, Nesting

- One concept per file. Aim for 200–400 lines, 800 hard cap.
- Functions: <50 lines, single responsibility.
- No nesting deeper than 4 levels. Prefer early returns and small
  helper functions.

## 8. TypeScript Discipline

- `strict: true` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- No `any` in committed code. Use `unknown` + narrowing when the type is
  genuinely unknown.
- No non-null assertions (`!`) outside of tests with a clear justification.

## 9. No Debug Noise in Shipped Code

- `console.log` is for development only. Production code uses a structured
  logger.
- No `debugger`, `// FIXME` left behind, or commented-out blocks in PRs.

## 10. Test Runner Flags (16GB Mac Safety)

Always run the test suite with the same flags the 11GB-swap-on-16GB-Mac fix
uses:

```
node --test --test-concurrency=4 --test-timeout=60000
```

Bare `node --test` is unsafe on memory-constrained hardware.

## 11. Local-First, Offline-Capable

SBOS-A1-ERP must run end-to-end with no network dependency beyond
opt-in AI features. Do not introduce code that requires a SaaS to function.

## 12. Armenian-Specific Code Paths

- Chart of accounts, VAT forms, and e-invoice schemas are Armenia-specific.
- Any change touching these areas must cite the authoritative source
  (SRC decree, ARLIS act, or maintained Armenian l10n dataset) in the
  commit body.

## 13. Question Before Damage

If an instruction is ambiguous and a wrong move would lose data, break
the build for everyone, or rewrite a lot of working code, **ask first**.
Otherwise, prefer momentum: small, reversible, well-tested steps.
