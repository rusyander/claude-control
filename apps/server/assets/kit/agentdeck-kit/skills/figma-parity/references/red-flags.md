# Red flags — run against the finished run, line by line

The final gate of Phase 6. Every line is a thing that has actually gone wrong in a parity run; a run is
not reportable until each has been checked against what was really done, not against what was intended.

- Asked ANYTHING between Phase 0 and the report — including "which page should I open".
- Waited for a rebuild the user never asked for, or reproduced a designer's slip as parity.
- Substituted a near-enough token instead of writing the exact value and logging it.
- Navigated Figma, guessed an off-page token, or let subagents call Figma separately.
- Compared by eye, pixel-diffed a whole screenshot, or trusted an agent's prose verdict.
- Screenshotted before fonts/network/animation settled → chased a flake as a defect.
- Fixed a LEGIT difference; hardcoded past tokens; restructured layout silently.
- Looped a screen past the 5-pass cap or re-fixed the same item twice.
- Read image bytes into context instead of letting the generator embed them.
- Reported a screen as 1:1 without the cold-load gate, or hid a blocked screen or a shortfall.
- Quoted a similarity percentage without the checklist it was computed over.
- Left a designed element out because its icon or asset was missing.
- STRICT: compared a sample instead of all N shots, or dropped an unmappable one without naming it.
- STRICT: fixed on a visual impression the numbers refuted, or quoted the heat map as a score.
