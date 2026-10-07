# Diagnosing a skill — when to split it, and what its symptom means

Disclosed reference for [`agentdeck-kit:skill-authoring`](../SKILL.md). Reached when a skill misbehaves or has grown
past one job — not when writing a fresh one. Terms used here are defined in [glossary.md](glossary.md).

## Granularity — when to split

Each cut spends one of the two loads, so split only when it earns it:

- **By invocation** — a distinct leading word should trigger it on its own, or another skill must reach
  it. You pay permanent context load for the new description.
- **By sequence** — the steps ahead tempt the agent to rush the one in front of it. Beware the reverse:
  merging sequences exposes each step's post-completion steps to what follows.

Splitting for _reuse alone_ is not a reason — reuse is why you extract, not the test for whether the
model should be able to reach it.

## Diagnosing a misbehaving skill

Name the failure before editing:

| Symptom                     | Failure mode              | Fix, in order                                                                    |
| --------------------------- | ------------------------- | -------------------------------------------------------------------------------- |
| Stops half way              | Premature completion      | Sharpen the criterion; split the sequence only if the bound is irreducibly fuzzy |
| Fires unasked               | Misfire                   | Invocation axis (SKILL.md §1) — a flag or a hook, not more prose                 |
| Never fires                 | Silent skip               | Description lacks the words the user types, or a stronger one outcompetes it     |
| Ignores half the rules      | Sprawl / buried reference | Disclose to `references/`, raise the criterion's demand                          |
| Does the forbidden thing    | Negation                  | Rewrite the prohibition as the positive target                                   |
| Contradicts itself          | Duplication               | Collapse to one single source of truth                                           |
| Reads fine, changes nothing | No-op                     | Delete the sentence, or strengthen a weak leading word                           |
