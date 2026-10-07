# improve-react — invocation variants and tone

## Invocation variants

| Invocation                                                                       | Behavior                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bare                                                                             | full workflow: recon → audit all → vet → confirm → plans                                                                                                                                                                                                                                                                                    |
| `quick` / `deep`                                                                 | audit effort (see the depth table in SKILL.md); composes with a focus                                                                                                                                                                                                                                                                       |
| category (`performance`, `accessibility`, `security`, `bugs`, `maintainability`) | recon + that category only                                                                                                                                                                                                                                                                                                                  |
| `plan <description>`                                                             | skip the audit; recon just enough, write one plan                                                                                                                                                                                                                                                                                           |
| `execute <plan>`                                                                 | only on the user's explicit yes for THIS run — a spawn plus `git worktree add` is orchestration and a git write, each gated globally; then an executor subagent (`[return-format]`, `[no-subagents]`) in the worktree, its diff reviewed against React Doctor (`--no-score --scope changed`), a verdict. No yes → hand the plan to the user |
| `reconcile`                                                                      | re-check `.agent/react-plans/` against current code: mark DONE, refresh stale `file:line`, retire fixed findings                                                                                                                                                                                                                            |

## Tone

Findings plainly, with evidence and the rule id. A short list of high-leverage plans beats a padded
one — "the code here is already solid" is a valid result. Where static code can't settle correctness
(a timing-dependent race, a re-render whose cost isn't statically visible), say so and put a Profiler
or runtime check in the plan instead of guessing.
