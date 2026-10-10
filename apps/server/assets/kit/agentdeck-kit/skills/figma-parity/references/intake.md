# Phase 0 — the only interruption before the end

The contract with the user: **everything the run could need is asked HERE, in one turn. After
that the run does not stop until the final decision set.** Anything discovered later that would
have been a question becomes a file entry, never a prompt.

## The question set (one AskUserQuestion in the user's language, recommended option first)

**Q1 — Mode**

- `AUTO` (recommended by default) — walk every screen, fix what is fixable, loop each screen until
  it converges, ask nothing more; open items collected for the end.
- `AUTO + STRICT SWEEP` (recommend this one whenever the user asked for "one to one", "pixel
  perfect" or "strict mode", in any language) — everything AUTO does, plus Phase 5S: when the work is finished,
  every shot the run took is compared as an image against its own place in Figma — all of them, not
  a sample — and what that finds is confirmed by numbers and fixed. Slower and noticeably more
  expensive; that is the price of the last few percent. `references/strict-sweep.md`.
- `AUDIT-ONLY` — measure and report, change no code.

Same question, second axis — **subagents** (`CLAUDE.md` → orchestration is opt-in, so they run only
if picked here, fleet size quoted): Phase 2 lens agents (3-5 per screen) and Phase 5S comparison
agents (one per batch of ≤5 pairs, ⌈N/5⌉ in all). Declined → I run the lenses in sequence and compare
the 5S pairs myself, one batch at a time — slower, and the images then enter the main context.

**Q2 — Scale policy** (quote the detected numbers: Figma frame width vs front viewport)

- `STRICT` — every px from Figma taken literally, ±1px, at one fixed width. Exactly the mock;
  other viewports are out of scope. Correct choice for a non-adaptive fixed-width target.
- `PROPORTIONAL` — geometry mapped by `k = frontWidth / figmaFrameWidth` onto DS tokens; colors,
  icons, composition stay 1:1; container widths and fill degree are legitimate differences.

**Q3 — target width** — the viewport all measurement and shots use (e.g. 400). Ask whether
other widths are in scope at all; a non-adaptive target means no responsive findings.

**Q4 — screen coverage** — the mapping is proposed by the agent, not requested from the user:
list the Figma frames (`get_metadata` on the file/page) and the front's routes (router config,
route files, nav), match them by name, and show the user only:

- the matched pairs as a compact confirm list,
- unmatched Figma frames and unmatched routes,
- screens that need a precondition the agent cannot invent (a specific account/role, seeded
  data, a feature flag, a modal reachable only after an action).

**Q5 — rebuild** — default is NO: the stand hot-reloads, verification happens immediately after
each fix. Only if the user has said they will rebuild does the run pause for it. State the
assumed default so a silent user gets the right one.

Also confirm, without asking where the answer is discoverable: Figma link + node-id, the real
Dev Mode MCP is attached (`figma` tools present in session — if absent, say so now and stop:
this is the one hard blocker), the stand answers, the e2e kit exists, theme and locale the
design is drawn in.

## Preflight — do every first-of-its-kind call while the user is still here

A permission dialog three hours in is the exact interruption this skill exists to prevent. So
smoke-test the whole toolchain NOW, in Phase 0, and report only what is missing:

1. `figma` MCP tools present, and a real call returns (`get_metadata` on the given node). Absent
   → the one hard blocker; stop and say what to start/reconnect.
2. Playwright launches, opens the stand, takes one throwaway screenshot to
   `.agent/figma-parity/preflight.png`, and reads one computed style.
3. One `Write`/`Edit` to a scratch file and one `node` run — the same call shapes the loop will
   repeat thousands of times.
4. The project's gate commands run (`type-check`, `lint`, `test` — the cheapest of them).
5. Read the CLI's user and project settings (permission allowlists) to name concretely
   what is not allowlisted, instead of "permissions may be asked".

Any of 2-5 prompting or failing → ask in this same turn: grant it, or the run cannot be
unattended. Everything green → say one line and start; do not turn a green preflight into a
question.

## Long-run hygiene

- `.agent/PROGRESS.md` — the screen queue with per-screen status and last parity score, the
  answers to Q1-Q5, the scale/`k` verdict. Written before the first fix, updated per screen, so
  a compaction costs nothing.
- Files that will collect open items, created empty up front so nothing is lost:
  `ASK-FIGMA.md` · `NO-TOKEN.md` · `SNAPPED.md` · `DECISIONS.md` · `ICONS-MISSING.md` ·
  `scale-inventory.md` · `checks/`. STRICT also: `sweep/UNMAPPED.md` · `sweep/FALSE-POSITIVES.md`.
- STRICT chosen → Q4's mapping is also the sweep's mapping seed, so unmatched frames and routes
  matter more here: say plainly that anything left unmatched will surface again in the final sweep.

## Phase 1 — reference pull, once per screen, orchestrator only

Details and the read-only Figma policy: `figma-access.md`. Cache to
`.agent/figma-parity/ref/<screen>/`, record the design frame width, and pull every screen's
reference up front so the fix phase never touches Figma again.
