# Mode AUTHOR — documentation from scratch

Read the code first, write second. A doc written from assumptions is worse than no doc: it is
believed.

## 1. Establish ground truth before writing a word

- Entry points, scripts, and real commands: `package.json` scripts, `Makefile`, CI workflow.
- Runtime requirements: engines, `.nvmrc`, lockfile, `Dockerfile`, env vars actually read in code.
- Ports, paths, defaults: from the code, not from any existing README.
- Run what is safe to run (`--version`, `--help`, a build, a test) and document the real output.
  Cannot run it → say the command is unverified, or leave it out.

## 2. Four document types — never mixed in one file

Splitting by _purpose_ is what keeps docs findable and short (Diátaxis, the standard practice):

| Type                   | Answers                   | Rule                                                     |
| ---------------------- | ------------------------- | -------------------------------------------------------- |
| Quick start / tutorial | "how do I get it running" | one happy path, every command copy-pasteable, no options |
| How-to                 | "how do I do task X"      | task-shaped title, numbered steps, no theory             |
| Reference              | "what exactly is X"       | exhaustive, tabular, no narrative                        |
| Explanation            | "why is it like this"     | architecture, trade-offs, constraints; no instructions   |

A file that answers two of these gets split. Most projects need README + 2–4 docs, not twenty.

## 3. Minimum viable set

1. `README.md` — what it is (1–2 sentences) · requirements · quick start · where everything else is.
2. `docs/architecture.md` — components, data flow, why this shape. Diagram only if it removes text.
3. `docs/<task>.md` — one per real recurring task (deploy, release, local debug, migrations).
4. `docs/reference.md` — env vars, config keys, CLI flags, ports; a table each.
5. `docs/adr/NNNN-<slug>.md` — only for decisions with live consequences.

Write only what a reader will actually need. An empty section is a promise you failed to keep;
delete it instead.

## 4. Scope control

Document the project as it is today. No roadmap, no "planned for the future", no aspirational
architecture. If the code is inconsistent, document the real behaviour and note the inconsistency
in one line — do not describe the version you wish existed.

## 5. Onboarding docs — the one type with extra rules

A README/ONBOARDING is written for someone starting from a clean machine, so it has demands the
other types do not:

- Every step reproducible from zero. No assumed local state, no "as usual".
- Map of the repo first: table `folder → role`, so the reader can orient before running anything.
- After the quick start, a way to **confirm it worked**: URL, expected output, test user (only if
  non-secret).
- The highest-value section is "common problems" — newcomer traps that are invisible in the code.
  Take them from `.agent/notes.md` and project memory; this is the part no code reading produces.
- No internal jargon without expansion. Language: whatever the project's docs already use.
- **Secrets, passwords, tokens: never**, in any form, not even masked examples.
- A statement you could not verify → mark it explicitly as not verified (`⚠️` + "not verified" in the doc's language), or drop it. Never quietly
  carry a command from the old doc that you did not run.

Red flags in a finished onboarding doc: a command you never executed · a "nicely rewritten"
version that lost a working non-obvious detail from the old one · any credential in the text.

## 6. Verify before finishing

- Walk the quick start yourself, in order, and fix what does not work.
- Every internal link resolves; every path exists.
- Every command was either run or is explicitly marked as unverified.
- Report honestly which parts were verified by running and which were not, and why.
