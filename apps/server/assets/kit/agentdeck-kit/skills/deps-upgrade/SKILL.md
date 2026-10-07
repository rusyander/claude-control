---
name: deps-upgrade
description: 'Use when asked to upgrade dependencies — staged batches by risk, changelogs for majors, verify each batch.'
---

# Dependency upgrade

## 1. Audit

1. Use the project's own manager and lockfile (npm/pnpm/yarn, go.mod, pyproject…). The lock is
   committed together with the manifest.
2. What is behind: `npm outdated` / `go list -u -m all` / equivalent. Vulnerabilities: `npm audit` /
   `govulncheck`.
3. Classify: patch (low risk) / minor (medium) / **major (changelog is mandatory reading)**. For a
   major, read the migration guide (context7/web) and write down what touches THIS project — grep
   for use of the changed APIs.
4. Batch plan for approval: security → patch/minor as one group → each major on its own.
   Respect exact pins (no `^`): they were pinned for a reason. Find the reason — comment, git
   history — before touching them.

## 2. Upgrade in batches

Per batch: upgrade → full project verification (type-check, lint, tests, build; for libraries also
build the consumers) → next. Gate: the project gate command green per batch, output quoted; after
the security batch, an `npm audit` re-run shows the previously-flagged advisories gone.
A failure is fixed inside its own batch per the migration guide, or the
batch is rolled back whole. Never carry breakage into the next batch.
Monorepo: upgrade shared packages in lockstep across subprojects — versions must not drift, and peer
deps must be checked.

## 3. Report

Table: package → from → to → type → what code changes it forced. Separately: what was deliberately
NOT upgraded and why (a major with a large migration → propose it as its own task). Runtime behaviour
checked live on the stand where reachable; what could not be run is listed as not verified, with
the reason.

## Red flags — run against the finished upgrade

- Everything upgraded in one go — nothing identifies the culprit when it breaks.
- A major merged without reading the changelog. Green tests ≠ no runtime-breaking change.
- Hand-editing the lockfile, or deleting it for a "clean install".
- Removed a pin without finding out why it existed.
