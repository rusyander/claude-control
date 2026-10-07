---
name: prepare-mr
description: 'Use when a finished batch is being readied for MR — final gate: verify, style self-review, pre-MR sieves with evidence, readiness checklist, summary.'
---

# MR preparation — the final gate

One command instead of five steps; order strict.

## 1. Full verification

The project's own commands (from the style profile / package.json / Makefile): type-check, lint,
tests, build — across EVERY affected subproject (buildable libraries first).
Gate: each profile command run, per-subproject exit 0 listed in the report; red → fixed to green
before step 2.

## 2. Style self-review

Invoke `agentdeck-kit:style-conformance-review` (project profile, all edits including subagents'). Fix what it
finds, re-verify what you touched. Already run over this exact diff (same batch, no edit since) →
cite that result instead: a second pass over an unchanged diff finds nothing new.

## 3. Sieves — one per blocker class reviewers kept finding

Each sieve is a class of reviewer blocker from real MRs: docs ≠ code (18), integration with the
target (6), isolation of stand and focus (3), consumers outside the diff (3), boundary input (1).
Run on the final code: the evidence belongs to the HEAD that goes up.

**Applicability comes from the changed paths**, never from judgement. Paths =
`git diff --name-only $(git merge-base origin/<target> HEAD)` + untracked; dot-dirs (`.agent/`,
`.claude/`) skipped. Kinds:

- **ui** — `.tsx .jsx .vue .svelte .astro .css .scss .sass .less .html`
- **backend** — `.go .py .java .kt(s) .rb .php .rs .cs .ex(s) .scala .sql`, or code under
  `server/ backend/ api/ service(s)/`
- **contract** — OpenAPI/Swagger files, `.proto .graphql .gql`, `.md .mdx .rst .adoc`,
  code/yaml/json under `contract(s)/ doc(s)/ api-docs/`
- **code** — any ui/backend file, or JS/TS source (`.js .jsx .ts .tsx .mjs .mts .cjs .cts`)
- **data** — `migrations/ migrate/ alembic/ flyway/ liquibase/`, `db/changelog/`, `db/schema.*`,
  `*.sql`, `schema.prisma`, `*migration*.<code|yaml|xml|json>`
- **always** — any change at all

**High risk** = a data path, or a path segment like auth/login/oauth/sso/password/credential/secret/
crypt/permission/rbac/acl/policy/payment/billing/invoice/checkout/wallet/security, or ≥40 code files.

Test paths (`tests/ e2e/ qa/ spec/ cypress/ playwright/ __tests__/`, `*.test.* *.spec.* *.stories.*`)
trigger only as an OpenAPI/Swagger/`.proto`/GraphQL file (contract).

| Sieve                | When              | Check → evidence                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| consumers-repo-wide  | code              | `node <kit>/tools/risk-tier.mjs --base origin/<target>`: the radius follows importers of what the files offer now; its block "CONSUMERS OF CHANGED STRINGS" is the repo-wide grep (e2e/QA included) for removed exports, test ids, routes and i18n keys. By hand, `git grep -nwF` over the WHOLE repo: every token in its «NOT SEARCHED» tail, plus the `-` side names it does not read — roles, UI strings. → commands + hits, each hit fixed or named |
| contract-by-request  | contract, backend | Second entry, from the contract: list every claim docs/OpenAPI/proto/README/help make about the changed behaviour (status, field names, error shape, limits, defaults); check EACH by a real request to a stand running THIS branch, or the route test through the real route. A claim checked by reading the diff counts as unchecked. → request + observed status/body line                                                                           |
| merge-tree           | always            | `git fetch`, then `git merge-tree --write-tree origin/<target> HEAD` → no conflicts; files the target changed since the merge-base that this branch also touches re-read (a clean merge can still be a semantic conflict). → command + result, re-read files named                                                                                                                                                                                      |
| foreign-removals     | always            | Every `-` hunk of `git diff origin/<target>...HEAD` is a removal this task meant; unsure → `git blame -L <start>,+<n> $(git merge-base origin/<target> HEAD) -- <file>` (the diff's old-side line numbers belong to the merge-base, not the target tip). Someone else's line lost in a rebase or an overwritten file → restored, or the file named with why. → files with removals, each marked intended/restored                                       |
| browser-focus        | ui                | Browser test (Playwright or the project e2e) over the changed screens: Tab order, visible focus, Escape/Enter, a narrow and a wide width. A component unit test is a different check. → command + pass line                                                                                                                                                                                                                                             |
| branch-backend-stand | backend           | Every live check ran against a stand whose backend is built from THIS branch — main or a shared dev stand proves another commit. → process/port + the commit it runs = `git rev-parse HEAD`                                                                                                                                                                                                                                                             |
| boundary-negative    | code              | One negative in the live run at a type or limit boundary of the changed input (empty, max+1, wrong type, missing field); the refusal is the documented one. → input + observed response                                                                                                                                                                                                                                                                 |
| tests-alongside      | code              | A behaviour change ships with a test that fails without it (red-before shown, skill `agentdeck-kit:bug-regression-test` for a fix), or the MR says why none is needed. → test file + the red run                                                                                                                                                                                                                                                        |
| lockfile-sync        | always            | Every changed dependency manifest (package.json, pyproject, go.mod, Cargo.toml, Gemfile, composer.json) has its lockfile regenerated by the project's own package manager in the same diff. → manifest ↔ lockfile pairs                                                                                                                                                                                                                                 |
| secrets              | always            | Added lines carry no real key, token, JWT, private key or password-in-URL (lockfiles excepted). A real one found → removed AND rotated; a fake fixture → named with why it is fake. → scan command + hits                                                                                                                                                                                                                                               |
| debug-leftovers      | always            | No focused test (`.only`, `fit`, `fdescribe`), `debugger`/`breakpoint()`/`pdb`, conflict marker, stray console.log or commented-out block in added lines. → grep + hits                                                                                                                                                                                                                                                                                 |
| committed-artifacts  | always            | No `.env`, key file, force-added ignored file or file >5 MB among added files. → added-file list checked                                                                                                                                                                                                                                                                                                                                                |
| env-config           | code              | Every env var the code starts reading without a default is declared in config / `.env.example` / compose / Helm / docs. → names + where each is declared                                                                                                                                                                                                                                                                                                |
| migration-safety     | data              | Destructive statements (DROP, RENAME, type change, DELETE without WHERE) go expand → migrate → contract; the migration applied on a fresh DB and on a copy of the current schema; rollback works. → apply + rollback output                                                                                                                                                                                                                             |
| rollback-plan        | high risk         | The MR states how the change is rolled back without data loss and which production signal shows it broke. → the MR paragraph                                                                                                                                                                                                                                                                                                                            |

The global push-sieves hook re-checks by git alone when the AGENT's shell runs `git push` /
`gh pr create|new` / `glab mr create|new` (a PreToolUse hook, not a git `pre-push`: a push from a
terminal, IDE or the panel passes unchecked). It DENIES on merge-tree conflicts, foreign removals,
secrets, debug-leftovers, committed-artifacts, lockfile-sync, env-config and removed names still
referenced (`# sieve-ack: <file|name>` clears a deliberate one), and NOTES tests-alongside,
migration-safety and rollback-plan. It is the backstop, cited as evidence only for the HEAD it passed
on; the rows above stay yours.

**Learned sieves.** A project may keep `.claude/sieves.md`: rows in the same shape, each born from a
reviewer blocker of a class the table above lacks (MR link + the blocker in one line). A reviewer
blocker of a new class → add its row there in the same pass as the fix, so the next MR runs it
unprompted. Those rows run beside the table, with the same gate.

Gate: a row per sieve, `pass` / `fail` / `n-a`, each with evidence — `n-a` names the absent kind or
the reason. Evidence from an older HEAD than the last edit → re-run that sieve. `fail` → fix, re-run
step 1 for the touched subproject, then every sieve whose evidence predates the fix. A sieve left
unchecked (no stand, no browser, no network) → **the MR is not ready**: name the sieve and why.

## 4. Readiness checklist

Walk the diff and answer each item (yes/no/n-a):

- [ ] DB migrations: present? deploy order accounted for (safety itself → migration-safety)?
- [ ] Backward compatibility: APIs/contracts/public exports unbroken?
- [ ] Client ↔ contract: every API field or parameter the client adds or reads exists in the spec
      (OpenAPI/proto) under the same name? A renamed field (`errors_24h` vs `errors_today`) passes every
      local check and breaks only against the live backend.
- [ ] One branch, one MR: no open MR for this source branch already (a second one reviews the same
      diff twice)?
- [ ] i18n: new strings in ALL locales?
- [ ] Config/env, litter, tests, secrets → the sieves env-config, debug-leftovers,
      committed-artifacts, tests-alongside, secrets; nothing to repeat here.
- [ ] Visible change → before/after shots per the project's screenshot rule
      (`.agent/**/screenshots/before-after/<task>/`)?
- [ ] TASKS.md (if kept): statuses and the "Resolution" field filled in?

A "no" where it should be "yes" → fix it, or state it explicitly in the MR description as a known
limitation.

## 5. Summary

Invoke `agentdeck-kit:changelog-builder` → ready MR description (+ a title in the project's commit convention) —
its header-id, quoted-fact and ticket-number gates included.
Hand the user: readiness verdict first (ready / not ready + the unchecked sieves), description,
sieve table, checklist result, what is left on their side (checks I could not run live, named with
the reason; the merge itself — git operations are the user's).

## Red flags — run against the finished handover

- Moving to step N with step N-1 red.
- Checklist "ticked" without walking the diff.
- A sieve row whose evidence is a conclusion ("checked, fine") instead of a command and its output.
- "Ready" with any applicable sieve unchecked.
- Summary written before the final style or sieve fixes (it will be stale).
