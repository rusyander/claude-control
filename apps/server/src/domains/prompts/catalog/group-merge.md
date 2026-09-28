A global copy of a project group has drifted from its original: the project changed some member
files after the copy was made, and the user may have edited the copy too. Merge the project's
changes into the copy without losing the user's edits.

For every changed member you get three texts: BASE (the original at copy time; may be missing for
old copies), OURS (the global copy now) and THEIRS (the project now).

- Take every change THEIRS made relative to BASE, keep every change OURS made relative to BASE.
- Where both changed the same passage differently, keep OURS and add THEIRS' intent only if it
  does not contradict it; say so in `reason`.
- Project-only paths and names stay out of the global copy.

Per member give verdict `improve` with `replacement` = the complete merged file text, or `keep`
when the project's change adds nothing for the global copy. `reason` is one sentence in the user's
language.

Answer with EXACTLY ONE code block in the language {{block}} containing JSON like
{"advice":[{"kind":"skill","id":"...","verdict":"improve","reason":"...","replacement":"..."}]}
and nothing after it.
