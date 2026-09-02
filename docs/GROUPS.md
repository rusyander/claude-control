# Groups: bundles of settings, project binding and a working order

The Groups section is the only one in the panel that Claude Code itself knows nothing about. It sees
rules, skills, hooks, MCP servers and permissions one by one; a group exists only in the panel's own
data and is there for you, so that these can be switched on and off in bundles instead of
individually.

🇷🇺 [Русская версия](GROUPS.ru.md) · 📖 [Project overview](../README.md) ·
🔧 [Setup and troubleshooting](SETUP.md) · 🚫 [What the panel does not do](LIMITATIONS.md)

---

## Why this exists

A single task usually needs several settings at once: two or three rules in `CLAUDE.md`, a couple of
skills, a pre-commit hook, the tracker's MCP server, a few permission entries. Switching them one by
one is exactly where time is lost: a hook left on, a server left connected, a rule from one project
caught in another.

A group solves this with one switch. Inside it are **references** to entities that already exist, not
copies of them: the same entity can belong to several groups, and its text stays single.

## What can go into a group

Five kinds of entity, plus a group itself:

| What          | Where it lives on disk             | What happens when the group is switched off                                |
| ------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| Rule          | a section in `~/.claude/CLAUDE.md` | moves to the “Disabled rules” service section                              |
| Skill         | a folder in `~/.claude/skills/`    | the folder moves to `skills-disabled/`                                     |
| Hook          | `~/.claude/settings.json`          | the command disappears from the file, its text is kept in the panel's data |
| MCP server    | `~/.claude.json`                   | moves to the `mcpServersDisabled` key                                      |
| Permission    | `~/.claude/settings.json`          | is removed from the allow list                                             |
| Another group | the panel's data                   | goes off with its parent; the panel will not let you create a cycle        |

Switching off **never deletes**. The rule's text, the skill's files, the hook's command all stay
where they were — only what Claude Code sees changes. Bisecting for a culprit relies on this: switch
off half the bundle, run, switch it back.

Besides its members, a group holds **environment variables**: while the group is on they sit in
`settings.json`, and they are removed when it goes off. The panel remembers which ones it set, so
variables you set by hand — or another group set — are left alone.

## Which switch wins

The most common question about this section is “I switch it on and it does not come on.” The reason
is that an entity has **two independent reasons to be off**: you switched it off yourself, and a
group is holding it down. The panel remembers these separately, and the entity is on only when both
reasons are gone.

Hence four rules that cover every case:

1. **A group does not undo a manual switch-off.** If you switched a member off with its own toggle,
   switching the group on will not revive it. A group only releases what it took down itself.
2. **Two groups hold in turn.** A member of two disabled groups comes back only when both are on.
3. **A single toggle is weaker than a group.** While a group holds a member down, its own switch
   cannot turn it on: the panel will remember your decision, but nothing changes on disk — the entity
   stays off until the group is on.
4. **Deleting a disabled group releases its members.** There is nothing holding them any more, so
   they come on — all except those switched off by hand and those held by a second disabled group.

A disabled group and a disabled scenario are marked with a badge, so the state is visible in the list
without opening the card.

## Project binding: the group switches itself on

A group can name one or more project paths. After that you no longer switch it on by hand:

- **When it fires.** The moment a run starts in that directory. The panel looks at the working folder
  and switches on the groups bound to it. This covers chats the panel creates itself as well — a
  [task split across branches](#groups-and-task-splitting) and a continuation in a clean session:
  otherwise such a chat would start with the project's rules and skills off.
- **A group already on is not touched at all** — not a single write to disk.
- **Branch copies count as the same project.** A parallel copy lives in the neighbouring directory
  `<project>-worktrees/<branch>`, and the binding knows it: chats split across branches get the same
  bundle.
- **It never switches back off.** Leaving the project does not take the group down, and that is
  deliberate: the configuration files are shared by every run in flight, and switching off would hit
  someone else's live agent. Switching off is manual only. If you do not want the automation, remove
  the path from the bindings on the Groups page.

A bound group's card carries a «From the project» block: the own set of every bound directory —
skills from `.claude/skills`, hooks from `.claude/settings.json` and rules from `.claude/rules`.
Claude Code loads them together with the user-level ones, which is why a bound group looked empty
without it. The panel only shows them: the set belongs to the project's git and is edited there.

One consequence looks like a bug unless you know it: **a group can switch itself on without you.** If
you find a group enabled that you never touched, a run started in a directory bound to it.

## Working order: steps that become a skill

A group can hold not only members but a **working order** — the steps of a routine task: where the
agent starts, what it does, how it finishes. Claude knows nothing about groups, so the steps do not
stay a description: the panel compiles them into an ordinary skill, `skills/scenario-…`, with a
header and sections, and that skill immediately becomes a member of the group — it goes off and on
with it and obeys its project binding.

Two fields without which the list stays a wish:

- **“done when”** on every step — the completion mark. Without it the agent decides for itself that a
  step is finished.
- **the trigger** — a regular expression over the request text. A skill's description only offers
  itself to the model; the expression installs a `UserPromptSubmit` hook next to the skill that
  brings the working order up by itself. The panel rejects an invalid expression.

The block is called “Working order” rather than “Scenarios” because on this same page “Scenarios”
already means when-then automations.

## Scenarios: a hook in plain words

A scenario is a hook described in plain words: “when” is picked from the list of Claude Code events,
“what to do” is written as a command. Scenarios have no magic of their own — everything a scenario
can do, a hook can do; the value is not having to remember `settings.json` syntax.

Recompilation happens on every save. Compiled scenarios land in `settings.json` as ordinary hooks,
and a marker referencing the scenario is appended to the command — that is how the panel tells its
own from yours. **Hooks written by hand are never touched:** the absence of that marker is what
identifies them.

Every scenario has its own toggle: a disabled one does not reach the compiled hooks and is marked
with a badge.

## Groups and task splitting

When the agent offers to spread a list of tasks across separate chats and branches, each spawned chat
works in its own copy of the repository, `<project>-worktrees/<branch>`. For the binding this is the
same project, so the bundle switches itself on there and is the same as in the main chat. The same
holds for a continuation in a clean session: it runs in the same directory and on the same branch.

The practical conclusion: if a group is bound to the project, nothing extra needs configuring — the
agents split across branches get the same rules and skills.

## What not to expect from groups

- **Claude does not know about groups.** For it there are only the resulting settings: enabled rules,
  skills sitting in place, hooks in `settings.json`. Asking the agent to “switch group X on” is
  pointless — the panel does that.
- **A scenario can do no more than a hook.** It is the same hook, only you do not have to write it by
  hand.
- **A group does not override your decisions.** Everything you switched off personally stays off.

## Where this is stored

Group membership, bindings, working order and scenarios live in the panel's data —
`~/.claude/claude-control/`, separate from Claude Code's configuration. Only the result reaches the
configuration: whether members are enabled, the group's variables and the compiled hooks. A backup is
made before every write.

## Conflicts inside a group

If one group ends up with two permission members carrying the same pattern and opposite decisions
(one allows, the other denies), the panel shows a warning in the group's card. That is not an error
in itself — but the outcome then depends on order, and it is better to decide explicitly.

Member order is set with the ↑ and ↓ arrows in the group's card.
