# §10 — the live run and its printed verdict

Not a re-read of the code and not another screenshot: the stand runs and the flow is walked. The
verdict is a table, not a sentence — what did not make it into the table was not verified, and that
is visible to everyone, the agent included.

## The suite

```js
import { pathToFileURL } from 'node:url';
// <kit> = the kit root (printed with the kit rules at session start)
const { suite } = await import(pathToFileURL('<kit>/tools/acceptance.mjs').href);

const t = suite('PROJ-777 — <what is checked>'); // tier and radius come from risk-tier itself
t.check('message appears in the feed', /Hello/, await feedText());
t.expectFail('empty message', /required/i, await errorText());
t.variation('delay /agents +1500 ms', 'skeleton', await stateName()); // T2 owes two
for (const e of t.entries) t.walked(e.label, 'screen opens with data', true, await opens(e));
process.exit(t.report());
```

`report()` prints a markdown table that goes into the MR and the QA comment unchanged, and exits
non-zero when anything failed · when there was **no negative row at all** — a walk that says nothing
about bad input is not a walk · at T2 with fewer than two `variation` rows · at T1/T2 while an entry
point under the cap (3 / 6) has no `walked` row. Entries over the cap are printed «NOT WALKED» by
name: the cap is the time budget, and what it cut is part of the verdict. The table computes the
tier itself and says where it came from; a tier that could not be computed is never shown as T0.

Pass `{ tier: 'T1' }` only to override a computed tier deliberately — the table then says so.

## The minimum, and the variations above it

At minimum one path that must succeed and one that must fail correctly: validation refused with the
right message, permission denied, empty state, network error. A non-visual change gets the
equivalent at its own level — the endpoint plus a deliberately wrong request, the script plus bad
input.

**At T2, two variations on top**, highest yield first. The happy path is green by construction, so
the defects live one step beside it:

- delay ONE of the N requests a screen fires and read the intermediate state — every loading guard
  written against "the data is here or it is not" breaks here, and nothing else in the stack catches
  it;
- the same screen for a role without the write right: a grey control with no stated reason reads as
  a broken page;
- zero rows, then one row;
- bad input, already covered by the negative row.

Whatever the project's e2e harness gives for these, use it; a trap found during the walk is fixed in
that harness, not remembered. Memory does not survive the next ticket; the harness does.

## Parity in both directions

A ticket carrying an authority — a design changelog, an API contract, an acceptance table — owes a
parity run in BOTH directions, and its verdict is a ledger row: everything the authority demands is
in the artifact, AND everything the artifact changed the authority authorised. The allowed set comes
from exactly the rows that grant permission, never a looser source — scope drift is invisible to the
first direction alone, and a check built that way can only ever confirm.

## The table itself is unverified code — show it red before quoting it green

An acceptance script is written once, for one ticket, and nothing tests it; every bug in it — a
selector that silently matches nothing, a field read off the wrong object, an `undefined` compared
to `undefined` — makes the run GREENER. So the table is run once against the state the fix removed:
the pre-fix revision, the pre-fix container image, the branch point. Rows that must fail then fail,
by name, and the count is recorded in the ledger beside the green one.

Keep the target selectable rather than hard-coded — an env override for the image or base URL costs
one line and is what makes the red run possible at all. Stays green on the old state ⇒ the table
proves nothing and may not be cited, whatever its summary says.

## Where the scripts live

In the ticket's own folder under the project's e2e or scripts root, named by the key. Never at the
harness root: that is where graveyards of abandoned one-off probes come from. They are deleted at
§13, leaving the shots script and the folder README.

A bug found during the walk is fixed on the spot, the §6 gates run again, and **only the spot it
touched is retested** — not the whole walk. Both the bug and its retest go into the ledger.

## The `10-live` note — what §12 and §13 read later

The head sha the table ran on · the PID and port of any dev server started for the walk · the id of
every entity the walk created on a shared stand, named `qa-<KEY>-<what>`. A commit after the run
means the table runs again on the new head — the touched rows at least — and a new note names it.
