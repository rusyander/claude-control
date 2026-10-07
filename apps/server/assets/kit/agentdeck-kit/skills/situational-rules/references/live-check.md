# Live check — a stand, a browser or an end-to-end script is about to run

Depth and the red-before rule sit in `verification-depth.md`; this is what to actually exercise.

## The happy path is green by construction

Walking the flow the change was built for proves the build compiled. Defects live one step off it, so
a live run is worth exactly the **variations** it adds. Four classes, in descending yield:

1. **Timing** — delay ONE of the N requests a screen fires and look at the intermediate state. Every
   loading guard written against "the data is here or it is not" breaks here; a guard narrowed from
   three queries to one is invisible to every other check. Highest yield in any React Query / SWR
   codebase, and the cheapest to stage (`page.route` + a sleep).
2. **Role** — the same screen under an account without the write permission. Grey controls with no
   stated reason read as a broken page; permission checks copied between two components drift.
3. **Empty and extreme** — zero rows, one row, a name at the length limit, a list past the first page.
4. **Bad input** — the negative case: a wrong value must be refused with a message a human can act on,
   never accepted silently. A run with no negative row says nothing about where defects live. A
   changed type, limit or validation owes the **boundary negative**: the value one step past it —
   max+1, the wrong type, empty or missing — gets the documented refusal, the value just inside passes.

T1 owes one positive and one negative. T2 owes two variations on top, chosen by what the change
touches — not the two that are easiest to stage.

**Where to walk comes from the radius, not from the ticket title.** `risk-tier.mjs` lists the entry
points — screens and routes — that reach the changed code, capped at 3 for T1 and 6 for T2. Each one
under the cap owes a **positive walk**: open it, exercise the changed behaviour, one table row. The
negative and the variations stay on the ticket's own screen — multiplying them by every entry is how
a check grows to ten times the fix. Entries over the cap are printed as not walked, by name.

## The variations have to be cheap or they will not happen

A variation hand-rolled per ticket costs more than the defect it finds, so it gets skipped under time
pressure and the skipping is invisible. They belong in the project's own harness — session and login,
route interception, role masking, theme, the readers that pull state out of the DOM — so a ticket
script is a scenario and nothing else. **A trap discovered during a run is fixed in the harness, not
remembered**: quoting in the env file, the exact path prefix a mask has to match, the request storm
right after login. Memory does not survive the next ticket; the harness does.

Probe scripts are throwaway and the scenario script is not: keep the scenario in the ticket's own
folder, delete the probes when the run is done.

## The verdict is a printed table, not a sentence

Each checkable statement from the plan becomes a row: what was expected, what the stand actually
showed, and the verdict. The table is the artifact that goes into the MR and the QA comment unchanged.
A row nobody printed was not checked, and neither the run's own summary line nor a number recalled
afterwards substitutes for the output.

## Reporting

Name the stand, the account, the browser, and which paths were walked. Anything not run — another
browser, a touch device, a real screen reader, a state the stand cannot reach — is listed as not
verified, with the reason. A user rebuild does not exist: a check that cannot be run now is reported
as not done, never parked on a future one. Never retry a failed login: that is how accounts lock.

Before/after images for a visible change are a separate obligation: `visible-fix-shots.md`.
