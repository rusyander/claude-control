---
name: requirements-grilling
description: 'Use when a task admits several readings, hides a gap, or points at something unlocatable — grill the decisions out in rounds, then build.'
---

# Requirements grilling — reach shared understanding before the first edit

The failure this prevents is silent: I pick one reading of an ambiguous request, build it well, and it
is the wrong thing.

## 1. The gate — three detectors, not a feeling

Run before the first edit. This fires only when I can **name** the ambiguity:

- **Two readings** — I can write two implementations that both satisfy the words literally and differ
  in what the user would see. Name both.
- **A hole** — a case the request never covers but the code must answer anyway: empty state, error,
  permission, what happens to data that already exists, what the other role sees.
- **An unlocatable subject** — the request names a thing I still cannot pin to a file, route or
  component _after a real search_. Not searched yet → search, then re-check the gate.

None fires → fast lane, build it. A clear bug report is not ambiguity: fix it. Over-interviewing a
task that was already clear is the mirror-image failure and costs the user more than a wrong guess.

## 2. Facts are mine, decisions are the user's

Before a question is allowed to reach the user, the environment must be exhausted — filesystem,
git, configs, running services, the API, the project profile. **Every question I ask must be one where a different answer changes what I build.** A
question I could have answered by reading a file is legwork handed back to the user.

## 3. Rounds over a decision tree

Decisions branch: settling one unblocks the ones hanging off it. The **frontier** is every decision
whose prerequisites are already settled — the questions answerable _now_, without guessing at answers
I have not heard yet.

- Ask the whole frontier as **one `AskUserQuestion` call**, ≤4 questions, Russian, every field Russian.
- Each question carries my **recommended answer first, labelled `(recommended)`** in the user's language — a question without a
  recommendation makes the user do my thinking.
- A question whose answer depends on another still open in this round belongs to the **next** round.
- Open-ended questions (no fixed options) go as plain text, not as forced choices.
- The user's answers reshape the tree → recompute the frontier → next round.

Facts needed for a frontier question do not block the round: look them up for that branch, ask the
rest now.

## 4. Stop — and say what you understood

- **Done** when a full round produces no new decision. Then restate the understanding in ≤5 Russian
  lines — scope, what is explicitly _out_ of scope, the decisions taken — and start building.
- **Cap: 3 rounds.** Past that, name the still-open unknowns as explicit assumptions, say so plainly,
  and build. Blocking forever is worse than a stated assumption the user can correct.
- **Silence is not agreement.** An unanswered question stays open or becomes a named assumption; it
  never becomes a yes.

## 5. Capture what was settled

- A term agreed → `.agent/glossary.md` in the same pass, never batched.
- A decision that is hard to reverse _and_ surprising _and_ carries a real trade-off → ADR
  (skill `agentdeck-kit:doc-hygiene`).
- The grilling produced several tasks rather than one → hand to `agentdeck-kit:task-spec-builder`.

## Red flags — run against the finished interview

- Asked something the filesystem, git, the API or the project profile would have answered.
- A question with no recommended answer attached.
- More than four in a round, or a question that depended on another still open in the same round.
- Interviewed a task that was already unambiguous — the fast lane was the right call.
- Started building without restating the understanding, or treated silence as a yes.
- Reached round four still asking instead of naming assumptions and moving.
