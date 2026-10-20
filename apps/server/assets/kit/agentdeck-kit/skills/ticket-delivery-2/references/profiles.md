# Profiles and the MR follow-up mode — picked once, at §3

A profile narrows the conveyor to the ticket's surface: it cuts stages that surface cannot reach and
gives the §9 reviewer and the §10 walk the right lens. It never lowers the §3 tier, never removes the
§6 gate, the negative row, the ledger or the Stop-and-ask list. Each profile is its own page, read
once after the pick; this page only picks. Pages, not skills: nothing joins the skill listing every
session pays for.

## Pick — from the §1 code classification and the §3 plan's file list

| Profile   | Signal                                                                           | Page                                         |
| --------- | -------------------------------------------------------------------------------- | -------------------------------------------- |
| design    | the ticket hands over a Figma link or node, or asks to match the mock one to one | [profile-design.md](profile-design.md)       |
| frontend  | every planned file is front: components, pages, styles, i18n, front tests        | [profile-frontend.md](profile-frontend.md)   |
| backend   | no file a user sees: handlers, services, queries, workers, jobs                  | [profile-backend.md](profile-backend.md)     |
| fullstack | both sides, or a contract / shared type / API shape both sides read              | [profile-fullstack.md](profile-fullstack.md) |
| none      | docs, CI, config, tooling, or unclear                                            | SKILL.md as written                          |

First match wins, top to bottom. A panel group that pins a profile (its path step names the page)
outranks the signal. Written once into the `03-plan` row: `profile: frontend`. The diff crossing the
boundary later (a front ticket needs a server fix) → switch to fullstack, one ledger row, and the
§1 backend question is asked then — never earlier for a profile that does not need it.

Several tickets in one handover: one profile over the whole diff; mixed sides → fullstack.

## Mode: MR follow-up — reviewer threads on an MR that already exists

Input: an MR link with 'fix the review comments', 'answer the threads', or a panel stage naming
threads. The conveyor runs short; the ledger key is the MR's ticket (no ticket → `mr-<iid>`).

- **§1** one discussions call: every unresolved thread, plus the MR diff. No claim — it is taken. Each
  thread is classified by code: agree → fix, disagree → reasoned answer with `file:line`, unclear →
  one question to the user.
- **§2** check out the MR's own branch; no new branch; no rebase unless the MR conflicts (§11).
- **§3** each thread = one statement; `risk-tier.mjs --base <MR head before the fixes>` over the fix
  diff only.
- **§4/§7** only for a thread asking for a visible change.
- **§9** no review agent: the human reviewer IS the review. A behaviour-bearing fix → one `deep-review` over the fix diff.
- **§10** only the rows the fixes touch.
- **§6** `gate-run --affected` — the touched zones and their dependents; FULL only when it says so
  (shared config, lockfile, CI file — gates.md §When the full gate runs).
- **§8** push to the MR's branch; the description changes only where its Verification table did.
- **§12** a reply per thread — what changed with `file:line`, or the reasoned disagreement. Replies
  are drafted into the ledger and posted after the user's yes for the batch, unless a project grant
  covers MR notes. A thread is resolved only where the team convention lets the author resolve it.

Then DONE: no pipeline read, no trunk chase (gates.md §Pipeline, §Target branch).
