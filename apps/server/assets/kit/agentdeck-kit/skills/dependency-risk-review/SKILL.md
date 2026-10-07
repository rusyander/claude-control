---
name: dependency-risk-review
description: 'Use before adding a NEW package — worth it? → health/size/license → alternatives → verdict. Upgrading existing → deps-upgrade.'
---

# New dependency review, before it lands

Every dependency is debt: updates, vulnerabilities, weight.

## 1. Is it needed at all

- Solvable in ≤50 lines of project-idiomatic code → write the code.
- A package with this function is already in the tree (**check the lockfile**) → use it. Two date
  libraries in one bundle is the classic failure.
- One function needed out of a large package → consider a targeted implementation.

## 2. Package health — fast signals

- Maintenance: last release date, unanswered issues, single maintainer?
- Maturity: downloads, who uses it, stability across majors.
- **Size and transitive tail**: bundlephobia / `npm info` — what it drags in. Weight is critical on
  the frontend.
- **License**: MIT/Apache/BSD fine; GPL/AGPL/non-standard → stop and flag it to the user.
- Vulnerabilities: known CVEs (`npm audit`, GitHub advisories).
- Typing (TS): native types / `@types` / none.

Gate: `npm view <pkg> version time license --json` + size via bundlephobia or `npm pack --dry-run`;
every table cell holds a number/string or the literal "unknown".

## 3. Alternatives & verdict

Run 1–2 alternatives through the same checklist, including "write it ourselves". Give the user a
recommendation with the reason; a comparison table when the choice is not obvious. Add only after
their yes; pin the version per project convention (none recorded → exact pin).

## Red flags — run against the finished verdict

- Added out of habit, without checking what the project already has.
- License ignored — AGPL in a proprietary project is a legal problem, not a preference.
- Abandoned package (years without a release) in a critical path.
- A heavy package for one function.
