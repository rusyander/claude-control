---
name: skill-authoring
description: 'Use when writing, editing, splitting or auditing a skill (SKILL.md, global or project) — invocation axis, information ladder, pruning verdicts.'
---

# Skill authoring — the quality bar

A skill wrangles determinism out of a stochastic system. **Predictability** — same _process_ every run,
not same output — is the root virtue; every lever here serves it. Our hooks, budgets and language
policy win wherever imported skill lore differs.

Terms and the near-synonyms that blur them: [references/glossary.md](references/glossary.md). A skill
that misfires, stalls or has outgrown one job: [references/diagnosis.md](references/diagnosis.md) — name
the failure there before editing. Skip both for a quick edit.

## 1. Invocation — decide before writing a line

The axis is chosen before the first line of body — the one decision the rest cannot undo.
**Model-invoked** (the default) pays **context load**: its description competes for attention every
turn. **User-invoked** (`disable-model-invocation: true`) pays **cognitive load**: the human is the
index, cured by the router `agentdeck-kit:skill-map`. **Hook-routed** is ours: a `UserPromptSubmit` regex fires on
exact triggers at zero always-on cost, and survives a long turn where descriptions drown. The table,
the reach each combination gives, and how a hook-routed description is cut:
[references/invocation.md](references/invocation.md).

A description that pleads ("ON EXPLICIT REQUEST ONLY", "never self-fires") is a flag or a hook written
as prose. Convert it. Verify the set: `node <kit>/tools/skills-audit.mjs` (`--usage`: usage from
logs, 0 hits → archive candidate).

## 2. The description

Two jobs: say what the skill is, list the **branches** that trigger it. Billed every turn, so it prunes
harder than the body.

- Front-load the **leading word** — the description is where it does its invocation work.
- One trigger per branch; synonyms renaming one branch are **duplication**.
- Carry the phrases the user actually types, in their language, into hook regexes (`"pixel perfect"`, `"run the docs"`) — invocation fires
  on the words in the prompt, not a paraphrase.
- Modes, phases and rules live in the body. **Budget ≤160 chars**; past that, a hook should route it or
  the description is carrying body content.
- **Near-miss check**: 3–5 adjacent prompts sharing the words but not the job must NOT fire this skill
  — near-misses, not strangers, mis-route. Test with substantive prompts: a one-step ask basic tools
  handle triggers nothing regardless.

## 3. Information ladder

1. **Step** — an ordered action in `SKILL.md`. Primary tier.
2. **In-skill reference** — a rule consulted on demand. A flat peer-set (every rule of a review on one
   rung) is a fine arrangement, not a smell.
3. **Disclosed reference** — `references/<name>.md`, reached by a **context pointer**, loaded only when
   the pointer fires.

**Progressive disclosure** is the move down that ladder, licensed by **branching**: inline what every
branch needs, disclose what only some reach. A pointer's _wording_, not its target, decides how reliably
the agent reaches — sharpen wording first, inline only if that fails. **Co-location**: a concept's
definition, rules and caveats under one heading, not scattered.

## 4. Completion criteria

Every step ends on the condition that says the work is done. Two independent properties:

- **Clarity** — can the agent tell done from not-done? A vague bound lets it declare victory and slide on.
- **Demand** — how much it requires. "Every modified model accounted for" forces legwork; "produce a
  change list" does not. Demand also binds _flat reference_: "every rule applied" is how a skill with no
  steps carries an exhaustiveness bar.

A `Gate:` criterion — a named command plus expected output — beats prose.

## 5. Leading words

A **leading word** is a compact concept already in the model's pretraining that the agent thinks with
while running the skill — _tracer bullet_, _fog of war_, _seam_, _tight loop_, _red_. Repeated as a token
(never restated as a sentence) it anchors a region of behaviour in the fewest tokens. Hunt triads spelled
out at three sites: "fast, deterministic, low-overhead" collapses to _tight_.

## 6. Pruning verdicts

Line by line for the first three, **sentence by sentence** for the last two:

- **Single source of truth** — each meaning in exactly one authoritative place.
- **Relevance** — does the line still bear on what the skill does?
- **Duplication** — the same meaning twice: costs maintenance and tokens, inflates its rank on the ladder.
- **No-op** — the model already does this by default, so you pay load to say nothing. Test: does the line
  change behaviour _versus the default_? Model-relative — settle disputes by running the skill. A leading
  word too weak to beat the default is a no-op; the fix is a stronger word.
- **Negation** — prohibition backfires: naming the banned behaviour makes it _more_ available. Prompt
  the **positive** — state the target so the banned one is never spoken.

House style ends most skills with **Red flags** — a _post-hoc self-check_ against finished work, not
in-flow steering. One that reads as an instruction belongs in the body, phrased positively.

## 7. Ship checklist

- [ ] Invocation axis deliberate; description within budget (§2), triggers not identity.
- [ ] `SKILL.md` ≤8 KB (≤12 KB once ≥3 `references/` files carry the detail; each reference ≤12 KB) —
      the audit checks it. The cap is a ceiling, never a target: a line earns its bytes by changing behaviour.
- [ ] Headroom left: under 80 B from a cap the audit warns early, body and `references/` alike —
      answer it by disclosing a block, never by trimming meaning to fit the number.
- [ ] Every step has a checkable completion criterion; verification names a real command.
- [ ] Pruning verdicts run — no-op and negation sentence by sentence.
- [ ] English body (`language-guard` denies Russian); user-facing output stays Russian.
- [ ] Router `agentdeck-kit:skill-map` updated — a map omitting a new skill or routing to a removed one lies.
- [ ] `node <kit>/tools/skills-audit.mjs` clean for this skill.
