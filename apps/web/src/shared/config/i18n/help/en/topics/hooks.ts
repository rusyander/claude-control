import type { hooksRu } from '../../ru/topics/hooks';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const hooksEn: typeof hooksRu = {
  topic: {
    title: 'Hooks',
    summary: 'Commands that run by themselves on Claude Code events',
    lead:
      'A hook is a command tied to an event: before a tool is called, after a file ' +
      'is written, when a session starts. Unlike rules and skills this is not a ' +
      'request to the model but ordinary code that always runs. So hooks are for ' +
      'the things you cannot leave to judgement: hard stops, auto-formatting, ' +
      'preparing context.',

    guideTitle: 'What this page contains',
    guideText:
      'First, why hooks exist and where they are stored. Then two diagrams: what ' +
      'happens at the moment of an event, and which file an entry ends up in. ' +
      'Then two paths in screenshots: the first hook from scratch and working ' +
      'with a set you already have. At the end — the events, the fields, the ' +
      'limits and how to undo.',

    whyGuarantee: 'It always fires',
    whyGuaranteeText:
      'A rule can be interpreted by the model however it likes; a hook cannot. It ' +
      'is your code, and it runs on every event no matter what the model decided.',
    whyBlock: 'It can say no',
    whyBlockText:
      'Two events — before a tool call and when you submit a message — can stop the ' +
      'action. That is how a guard against rm -rf or writing a token into a file is ' +
      'built.',
    whyAutomate: 'It removes manual chores',
    whyAutomateText:
      'Formatting on save, a briefing at session start, a checkpoint before the ' +
      'context is compacted — things you would otherwise have to remember and do ' +
      'yourself.',

    diffTitle: 'A hook, a rule and a skill are not the same thing',
    diffCaption:
      'Three ways to shape how the agent works, and they get confused constantly. ' +
      'The difference is who executes them.',
    diffRule: 'A rule is text for the model',
    diffRuleText:
      'It lives in CLAUDE.md, costs context on every request and is followed ' +
      'exactly as far as the model understood it. A hook is code the system runs.',
    diffSkill: 'A skill is an instruction on demand',
    diffSkillText:
      'It is pulled in when the model decides the task fits. A hook does not ask ' +
      'the model at all: the event happened, the command ran.',
    diffPermission: 'A permission is an allowance with no code',
    diffPermissionText:
      'A denial in permissions is a pattern and executes nothing. A hook can look ' +
      'at the arguments, read the disk and decide — but only on two of the nine events.',

    guide: {
      mapTitle: 'What happens at the moment of an event',
      mapCaption:
        'The diagram answers the section\'s main question: why a hook "silently ' +
        'did nothing", and why exit code 2 stops the work on one event and only ' +
        'writes to the log on another.',
      storageMapTitle: 'Where a hook lives',
      storageMapCaption:
        'The second diagram is about storage. A hook has two parts in different ' +
        'places, which is exactly why switching it off looks like disappearance ' +
        'and deleting it does not remove the file.',
      pathTextTitle: 'The same path in words',
      pathTextText:
        'The event happens → Claude Code checks the tool filter (four of the nine ' +
        'events have one) → runs the command, handing it the event on stdin → looks ' +
        'at the exit code. A 2 on PreToolUse and UserPromptSubmit stops the action, ' +
        'and the text from stderr explains why; on the other seven events nothing ' +
        'is blocked. When the script file is missing there is no error either — ' +
        'nothing simply happens, and that is the one reason the panel paints such a ' +
        'hook red.',

      firstTitle: 'The first hook: from an empty section to a guard',
      firstCaption:
        'There is no hooks key in settings.json at all. Five steps, and the file ' +
        'gains an entry while hooks/ gains a working script.',
      fEmpty: 'Not a single hook',
      fEmptyText:
        'The empty state explains what a hook is and offers ready-made presets. At ' +
        'this point neither the file nor the hooks key in settings.json exists — ' +
        'the panel will create both.',
      fForm: 'The event is picked from a list',
      fFormText:
        'Next to every event it says when it happens and whether it can stop the ' +
        'action — there is no need to memorise nine names. Below is the tool filter ' +
        'as checkboxes: in the file it will be joined by a vertical bar.',
      fPreset: 'A preset fills everything in at once',
      fPresetText:
        'The destructive command guard set the event, the Bash|PowerShell filter, ' +
        'the guard template and the pattern list. Only two things were typed here: ' +
        'the file name, no-force-push, and the commands to intercept — git push ' +
        '--force, git reset --hard.',
      fCard: 'The hook in the list, the script on disk',
      fCardText:
        'The panel created the file in hooks/ and filled in the launch command with ' +
        'an absolute path: the hooks counter became 1, the scripts counter 8. If the ' +
        "name is taken the panel refuses rather than overwriting someone else's file.",
      fBulk: 'Several guards in one action',
      fBulkText:
        'The second creation mode: five presets with checkboxes instead of a form. ' +
        'Two are ticked; the panel will create them one by one and show progress, ' +
        'and a failure on one does not cancel the rest.',

      livingTitle: 'The set is already there: order, switching off, editing',
      livingCaption:
        'Six hooks across four events. This is where everything that makes hooks ' +
        'different shows up: grouping by event, order within it, entries from the ' +
        'personal file and a broken hook.',
      lList: 'The list is grouped by event',
      lListText:
        'Not alphabetically: the event group is the answer to "what happens at this ' +
        'point". PreToolUse holds two guards, PostToolUse two handlers, and one of ' +
        'them carries a red "script file not found" mark: the entry is there, the ' +
        'file is not, and such a hook does exactly nothing. The local SessionEnd hook ' +
        'carries the same mark.',
      lLocal: 'Entries from the personal file are marked',
      lLocalText:
        'A hook from settings.local.json is shown with a "local" badge and no ' +
        'toggle: switching off would mean deleting a line from a personal file, and ' +
        'the panel does not make that decision for you. Deleting is possible — and ' +
        'the dialog states which file the entry leaves and that the script stays on disk.',
      lOrder: 'Order within an event',
      lOrderText:
        'Hooks of one event run top to bottom, and the arrows change exactly that ' +
        'order in the file. The order of events among themselves is not ' +
        'configurable — Claude Code decides it.',
      lOff: 'A disabled hook leaves the file',
      lOffText:
        'The toggle removes the entry from settings.json entirely — otherwise the ' +
        "CLI would keep running it. The panel remembers the hook's text, so " +
        'switching it back on restores exactly what was there.',
      lEdit: 'A ready hook exposes its command',
      lEditText:
        'The file holds only the command and the timeout — that is what the form ' +
        'shows; presets are not offered here, so nothing configured gets ' +
        'overwritten. The timeout hint names the CLI default: empty means 60 seconds.',

      shotsTitle: 'The screenshots are real',
      shotsText:
        'The frames were shot on a separate panel with a throwaway config ' +
        'directory: it parses a real settings.json, creates real files in hooks/ and ' +
        'writes there. They are re-shot with node tools/help-shots/config-panel.mjs.',
    },

    canPreset: 'Build a hook from a ready-made preset in one click',
    canScript: 'Let the panel create the script file and fill in the launch command',
    canMatcher: 'Limit the event to specific tools with checkboxes',
    canAssistant: 'Fill the form with the assistant by describing the task in words',
    canProbe:
      'Run the hook against a prepared event or your own arbitrary JSON event — ' +
      'instantly, without using your limit',
    canBulkPresets: 'Create several presets at once by ticking the ones you want',
    canToggle: 'Switch a hook off without losing its settings',
    canOrder: 'Reorder hooks within a single event with up and down buttons',
    canTimeout: 'Set a timeout so a stuck script does not hold up the work',

    cantDebug: 'Step through a script in a debugger — only runs and output',
    cantLocal:
      'Switch off a hook from settings.local.json with the toggle: editing and deleting it ' +
      'is possible, but switching off would mean deleting a line from a personal file',
    cantBlockAll: 'Block an action on any event: only two of the nine can stop anything',
    cantStable:
      'Rely on a stable link for two identical hooks: the identifier is derived from ' +
      'the content, and full duplicates differ only by a suffix',
    cantProjectHooks:
      "Configure a project's hooks: the section edits personal files, while a project's " +
      '.claude/settings.json lives in the Projects section',
    cantOrderEvents:
      'Reorder the events themselves: the order within an event is yours, the order of events ' +
      "is the CLI's",

    storageFile: 'Settings',
    storageFileValue: '~/.claude/settings.json → the hooks key',
    storageLocal: 'The personal file',
    storageLocalValue:
      '~/.claude/settings.local.json → read and written; entries carry a "local" badge',
    storageScripts: 'Scripts',
    storageStructure: 'How it is stored',
    storageStructureValue: 'event → filter → commands; the panel flattens that into a plain list',
    storageOff: 'Disabled ones',
    storageOffValue: 'never written to settings.json at all — their text is kept by the panel',

    badgeBlocks: 'can stop it',
    badgeMatcher: 'has a filter',

    evtPreToolUse:
      'Before Claude calls a tool. This is where hard stops go: refuse a dangerous ' +
      'command or demand confirmation.',
    evtPostToolUse:
      'Right after a tool has finished. Reacting to the result: format the changed ' +
      'file, run a linter, record the event.',
    evtUserPromptSubmit:
      'Once you send a message, before Claude has seen it. You can append context to ' +
      'the request or bring up a rule by keyword.',
    evtNotification:
      'When Claude Code shows a notification. Useful for passing it on: a sound, a ' +
      'system window, a message in a chat app.',
    evtStop:
      'When Claude has finished answering. Wrap-up work: collect a report, signal ' + 'completion.',
    evtSubagentStop:
      'When a subordinate agent has finished. Handling the results of background tasks.',
    evtSessionStart:
      'When a session starts or resumes. Preparing context: repository state, open ' +
      'tasks, an environment check.',
    evtSessionEnd: 'When a session ends. Tidying up: save notes, close temporary files.',
    evtPreCompact:
      'Before an overflowing context is compacted. The last chance to write what ' +
      'matters to a file — after compaction the details are gone.',

    noteProviderTitle: 'Other providers have a different hook model',
    noteProviderText:
      'Everything described here is about Claude Code. With the Qwen Code provider the ' +
      'section opens a list of rules: an event, an optional matcher, a command and a ' +
      'timeout in MILLISECONDS. They live under the root hooks key of settings.json — the ' +
      'same file where the panel edits permissions; there are eighteen events, and six of ' +
      'them (UserPromptSubmit, MessageDisplay, Stop, StopFailure, TodoCreated, ' +
      'TodoCompleted) take no matcher per the docs, so the field is simply hidden. An ' +
      'unfamiliar shape is preserved per event: an event whose group carries two actions ' +
      'or a foreign field turns read-only as a whole, while the rest stay editable. The ' +
      'disableAllHooks key is shown as a warning: while it is on, the CLI runs no hook at ' +
      'all. With the Kimi Code provider it is the same list of rules, but stored as an ' +
      'array of [[hooks]] tables in config.toml, with the timeout in SECONDS (1–600), ' +
      'sixteen events, and the first three (UserPromptSubmit, PreToolUse, Stop) able to ' +
      'block the action with exit code 2. Kimi has no project hooks at all. The guard is ' +
      'stricter than Qwen’s: a flat TOML array cannot be rewritten partially without ' +
      'losing foreign entries, so any deviation from the documented shape turns THE WHOLE ' +
      'section read-only. With the OpenCode provider the ' +
      'section opens a different screen, because its hooks are built differently: they ' +
      'are the experimental.hook key of opencode.json (global and per-project), and ' +
      'there are exactly two events. "File edited" (file_edited) maps a file pattern to ' +
      'a list of actions — edit a file matching *.ts and prettier --write runs. ' +
      '"Session completed" (session_completed) is simply a list of actions to run when ' +
      'work finishes. A command is given as a list of arguments, not a shell string: ' +
      'the program first, then its arguments one per field, so no pipes and no && ' +
      'there. OpenCode has no blocking, no tool matchers and no nine events. Note: as of ' +
      '25 July 2026 the section is READ-ONLY for OpenCode. The key lived under ' +
      'experimental, which OpenCode declares unstable, and it is gone from there: neither ' +
      'the configuration reference nor the published schema mentions it any more, and ' +
      'experimental itself is closed to unknown keys in the schema. The panel shows what ' +
      'is already in the file but has stopped writing — the documented way to attach an ' +
      'action to an event is now plugins alone.',

    eventsTitle: 'Nine events: what fires when',
    eventsCaption:
      'Only PreToolUse and UserPromptSubmit can block an action. Four events support ' +
      'a tool filter; on the others a hook always fires.',

    templatesTitle: 'What a hook does: four templates',
    templatesCaption:
      'The template decides what code the panel writes for you and which fields the ' +
      'form shows.',
    tplMessage: 'Message',
    tplMessageText:
      'Prints text that Claude will see. That is how a reminder at session start or ' +
      'before compaction is added.',
    tplGuard: 'Guard',
    tplGuardText:
      'Looks for your patterns in the command or the file path and, on a match, ' +
      'stops the action with an explanation. Patterns are listed comma-separated.',
    tplShell: 'Shell command',
    tplShellText:
      'Runs an ordinary shell command — a formatter over the saved file, say. The ' +
      'action itself is not blocked.',
    tplBlank: 'Blank scaffold',
    tplBlankText:
      'A ready file that reads the event from stdin with room for your own logic. ' +
      'The place to start for anything custom.',

    presetsTitle: 'Ready-made presets',
    presetsCaption:
      'Five of them fill in the event, filter, template and every related field at ' +
      'once. Available when creating only, so a configured hook is never overwritten.',
    bulkTitle: 'Several at once',
    bulkText:
      'The second creation mode: instead of one form, a list of presets with ' +
      'checkboxes. Tick what you need and the panel creates them one by one, showing ' +
      'progress. A set of guards goes in with one action rather than five trips ' +
      'through the form. A failure on one preset does not cancel the rest, and what ' +
      'was created is edited as usual afterwards.',
    presetDestructive: 'Destructive command guard',
    presetDestructiveText:
      'Before Bash and PowerShell calls it checks the command for rm -rf, DROP ' +
      'TABLE, TRUNCATE, kubectl delete, docker volume rm — and stops it.',
    presetSecret: 'Secret guard',
    presetSecretText:
      'Before a file is written or edited it looks for token prefixes in the ' +
      'content: glpat-, ghp_, sk-, AKIA, the start of a private key.',
    presetFormat: 'Format on save',
    presetFormatText: 'After a file is written or edited it runs prettier over it.',
    presetBrief: 'Session briefing',
    presetBriefText: 'At session start it reminds you to check the project working notes.',
    presetCheckpoint: 'Checkpoint before compaction',
    presetCheckpointText:
      'Before an overflowing context is compacted it reminds you to write progress ' +
      'to a file — after compaction the details cannot be recovered.',

    fieldsTitle: 'Fields of a hook',
    fieldsCaption: 'Names match the hookDraftSchema schema.',
    fieldEvent: 'The Claude Code event the hook runs on. One of the nine.',
    fieldMatchers:
      'A filter by tool. Picked with checkboxes and written to the config joined by ' +
      'a vertical bar — syntax you do not need to remember.',
    fieldScriptName:
      'The script file name without an extension. If set, the panel creates the file ' +
      'in hooks/ and fills in the launch command itself. If a file with that name already ' +
      'exists, the panel refuses rather than overwrites: the other script stays intact.',
    fieldTemplate: 'What the hook does: message, guard, shell command, or a blank scaffold.',
    fieldDescription:
      'One sentence about what the hook is for. It goes into the header of the ' +
      'created script.',
    fieldMessage: 'The text of the message, or the explanation given when blocking.',
    fieldGuardPatterns:
      'What to intercept — patterns separated by commas. For the guard template only.',
    fieldCommand: 'A ready command, when no script file needs to be created.',
    fieldTimeout:
      'How many seconds to wait for the script before cutting it off. Empty means the ' +
      'Claude Code default, 60.',
    fieldGroups: 'Groups the hook belongs to.',

    limitsTitle: 'The limits of the section',
    limitsCaption:
      'The numbers and conditions people trip over most. Everything listed here is ' +
      'visible in the frames above.',
    limitEvents: 'Events',
    limitEventsValue:
      'nine. Two can stop an action — PreToolUse and UserPromptSubmit; four support a tool filter',
    limitTimeout: 'Timeout',
    limitTimeoutValue: 'in seconds; empty means the Claude Code default, 60',
    limitId: 'Identifier',
    limitIdValue:
      'the event plus a hash of the content: editing the command makes it a different entry, ' +
      'and two full duplicates differ only by a suffix',
    limitLocalWrite: 'The personal file',
    limitLocalWriteValue:
      'edits and deletions go back into settings.local.json exactly; there is no toggle — the ' +
      'panel does not remove lines from a personal file on its own initiative',
    limitProject: 'Project hooks',
    limitProjectValue:
      "not configured here: the section works with personal files, a project's " +
      '.claude/settings.json lives in the Projects section',
    limitApply: 'When it takes effect',
    limitApplyValue:
      'hooks are read when a session starts: an open conversation will not see a new hook, ' +
      'a restart is needed',

    recipesTitle: 'Setting up a guard in a minute',
    recipe1: 'Create → pick a preset',
    recipe1Text:
      'The destructive command guard fills in the event, filter, template and the ' +
      'pattern list for you.',
    recipe2: 'Adjust the patterns to your work',
    recipe2Text:
      'The comma-separated list is what will be intercepted. Add your own — a deploy ' +
      'command, for instance.',
    recipe3: 'Save and run it in the sandbox',
    recipe3Text:
      'The direct-run tab has prepared events: a safe command, a destructive one, a ' +
      'git push. You see at once what the hook caught and what it let through.',
    recipe4: 'Restart Claude Code',
    recipe4Text: 'Hooks are read at startup — in an open session a new hook is not active yet.',

    undoTitle: 'How to undo',
    undoCaption:
      'Nothing the section does is irreversible. The order below runs from the ' +
      'gentlest option to the bluntest.',
    undoToggle: 'Switch it off with the toggle',
    undoToggleText:
      'The entry leaves settings.json while its text stays with the panel. Switching ' +
      'it back on restores exactly what was there — the way to check "is it the ' +
      'hook?" without losing anything.',
    undoOrder: 'Put the order back with the arrows',
    undoOrderText:
      'Order within an event is just the order of lines in the file; the same arrows ' +
      'move it back.',
    undoDelete: 'Delete the entry',
    undoDeleteText:
      'The script stays in hooks/ and shows up in the Scripts section marked ' +
      '"unbound": the file may be needed by another hook.',
    undoBackup: 'Take it from a backup',
    undoBackupText:
      'Before every write the panel puts a copy of settings.json into backups/ — the ' +
      'whole state is restored from there, foreign keys of the file included.',

    notesTitle: 'Things people trip over',
    noteBrokenTitle: 'A hook with a missing script fails silently',
    noteBrokenText:
      'There is no error — nothing simply happens. The panel marks such hooks with a ' +
      'red badge, and on the Overview the whole hooks tile turns red.',
    noteIdTitle: 'A hook identifier is derived from its content',
    noteIdText:
      'It carries the event and a short hash of the filter and command, so deleting a ' +
      'neighbouring hook no longer shifts other links. The old positional form is kept ' +
      'as a fallback: marks made before the switch are still found by it. Editing the ' +
      'command itself does change the link, though — that is a different entry.',
    noteDisabledTitle: 'A disabled hook disappears from settings.json',
    noteDisabledText:
      'Otherwise Claude Code would keep running it. The command is not lost: a ' +
      "snapshot of the hook sits in the panel's state.json and is mixed back into " +
      'the list, so switching it on returns exactly what was there. Editing the file ' +
      'by hand outside the panel will not show disabled hooks.',
    noteLocalTitle: 'Hooks from settings.local.json are edited in their own file',
    noteLocalText:
      'The panel reads both the main settings.json and the personal ' +
      'settings.local.json — otherwise the list would lie about what actually fires. ' +
      'Entries from the personal file carry a "local" badge, and an edit goes back to ' +
      'exactly the same place rather than moving into the shared config: a personal ' +
      'setting must not become a shared one. Such a hook has no toggle on purpose — ' +
      'switching off here would mean deleting a line from a personal file, and the ' +
      'panel does not make that decision for you.',
    noteScriptTitle: 'Deleting a hook does not delete its script',
    noteScriptText:
      'The file stays in hooks/ and shows up in the Scripts section marked ' +
      '"unbound". That is deliberate: another hook may need it.',
    noteExitTitle: 'Exit code 2 means refusal',
    noteExitText:
      'On PreToolUse and UserPromptSubmit it stops the action, and the text from ' +
      'stderr explains why. On the other events nothing is blocked.',
  },

  shots: {
    first: {
      '01-empty': 'No hooks key in settings.json yet: the empty state explains and offers',
      '02-form': 'The event is picked from a list — each one says when it happens',
      '03-preset':
        'The preset filled in the event, filter and patterns; the file name and commands were typed',
      '04-card': 'An entry in settings.json and a script on disk: 1 hook, 8 scripts',
      '05-bulk': 'Several at once: two of the five presets are ticked',
    },
    living: {
      '01-list': 'Six hooks grouped by event; two carry a red mark about a missing file',
      '02-local': 'The dialog names the file the entry leaves and promises to keep the script',
      '03-order': 'The arrows change the order within an event — which is the order of execution',
      '04-off': 'The toggle removed the entry from settings.json; the panel keeps its text',
      '05-edit': 'A ready hook exposes its command and timeout; empty means the CLI default, 60',
    },
  },

  diagrams: {
    'hook-flow':
      'What happens at the moment of an event: the tool filter, the command launched with the event on stdin, and the exit code — a 2 stops the action on only two of the nine events.',
    'hook-storage':
      "Where a hook lives: the entry in settings.json or settings.local.json, the script file in hooks/, the snapshot of a disabled one in the panel's state.json. That is why switching off looks like disappearance and deleting does not remove the file.",
  },
};
