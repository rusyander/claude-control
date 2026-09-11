import type { groupsRu } from '../../ru/topics/groups';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const groupsEn: typeof groupsRu = {
  topic: {
    title: 'Groups',
    summary: 'Setting bundles, a working order and «when X happens — do Y» scenarios',
    lead:
      'The only section Claude Code itself knows nothing about: groups and scenarios ' +
      'live in the panel’s own data. A group collects settings into a bundle that is ' +
      'switched on at once. A scenario is a hook described in plain words: the panel ' +
      'turns it into a real hook in the configuration.',

    guideTitle: 'What is inside',
    guideText:
      'First why this exists and what the section is NOT. Then two diagrams and two ' +
      'paths in real frames: a bundle behind one toggle, and a group that switches ' +
      'itself on. Then the project binding and the «who overrides whom» rules, and at ' +
      'the end — what goes to disk, the fields, the boundaries, the traps and how to undo.',

    whyEnv: 'One toggle instead of ten',
    whyEnvText:
      'Rules, skills, hooks, servers and permissions for one task go dark and come back ' +
      'together. The panel remembers what IT switched off, so switching a group on never ' +
      'touches what you switched off yourself.',
    whyBundle: 'The bundle follows the project',
    whyBundleText:
      'A group can be bound to project directories: the first message to the agent in ' +
      'such a project switches it on by itself, along with its variables and working order.',
    whySimple: 'Automation without syntax',
    whySimpleText:
      'A scenario asks «when» and «what to do» in plain words. You do not have to ' +
      'remember which event and which matcher to type.',

    diffTitle: 'What this section is NOT',
    diffCaption:
      'The four things it gets mistaken for. No screenshot refutes any of them: in each ' +
      'case the screen looks exactly the way the reader expects.',
    diffClaude: 'Not an entity for Claude',
    diffClaudeText:
      'The agent sees the resulting settings only: rules, skills, hooks, servers. ' +
      '«Switch the review group on» means nothing in a conversation — a group exists for ' +
      'the panel alone.',
    diffCopy: 'Not a copy of the settings',
    diffCopyText:
      'A group holds references to existing rules, skills, hooks, servers and ' +
      'permissions. The same entity can belong to five groups — no copies appear, and ' +
      'deleting a group deletes none of its members.',
    diffMagic: 'A scenario is nothing more than a hook',
    diffMagicText:
      'It has no magic of its own: on save it becomes an ordinary hook in settings.json ' +
      'and works exactly the same. The value is in not having to remember the event, the ' +
      'matcher and the syntax.',
    diffAuto: 'The binding is not a project switch',
    diffAutoText:
      'It can only switch on. Leaving the project does not put the group out, and no ' +
      'other group is switched off by it: the configuration files are shared by every ' +
      'run in flight.',

    guide: {
      mapTitle: 'How it works',
      mapCaption:
        'Two diagrams: why a switched-off member does not revive when the group comes ' +
        'back, and what a scenario turns into on save. Neither is visible on any screen.',
      pathTextTitle: 'The same path in words',
      pathTextText:
        'Every entity carries two independent marks: «the human switched it off» and ' +
        '«a group is holding it down». The panel remembers them separately, and the ' +
        'entity becomes enabled only when both are gone. A scenario, in turn, is rebuilt ' +
        'into a hook on every save, with an origin mark at the end of the command — that ' +
        'is how the panel tells its own hooks from hand-written ones, which it never touches.',

      bundleTitle: 'Path one: a bundle for one task',
      bundleCaption:
        'Nine frames from the empty section to deletion: the membership form, a ' +
        'permission conflict, the variables, the card, the toggle and what it does to the ' +
        'Rules section.',
      bEmpty: 'The empty section',
      bEmptyText:
        'Not a single group, and the panel explains what they are for. Scenarios are the ' +
        'second list on the same page, with their own «Create scenario» button.',
      bForm: 'Membership: references, not copies',
      bFormText:
        'On the left, everything already in the configuration, by kind: rules, skills, ' +
        'hooks, servers, permissions and other groups. On the right «Order of ' +
        'application» — what you picked, with ↑ and ↓ arrows; 6 members are selected in the frame.',
      bConflict: 'The panel spots a permission conflict itself',
      bConflictText:
        'Add an allow for a pattern that already has a deny as the seventh member, and ' +
        'the form says it plainly: for «Bash(git push:*)» the group sets both allow and ' +
        'deny — Claude Code will take one. It does not block the save, but it will not ' +
        'stay silent either.',
      bEnv: 'Binding, working order and variables',
      bEnvText:
        'Below the membership are three blocks: the projects where the group switches ' +
        'itself on, the working order in steps, and the group’s environment variables. ' +
        'They go into settings.json while the group is on and are taken away when it goes off.',
      bCard: 'The group’s card',
      bCardText:
        'The number of members, the variable counter (env: 1) and the description — the ' +
        'very sentence that reminds you a month later what the bundle was for.',
      bOff: 'The toggle put the whole bundle out',
      bOffText:
        'The group is marked «off». Rules moved into «Disabled», skill folders into ' +
        'skills-disabled, servers into mcpServersDisabled, hooks disappeared from ' +
        'settings.json. Not a single file was deleted.',
      bRulesOff: 'What the Rules section shows',
      bRulesOffText:
        'Both of the group’s rules are marked «off» — the one the group put out and the ' +
        'one switched off by hand earlier. They look identical, and that is exactly where ' +
        'the next frame comes from.',
      bRulesOn: 'The group is back on',
      bRulesOnText:
        '«Answer with a diff» has returned, while «No new dependencies» stayed off: it ' +
        'was not the group that put it out, it was you. A group releases only what it ' +
        'switched off itself.',
      bDelete: 'Deletion asks for the name',
      bDeleteText:
        'The dialog waits until you type the group’s name and states both consequences ' +
        'honestly: the members stay where they are, and if the group was off they come ' +
        'back on, because there is nobody left to hold them down.',

      autoTitle: 'Path two: a group that switches itself on',
      autoCaption:
        'Eight frames about the automation: the project binding, the working order in ' +
        'steps, the compiled skill and a scenario that became a hook.',
      aBinding: 'Binding to projects',
      aBindingText:
        'Projects come from the Projects section, are ticked with checkboxes, and the ' +
        'panel warns right there: the group will switch itself on when the agent starts ' +
        'working in this project — and in the copies of its branches — and will not ' +
        'switch itself off again.',
      aSteps: 'The working order in steps',
      aStepsText:
        'Three steps, each with «what to do», details and «done when». That last field is ' +
        'the point of the step: without it the agent decides for itself that the step is ' +
        'done. The line under the list says what the steps will turn into.',
      aTrigger: 'A bad trigger is not accepted',
      aTriggerText:
        'The trigger is a regular expression over the request text. For «[ticket» the ' +
        'field goes red with «This is not a regular expression». The panel does not block ' +
        'the save, but it will not install a trigger hook with a broken expression: the ' +
        'working order stays a skill that Claude picks by its description.',
      aCard: 'The card of a bound group',
      aCardText:
        'Under the name — «projects: 1» and «steps: 3», and below them the project’s own ' +
        'set: from C:/work/shop-front, 2 skills, 2 hooks and 2 rules. That is what comes ' +
        'from the repository on top of the group, and it is edited in the repository only.',
      aSkill: 'The steps became a skill',
      aSkillText:
        'A «Shop tickets» skill appeared in the Skills section — 1 file, 980 B, and its ' +
        'description is assembled from the «when to apply» field. The skill became a ' +
        'member of the group and goes dark with it. Renaming the group does not rename ' +
        'the skill: the name is computed once, or a second, orphaned skill would be left on disk.',
      aForm: 'A scenario: «when — what»',
      aFormText:
        'An event from the list (nine of them in the form, from PreToolUse to PreCompact), ' +
        'a matcher by tool name or a quick pick of a skill, and a shell command. The form ' +
        'says right away that exit code 2 stops the action and asks for confirmation.',
      aAutomation: 'The scenario on the page',
      aAutomationText:
        'The list of scenarios under the groups: the PostToolUse event, the Edit matcher, ' +
        'the pnpm type-check command. Each has its own toggle — a scenario switched off ' +
        'does not reach the compiled hooks.',
      aHooks: 'Both of them show up in Hooks',
      aHooksText:
        'The last two hooks were placed by the panel, and the mark at the end of the ' +
        'command says so: agentdeck:scenario:grp-tickets on the working-order ' +
        'trigger and agentdeck:automation:auto-1 on the scenario. Hand-written hooks ' +
        'carry no mark, and a rebuild never touches them.',

      shotsTitle: 'The frames are real',
      shotsText:
        'Every screenshot is taken from a running panel on a separate stand with a ' +
        'throwaway settings directory: only the server’s answers are stubbed — the layout ' +
        'and the labels are the ones you get. The «Frontend review» and «Shop tickets» ' +
        'groups and the C:/work/… paths are invented so that nothing from a real machine ' +
        'gets into a frame.',
    },

    bindTitle: 'Binding to a project',
    bindCaption:
      'The section’s only automation, and at the moment it fires nothing is visible on ' +
      'screen: the group simply turns out to be on. Hence — in words.',
    bindProject: 'When it fires',
    bindProjectText:
      'When a message is sent to the agent: the panel looks at the run’s working ' +
      'directory and switches on the groups bound to it. The same goes for the chats the ' +
      'panel starts itself: splitting work across branches and continuing in a clean ' +
      'session switch the bundle on the same way, or such a chat would start with the ' +
      'project’s rules and skills off. A group that is already on is not touched at all — ' +
      'not a single write to disk.',
    bindWorktree: 'Branch copies count too',
    bindWorktreeText:
      'A branch copy lives next to the repository, in the neighbouring ' +
      '«<project>-worktrees/<branch>» directory. For the binding it is the same project, ' +
      'so a chat split by branches gets the same bundle.',
    bindNoOff: 'It never switches back off',
    bindNoOffText:
      'Leaving the project does not put the group out, and that is deliberate: the ' +
      'configuration files are shared by every run in flight, and switching things off ' +
      'would hit someone else’s live agent. Switching off is done by hand only.',

    toggleTitle: 'Who overrides whom: the group and a single toggle',
    toggleCaption:
      'An entity has two independent reasons to be off: you switched it off yourself, or ' +
      'a group is holding it down. The panel remembers them separately, and the entity ' +
      'becomes enabled only when both reasons are gone. Hence the four rules below — they ' +
      'explain every «I switch it on and it does not come on».',
    toggleManual: 'A group does not undo a manual switch-off',
    toggleManualText:
      'If a member was switched off by its own toggle, switching the group on will not ' +
      'revive it. These are different decisions: a group releases only what it put out itself.',
    toggleTwo: 'Two groups hold in turn',
    toggleTwoText:
      'A member of two switched-off groups revives only when both are on. While even one ' +
      'is off, it keeps holding the member down.',
    toggleSingle: 'A single toggle is weaker than a group',
    toggleSingleText:
      'You cannot switch a member on with its own toggle while a group is holding it ' +
      'down. The panel answers with success and remembers your decision, but nothing ' +
      'changes on disk — the entity stays off until the group comes back.',
    toggleDelete: 'Deleting a switched-off group releases its members',
    toggleDeleteText:
      'The group is gone, so there is nobody to hold them, and the members come on: all ' +
      'of them except the ones switched off by hand or held by a second switched-off group.',

    storageTitle: 'The panel’s data and Claude Code’s configuration',
    storageWhere: 'Groups and scenarios',
    storageWhereValue: 'in the panel’s data, separately from Claude Code’s configuration',
    storageEnv: 'The group’s variables',
    storageSkill: 'The working-order skill',
    storageHooks: 'Scenarios and triggers',
    storageMarker: 'How the panel’s own is told apart',
    storageMarkerValue:
      'the command carries a agentdeck:scenario:<id> or ' +
      'agentdeck:automation:<id> mark — hooks without one are never touched',
    storageDisabled: 'Members that were put out',
    storageDisabledValue:
      'rules go to «Disabled» in CLAUDE.md, skills to skills-disabled, servers to ' +
      'mcpServersDisabled, hooks simply leave settings.json',

    canCollect:
      'Collect five kinds of entity into a group: rules, skills, hooks, servers, permissions',
    canToggleGroup: 'Switch a group off with one toggle — every member goes dark at once',
    canGroupEnv:
      'Set the group’s variables: they go into settings.json when it is on and are taken ' +
      'away when it is off, without touching ones set by hand or by another group',
    canBindProject: 'Bind a group to projects — it switches itself on when you work in them',
    canSteps: 'Describe the working order in steps: the panel builds a skill out of them',
    canAutomation: 'Describe a scenario in words and get a ready hook',
    canConflict:
      'See a warning about a conflict inside the group: two permission members with the ' +
      'same pattern and different decisions',
    canSandbox: 'Run the group’s own rules, skills, hooks and servers in the sandbox at once',
    canNest: 'Nest a group in a group: a member can be another group, cycles are refused',
    canAssistant: 'Fill the group or scenario form with the assistant',

    cantKnow: 'Count on Claude knowing about groups: for it there are only the resulting settings',
    cantMagic: 'Get more from a scenario than a hook can do — it IS a hook, only easier',
    cantOverride:
      'Switch a member on with its own toggle while a switched-off group holds it: the ' +
      'group is stronger than a single switch',
    cantRevive:
      'Undo a manual switch-off by switching the group on: what you switched off ' +
      'individually stays off',
    cantAutoOff: 'Switch a group off automatically — the binding can only switch on',
    cantPermSandbox:
      'Check a group’s permissions with the sandbox: an isolated run has boundaries of its own',

    fieldsTitle: 'Group and scenario fields',
    fieldsCaption: 'The names are the ones in the groupSchema and automationSchema schemas.',
    fieldName: 'The name of the group or scenario.',
    fieldDescription:
      'What this group is for. Helps you recall the point of the bundle a month later.',
    fieldMembers:
      'The group’s membership: references to rules, skills, hooks, servers and permissions.',
    fieldEnv: 'The group’s environment variables, one KEY=VALUE line each.',
    fieldProjectPaths:
      'Project directories where the group switches itself on. Empty — the manual toggle only.',
    fieldSteps:
      'The working-order steps. Compiled into a skill, and the skill is what joins the group.',
    fieldScenarioTrigger:
      'A regular expression over the request text. Filled in — the panel installs a UserPromptSubmit hook.',
    fieldTrigger: 'The scenario’s event and an optional matcher.',
    fieldAction: 'The shell command to run.',
    fieldCompiled: 'A reference to the hook the scenario became. Read-only.',

    limitsTitle: 'Boundaries and numbers',
    limitsCaption: 'The things people come back for and look up with their eyes, not by reading.',
    limitMembers: 'Kinds of member',
    limitMembersValue:
      'five: rule, skill, hook, server, permission. Plus another group — nesting is ' +
      'allowed, a cycle is refused',
    limitEvents: 'Scenario events',
    limitEventsValue: 'nine, from PreToolUse to PreCompact — the same list an ordinary hook has',
    limitExit: 'Exit code 2',
    limitExitValue: 'stops the action and asks for confirmation; any other code is just a message',
    limitAuto: 'The project binding',
    limitAutoValue:
      'switches on only, and at the start of any run in the directory: a message sent to ' +
      'the agent, a task split, a clean-session continuation. A branch copy counts as the ' +
      'same project',
    limitRebuild: 'Rebuilding scenarios',
    limitRebuildValue:
      'on every save. Only hooks carrying the panel’s mark are touched, hand-written ' +
      'ones stay as they are',
    limitSandbox: 'The sandbox',
    limitSandboxValue:
      'takes the group’s own members — rules, skills, hooks, servers. Permissions are ' +
      'never carried over, and a nested group’s membership is not expanded',

    notesTitle: 'Things that trip people up',
    noteAutoOnTitle: 'A bound group switches on without asking',
    noteAutoOnText:
      'The very first run in a bound project switches the group on — a typed message, a ' +
      'task split and a clean-session continuation alike — with its rules, skills, hooks ' +
      'and variables, and in every project at once: the ' +
      'configuration files are shared. That is the price of the automation, so bind only ' +
      'bundles that do not get in the way of the rest of the work.',
    noteRebuildTitle: 'Scenarios are rebuilt on every save',
    noteRebuildText:
      'The panel recreates the hooks out of them and leaves hand-written hooks alone — ' +
      'the absence of the mark is what tells them apart. An edit made directly to a ' +
      'compiled hook is lost at the next rebuild.',
    noteLocalHookTitle: 'A hook from settings.local.json does not obey a group',
    noteLocalHookText:
      'The panel never writes to that file, so it has nothing to switch such a hook off ' +
      'with — it stays on even when it belongs to a group that went dark. The panel ' +
      'counts those members separately and says how many were skipped when the group is toggled.',
    noteTriggerTitle: 'A bad trigger blocks the save',
    noteTriggerText:
      'The Save button stays clickable and the form only reddens the field — but the ' +
      'panel rejects the whole save: «The trigger expression is not a regular ' +
      'expression». Neither the steps nor the membership nor the variables are stored, ' +
      'and nothing appears in the Hooks section. Fix or clear the expression and save again.',
    noteInvisibleTitle: 'Claude knows nothing about groups',
    noteInvisibleText:
      'It sees the resulting settings only. A group is a way to keep order on your side, ' +
      'not something you can ask for in a conversation.',
    notePermTitle: 'Permissions are not carried into the sandbox',
    notePermText:
      'Even when they belong to the group. An isolated run has boundaries of its own, ' +
      'and substituting yours for them would be wrong.',
    noteConflictTitle: 'The panel only catches a permission conflict on one pattern',
    noteConflictText:
      'Two permission members with the same pattern and different decisions (allow and ' +
      'deny at once) are highlighted right in the group form. Contradictions in meaning — ' +
      'two rules or skills that argue in substance — it does not see: those show up only in a run.',

    undoTitle: 'How to put it back',
    undoCaption: 'One case per line — undo is looked up after the fact, not before.',
    undoOff: 'A group was switched off by mistake',
    undoOffText:
      'Switch it back on with the same toggle: the members return from «Disabled», ' +
      'skills-disabled and mcpServersDisabled, and the variables go into settings.json ' +
      'again. All except the ones you had switched off yourself — those you switch on by hand.',
    undoDelete: 'A group was deleted',
    undoDeleteText:
      'The members are all still there — assemble the bundle again and, if the group was ' +
      'off, check the toggles: its members came on when it was deleted.',
    undoAuto: 'A group switched itself on and is not wanted',
    undoAutoText:
      'Switch it off with the toggle and untick the project in the group’s form, or the ' +
      'next message in the same directory switches it on again.',
    undoHook: 'An edit to a compiled hook disappeared',
    undoHookText:
      'As it should: a hook with the panel’s mark is rebuilt from the scenario. Edit the ' +
      'scenario itself, and if you need the hook as it is — remove the mark and the panel ' +
      'will stop treating it as its own.',
    undoSkill: 'The working-order skill is in the way',
    undoSkillText:
      'It is a member of the group and goes off with it. To remove it entirely, clear the ' +
      'steps in the group form; deleting the skill folder by hand is pointless — the next ' +
      'save builds it again.',
  },

  shots: {
    bundle: {
      '01-empty':
        'The empty section: no groups, no scenarios, and the panel explains what they are for',
      '02-form':
        'The group form: everything in the configuration on the left, the order of application on the right, 6 selected',
      '03-conflict':
        'An allow added as the seventh member to a pattern that has a deny — the form warns about the conflict',
      '04-env':
        'The bottom of the form: projects for automatic switch-on, the working-order steps and the group’s variables',
      '05-card': 'The «Frontend review» card: 6 members, env: 1 and the description of the bundle',
      '06-off': 'The same bundle after the toggle: the «off» badge on the group’s card',
      '07-rules-off':
        'The Rules section: two rules marked «off» — one put out by the group, the other by you',
      '08-rules-on':
        'The group is back on: «Answer with a diff» returned, the manually disabled rule stayed off',
      '09-delete':
        'The delete dialog: type the name, the members stay, and a switched-off group releases them',
    },
    auto: {
      '01-binding':
        'Binding to projects: ticks on the directories and the warning that the group will not switch itself off',
      '02-steps': 'Three working-order steps: what to do, the details and «done when»',
      '03-trigger-error':
        'A bad trigger: the field goes red with «This is not a regular expression», and the panel will reject the save',
      '04-card':
        'The bound group’s card: projects 1, steps 3 and the project’s own set — 2 skills, 2 hooks, 2 rules',
      '05-skill': 'The Skills section: the steps became the «Shop tickets» skill, 1 file, 980 B',
      '06-automation-form':
        'The scenario form: the event, a matcher or a quick skill pick, the command and what exit code 2 means',
      '07-automation-card':
        'The scenario on the page: PostToolUse, the Edit matcher, the pnpm type-check command',
      '08-hooks':
        'The Hooks section: two hooks from the panel, marked agentdeck:scenario and agentdeck:automation',
    },
  },

  diagrams: {
    'two-marks':
      'Two independent switch-off marks: one belongs to the human, one to the group, and an entity revives only when both are gone.',
    'compiled-set':
      'What a group does to the configuration: the steps become a skill, the scenario a marked hook, and the variables go into settings.json while the group is on.',
  },
};
