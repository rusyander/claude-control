# Invocation — the three routes and what each one costs

Disclosed reference for [`agentdeck-kit:skill-authoring`](../SKILL.md) §1. Reached when creating a skill, when
changing how an existing one is reached, or when [diagnosis.md](diagnosis.md) names a misfire or a
silent skip. Terms: [glossary.md](glossary.md).

## The frontmatter axis

| Frontmatter                      | User invokes | Model invokes | Description in context |
| -------------------------------- | ------------ | ------------- | ---------------------- |
| (default)                        | yes          | yes           | **every turn**         |
| `disable-model-invocation: true` | yes          | no            | never                  |
| `user-invocable: false`          | no           | yes           | every turn             |

Model-invocation always _includes_ user reach: a model-invoked skill keeps its description, so the
agent fires it autonomously and the human can still type its name. It is also the only kind another
skill can reach, which makes it the one home for reference several skills share.

`disable-model-invocation: true` strips the description from the agent's reach entirely — zero context
load, and no other skill can route to it. That is the right trade for a skill with side effects the
human should be choosing deliberately; it is the wrong one for anything another skill must reach.

## The third route: hook-routed

A `UserPromptSubmit` regex in `settings.json` fires a skill on exact triggers at zero always-on cost.
Ours: `docs-order-hint`, `figma-hint`. Two properties make it worth the wiring:

- the trigger is exact — it matches the words the user actually types, not a paraphrase the model has
  to judge;
- it survives a long turn, where a description competes with everything else already in the window and
  loses.

Where a hook routes, cut the description to identity plus the triggers the hook misses — the hook owns
the exact phrases, the description owns the rest of the surface.

A hook-routed skill stays **model-invoked**. The hook instructs the model to use the skill, so
`disable-model-invocation` would put it beyond the reach of the very mechanism routing to it.

## Where the axis is the bug

An event trigger written as prose («auto-fire on X», «always run this first») is a hook that was never
wired: the description cannot enforce it and pays every turn for failing to. Wire the hook instead, and
say so — offering the hook is part of authoring the skill.
