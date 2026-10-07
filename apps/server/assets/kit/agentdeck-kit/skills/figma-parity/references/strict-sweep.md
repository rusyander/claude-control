# Phase 5S — STRICT visual sweep (mode `AUTO+STRICT` only)

Phases 2-5 compare NUMBERS against the nodes the checklist enumerated. Whatever the checklist
never listed survives a 99% score: an element nobody mapped, a wrong glyph, blocks in the wrong
order, a shadow drawn as an image, a state screen that was never matched to a frame. This phase
closes that hole — every final artifact of the run is compared to its design counterpart AS AN
IMAGE, and every claim the image raises is then re-proved with numbers.

Runs after Phase 5 converged, before Phase 6. `AUDIT-ONLY` never reaches it; plain `AUTO` skips
it. Cost is the mode's point: all N artifacts compared, never a sample. Never traded down.

## 5S.1 Artifact inventory — N is fixed here, and N is everything

Enumerate every PNG the run produced as a FINAL state: `shots/<screen>/after.png`, every
`state-*.png`, the last frame of every `motion-*.png` strip, every data-case shot, every modal /
sheet / sub-screen captured. 32 shots → 32 pairs. No sampling, no top-N, no "the small ones are
obviously fine". Write `.agent/figma-parity/sweep/inventory.json`:

```jsonc
{
  "pairs": [
    {
      "id": "login-hover",
      "screen": "Login",
      "kind": "screen|state|motion|data",
      "shot": "../shots/login/state-hover.png", // paths relative to this file
      "figmaShot": "../ref/login/states/hover.png",
      "figmaNode": "12:340",
      "mappedBy": "variant name «Button/hover»",
    },
  ],
}
```

## 5S.2 Mapping — 100% resolved or named out loud

Every artifact resolves to a Figma counterpart, in this order: cached `ref/<screen>/metadata.json`
name match → the node the checklist rows for that shot already point at → the Q4 mapping the user
confirmed → a state/variant frame of the same component.

- Unresolvable → `.agent/figma-parity/sweep/UNMAPPED.agent.md` (artifact, what was searched, why it
  failed). It still appears in the report. Never dropped silently — an uncompared shot is the
  exact failure this phase exists to prevent.
- **Reverse direction, equally binding.** Every frame and variant on the screens page with no
  artifact = a screen or state that was never captured. Reachable → capture it now and add the
  pair. Not reachable → escalate as missing coverage, do not quietly narrow N.
- Extra Figma pulls this phase needs (state-variant screenshots) stay orchestrator-only, one per
  node, cached — `figma-access.md` is unchanged, including "never switch the user's page".

## 5S.3 Composites

```bash
node <kit>/skills/figma-parity/tools/visual-sweep.mjs .agent/figma-parity/sweep/inventory.json
```

Per pair, into `.agent/figma-parity/sweep/<id>/`: `pair.png` (both normalised to one width, side
by side, same scale), `overlay.png` (front over design at 50%), `heat.png` (blocked colour delta).

`heat.png` and the tool's `attentionOnly_hotBlocksPct` are an **attention map — where to look**.
They are never a verdict and never a parity percentage (`scoring.md`). Playwright not importable
→ the tool writes `pairs.json` alone and says "no composites"; the sweep runs on the two raw
images.

## 5S.4 Comparison — batches of ≤5 pairs

The only place in this skill where image bytes are read. Agents picked at intake → one comparison
agent per batch, in parallel, and the bytes stay in their contexts. Declined → I compare batch by
batch, `found.md` written before the next batch opens.

Input per pair: the two shots + the three composites, `checks/<screen>.json`, viewport, scale policy
and `k`, and the screen's LEGIT list. Look for what numbers structurally cannot see:

1. element present / absent / extra;
2. order and composition of blocks;
3. alignment and optical position;
4. glyph identity, image crop and aspect;
5. text copy and truncation vs the design's own text;
6. z-order, elevation, overlap;
7. anything the checklist has no row for at all.

Re-reporting a check the checklist already marks `ok` is out of scope — that is the numeric pass's
job and duplicating it wastes the round. Return ≤10 lines to chat, full table to
`sweep/<id>/found.md`: `region (coarse xy) · design shows · front shows · suspected property ·
confidence`. "Looks the same" is not a return: an empty table is (0 rows, stated explicitly).

## 5S.5 Numbers decide — the image only proposes

Every row is re-proved before anything is touched: locate the element live via Playwright, read
`getComputedStyle` + bounds, compare against the cached Figma spec of the mapped node.

- **Confirmed** (two numbers disagree, or the element is genuinely absent/extra) → normal Phase 4
  bucket: AUTO fixed now, ESCALATE written to the decision file.
- **Not confirmed** (numbers match inside tolerance) → **discarded as a false positive**. One line
  in `sweep/FALSE-POSITIVES.md`: pair, the claim, the two numbers that refuted it. Never fixed on
  a visual impression alone.
- **Not numerically measurable** (glyph identity, crop, block order, text copy) → a second agent
  with a different lens re-checks that one claim. Both agree → real. Disagree → a third decides by
  majority. Still split → decision file, never a silent fix.

## 5S.6 Loop until dry

Re-capture only the artifacts a fix touched, re-run their pairs. A round that adds zero confirmed
findings ends the sweep. Cap 3 rounds; hitting the cap is reported, not hidden. Confirmed count
per round goes to `.agent/PROGRESS.md`, so a compaction costs one round, not the sweep.

Cross-screen rule from `scoring.md` still applies: a shared token touched here re-scores its other
consumers before the round closes.

## 5S.7 The STRICT gate

The run is not reported done while any of these is true:

- an artifact is neither compared nor listed in `UNMAPPED.md`;
- a Figma frame or variant has no artifact and no stated reason;
- a confirmed finding is neither fixed nor escalated;
- the last round was capped at 3 without going dry, and that is not said.

Per-screen thresholds stay as `scoring.md` defines them. The sweep adds one coverage line, with
its own denominator, to the report and the chat answer:

```
compared N/N · confirmed X · fixed Y · escalated Z · false positives W
```

Any denominator other than N is stated together with the reason it is not N.
