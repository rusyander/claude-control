---
name: config-draft
description: "Use when adding or changing an agent rule, hook or skill (global or project layer): draft in the user's language → gate → compressed English final → proved write."
---

# config-draft — an intent turned into a proved config change

Scope: the agent's instruction layers — the CLI's instruction file (`CLAUDE.md`, `AGENTS.md`,
`QWEN.md`, …), its skills, hooks and settings, globally or in a repo's own config folder. Two
approvals, one write, one proof. The user states the intent in their language; what ships is
compressed English, pruned, and demonstrated working.

## 1. Classify — which layer carries the meaning

| The change is                                     | It lives in                                           | What it costs                      |
| ------------------------------------------------- | ----------------------------------------------------- | ---------------------------------- |
| behaviour in every session, no detectable trigger | the instruction file                                  | re-billed every turn — last resort |
| behaviour at one machine-detectable moment        | a situational rule + the hook trigger that injects it | once, in the session that needs it |
| a repeatable multi-step procedure                 | `skills/<name>/SKILL.md`                              | its description, every turn        |
| a deterministic check or verdict                  | a hook module                                         | one process per event              |
| a fact about the user, a project, an agreement    | project memory / `.agent/` notes                      | already project-scoped             |
| harness mechanics — permissions, env, wiring      | the CLI's settings file                               | read its docs first                |

Grep the layer before drafting: a file that already carries the meaning gets **updated**; name that
exact file out loud. A trigger the machine can detect beats an always-loaded paragraph every time.

Canon per kind, loaded not restated: skill quality → skill `agentdeck-kit:skill-authoring`; sizes,
lifecycle and doc layout → skill `agentdeck-kit:doc-hygiene` §3; hook mechanics → the
`hook-authoring` situational rule.

## 2. Draft in the user's language — the meaning gate

Four things: what it does, when exactly it fires, which file takes it, and the draft text itself.
Name what it replaces or duplicates, if anything.

**Gate:** an explicit yes on the MEANING. Nothing is written to disk before it.

## 3. English final — the text gate

Translate the body and prune it by the canon of that layer — a config file is paid for on every turn
that loads it. Two things survive the translation verbatim:

- **trigger phrases in the user's language** inside a hook regex — the regex matches the words the
  user actually types, so a translated trigger fires on nothing. A skill `description` stays English:
  the model matches it by meaning.
- **the reason line** — the "why" compresses best and is exactly what keeps the rule from being pruned
  as noise by a later audit. Dates absolute.

Show the exact bytes about to be written. **Gate:** the approval that counts is on THIS text.

## 4. Write, then prove it

Verification is by kind, and each one names a command:

- **skill** — frontmatter parses, the name matches its folder, every referenced file exists;
  `agentdeck-kit:skill-map` updated in the same pass, or the map lies about what exists.
- **hook or module** — a test case covering it green, the hook run once with a real-shaped stdin and
  its output read, and the real event fired once in a session with its effect seen. Unproven wiring
  is not delivered.
- **situational rule** — drive the trigger with a real path or command and see the block arrive.
- **instruction file or memory** — the file still inside its budget after the edit, and the claim it
  makes true as of today.

## 5. Retiring — the same two gates, run backwards

Removal is a config change: it goes through §2 and §3 like any other, and the line saying WHY it went
is what stops it coming back next month. Nothing is removed while something still points at it.

- **skill** → moved to an archive folder, never `rm`; its line out of `agentdeck-kit:skill-map`.
- **situational rule** → the file and its trigger go together; half of that is a rule that silently
  stopped existing.
- **hook or module** → out of its registration and settings, its test case with it: a settings entry
  pointing at a deleted script fails on every matching call.
- **instruction-file rule or memory** → one line in an archive note that is never auto-loaded.

Gate: the §4 check for that kind, plus a grep for the dead name across the config layer coming back
empty.

## 6. Report

File path · one line of meaning in the user's language · the verification output as it came back. A
check that could not be run is reported as not run.

## Red flags

- What landed differs from the text that was approved.
- A second file now says what an existing one already said.
- The change was "obviously right", so nothing was fired to prove it.
- Trigger regexes got translated on the way to English.
- A person's name, an agreement or an assessment landed in a git-tracked config instead of memory.
