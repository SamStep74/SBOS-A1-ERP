# AGENTS.md — A1-portfolio (cross-repo documentation)

This file applies to every agent (human or AI) that touches the `armosphera/A1-portfolio`
repository. It extends, and never weakens, the global rules in this same repo's
`LICENSING.md`, `ARCHITECTURE.md`, and `SECURITY.md`.

## 1. What this repo is — and isn't

`A1-portfolio` is the **cross-repo documentation source of truth** for the entire A1
product family. It contains:

- `README.md` — repo index grouped by layer (Engine / Application / Reference)
- `LICENSING.md` — license matrix across all 9 repos
- `ARCHITECTURE.md` — layer cake, data flow, open portfolio questions
- `SECURITY.md` — vulnerability reporting, severity SLAs

**This repo has no code, no tests, no CI.** It's documentation. Edits here are edits
to the *portfolio* — they ripple by being read by humans and agents in every other repo.

## 2. When to edit this repo

Touch this repo whenever:

1. You add a new A1 repo → update the **Repo index** in `README.md` and the layer cake
   in `ARCHITECTURE.md`.
2. You change a license in any repo → update the matrix in `LICENSING.md`. (Per the
   file's preamble: "If a repo's `LICENSE` file disagrees with this document, the
   `LICENSE` file wins — but please open an issue so we can resolve the drift.")
3. You introduce a new cross-repo invariant (e.g. a new pinned SHA, a new eval lane
   contract, a new sovereignty constraint) → document it in `ARCHITECTURE.md` and link
   from `SECURITY.md` if it touches security posture.
4. You change release / tagging convention → update `docs/RELEASE-PROCESS.md` (TODO —
   does not exist yet).
5. You change which repo is canonical for a domain → update `docs/PRODUCTS.md` (TODO).

## 3. The 4 files you must keep coherent

These are the load-bearing docs. **All four must agree on the canonical repo list.**

- `README.md` — repo index
- `LICENSING.md` — license matrix table
- `ARCHITECTURE.md` — layer cake (must show the same repos)
- `SECURITY.md` — supported versions table

If you add a repo, edit all 4. If you deprecate a repo, edit all 4 + open an issue.

## 4. Conventional Commits

```
<type>(<scope>): <description>

<optional body>
```

Allowed types: `docs`, `chore`, `feat` (for new docs sections), `fix` (typos /
wrong claims), `refactor` (restructuring existing docs).

- Subject line ≤72 chars, imperative mood, no trailing period.
- Body explains **why**, not **what** (the diff shows the what).

## 5. No Code, No Secrets

- This repo has no source code, no tests, no CI. **Don't add any.**
- No secrets, no API keys, no customer data. If you find one in a PR, reject and rotate.

## 6. Markdown Discipline

- One H1 per file. Use H2 for sections, H3 for subsections.
- Code blocks must specify language: ` ```bash `, ` ```js `, ` ```python `, etc.
- Tables use GitHub-flavored markdown alignment (left for text, right for numbers).
- Internal links use relative paths (`./LICENSING.md`), external links use full URLs.
- Line length ≤120 chars (Markdown doesn't hard-wrap but keep readable in raw view).

## 7. Drift Detection (TODO)

This repo should grow a CI check that:

- Compares the repo index in `README.md` against the actual list of repos in the
  `armosphera` org.
- Compares the license matrix in `LICENSING.md` against each repo's `LICENSE` file.
- Compares the architecture layer cake in `ARCHITECTURE.md` against the actual repo
  descriptions.

Add as a Karpathy eval lane: `portfolio-drift-contract`.

## 8. Day-One Checklist

```
1. cat AGENTS.md             # this file
2. cat README.md             # current repo index
3. cat LICENSING.md          # current license matrix
4. cat ARCHITECTURE.md       # current layer cake
5. cat SECURITY.md           # current policy
6. Now edit — keep all 4 in sync.
```

## 9. Roadmap Items (Track Here)

The following are **known portfolio gaps** that this repo will track:

- [ ] `docs/CONTRIBUTING.md` — how to file issues against the right repo
- [ ] `docs/RELEASE-PROCESS.md` — how releases are cut (tag, notes, publishing)
- [ ] `docs/PRODUCTS.md` — naming matrix: which repo is canonical for X
- [ ] AGPL-3.0 dual-license migration for engines (2026 H2)
- [ ] Portfolio drift CI (drift between docs and actual repos)
- [ ] Cross-repo evaluation report (which repos have AGENTS.md, program.md,
      .orchestration/, Karpathy eval lanes — vs which don't)

## 10. Ownership

**Armosphera LLC** · contact: ops@a1-suite.local · security: ops@a1-suite.local

---

*Adapted from `armosphera/SBOS-A1-ERP/AGENTS.md`. Specializes for "this repo IS the
documentation." License: Proprietary (`LicenseRef-Armosphera-Proprietary`). See `LICENSE`.*