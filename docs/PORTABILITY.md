# Moving an environment between CLIs

The panel can take what is configured in one agentic CLI and lay it into the files of another:
instructions, skills, commands, subagents, hooks, permissions, MCP servers, environment variables,
plugins. The question it answers honestly while doing so is **not "did it move", but "does it work
the same"** — and every entry gets its own answer.

This document is an overview for a person: what travels, in what shape, and where the limits are.
The whole path in screenshots lives in the panel itself: **Help → Environment passport**. The
long-form illustrated explainer is [PORTABILITY.ru.pdf](PORTABILITY.ru.pdf) (Russian).

🇷🇺 [Русская версия](PORTABILITY.ru.md) · 🔌 [Providers: format details](PROVIDERS.md) ·
🚫 [What the panel does not do with other CLIs](LIMITATIONS-PROVIDERS.md)

---

## Five questions in a row

The "Environment passport" section is built as a conversation, and its order is not decoration: each
step answers the question the previous one raises.

| Step             | The question                             | What the panel does                                                                           |
| ---------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Passport**     | what is actually configured              | reads the chosen CLI files and shows entries by kind — with named omissions right beside them |
| **Fidelity**     | what of it reaches another CLI           | computes a level for every entry: natively, emulated, wired, as text, impossible              |
| **Transfer**     | what exactly changes in the target files | shows the plan by file and by line; writes only after your word                               |
| **Subscription** | should the target be kept in agreement   | rebuilds the subscribed layers from the panel canon on request                                |
| **Work**         | and the unfinished conversations?        | offers to continue them at the active CLI — by the checkpoint file, not by transcripts        |

The passport and the report write nothing. Only the transfer and the rebuild write — and every write
starts with a backup.

## The five fidelity levels

A level answers one question: is this the same entry at the target — or a similar one, or none at all.

| Level          | What it means                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Natively**   | the target has the same mechanism and the entry becomes its entry. The only level at which nothing is lost                                                                    |
| **Emulated**   | there is no such mechanism, but the panel achieves the same behaviour by its own means — the supervisor inside a panel-started run. A CLI you launch directly will not see it |
| **Wired**      | the behaviour is held by the contour in the request path: the panel sees the tool call and decides whether to let it through. Turn the contour off and the level drops        |
| **As text**    | the entry arrives as content, not as a mechanism: a skill becomes a piece of instructions. The model will read it, but text cannot stop an action                             |
| **Impossible** | the reason is named exactly: the target has no such event, the entity lives inside a foreign process, the body of the entry is synced with an account                         |

There is no "text is probably enough" in this vocabulary. When the requirements of an entry cannot be
determined, the panel assigns the worst level rather than guessing.

**The main caveat stands above the report table, not in a footnote:** entries that work only when
started through the panel can be more than half of them. A CLI you launch from your own terminal will
not see them.

## The one-off transfer

There is no "transfer" button without a shown plan — not "it is disabled", it is absent. First the
list of target files, the `+N −M` counters and the line-by-line diff, and only then the decision.

- **The backup comes first.** Every file is copied before its own write. Backups turned off in the
  settings — the transfer does not start at all: without copies there is no revert, and promising one
  without having it is worse than refusing up front.
- **One entry failed to apply — the whole migration rolls back.** Half a transferred environment
  never stays behind.
- **The revert survives a page reload.** Files you edited after the transfer are named one by one and
  are left alone by default: restoring a backup over your edit would erase it silently.
- **Files diverged from the shown plan — that is a new plan, not an error.** A fresh one takes the
  place of the old and the difference is visible.
- **The target already holds an entry with the same name and different content** — "keep · replace ·
  rename", keep by default. Neither wins silently.

## Subscribing to the canon

A one-off transfer answers "move what is there now". A subscription answers "keep this in agreement":
the panel rebuilds the subscribed layers at the target whenever you ask.

**The subscription canon is the panel own files, not the source picked at the top.** The truth has
exactly one owner and it is not a choice: otherwise the first rebuild would erase the work of the
second owner. The canon is re-read every time — a stored canon would be a second truth.

### When a file was edited by hand

The panel remembers the fingerprint of every file it wrote. A file that changed since is **held back:
not one byte.** There is no silent overwrite at all — instead there are three outcomes, and the choice
is yours:

| Outcome                          | What happens                                                                                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Take the edit into the canon** | the panel reads the target file with its own importer and appends what it parsed into its own files. There is no text splicing: only what it parsed enters the canon   |
| **Restore the projection**       | the panel rewrites from the canon what it writes itself: the whole file where the file is hers, and only her own section where she keeps a block inside a foreign file |
| **Stop writing into the file**   | ALL layers of that file are dropped from the subscription. Leaving one subscribed would re-open the same drift on the next rebuild                                     |

There is deliberately no line-level merge of your edit with the canon: it would require guessing what
you meant.

### Inside a foreign file the panel keeps its own section

Where the file belongs to the target entirely, the file is rebuilt. Where the panel appends its own
block to a foreign file (`<!-- agentdeck:portability:begin -->`), only the block is rebuilt — the text
around it stays yours. The "restore the projection" outcome works exactly the same way.

## Unfinished work

The environment has moved — and the conversations stayed at the previous CLI. The card "Unfinished
work at other CLIs" offers to continue them at the CLI that is active right now (at the active one:
the environment transfer target picked above on the page has nothing to do with it, and the card
names its own destination).

The transcript does not travel: no foreign CLI has a format for it, and the panel will not invent
one. What travels is what a clean-session continuation lives on: the **checkpoint file** in the
shared working directory (`.agent/PROGRESS.md` by default) and the **original task** of the whole
job. The source conversation stays where it is and is not closed — you can come back to it at any
moment, and a line saying where the work went appears in its feed.

A candidate is a conversation of any CLI but the active one that has a working directory and was
touched within the last day. An unusable conversation does not disappear from the list; it stands
there with its reason:

- **the continuation chain reached its cap** — eight moves in a row;
- **there is no checkpoint file in the directory** — the new conversation would have nothing to read;
- **the checkpoint has not changed since the last carry** — it would read exactly the same.

The last one is the loop guard, and its memory is shared with the clean-session continuation: a
conversation carried to another CLI will not continue on its own on the same unchanged checkpoint,
and the other way round.

One honest caveat about Claude: its feed is the CLI own transcript, and the panel does not write into
it. The work will move, but no "work carried" line appears in the old conversation unless a run is
going in it. The panel says so plainly instead of staying green and silent.

## The acceptance probe

The fidelity report is a forecast. The probe is a measurement: the panel starts the **real** target
CLI in a temporary home, puts six of its own probe entries there and answers it with a stub instead of
a model. Six probes: a hook blocks · a skill fires · a permission refuses · an MCP tool is visible ·
a variable arrived · a command expanded.

The target CLI is not on the machine — there is nothing to measure, and that is said in words. Files
are still written: the transfer is allowed in advance, and the fidelity is marked "not verified"
rather than "works".

## Limits

- **The panel does not install other CLIs.** It transfers settings, not tools.
- **A secret value is never transferred.** The variable name travels, not its contents.
- **Conversation history does not travel**: foreign CLIs have no format for it. The environment does
  — and unfinished work continues at the new CLI from the checkpoint file, see [Unfinished
  work](#unfinished-work).
- **There is no merging of two people's configurations.** A transfer is about one person, their
  environment and their machine.
- **Only the Claude path has been exercised live.** The other formats come from each CLI's own
  documentation and are covered by round-trip tests; the first real write is worth eyeballing.

What exactly is left open for each provider is in
[What the panel does not do with other CLIs](LIMITATIONS-PROVIDERS.md#sections-still-open-per-provider).
