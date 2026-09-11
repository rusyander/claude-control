import type { permissionsRu } from '../../ru/topics/permissions';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const permissionsEn: typeof permissionsRu = {
  topic: {
    title: 'Permissions',
    summary: 'What Claude does without asking, what it asks about, and what it never does',
    lead:
      'A permission is a tool pattern plus a decision about it: allow, ask, or deny. ' +
      'Rules and skills explain to Claude how to behave; permissions draw a line it ' +
      'will not cross even if it decides that would be better. This is the one ' +
      'section where a refusal is mechanical.',

    guideTitle: 'How to read this page',
    guideText:
      'Two diagrams first: who decides whether a tool call may happen, and where a ' +
      'permission physically lives. Then two paths in screenshots — “the first setup” ' +
      'is done once, “an audit” is what repeats for the rest of the set’s life. After ' +
      'the screenshots: what the section writes on disk, the limits and refusals, and ' +
      'at the end the things people trip over.',

    whyHard: 'A boundary, not a request',
    whyHardText:
      'A rule can be interpreted; a permission cannot. Denying a command means the ' +
      'command does not run, whatever the model reasons.',
    whyQuiet: 'Fewer pointless questions',
    whyQuietText:
      'Actions you always allow anyway — reading files, git status — can be moved to ' +
      'allowed so you stop confirming them by hand.',
    whySystem: 'In plain language',
    whySystemText:
      'The System tab shows not raw patterns but ordinary actions with a risk rating: ' +
      '“any shell commands”, “deleting files”, “pushing to a remote”.',

    notTitle: 'What this section is NOT',
    notCaption:
      'Half the questions are “is this here or there”. Below are the neighbours it gets ' +
      'confused with most.',
    notColumn: 'Neighbouring section',
    notMeaningColumn: 'What it does instead',
    notRules: 'Rules and CLAUDE.md',
    notRulesText:
      'They explain to Claude how to behave. Those are requests: they can be read ' +
      'differently and worked around. A permission is a mechanical boundary, which is ' +
      'exactly why it stands apart.',
    notGroups: 'Groups',
    notGroupsText:
      'They silence and restore a batch of permissions at once, with one toggle. The ' +
      'permissions themselves still live here: a group only lifts their lines out of the ' +
      'file and puts them back.',
    notProjects: 'Projects',
    notProjectsText:
      'Project-level permissions live in the project itself and are edited there. This ' +
      'set is user-level: it applies in every conversation that does not say otherwise.',
    notMcp: 'MCP servers',
    notMcpText:
      'That is where a server is connected: address, command, tokens. Here you decide ' +
      'which of its tools Claude may use. “The server answers” and “the tool is allowed” ' +
      'are different things.',
    notSettings: 'Settings → backups',
    notSettingsText:
      'The only place a deleted permission can come back from: a backup is the whole ' +
      'settings file of that moment, not a single line.',

    mapTitle: 'How it works',
    mapCaption:
      'A screenshot shows a state, a diagram shows the mechanism: who takes the decision ' +
      'and where it is written down.',
    pathTextTitle: 'The same path in words',
    pathTextText:
      'Claude is about to call a tool. Out of the rules read at session start, the ones ' +
      'covering this call are selected: an exact match, a bare tool name (Bash covers ' +
      'Bash(git push:*) too), an MCP server name (mcp__orders covers ' +
      'mcp__orders__refund_order). Among those, the strongest decision wins: deny beats ' +
      'ask, ask beats allow — regardless of the file and the order of lines. If no rule ' +
      'matched, you are asked for confirmation — and asked where the work is happening: ' +
      'in a terminal that is Claude’s own question, in the panel chat it is an “the agent ' +
      'asks for permission” card right in the conversation, and the run waits until you ' +
      'answer. The panel runs the same analysis on its own side too — that is what draws ' +
      'the “not in effect” badge and the warning inside the form.',

    guide: {
      setupTitle: 'Path 1. The first setup: an empty section → a working set',
      setupCaption:
        'You come here when there are no permissions yet and Claude asks about ' +
        'everything. Done once; after that you live by audits.',
      setupEmpty: 'Open the System tab',
      setupEmptyText:
        'It is a list of common actions by category, not raw patterns. Each shows “Not ' +
        'set” on the right: there is no rule, so Claude will ask for confirmation. An ' +
        'empty section does not mean “everything is allowed”.',
      setupPreset: 'Press “Configure” next to the action you want',
      setupPresetText:
        'The form opens with the pattern already filled in — nothing to invent. All that ' +
        'is left is the decision: “Allowed”, “Ask” or “Denied”. The line under the ' +
        'buttons spells the choice out in plain words.',
      setupWarning: 'The pattern is checked for typos',
      setupWarningText:
        'Type a wish in words and the form warns: “does not look like the known forms”. ' +
        'That is a hint, not a block — you may save it, but such a rule will never fire.',
      setupBulk: 'Enter the routine as a batch',
      setupBulkText:
        'The “Several at once” tab: one decision for the whole list, then one pattern ' +
        'per line. The panel parses the list as you type and shows what it will create ' +
        'before you press anything.',
      setupConfigured: 'The System tab shows the result',
      setupConfiguredText:
        'Instead of “Not set” — a coloured decision badge and an “Edit” button. The ' +
        'counter in the sidebar counts every rule of the set, not only these.',
      setupShadowed: 'The form warns about an override',
      setupShadowedText:
        'If the same call is already covered by a stronger decision, the form says so ' +
        'before saving. It does not stop you: the choice is yours.',
      setupShadowedList: 'An overridden rule is visible in the list too',
      setupShadowedListText:
        'The card shows the decision that won plus a “not in effect” badge. That is the ' +
        'answer to the section’s main question — “I allowed it, why does it not work”.',

      auditTitle: 'Path 2. An audit: find it, switch it off, delete it',
      auditCaption:
        'You come back here once there are many rules: find the one you need, see where ' +
        'it came from, remove what is stale.',
      auditAll: 'The “All rules” tab — a flat list',
      auditAllText:
        'Search by pattern and a filter by decision. Every row carries four actions: ' +
        'move between files, edit, delete and a toggle.',
      auditSearch: 'Search by a fragment of the pattern',
      auditSearchText:
        'The search matches substrings: “git” finds every rule with git in the pattern, ' +
        'narrowed ones included. The decision filter works alongside it.',
      auditLocal: 'Local permissions are badged and have no toggle',
      auditLocalText:
        'Entries from settings.local.json carry a “local” badge. They can be edited, ' +
        'moved and deleted, but they have no toggle: the panel silences the personal ' +
        'file only when asked directly.',
      auditDisabled: 'The toggle switches off without deleting',
      auditDisabledText:
        'The line physically leaves the file — left there, it would keep working. In the ' +
        'list the rule stays marked “disabled”, and the toggle puts it back.',
      auditMcp: 'MCP tool permissions have their own tab',
      auditMcpText:
        'There can be over a hundred of them, and in the general list they swamp ' +
        'everything else. They behave exactly like any other permission.',
      auditDelete: 'Deleting asks you to type the name',
      auditDeleteText:
        'The dialog says what will happen: the line leaves settings.json and the tool ' +
        'returns to asking on every call. No mark is kept to restore it from — only the ' +
        'file backup in Settings.',
    },

    canThree: 'Assign one of three decisions: allow, ask, deny',
    canPattern: 'Narrow a rule to a specific command: not all of Bash, only git push',
    canPreset: 'Configure a common action from a ready list in one click',
    canBulk:
      'Create a batch of rules as a list, one per line: one decision is chosen for ' +
      'the whole list',
    canMcp: 'Manage permissions for MCP server tools on a separate tab',
    canMove: 'Move a permission between settings.json and settings.local.json with a button',
    canToggle:
      'Switch a permission off without deleting it: it leaves settings.json but stays in the ' +
      'list marked “disabled” — a permission held by a group looks the same',
    canSee: 'See which common actions are still unconfigured',
    canValidate:
      'Get a warning when a pattern does not look like the known forms: ' +
      'Bash(…), mcp__server__tool, Read(…)',
    canAssistant: 'Fill the form with the assistant by describing the rule in words',
    canShadow:
      'See which rules are not in effect: a stronger decision with the same or a wider ' +
      'pattern overrides them — deny on all of Bash silences allow on Bash(git status:*)',

    cantWhy: 'Find out why Claude asked for confirmation of a particular action',
    cantOrderCustom: 'Set your own resolution order: the priority of decisions is fixed',
    cantProject:
      'Split permissions per project here: this set is user-level, ' +
      'while project permissions live in the Projects section',
    cantRestart:
      'Apply an edit to a conversation already running: the files are read at session start',
    cantUndo:
      'Undo a deletion from inside the section: it comes back only by rolling the file back',

    storageFile: 'Where it is stored',
    storageFileValue: '~/.claude/settings.json → permissions.allow, .ask, .deny',
    storageLocal: 'The personal file',
    storageLocalValue:
      '~/.claude/settings.local.json → read and written; entries carry a "local" badge',
    storageId: 'Rule identifier',
    storageIdValue: 'the decision and the pattern together — it changes with the decision',
    storageMove: 'Changing the decision',
    storageMoveValue: 'the rule physically moves between the three lists',
    storageOff: 'A disabled permission',
    storageOffValue:
      'the line is cut from the file, and the mark that can restore it lives in ' +
      'agentdeck/state.json',
    storageWhen: 'When Claude sees it',
    storageWhenValue:
      'both files are read at session start — a conversation already open will not see the edit',
    storageOs: 'Your system matters',
    storageOsValue: 'the set of dangerous commands and the shape of paths depend on your OS',

    priorityTitle: 'Priority: what beats what',
    priorityCaption:
      'One action can fall under several rules. The strictest wins: a denial beats a ' +
      'question, a question beats an allowance.',
    priorityTop: 'stronger',
    priorityBottom: 'weaker',
    priorityDeny: 'never runs',
    priorityAsk: 'needs confirmation',
    priorityAllow: 'runs without asking',
    priorityNote:
      'Which has a practical consequence: a broad allowance such as Bash is safer ' +
      'balanced by narrow denials than by narrowing the allowance itself.',

    patternTitle: 'What a pattern is made of',
    patternCaption: 'A pattern is a tool name, narrowed where needed down to a specific command.',
    patternTool: 'A whole tool',
    patternToolText:
      'Read, Write, WebFetch, Bash — the rule covers every call of that tool. The ' +
      'broadest option.',
    patternNarrow: 'Narrowed down',
    patternNarrowText:
      'Bash(git push:*) — only pushing to a remote; other shell commands are untouched. ' +
      'The asterisk stands for the rest of the command.',
    patternMcp: 'An MCP server tool',
    patternMcpText:
      'mcp__server__tool — a rule for one tool of a connected server. There can be over ' +
      'a hundred of these, which is why they get their own tab.',

    tabsTitle: 'The three tabs of the section',
    tabSystem: 'System',
    tabSystemText:
      'Common actions by category: files, shell, network, git, tools. Each has a risk ' +
      'rating and its current state. “Not set” means there is no rule and Claude Code ' +
      'decides by its own defaults.',
    tabMcp: 'MCP servers',
    tabMcpText:
      'Permissions for the tools of connected servers. Kept apart because otherwise they ' +
      'swamp the general list.',
    tabAll: 'All rules',
    tabAllText:
      'A flat list of every rule with a filter by decision and a search by pattern. This ' +
      'is where you go to find one specific rule.',

    risksTitle: 'Risk ratings on the System tab',
    riskLow: 'Low',
    riskLowText:
      'The action changes nothing and goes nowhere: reading files, git status, web ' +
      'search, calling skills.',
    riskMedium: 'Medium',
    riskMediumText:
      'It changes files or reaches the network: editing and creating files, committing, ' +
      'fetching pages, running subordinate agents.',
    riskHigh: 'High',
    riskHighText:
      'Irreversible or visible to others: any shell command, deleting files, pushing to ' +
      'a remote.',

    refusalsTitle: 'Limits and refusals: what to do',
    refusalsCaption:
      'On the left, what you see on screen; on the right, what it means and how to fix it.',
    refusalsColumn: 'What you see',
    refusalsMeaningColumn: 'What to do',
    refusalShadow: 'Not in effect: overridden by “Denied”',
    refusalShadowText:
      'The same call is covered by a stronger decision. Either lift the denial or narrow ' +
      'its pattern — an allowance will not become stronger by itself.',
    refusalUnknown: 'Does not look like the known forms',
    refusalUnknownText:
      'The “Rule” field holds a wish in words, not a pattern. The panel will let you ' +
      'save it, but such a rule covers no call at all: make it Bash(…), Read(…) or ' +
      'mcp__server__tool.',
    refusalNotSet: 'Still “not set” although the rule exists',
    refusalNotSetText:
      'The System tab matches patterns literally: Bash(git push:*) and ' +
      'Bash(git push origin:*) are different to it. Look for your rule on the “All ' +
      'rules” tab.',
    refusalRestart: 'The edit had no effect',
    refusalRestartText:
      'Rules are read at session start. Open a new conversation — neither the terminal ' +
      'nor the panel chat picks up new permissions mid-dialogue.',
    refusalDeleted: 'Deleted a permission you needed',
    refusalDeletedText:
      'Create it again, or roll back the file backup in Settings — it restores the whole ' +
      'settings.json of that moment, neighbouring edits included.',

    fieldsTitle: 'Fields of a rule',
    fieldsCaption: 'Names match the permissionDraftSchema schema.',
    fieldPattern:
      'The pattern: a whole tool name or a narrowed one, or an MCP server tool in the ' +
      'form mcp__server__tool.',
    fieldDecision: 'The decision: allow — no questions, ask — confirm first, deny — refuse.',
    fieldGroups: 'Groups the rule belongs to.',

    notesTitle: 'Things people trip over',
    noteDenyTitle: 'A denial beats an allowance',
    noteDenyText:
      'If the same pattern is in both allowed and denied, denial wins. The redundant ' +
      'allowance is not highlighted anywhere.',
    noteIdTitle: 'Changing the decision changes the identifier',
    noteIdText:
      'The rule physically moves between lists in the file, so a link to it stops ' +
      'opening the right thing once the decision changes.',
    noteExactTitle: 'The System tab matches patterns literally',
    noteExactText:
      'A preset counts as configured only on an exact match. Bash(git push:*) and ' +
      'Bash(git push origin:*) are different things to it, and the second shows up as ' +
      '“not set”.',
    noteLocalTitle: 'Permissions from settings.local.json are edited right here',
    noteLocalText:
      'The panel reads both files — otherwise the list could not answer “why is this ' +
      'allowed”. Entries from the personal file carry a “local” badge, and an edit goes ' +
      'back exactly where it came from: a local permission is rewritten into ' +
      'settings.local.json, an ordinary one into settings.json. They cannot be mixed. ' +
      'Priority is shared regardless: a deny in the personal file beats an allow in the ' +
      'main one exactly as it would otherwise.',
    noteChatTitle: 'In the panel chat confirmation arrives as a card',
    noteChatText:
      'The “ask” decision works here too: the agent’s request appears as an “the agent ' +
      'asks for permission” card with Allow and Deny buttons, and the run waits until you ' +
      'press one; with no answer for half an hour the request is denied by itself — the ' +
      'safe side. Auto-approve silently lets through only what is reversible: reading ' +
      'always passes, even with the toggle off, while anything irreversible (deleting, ' +
      'wiping history, publishing outward) asks whatever the toggle says. Your own “ask” ' +
      'and “deny” rules outrank auto-approve — a matching call brings the card back. The ' +
      'edit toggle is an extra “read only” fuse, not a replacement for confirmation.',
    noteProviderTitle: 'Other providers use a different model',
    noteProviderText:
      'With the Codex provider these are not allow/ask/deny lists but two config.toml keys: ' +
      'approval_policy (when to ask) and sandbox_mode (what may be written). Gemini uses ' +
      'a third model, kept in settings.json: the approval mode general.defaultApprovalMode ' +
      'plus the tool lists coreTools (what is allowed) and excludeTools (what is blocked, ' +
      'and it wins). Allowing by list is safer than blocking by list. The panel never ' +
      'writes the yolo mode: in Gemini it is a command-line flag only and breaks CLI ' +
      'startup from the settings file. Qwen Code has its own model despite being a Gemini ' +
      'fork: the tools.approvalMode mode (default, plan, auto-edit, auto, yolo — here ' +
      'yolo is documented as a settings-file value, so the panel does write it) plus ' +
      'three rule lists permissions.allow, permissions.ask and permissions.deny, where a ' +
      'rule looks like Bash(git push *) or Read(/src/**); deny wins over the rest and ' +
      'holds even in autonomous modes. Continue has the simplest model of all, and it ' +
      'lives in a SEPARATE file, ~/.continue/permissions.yaml: no mode at all, just three ' +
      'lists — allow (run straight away), ask (confirm) and exclude (hide the tool from ' +
      'the agent). In headless mode (cn -p) tools under ask are unavailable: there is ' +
      'nobody to confirm. Goose boils down to ONE key, GOOSE_MODE in config.yaml: auto (run ' +
      'without asking), approve (by the configured permissions), smart_approve (auto-approve ' +
      'the safe calls) and chat (never run tools at all). Goose has no rule lists, and per-tool ' +
      'permissions sit in a neighbouring permission.yaml: the panel shows them as three lists ' +
      'but never writes that file — its format is absent from the Goose documentation, and the ' +
      'panel will not guess a foreign format. Change them with goose configure. ' +
      'Kimi Code has two models at once: the default_permission_mode key of config.toml ' +
      '(manual — always ask, auto — the agent decides, yolo — never ask) and an ORDERED ' +
      'array of [[permission.rules]], each with a pattern (Read, Bash(git push*), ' +
      'mcp__server__tool) and an allow / ask / deny decision. Order matters: the rules are ' +
      'checked top to bottom. An unknown field inside the permission block makes the ' +
      'section read-only — the panel does not edit blindly. ' +
      'OpenCode uses yet another model — the permission key ' +
      'of opencode.json (global and per-project): the edit (file edits), bash (shell ' +
      'commands) and webfetch (network fetches) tools each get an allow, ask or deny ' +
      'level, and bash may take a list of command patterns instead — e.g. “*” ask, ' +
      '“git *” allow, “git push *” deny. Entries inside permission that the panel does ' +
      'not manage are kept as they are and shown read-only; per-agent permissions ' +
      '(agent.*) are not touched at all. ' +
      'Cursor has the shortest list-based model: the permissions key in ' +
      '~/.cursor/cli-config.json (in a project the file is named .cursor/cli.json and holds ' +
      'permissions only) and exactly two lists — allow (run without asking) and deny ' +
      '(blocked). There is neither a mode nor an “ask” list: anything in neither list the ' +
      'CLI asks about itself, and deny beats allow. A rule reads as Shell(git status), ' +
      'Read(src/**), Write(docs/**), WebFetch(domain) or Mcp(server:tool). ' +
      'Templates, mcp__* permissions and moving an ' +
      'entry between files are Claude capabilities. For Aider the section is ' +
      'hidden.',
  },

  shots: {
    setup: {
      '01-system-empty':
        'The System tab on an empty set: every action reads “Not set” next to a “Configure” button',
      '02-form-preset':
        'The form with the pattern Bash(git push:*) already filled in and “Denied” chosen',
      '03-form-warning':
        '“deny git push” typed instead of a pattern — the warning “does not look like the known forms”',
      '04-bulk':
        'The “Several at once” tab: six lines, a “6 recognised” badge and the “Create all (6)” button',
      '05-system-configured':
        'The same cards once configured: decision badges, “Edit”, and the sidebar counter at 11',
      '06-form-shadowed':
        'The form warns: a “Denied” for Bash(git push:*) already exists and it is stronger',
      '07-system-shadowed':
        'The “Pushing to a remote” card carrying the badge “not in effect: overridden by Denied”',
    },
    audit: {
      '01-all-rules':
        'The “All rules” tab: search, the decision filter and twenty rules with their row actions',
      '02-search': 'The search “git” leaves four rules — from an allowed status to a denied push',
      '03-local': 'The search “Bash(”: the two bottom rows are badged “local” and have no toggle',
      '04-disabled':
        'Bash(git commit:*) after the toggle: a “disabled” badge, a grey switch and an “Updated” toast',
      '05-mcp-tab': 'The “MCP servers” tab: five tool permissions of the orders server',
      '06-delete':
        'Deleting asks for the rule name and states that the tool returns to asking every time',
    },
  },

  diagrams: {
    'decision-order':
      'One call end to end: session rules → the covering ones → the strongest decision → denial, question or silence',
    'where-rules-live':
      'The form, the two settings files and the panel’s own mark: what the toggle, the bin and the move button do',
  },
};
