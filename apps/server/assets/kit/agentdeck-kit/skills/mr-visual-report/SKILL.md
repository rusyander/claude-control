---
name: mr-visual-report
description: Use when a UI change is finished and its MR needs a visual report — before/after shots per changed page, shots of new pages, a QA section with steps and test data on top.
---

# MR visual report

The MR description must let a reviewer SEE the change and let QA test it without asking anyone.

## Inputs

- Final 'after' shots of every touched page (all states).
- 'Before' shots: taken before the first edit. If they are missing, shoot the base branch on the stand. Never pass a Figma frame off as 'before'.

## Steps

1. Find the MR of the current branch. If there is none, draft the description and ask before creating it — an MR write needs an explicit yes.
2. Classify each touched page:
   - changed: a before/after pair per changed spot, same viewport and same data on both sides;
   - new: name, route, one-line purpose, shots of every new spot in every state (empty, filled, error, loading, modals).
3. Upload the images as MR attachments. Local paths never appear in the text. Open each uploaded link.
4. Description order:
   1. `## For QA` — where to open (routes or stand URL), numbered steps with the expected result, test data (accounts and roles, required entities and flags, how to create them). Secrets are referenced by where they live, never written inline.
   2. `## Changed pages` — per page, before/after pairs, one line on what changed.
   3. `## New pages` — per page, purpose plus shots.
5. Published-text rule: only what changed and why. No process narration, no authorship, no local paths.
6. Show the draft to the user and write to the MR only after an explicit yes. Afterwards read the MR back and confirm every image renders.

## Done when

The QA section comes first and contains steps and test data; every changed page has a before/after pair; every new page has at least one shot; every image renders from the MR itself.
