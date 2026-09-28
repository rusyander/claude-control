import type { groupsRu } from '../../ru/topics/groups';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const groupsEn: typeof groupsRu = {
  topic: {
    title: 'Groups',
    summary: 'Setting bundles, the working order of a task and step-only scenarios',
    lead:
      'A section Claude Code itself knows nothing about: groups and scenarios live ' +
      'in the panel’s data. A group bundles rules, skills, hooks, servers and permissions into a ' +
      'set that switches on at once, and carries its own Working order for a task. A group is ' +
      'either global (in the shared directories) or project (what a project already carries in ' +
      'its .claude). A scenario is a group made of steps only; a hook joins a group as a Hook ' +
      'step of its working order.',

    guideTitle: 'What is inside',
    guideText:
      'First why this exists and what the section is NOT. Then two diagrams and four ' +
      'paths in real frames: where groups come from, the working order with a step of ' +
      'your own, a bundle for a task behind one toggle, and a group that switches on by ' +
      'itself. Then the global ↔ project pair, binding to projects and the “who ' +
      'overrides whom” rules, and at the end — what goes to disk, the fields, limits, ' +
      'fine points and undo.',

    whyEnv: 'One toggle instead of ten',
    whyEnvText:
      'Rules, skills, hooks, servers and permissions for one task go dark and come back ' +
      'together. The panel remembers what IT switched off, so switching a group on never ' +
      'touches what you switched off yourself.',
    whySources: 'A project’s order becomes visible and portable',
    whySourcesText:
      'Discovery finds the ladders projects already carry: a working-order skill, review ' +
      'rules, check hooks. A good one can be copied to the shared directories and used in ' +
      'any project without touching the original repository.',
    whyPath: 'A step of your own in the working order',
    whyPathText:
      'The working order shows how the pipeline takes a task: pipeline stages, the ' +
      'group’s skill steps and your own steps between them, each marked with where it ' +
      'comes from. A step is written in your own words — the assistant asks, suggests a ' +
      'similar resource and prepares the English side for the model itself.',
    whySimple: 'A hook without syntax',
    whySimpleText:
      'The Hook step asks for an event from the list, a matcher and a command. No need to ' +
      'remember how a hook is written in settings.json, and the hook joins the group at once.',

    diffTitle: 'What this section is NOT',
    diffCaption:
      'Four things it is mistaken for. No screenshot can refute any of them: in each ' +
      'case the screen looks exactly as the person expects.',
    diffClaude: 'Not something Claude sees',
    diffClaudeText:
      'The agent sees only the resulting settings and the working-order steps the conveyor hands ' +
      'it as further turns. Saying “switch on the review group” in a conversation means ' +
      'nothing to it — only the panel has groups.',
    diffCopy: 'Not a copy of settings',
    diffCopyText:
      'A group holds references to existing rules, skills, hooks, servers and ' +
      'permissions. One entity can belong to five groups, and deleting a group deletes ' +
      'no member. Only the explicit “Copy to global” button copies files.',
    diffMagic: 'A Hook step is an ordinary hook',
    diffMagicText:
      'A Hook step has no magic of its own: it creates an ordinary hook in settings.json, which ' +
      'works exactly like a hand-written one and shows in the Hooks section. Automations made ' +
      'earlier were moved once, at start-up, into such steps and ordinary hooks.',
    diffAuto: 'A project group is not an edit of the repository',
    diffAutoText:
      'Importing a finding and copying to global change no project file. The only thing ' +
      'the panel puts into a project is the override file, and that never reaches a ' +
      'commit and is removed byte for byte.',

    guide: {
      mapTitle: 'How it works',
      mapCaption:
        'Two diagrams: why a switched-off member does not revive when its group is ' +
        'switched on, and where each part of a group goes. Neither is visible on any screen.',
      pathTextTitle: 'The same in words',
      pathTextText:
        'Every entity carries two independent marks: “switched off by a person” and “held off by ' +
        'a group”. The panel keeps them apart, and an entity is on only when both are cleared. ' +
        'Working-order steps are not written into the configuration at all: the conveyor hands ' +
        'them to the model as turns after their stage. The override is one local rule file in ' +
        'the project, and a Hook step is an ordinary hook in settings.json.',

      sourcesTitle: 'Path one: where groups come from',
      sourcesCaption:
        'Six frames: the tabs with the card grid, a finding’s window, a pair’s window, a copy to ' +
        'shared with the agent’s advice, merging a changed original and the Members tab.',
      sSections: 'Tabs and the card grid',
      sSectionsText:
        'Four tabs: Global, In projects, Found and Discovery, each with a count. On Discovery it ' +
        'is the number of sources, or a red number of errors when a pass failed somewhere. ' +
        'While a count is being read it shows “…”, if it could not be read — “!”, never a ' +
        'zero; on a narrow screen the tabs wrap onto two lines and errors read “!N”. The ' +
        'open tab sits in the address (?tab=) and is remembered: a link opens its own tab, and ' +
        'without one the page returns to where you were; the left and right arrows switch tabs ' +
        'from the keyboard. Each tab holds a grid of cards. A card shows only the essentials: ' +
        'name, scope, When, the first steps (conveyor stages excluded), how many steps and ' +
        'members, the toggle and a warning if the original was edited or a member has no ' +
        'file. A skill’s first steps are in the interface language; while their names are ' +
        'being written the card leaves them out and counts them in “and N more”; if the ' +
        'path could not be read it says so. Clicking the name (or ' +
        'Enter on it) opens the group’s window; Escape closes it and returns focus to the card. ' +
        'Discovery shows the last pass over the sources: every project the panel knows and each ' +
        'CLI’s shared directories, with status and number of findings, errors first and in ' +
        'words (“the CLI did not answer in time”, “the model’s answer could not be parsed”), ' +
        'the detail in a tooltip; a source that is gone leaves the log; a source ' +
        'where nothing changed is not asked of the model twice. The Discover groups button runs ' +
        'the pass again.',
      sFound: 'A finding: its members and why it is a bundle',
      sFoundText:
        'A finding’s window is laid out like a group’s: “When”, why these files work ' +
        'together, the Working order tab (skill steps, view only) and Members with one ' +
        'line about each member. “Import” in the window’s header makes the finding a ' +
        'project group: a record in the panel, the files stay where they were. The group ' +
        'is created switched off and switches nothing off — switch it on yourself when ' +
        'you need it. A group holds skills, rules, hooks and MCP; anything else (a ' +
        'project’s CLAUDE.md, say) is named by the window before the import and marked ' +
        '“stays out of the group” in Members.',
      sPair: 'A pair: one window for two sources',
      sPairText:
        'The global copy and the project original are shown as one card, and its window ' +
        'has the “Global · Project” switch: each project runs one side, and the inactive ' +
        'one is marked “Untouched, left in the project, inactive”. Below — the project ' +
        'override and an “Changed in the project” line if the original was edited after ' +
        'the copy. The window’s header has Edit, Copy, “Copy to global” (for a ' +
        'project group), the sandbox and delete.',
      sCopy: 'Copy to global and the agent’s advice',
      sCopyText:
        'A copy moves every skill, rule and hook of the group into the shared directories ' +
        'of the chosen CLI. A taken name gets a suffix, and the window says so plainly. ' +
        'Then the agent advises “take ours”, “improve” or “keep” for each member, with a ' +
        'reason; you apply it, and the edits land only in the global copy. A new hook or ' +
        'MCP from the agent is a command that will run on this machine: the window shows ' +
        'its text and leaves it unticked. The panel makes no second copy of the same ' +
        'group for the same CLI — a merge with the original updates the copy. The group’s ' +
        'pinned skill numbers travel with the copy, under the new name for a renamed ' +
        'skill; “Auto” stays “Auto”. In another CLI’s directories numbers arrive only for ' +
        'the skills it accepted: codex has no skills, so a copy for it goes without ' +
        'numbers. A scenario stays a scenario in the copy. A copy for another CLI is a ' +
        'card of its own, “global · qwen”: no Claude toggle, not paired with the project ' +
        'group, and no override. The agent gives advice only for a copy into Claude — the ' +
        'window of a copy for another CLI says so, and the copy is ready as it is. If the ' +
        'agent did not answer, the window says “The agent did not answer — no advice”: the ' +
        'copy is already made and can be checked by hand. The copy’s warnings (a taken ' +
        'name, a member that does not carry over) are written in words, not codes.',
      sDuplicate: '“Copy”: your own copy next to it',
      sDuplicateText:
        'The Copy button sits on the group’s card (the icon next to the toggle) and in its ' +
        'window’s header. The copy lands next to it as “<name> (copy)”, the next one as ' +
        '“(copy 2)”; the name can be changed in the window, a taken one is refused. Members, ' +
        'the Working order steps (each with a new id), pinned numbers, “When”, the flow and ' +
        'the scope come along; the project binding is not copied, or the copy would switch ' +
        'itself on next to the original. The copy is created switched off and switches ' +
        'nothing off: skills and rules shared with the original stay as they are. Switched ' +
        'on and then off, it switches its members off like any group. Editing the copy never ' +
        'touches the original. The panel agent does the same with the copy_group action, ' +
        'through a confirmation card.',
      sMerge: 'The original changed: merge',
      sMergeText:
        '“Merge into our copy” asks the agent to bring the project’s edits over without ' +
        'losing ours. The proposal comes as the same list of checkboxes; nothing is ' +
        'written until you press “Apply ticked”.',
      sDetails: 'Members: who is in it and where it is used',
      sDetailsText:
        'The window’s second tab has the description, the members and the paths: where ' +
        'the group was found and which projects use it. Each member has a human name and ' +
        'a “what it does” line in the interface language: a cheap model writes them from ' +
        'the member’s file where it lives (a project skill — from the project), once, then ' +
        'from the cache. The id is a secondary line under the name: for a hook it is ' +
        '“Event:hash”. While the name is being written the line says “description on its ' +
        'way…”, before that the line from the file itself shows; with no description at ' +
        'all — “no description”, and a member whose file is gone is marked “file missing”, ' +
        'with the same warning on the group’s card. A member of a global group that lives ' +
        'only in a project’s .claude is marked “only in project <name>”: the group does not ' +
        'manage it, and the card names it on its own “Only in project …” line, not as a ' +
        'missing file. The paths are plain text you can select and copy.',

      pathTitle: 'Path two: a step of your own in the working order',
      pathCaption:
        'Nine frames: the Working order in a group’s window, the step assistant, a ready step in ' +
        'two languages, translating the other side, the “resource or prompt” question, a row’s ' +
        'hint, the step window with the skill’s numbers, picking a ready resource and a hook ' +
        'step.',
      pPath: 'The Working order tab',
      pPathText:
        'The group’s window opens on it. The six conveyor stages (not editable) are thin ' +
        'separators; the group’s skill steps are gathered into one block per skill, which folds ' +
        'with a click on its header; your steps sit between them. Only steps are numbered — a ' +
        'stage is not a step. A coloured label on a step says where it comes from: our skill, a ' +
        'foreign skill (not in our catalog), a prompt, a hook, a rule or a utility. A step’s ' +
        'numbers (review rounds, agents per round) sit right in the row as lists. A “+” between ' +
        'rows is where a new step goes: inside an open skill block the step runs in the same ' +
        'turn as the skill, and a step after a stage runs as its own checked turn after it. At ' +
        'the top are a search by title and description and Collapse all, and that bar stays ' +
        'above the list while it scrolls — no step shows through under it; while the search is not ' +
        'empty the list is flat, with no “+” and no dragging. Your own steps move by their ' +
        'handle with the pointer or the keyboard (Space to pick up, arrows to move, Space to ' +
        'drop, Escape to cancel), they can be edited and deleted, and deleting asks for ' +
        'confirmation. A step after Task analysis runs in the analysis chat, before the group ' +
        'and models are chosen.',
      pAsk: 'The assistant asks and looks for something similar',
      pAskText:
        'A step is written in your own words: “after review run e2e and attach the ' +
        'report”. The assistant names a similar resource if one exists and asks the ' +
        'questions without which the step would stay vague. You answer in the same window. ' +
        'When a similar resource is found, the ready step has a “The step will point at …” ' +
        'switch: on — the step becomes a link to the resource, off — “The step keeps your own ' +
        'text”.',
      pProposal: 'A ready step in two languages',
      pProposalText:
        'The result is a title, the text for the model and “Done when”, in Russian and ' +
        'English. The English side goes into the run: models get their instructions in ' +
        'English, and the Russian side is for you.',
      pTranslate: 'Editing one side',
      pTranslateText:
        'Edited the English text — the window warns that the Russian side should be ' +
        'translated again and asks the assistant to do it with one button. The side edited ' +
        'last counts as the source. Both sides edited — the window asks: translate from RU, ' +
        'translate from EN, or keep both as written; until you choose, “Confirm” is closed.',
      pPromote: 'Make the step a resource?',
      pPromoteText:
        'After “Confirm” the step is saved as a panel prompt — it lives in the group’s ' +
        'data, and its English side goes into the run. If the step will be useful in ' +
        'other groups too, the assistant offers to make it a skill, hook or rule and ' +
        'shows a draft of the file. “Make” creates the resource the panel’s usual way ' +
        '(with a backup) and adds it to the group; “Keep as a panel prompt” creates ' +
        'nothing.',
      pSummary: 'The hint on a row',
      pSummaryText:
        'Hover a step or Tab onto it — a description appears under it: for a skill step, the ' +
        'first paragraph of its section; for your own step, the start of its text; for a ' +
        'resource step, a summary of what the resource does. What happens at a stage is told by ' +
        'the tooltip over its separator. The model writes the summary once per file content, and ' +
        'it is asked only when the hint is visible. Escape hides the hint without closing the ' +
        'window.',
      pKnobs: 'The step window and the skill’s numbers',
      pKnobsText:
        'Clicking a row opens the step window over the group’s window: what it is and ' +
        'where it comes from, the file path, where the step stands, the full text (the ' +
        'skill’s section word for word, or both sides of your own step) and the step’s ' +
        'numbers with the quote from the skill each one came from. Each number is a list: ' +
        '“Auto (skill: N)” — the skill picks the number — or your own number from min to ' +
        'max. A chosen number is pinned by the group even when it equals the skill’s, so ' +
        'a change to the skill will not move it; “Auto” removes the pin. The skill itself ' +
        'is not edited. A number sits in the row of the step whose section of the skill ' +
        'names it (review rounds at review, retries at fixes), for a project skill too. ' +
        'While the model is extracting numbers from a new skill, “reading skill…” shows ' +
        'above the rows. A pinned number outside the range shows as “N (outside min–max)” — ' +
        'pick a value from the range. A resource step of a project group opens the file and ' +
        'summary from the project’s .claude, not the shared ones.',
      pPick: 'Pick a ready one',
      pPickText:
        'The second tab of the new-step window is a catalog of what already exists: skills, ' +
        'rules, hooks and utilities, with a search and a filter by kind. Each row has a title, ' +
        'one line on what the resource does and its id. A click adds a step that refers to the ' +
        'resource. In a scenario the picked skill, rule or hook also becomes a member; a utility ' +
        'never becomes a member — the step simply asks the model to run it. In a disabled ' +
        'group the catalog warns: a skill, rule or hook not yet among its members becomes ' +
        'one and is switched off everywhere, not just here, until the group is switched on. The ' +
        'edit form of a disabled group carries the same warning above its members: “The group is off. ' +
        'Whatever you add to it is switched off everywhere…”.',
      pHook: 'A hook step',
      pHookText:
        'The third tab creates a hook right from the working order: step title, event, a ' +
        'tool-name matcher and the command. Create the hook and add it as a step makes an ordinary hook, ' +
        'makes it a group member and places a step that refers to it; the step and the hook ' +
        'share one title. If the hook was not created, the window names the reason and the ' +
        'working order stays as it was.',

      bundleTitle: 'Path three: a bundle for a task',
      bundleCaption:
        'Eleven frames from an empty section to deletion: choosing the kind, the members form, the insertion point, a ' +
        'permission conflict, variables, the card, the toggle and what it does to the Rules ' +
        'section.',
      bEmpty: 'An empty section',
      bEmptyText:
        'Not a single group, and the panel explains what they are for; in the middle is Create ' +
        'group. Above the grid are the tabs, all at zero.',
      bKind: 'Which group to create',
      bKindText:
        'Create group is the one button on the page; the kind is chosen in the window. Bundle — ' +
        'members that switch on together; the work runs through the conveyor stages, your own ' +
        'steps sit between them. Scenario — steps in order, and that is the whole job. A hook ' +
        'joins a group as a Hook step in its Working order.',
      bForm: 'Members: references, not copies',
      bFormText:
        'Bundle opens the New bundle form: at the top, name, description and When it fits. Below, everything already in the ' +
        'configuration, by kind: rules, skills, hooks, servers, permissions and other groups. ' +
        'Under that, Apply order — the selection as a list; the frame has 6 members selected.',
      bOrder: 'Apply order and the insertion point',
      bOrderText:
        'Each row has a number, a kind, a name and one line on what the member does: a summary, ' +
        'the description from its file or, when there is neither, the id itself. The ↑ and ↓ ' +
        'arrows reorder, the cross removes. A “+” between rows picks a place: the next member ' +
        'you tick goes there instead of the end of the list; Cancel inserting restores the usual ' +
        'order.',
      bConflict: 'The panel spots a permission conflict itself',
      bConflictText:
        'An allow for the same pattern that already has a deny was added as the seventh ' +
        'member — and the form says so plainly: “Bash(git push:*) has both allow and deny ' +
        'in the group — Claude Code will take one”. It does not block saving, but it will ' +
        'not stay silent either.',
      bEnv: 'Binding and variables',
      bEnvText:
        'Below the members — the projects in which the group switches on by itself, and ' +
        'the group’s environment variables. The variables go into settings.json while the ' +
        'group is on and are removed when it is switched off. The form has no working ' +
        'order — it lives on the Working order tab of the group’s window.',
      bCard: 'The group card and window',
      bCardText:
        'The card carries the “global” badge, the When line, the first steps and the number of ' +
        'steps and members. Clicking the name opens the group’s window: a new group’s Working ' +
        'order has only the six conveyor stages, your steps are added with “+” or Add step, and ' +
        'members live on the Members tab. Variables and project binding are edited in the form, ' +
        'via Edit in the window’s header.',
      bOff: 'The toggle switched the whole bundle off',
      bOffText:
        'The group carries a “switched off” badge. Rules moved to “Disabled”, skill folders ' +
        'to skills-disabled, servers to mcpServersDisabled, hooks left settings.json. Not ' +
        'a single file was deleted.',
      bRulesOff: 'What the Rules section shows',
      bRulesOffText:
        'Both of the group’s rules are marked “switched off” — the one the group switched ' +
        'off and the one switched off by hand earlier. They look the same, and that is ' +
        'exactly what the next frame is about.',
      bRulesOn: 'The group switched back on',
      bRulesOnText:
        '“Answer with a diff” came back, while “Add no new dependencies” stayed off: it ' +
        'was held off by you, not by the group. A group releases only what it switched ' +
        'off itself.',
      bDelete: 'Deletion asks for the name',
      bDeleteText:
        'The dialog waits until you type the group’s name and is honest about two ' +
        'consequences: members stay in place, and if the group was off they switch back ' +
        'on, because nothing holds them off any more.',

      autoTitle: 'Path four: a group that switches itself on',
      autoCaption:
        'Four frames on automation: binding to a project, the When it fits line, a bound ' +
        'group’s Members and a scenario — a group made of steps only.',
      aBinding: 'Binding to projects',
      aBindingText:
        'Projects come from the Projects section and are ticked, and the panel warns ' +
        'straight away: the group switches itself on when the agent starts working in ' +
        'that project — and in its branch copies — and does not switch itself back off.',
      aWhen: '“When it fits”',
      aWhenText:
        'One line on which task the group is for. “Auto” picks the group by it when the panel ' +
        'triages a task to split it across branches; in a plain chat without a split “Auto” ' +
        'picks no group — choose it explicitly. With an empty line “Auto” never picks this ' +
        'group, not even in a split.',
      aDetails: 'Members of a bound group',
      aDetailsText:
        'The members and “Used in” with the bound project, and below — the project’s own ' +
        'set: from C:/work/shop-front you see 2 skills, 2 hooks, 2 rules. That is what ' +
        'comes from the repository on top of the group, and it is edited only in the ' +
        'repository itself.',
      aScenario: 'A scenario: a group made of steps only',
      aScenarioText:
        'Create group → Scenario asks for a name, an optional When it fits line (Auto ' +
        'picks the scenario by it when a task is split across branches; in a plain chat the ' +
        'scenario is chosen explicitly) and where it lives — global or in a project. A ' +
        'scenario cannot be created without a name. A scenario has no conveyor stages: the steps ' +
        'run in order, each as its own turn, and that is the whole job. After creation its ' +
        'Working order opens — describe the first step in words, pick a ready one or create a ' +
        'hook. On its card a scenario carries the “scenario” badge.',

      shotsTitle: 'The frames are real',
      shotsText:
        'Every screenshot was taken from a running panel on a separate stand with a ' +
        'temporary configuration directory: only the server’s answers are substituted, the ' +
        'markup and labels are the same as yours. The groups, projects and C:/work/… paths ' +
        'are made up, so that nothing from a real machine gets into a frame.',
    },

    pairTitle: 'Global and project: which one acts',
    pairCaption:
      'Copying a project group to global links the two into a pair. The pair’s rules are ' +
      'never visible as a whole in any screen state, so — in words.',
    pairOne: 'One side acts in a project',
    pairOneText:
      'For every pair in every project the panel remembers separately which side is ' +
      'active, and never holds both at once. After a copy only that pair switches to the ' +
      'global side — the choice of other pairs in the same project does not change; the ' +
      'switch in the pair’s window brings the project one back. If the side choice could ' +
      'not be read, the pair’s card says so: “Could not find out which side is active”.',
    pairOverride: 'The override is one local file',
    pairOverrideText:
      'To make the CLI in the project follow the global group rather than its own ladder, ' +
      'the agent writes .claude/rules/agentdeck-group.local.md and a line for it in ' +
      '.git/info/exclude — it never reaches a commit. If text alone is not enough, a ' +
      'Skill(<id>) deny for the project skill of the same purpose goes into ' +
      'settings.local.json. Switched off — the file, the line and the deny are removed, ' +
      'and the project is byte for byte as it was. The exception is your own text added ' +
      'below the panel’s block: on switch-off and on update it stays, the panel’s block ' +
      'leaves the file, and the file becomes yours — the panel no longer treats it as its ' +
      'override. Whatever you edited yourself in ' +
      'settings.local.json and .git/info/exclude after switching on stays. If ' +
      'settings.local.json no longer reads as JSON, the deny cannot be removed — the ' +
      'override stays on until the file is fixed.',
    pairMerge: 'The original keeps being edited',
    pairMergeText:
      'The panel remembers the original’s fingerprint at the time of the copy. When the ' +
      'project files change, the pair’s card warns, and its window names the members ' +
      'and offers a merge; you decide, and our edits are not lost.',
    pairClaude: 'The override for other CLIs',
    pairClaudeText:
      'The override writes only the project’s .claude/ files — it is a Claude feature. ' +
      'Another CLI’s local instruction files are read, not written; the pair’s window says ' +
      'plainly that the override works for Claude only, and a copy for another CLI has ' +
      'none at all.',

    bindTitle: 'Project binding and “Auto”',
    bindCaption:
      'The section’s only automation: nobody touched the toggle, yet the group is on. ' +
      'The only place it shows is the run feed, where the panel puts a line about it; ' +
      'the section itself shows nothing, so — in words.',
    bindProject: 'When it fires',
    bindProjectText:
      'At the moment a message is sent to the agent: the panel looks at the run’s working ' +
      'directory and switches on the groups bound to it. The same goes for chats the ' +
      'panel starts itself: splitting tasks by branch and continuing in a clean session ' +
      'switch the bundle on the same way, otherwise such a chat would start with the ' +
      'project’s rules and skills switched off. A group that is already on is not ' +
      'touched at all — not a single write to disk.',
    bindWhen: '“Auto” picks by the “When” line',
    bindWhenText:
      'The chat’s group choice defaults to “Auto”. It picks only when a task is split ' +
      'across branches: triage compares each split group with the “When” lines of the ' +
      'groups available in this project and takes the one that fits, honouring the side of ' +
      'a pair that is active when the branch starts (switch sides after triage and the ' +
      'branch gets the new one); a scenario is shown to triage as a scenario — its steps are the ' +
      'whole work. In a plain chat without a split “Auto” picks no group: the enabled groups ' +
      'and the ones bound to the project work, anything else is chosen explicitly. A group ' +
      'without a “When” line is never picked this way.',
    bindNotice: 'The panel says so in the feed',
    bindNoticeText:
      'Having switched a bundle on, the panel puts the line “Bundle “X” switched on by ' +
      'itself — it is bound to this project” into the run feed; several switched on — ' +
      'they are named in one line. One line per fact: a bundle already on is left alone ' +
      'and not mentioned twice. A foreign CLI has no feed for panel notes, and there the ' +
      'fact shows only on the Groups page.',
    bindWorktree: 'Branch copies count too',
    bindWorktreeText:
      'A branch copy lives next to the repository, in the sibling directory ' +
      '“<project>-worktrees/<branch>”. For binding and for discovery it is the same ' +
      'project, so chats split by branch get the same bundle.',
    bindNoOff: 'It does not switch back off',
    bindNoOffText:
      'Leaving a project does not switch the group off, on purpose: the configuration ' +
      'files are shared by every running session, and switching off would hit someone ' +
      'else’s live agent. Switching off is manual only.',

    toggleTitle: 'Who overrides whom: a group and a single toggle',
    toggleCaption:
      'An entity has two independent reasons to be off: you switched it off yourself, or ' +
      'a group holds it off. The panel keeps them apart, and an entity is on only when ' +
      'both are cleared. Hence the four rules below — they explain every “I switch it ' +
      'on and it stays off”.',
    toggleManual: 'A group does not undo a manual switch-off',
    toggleManualText:
      'If a member was switched off by its own toggle, switching the group on will not ' +
      'revive it. These are different decisions: a group releases only what it held off.',
    toggleTwo: 'Two groups hold it in turn',
    toggleTwoText:
      'A member of two switched-off groups revives only when both are switched on. While ' +
      'either is off, it keeps holding the member off.',
    toggleSingle: 'A single toggle is weaker than a group',
    toggleSingleText:
      'A member cannot be switched on by its own toggle while a group holds it off. The ' +
      'panel answers with success and remembers your decision, but nothing changes on ' +
      'disk — the entity stays off until the group is switched on.',
    toggleDelete: 'Deleting a switched-off group releases its members',
    toggleDeleteText:
      'The group is gone — nothing holds them off, and the members come back on: all ' +
      'except those switched off by hand or held by a second switched-off group.',

    storageTitle: 'Panel data, Claude Code configuration and the project',
    storageWhere: 'Groups, scenarios and their path',
    storagePairs: 'The pair side choice, overrides, the agent’s advice',
    storageDiscovery: 'Discovery findings',
    storageSummaries: 'Resource “what it does” summaries',
    storageOverride: 'The project override',
    storageOverrideValue:
      '<project>/.claude/rules/agentdeck-group.local.md and a line in .git/info/exclude; ' +
      'if needed, a Skill(<id>) deny in settings.local.json',
    storageEnv: 'Group variables',
    storageHooks: 'Hooks of Hook steps',
    storageDisabled: 'Members held off',
    storageDisabledValue:
      'rules — into “Disabled” in CLAUDE.md, skills — into skills-disabled, servers — into ' +
      'mcpServersDisabled, hooks simply leave settings.json',

    canCollect:
      'Collect entities of five kinds into a group: rules, skills, hooks, servers, permissions',
    canToggleGroup: 'Switch a group off with its toggle — all its members go dark at once',
    canGroupEnv:
      'Set group variables: on switch-on they go into settings.json, on switch-off they ' +
      'are removed without touching those set by hand or by another group',
    canBindProject: 'Bind a group to projects — it switches itself on when you work there',
    canDiscover:
      'Find the ladders projects already carry and import them without touching the repository',
    canCopy: 'Copy a project group to global and choose which side acts in the project',
    canPath: 'Insert a step of your own into the working order after any stage — in your own words',
    canAutomation:
      'Add a hook as a Hook step: an event from the list, a matcher and a command — no JSON',
    canConflict:
      'See a warning about a conflict inside a group: two permission members with the ' +
      'same pattern and different decisions',
    canSandbox: 'Run the group’s own rules, skills, hooks and servers in the sandbox at once',
    canNest:
      'Nest a group in a group: another group can be a member, the panel will not let a cycle form',
    canAssistant:
      'Fill in the whole group form with the assistant — name, "When", variables, members and ' +
      'projects; it picks members and projects only from what the panel has, and names what it ' +
      'could not find under its answer. The panel agent can build a ' +
      'group too: read it, draft one from a description, add and move a step, set skill numbers ' +
      '(every change goes through a confirmation card)',

    cantKnow: 'Expect Claude to know about groups: it only sees the resulting settings',
    cantMagic: 'Get more from a Hook step than a hook can do — it is an ordinary hook',
    cantOverride:
      'Switch a member on by its own toggle while a switched-off group holds it: a group ' +
      'is stronger than a single switch',
    cantRevive:
      'Undo a manual switch-off by switching the group on: what you switched off ' +
      'separately stays off',
    cantAutoOff: 'Switch a group off automatically — binding can only switch on',
    cantBuiltIn: 'Reorder or remove a built-in conveyor stage: your own steps go between them',
    cantBoth: 'Keep both sides of a pair active in one project at once',
    cantPermSandbox:
      'Test the group’s permissions in the sandbox: an isolated run has its own limits',

    fieldsTitle: 'Group fields',
    fieldsCaption: 'Names as in the groupSchema schema.',
    fieldName: 'Name of the group or scenario.',
    fieldDescription: 'What the group is for. Helps recall the point of the bundle a month later.',
    fieldWhen:
      'One “when it fits” line. “Auto” in the chat picks the group by it; empty — explicit choice only.',
    fieldMembers:
      'The group’s members: references to rules, skills, hooks, servers and permissions.',
    fieldEnv: 'The group’s environment variables, one KEY=VALUE per line.',
    fieldProjectPaths:
      'Project directories in which the group switches itself on. Empty — manual toggle only.',
    fieldScope:
      'Where the group lives: global — the shared directories, project — one project’s files (path and CLI).',
    fieldOrigin:
      'On a global copy — where it was copied from and the original’s fingerprint: it shows the project changed.',
    fieldPathSteps:
      'Your own working-order steps: after which stage, title, text for the model and “done when”, in two languages.',
    fieldFlow:
      'The group’s kind: conveyor — conveyor stages with your steps between them, scenario — a scenario of steps only. No field means conveyor.',
    fieldKnobs:
      'Pinned numbers of member skills, keyed <skill>:<number name>, for example ticket-delivery:review-rounds. No entry means Auto, the number comes from the skill.',
    limitsTitle: 'Boundaries and numbers',
    limitsCaption: 'What people come back for and look up by eye rather than by reading.',
    limitMembers: 'Member kinds',
    limitMembersValue:
      'five: rule, skill, hook, server, permission. Plus another group — nesting is ' +
      'allowed, the panel will not let a cycle form',
    limitStages: 'Built-in path stages',
    limitStagesValue:
      'six: triage, plan, work, review, fixes, delivery. A step of your own goes after any of them',
    limitDiscovery: 'Discovery',
    limitDiscoveryValue:
      'every project the panel knows (branch copies count as their project) and the shared ' +
      'directories of every CLI. The model is asked only about a source where something changed',
    limitEvents: 'Hook step events',
    limitEventsValue: 'nine, from PreToolUse to PreCompact — the same list as an ordinary hook',
    limitExit: 'Exit code 2',
    limitExitValue: 'stops the action and asks for confirmation; other codes are just a message',
    limitAuto: 'Project binding',
    limitAutoValue:
      'switches on only, at the start of any run in the directory: a message to the agent, ' +
      'a task split, a continuation in a clean session. A branch copy counts as the same project',
    limitSandbox: 'Sandbox',
    limitSandboxValue:
      'takes the group’s own members — rules, skills, hooks, servers. Permissions are ' +
      'never carried over, a nested group’s members are not expanded',

    notesTitle: 'Traps people trip over',
    noteAutoOnTitle: 'A bound group switches on without asking',
    noteAutoOnText:
      'The very first run in a bound project switches the group on — a typed message, a ' +
      'task split or a continuation in a clean session alike — together with its rules, ' +
      'skills, hooks and variables, and in every project at once: the configuration ' +
      'files are shared. That is the price of automation, so bind only bundles that do ' +
      'not get in the way of other work.',
    noteEnglishTitle: 'The model gets the English side of a step',
    noteEnglishText:
      'The Russian text of a step is for you; the English one goes into the run. Edit one ' +
      'side without translating the other and they drift apart — the step window warns ' +
      'about it.',
    noteRebuildTitle: 'Automations became Hook steps',
    noteRebuildText:
      'Automations made earlier are moved once, at start-up: each becomes an ordinary hook ' +
      'without a mark (a disabled one becomes a disabled hook) and a Hook step after the ' +
      'Work stage in each of its groups, marked “needs translation”. From then on the hook ' +
      'is edited like any other — in Hooks or in the step window.',
    noteLocalHookTitle: 'A hook from settings.local.json does not obey a group',
    noteLocalHookText:
      'The panel does not write to that file, so it has no way to switch such a hook off ' +
      '— it stays on even inside a switched-off group. The panel counts such members ' +
      'separately and says how many were skipped when toggling.',
    noteOldStepsTitle: 'Old form steps are now in the Working order',
    noteOldStepsText:
      'Steps set earlier in the group form became your own working-order steps after ' +
      'the “Work” stage. They have no English side yet, and the row is marked “needs ' +
      'translation”: open the step, Edit, and ask for a translation.',
    noteInvisibleTitle: 'Claude does not know about groups',
    noteInvisibleText:
      'It sees only the resulting settings and the conveyor’s turns. A group is a way to ' +
      'keep your own house in order, not something you can ask for in a conversation.',
    notePermTitle: 'Permissions are not carried into the sandbox',
    notePermText:
      'Even when they belong to the group. An isolated run has its own limits, and ' +
      'replacing them with your permissions would be wrong.',
    noteConflictTitle: 'The panel catches only a same-pattern permission conflict',
    noteConflictText:
      'Two permission members with the same pattern and different decisions (allow and ' +
      'deny at once) get a warning right in the group form. Meaning-level contradictions ' +
      '— two rules or skills arguing about substance — it cannot see: only a run shows those.',

    undoTitle: 'How to put it back',
    undoCaption: 'One case per line — people come for an undo after they have already done it.',
    undoOff: 'The group was switched off by mistake',
    undoOffText:
      'Switch it back on with the same toggle: members return from “Disabled”, ' +
      'skills-disabled and mcpServersDisabled, variables go back into settings.json. ' +
      'Except those you had switched off yourself — those need switching on by hand.',
    undoDelete: 'The group was deleted',
    undoDeleteText:
      'The members are still there — build the bundle again and, if the group was off, ' +
      'check the toggles: after deletion the members that no other group holds and that ' +
      'you did not switch off yourself came back on. The group’s variables left ' +
      'settings.json with it — except those shared with another group; a new group ' +
      'brings them back on switch-on. Before the panel agent deletes a group, its card ' +
      'names both the variables leaving and the members that will switch on.',
    undoAuto: 'The group switched itself on and is not wanted',
    undoAutoText:
      'Switch it off with its toggle and remove the project in the group form, otherwise ' +
      'the next message in the same directory switches it on again.',
    undoOverride: 'The project should follow its own ladder',
    undoOverrideText:
      'Switch off “Project override” in the pair’s window or switch the side to ' +
      '“Project”: the rule file, the line in .git/info/exclude and the skill ban are ' +
      'removed, and the project is byte for byte what it was before the copy.',
    undoStep: 'A step of your own gets in the way',
    undoStepText:
      'Delete it with the bin in its working-order row. If the step was already made a ' +
      'resource, the skill, hook or rule stays a member of the group — remove it from ' +
      'the members or delete it in its own section.',
  },

  shots: {
    sources: {
      '01-sections':
        'The groups page: the Global, In projects, Found and Discovery tabs with an error count, ' +
        'and the card grid',
      '02-found':
        'A finding’s window: “When”, why it is a bundle, the working order and Import in ' +
        'the header',
      '03-pair':
        'The pair’s window: header actions, the side for the project, the override and ' +
        '“Changed in the project”',
      '04-copy': 'Copy to global: a taken-name warning and the agent’s advice on each member',
      '05-merge':
        'Merging the original’s changes: advice with checkboxes, nothing written before Apply',
      '06-details': 'Members: what each member does — from its file, “Found in” and “Used in”',
      '07-duplicate':
        'The Copy group window: what goes into the copy, that it is switched off and switches ' +
        'nothing off, and the suggested “(copy)” name',
    },
    path: {
      '01-path':
        'The Working order in a group’s window: stages as thin separators, a skill block with ' +
        'numbers in the row, your steps with labels and handles, search and Collapse all',
      '02-ask': 'The step window: the assistant names a similar skill and asks two questions',
      '03-proposal': 'A ready step: title, text for the model and “Done when” in two languages',
      '04-translate':
        'Editing the English side: the window asks to translate the Russian one again',
      '05-promote':
        'The step is saved as a panel prompt: make a skill of it from the draft or keep ' +
        'it a prompt',
      '06-summary': 'The hint on a row: what the release-notes skill the step refers to does',
      '07-knobs':
        'A skill step’s window: its source, where it stands, “Auto” and pinned numbers ' +
        'with quotes from the skill',
      '08-pick':
        'Pick a ready one: a catalog of skills, rules, hooks and utilities with a search and a ' +
        'kind filter',
      '09-hook':
        'A hook step: title, event, matcher and command — the hook becomes a member, the step ' +
        'refers to it',
    },
    bundle: {
      '01-empty': 'An empty section: tabs at zero and Create group in the middle',
      '01-kind':
        'The Which group to create window: Scenario and Bundle, each with a line on how the work runs',
      '02-form':
        'The group form: name, “When it fits”, everything in the configuration and the order of application, 6 selected',
      '02-order': 'Apply order: a line on what each member does, and a “+” that picked place 2',
      '03-conflict':
        'An allow for a pattern with a deny added as the seventh member — the form warns about the conflict',
      '04-env':
        'The bottom of the form: projects for automatic switch-on and the group’s variables',
      '05-card':
        'The window of the new “Ревью фронтенда” group: the Working order is only the ' +
        'pipeline stages with “+” between them so far',
      '06-off': 'The same bundle after the toggle: a “switched off” badge on the group card',
      '07-rules-off':
        'The Rules section: two rules marked “switched off” — one by the group, one by you',
      '08-rules-on':
        'The group is back on: “Answer with a diff” returned, the rule switched off by hand stayed off',
      '09-delete':
        'Deleting from the group window’s header: type the name, members stay, a ' +
        'switched-off group releases them',
    },
    auto: {
      '01-binding':
        'Binding to projects: ticks by the directories and a warning that the group will not switch back off',
      '02-when': 'The “When it fits” line: “Auto” in the chat picks the group by it',
      '03-details':
        'Members of a bound group: members, “Used in” and the project’s set — 2 skills, 2 ' +
        'hooks, 2 rules',
      '07-scenario':
        'A new scenario from Create group → Scenario: name, When it fits and where it lives',
    },
  },

  diagrams: {
    'two-marks':
      'Two independent switch-off marks: one belongs to the human, one to the group, and an entity revives only when both are gone.',
    'compiled-set':
      'Where a group goes: working-order steps into conveyor turns, the override into a local ' +
      'project file, variables into settings.json, a Hook step into an ordinary hook.',
  },
};
