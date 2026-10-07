# Compression — worked examples

Rules live in `SKILL.md` §2. This file is the calibration: what "maximum compression without
quality loss" actually looks like. Target ≈2–4× fewer tokens (SKILL §2a), zero facts lost.

## Prose → facts

BAD (38 words):

> We are currently waiting for the backend team to deliver the cart photo endpoint. The contract
> has not been agreed yet, so for now the component renders a placeholder. We should revisit this
> once the API is ready.

GOOD (12 words):

> Cart photo: endpoint pending backend, contract TBD → placeholder in `CartItem.tsx`.

Facts kept: what's missing, who owns it, contract state, where the workaround lives.
Cut: "currently", "we should", "for now", the retelling of the plan.

## Decision entries

BAD:

> After discussing several options, we decided to use React Query instead of writing our own
> caching layer, because it handles retries and deduplication out of the box.

GOOD:

> React Query, not own cache — retries + dedup built in (2026-07-20).

Keep the _why_ only when it prevents the decision being redone. Drop the deliberation.

## Gotchas

> PS 5.1 mangles UTF-8 on stdin → never round-trip source through PowerShell; use Write tool.

One line: trigger → consequence → rule.

## Anti-patterns

| Anti-pattern                                | Fix                                       |
| ------------------------------------------- | ----------------------------------------- |
| "As discussed above / see previous section" | delete — the model reads the whole file   |
| Stacked history: "was X; update: now Y"     | replace with Y                            |
| File tree of the repo                       | delete — `ls`/Glob is cheaper than tokens |
| Code block >3 lines                         | path + line range instead                 |
| Same fact in CLAUDE.md and notes.md         | keep one, link from the other             |
| "TODO: maybe consider…" with no owner       | delete                                    |
| Status prose ("work is going well")         | delete or replace with state + blocker    |

## Data files — exception

Tables of measurements, node-ids, hex, generated exports: never compressed, never translated.
Only split when size blocks reading (see budgets).
