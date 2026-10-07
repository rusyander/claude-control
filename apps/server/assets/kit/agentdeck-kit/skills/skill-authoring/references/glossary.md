# Skill-authoring glossary — the terms, and what each one is not

Disclosed reference for [`agentdeck-kit:skill-authoring`](../SKILL.md). Adapted from mattpocock/skills
`writing-great-skills` GLOSSARY. Each term carries an _*Avoid*_ list — near-synonyms that blur it.

**Predictability** (root virtue, defined in SKILL.md) — same _way_ every run, not same output. A
brainstorming skill should predictably diverge: its tokens vary, its behaviour does not. Cost and
maintainability are symptoms of it, not rivals. _Avoid_: consistency, reliability, output-determinism.

## Invocation

**Model-invoked** — keeps its `description`, so the agent fires it autonomously _and_ the human can
still type its name: model-invocation always _includes_ user reach. Pays permanent **context load**.
Reachable by other skills, and the one home for reference several skills share. _Avoid_: ability, tool.

**User-invoked** — `disable-model-invocation: true`. Description stripped from the agent's reach; only
the human typing the name gets in, and no other skill can fire it. Zero context load. _Avoid_: command.

**Description** — the machine-readable trigger, and the one **context pointer** a model-invoked skill
keeps loaded at all times. Its mere presence _is_ the invocation axis. _Avoid_: frontmatter, summary.

**Context pointer** — a reference held in context that names out-of-context material and encodes the
condition for reaching it. The description is the top-level pointer (window → skill); pointers to
`references/` files are the same object one level down. Its wording, not its target, decides when and
how reliably the agent reaches. A must-have behind a weak pointer is a variance bug. _Avoid_: link, import.

**Context load** — what a model-invoked skill costs the window: its description, always loaded, spending
both tokens and attention. The brake on splitting into more model-invoked skills. _Avoid_: token cost.

**Cognitive load** — what a user-invoked skill costs the human: remembering it exists and when to reach
for it. Not a cost to minimise — it is the price of human agency, and the reason skills with side
effects stay user-invoked. _Avoid_: burden, overhead.

**Router skill** — names the other skills and when to reach for each, so the human holds one thing
instead of many. The cure for cognitive load when skills multiply. Ours is `agentdeck-kit:skill-map`.
_Avoid_: dispatcher, menu, registry.

## Information hierarchy

**Information hierarchy** — content ranked by how immediately the agent needs it: steps (in-file,
primary) → reference (in-file) → reference (disclosed). Independent of invocation. In-file reference
that should be disclosed buries the steps and turns attending to them into a coin-flip — a variance
lever, not just a legibility one. _Avoid_: structure, layout.

**Progressive disclosure** — moving reference out of `SKILL.md` behind a context pointer. Not primarily
a token optimisation; it is how the hierarchy is protected. _Avoid_: lazy loading.

**Co-location** — keeping what the agent needs at once in one place: a concept's definition, rules and
caveats under one heading. The hierarchy ranks _how far down_ a piece sits; co-location decides _what
sits beside_ it. _Avoid_: grouping, cohesion.

**Sprawl** — _failure mode._ Simply too long, independent of whether the lines are stale or repeated.
Even an all-live, all-unique skill can sprawl. Cure: the ladder. _Avoid_: bloat, verbosity.

## Steering

**Branch** — a distinct way the skill can be invoked, so different runs take different paths through it.
The cleanest disclosure test: inline what every branch needs, disclose what only some reach.
_Avoid_: path, fork.

**Leading word** (Leitwort) — a compact concept already in the model's pretraining that the agent thinks
with while running the skill. Encodes a behavioural principle in the fewest tokens by invoking priors
the model already holds. Repeated as a _token_, never as a sentence. _Avoid_: keyword, motif.

**Completion criterion** — the condition that says a unit of work is done. **Clarity** (done vs not-done
distinguishable) resists premature completion and needs steps to bite; **demand** (how much it requires)
sets legwork and binds flat reference too. Strongest criteria are both. _Avoid_: exit condition.

**Legwork** — the work the agent does _within_ a step: reading, exploring, digging up what it needs
rather than offloading to the user. Latent in the wording, never its own step. Raised by a leading word
or an exhaustive completion criterion. _Avoid_: effort, coverage.

**Post-completion steps** — the steps that follow the current one. Visible, they pull the agent forward.
_Avoid_: horizon, lookahead.

**Premature completion** — _failure mode._ Ending a step before it is genuinely done because attention
slipped to _being done_. Fuzziness is the necessary condition: a sharp bound resists the pull however
many later steps are visible. Two levers, in order: **sharpen the bound first** (local, cheap); hide
later steps only when the criterion is irreducibly fuzzy _and_ you observe the rush — and hiding works
only across a real context boundary (a subagent dispatch, a fresh session), never an inline skill call.
_Avoid_: the rush, shortcutting.

**Negation** — _failure mode._ Steering by prohibition drags the forbidden behaviour into context and
makes it _more_ available. The negation is a weak modifier the strongly-activated concept overruns, so
the ban half-reads as an instruction. Cure: prompt the positive. _Avoid_: don't-prompting.

## Pruning

**Single source of truth** — each meaning in exactly one authoritative place, so a behaviour change is a
one-place edit. **Duplication** is its violation: the same meaning in more than one place, costing
maintenance and tokens and inflating that meaning's prominence past its real rank. The accidental
inverse of a leading word, which raises attention on purpose by repeating a _token_, never a meaning.

**Relevance** — whether a line still bears on what the skill does. Lost either by never bearing (mere
exposition, or a branch that should be disclosed) or by going stale. **Sediment** is the failure mode:
stale layers that settle because adding feels safe and removing feels risky — the default fate of any
skill without a pruning discipline. _Avoid_: staleness, cruft, rot.

**No-op** — _failure mode._ An instruction that changes nothing because the model already does it by
default. Test: does the line change behaviour versus the default? A line can be perfectly relevant and
still be a no-op. Model-relative — settle a disagreement by running the skill, not by arguing about the
default. _Avoid_: restating the obvious.

When to spend a split, and how to name a failure before editing:
[diagnosis.md](diagnosis.md).
