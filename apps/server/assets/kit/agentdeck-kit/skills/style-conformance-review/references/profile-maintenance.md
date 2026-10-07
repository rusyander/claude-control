# Phase 3 — Maintaining the profile (how review remarks become rules)

## Sources

- **Forge harvest — the main channel.** `node <kit>/tools/review-harvest.mjs --profile <profile>`
  from the repo root: every human note on MY merge requests since the header's `Harvested through`
  (else the profile's `modified:`, else 30 days), replies in my threads marked `↳`, bots and system
  notes dropped, one line each with a `#note_N` link; `--full` for whole bodies, `--json` for a script.
  GET only. First run on an old profile is big (one real repo: 55 MRs, 103 notes, 47 KB) — redirect to a
  scratch file and read it in parts. The user relaying a comment is the second channel, not the first:
  a relay covers the MRs the user happened to open.
- Watermark: printed only after a full read → write it into the header verbatim. `watermark: none`
  (exit 1, an MR unread) → fold what came, keep the old watermark, name the unread MR in the report.
- 0 remarks over many MRs = this team reviews in chat (one real repo: 61 MRs, 0 notes) — there the
  feedback memories are the channel. Each style-bearing `type: feedback` memory newer than the profile
  → one rule `[user DD.MM] <rule> [[memory-name]]`; a user override of a global rule matters most
  (e.g. `border-radius` staying on `var(--radius-*)` against the global numeric-literal rule — it
  lived only in a memory, so a review reading the profile would have "fixed" it).

Why both channels (calibrated on real repos): one profile's last lesson was a month old; ~17 style remarks followed
on own MRs and none reached the profile; seven of them were stale comments — the rule was already in
the profile, but the check read only the comments beside the edit, and the lying one sat outside the
diff. Another repo's profile was a byte copy of a sibling repo's pre-migration one, hash unknown to the
repo, while 15 feedback memories written after it were never folded in.

## Sort every remark before writing anything

- **style / convention** (placement, naming, extraction, typing, layering, comments, i18n keys,
  duplication) → a rule. Short line-anchored asks ("extract to a constant", "why useCallback here",
  "do it with a map") are almost always this class.
- **correctness** (a bug, a race, a contract mismatch) → not the profile; it is deep-review's axis 1.
  Only its _shape_ can become a lesson when it recurs (e.g. «a claim in a comment the code disproves»).
- **consciously accepted** — the author declined and the reviewer let it go → a one-line «accepted»
  note, so the next review does not raise it again.
- Process remarks (MR description, ticket numbers, merge order) → `agentdeck-kit:changelog-builder` / `agentdeck-kit:prepare-mr`
  territory, not code style.

## Writing a lesson

- Generalise from the case, cite the MRs: `rule (!556 !575)`. One rule per convention — a new case of
  an existing rule adds its `!N`, never a second line.
- A lesson contradicting a conventions section → review beats code beats docs: rewrite the section,
  say which review won.
- A remark matching a rule ALREADY in the profile → append `(recurred !N, DD.MM)`. Recurrence means
  the check did not run where it should, or runs too narrow — widen the Phase 2 step, not the wording.
- Keep «Review lessons» newest first and the profile under ~150 lines: merge before appending.

## Other upkeep

- Profile-vs-reality divergence found in Phase 2 → fix the profile in the same run.
- Stale section (criteria: SKILL.md Phase 0) → rebuild incrementally: only that section.
- After any update — refresh the header: commit hash/date for re-checked sections, watermark for the
  harvest.
