import type { TranslationSchema } from './ru';
import { helpEn } from './help/en';

/** Типизирован по русской версии: забыть ключ при переводе не получится. */
export const en: TranslationSchema = {
  help: helpEn,

  common: {
    appName: 'Claude Control',
    appTagline: 'Every Claude Code setting in one place',
    collapseSidebar: 'Collapse the sidebar',
    expandSidebar: 'Expand the sidebar',
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    edit: 'Edit',
    create: 'Create',
    search: 'Search',
    refresh: 'Refresh',
    enabled: 'Enabled',
    disabled: 'Disabled',
    loading: 'Loading…',
    empty: 'Empty',
    error: 'Error',
    total: 'total',
    show: 'Show',
    hide: 'Hide',
    needsRestart: 'Changes apply after restarting Claude Code',
    backupCreated: 'Backup created',
    confirmTypeName: 'Type "{{name}}" to confirm',
    other: 'Other',
    close: 'Close',
    megabytes: 'MB',
    gigabytes: 'GB',
    showAll: 'Show all ({{count}})',
    showLess: 'Collapse',
    details: 'Details',
    deleteTitle: 'Delete permanently?',
    deleteRule:
      'The rule will be cut from CLAUDE.md. A backup of the file goes to claude-control/backups, but the rule itself will be gone from the file.',
    deleteSkill:
      'The skill folder will be deleted from disk with everything inside. A copy of the folder goes to claude-control/backups — restoring it from there is a manual job.',
    deleteHook:
      'The hook will be removed from settings.json. The script file stays on disk but stops being called. A config backup goes to claude-control/backups.',
    deleteMcp:
      'The server will be removed from the configuration. Its tools stop being available to Claude after a restart.',
    sourceLocal: 'local',
    deleteHookLocal:
      'The hook will be removed from settings.local.json, your personal settings file. The script file stays on disk. A config backup goes to claude-control/backups.',
    localReadOnly:
      'An entry from settings.local.json, your personal settings file. Claude Code applies it alongside the shared ones; edits go back to that same file.',
    deleteGroup:
      'The group will be deleted. The rules, skills, hooks and servers themselves stay where they are — only the grouping disappears. If the group is currently off, its members are switched back on.',
    deleteAutomation:
      'The automation will be deleted and the hook compiled from it removed from settings.json. Hand-written hooks are left alone.',
  },
  nav: {
    overview: 'Overview',
    search: 'Search',
    analytics: 'Analytics',
    chat: 'Chat',
    rules: 'Rules',
    claudeMd: 'CLAUDE.md',
    hooks: 'Hooks',
    scripts: 'Scripts',
    skills: 'Skills',
    commands: 'Commands',
    plugins: 'Plugins',
    mcp: 'MCP servers',
    permissions: 'Permissions',
    env: 'Environment',
    projects: 'Projects',
    groups: 'Groups',
    history: 'Change history',
    compare: 'Comparison',
    settings: 'Settings',
    help: 'Help',
    sectionMain: 'Main',
    sectionBehavior: 'Claude behaviour',
    sectionIntegrations: 'Integrations and access',
    sectionApp: 'Application',
  },
  providerCompare: {
    title: 'Configuration comparison',
    subtitle: 'What one CLI has and the other does not — and how to move it across',
    left: 'Left',
    right: 'Right',
    swap: 'Swap the sides',
    samePair: 'Pick two different providers',
    empty: 'Neither side has anything here',
    incomparable: 'different models',
    opaque: 'The value is secret — only presence was checked',
    loadError: 'The comparison failed to load',
    loadErrorText: 'The panel could not read the configurations. Check that the server is running.',
    toRight: 'Move into {{name}}',
    toLeft: 'Move into {{name}}',
    migrateDone: 'Entries moved: {{count}}',
    migrateNothing: 'There turned out to be nothing to move',
    migrateError: 'The transfer failed',
    section: {
      mcp: 'MCP servers',
      env: 'Environment variables',
      permissions: 'Permissions',
      instructions: 'Global instructions',
    },
    state: {
      same: 'identical',
      differs: 'differs',
      'left-only': 'left only',
      'right-only': 'right only',
    },
  },
  providers: {
    inDevelopment: 'in development',
    inDevelopmentShort: 'soon',
    unsupported: 'unavailable',
    unknownProvider: 'this provider',
    sectionPlannedSubtitle: 'This section is still in development for the selected provider',
    sectionPlannedTitle: 'The “{{provider}}” section is still in development',
    sectionPlannedText:
      'Support for this section with “{{provider}}” is planned, but the adapter is not ready yet. The panel does not read from or write to this provider’s configuration. This section works fully with the Claude Code provider.',
    sectionUnsupportedTitle: 'This section is unavailable for “{{provider}}”',
    sectionUnsupportedText:
      'This CLI has no such section, so it is hidden from navigation. Choose a provider that supports it — for example, Claude Code.',
  },
  search: {
    title: 'Search',
    subtitle:
      'One box across every section: rules, skills, hooks, scripts, permissions, variables, servers and plugins',
    placeholder: 'Looking for what? A name, command, pattern, key…',
    promptTitle: 'Start typing a query',
    promptText: 'Searches every configuration section at once. Two characters are enough.',
    emptyTitle: 'Nothing found',
    emptyText: 'No matches for "{{query}}". Try another word or part of a name.',
    resultsCount: 'Found: {{count}}',
    section: {
      rule: 'Rules',
      skill: 'Skills',
      hook: 'Hooks',
      script: 'Scripts',
      plugin: 'Plugins',
      mcp: 'MCP servers',
      permission: 'Permissions',
      env: 'Environment variables',
      instructions: 'Global instructions',
    },
  },
  palette: {
    title: 'Command palette',
    placeholder: 'Jump to a section or search the configuration…',
    hint: 'Start typing: a section to jump to, or a query across all sections.',
    empty: 'Nothing found for “{{query}}”.',
    footer: '↑↓ to move · ⏎ to open · g o overview · g c chat · ? help · Esc to close',
  },
  notifications: {
    title: 'Notifications',
    subtitle: 'Recent notifications — the ones shown as toasts',
    clear: 'Clear',
    emptyTitle: 'No notifications yet',
    emptyText: 'Recent toasts will appear here: creations, errors, configuration changes.',
  },
  history: {
    title: 'Change history',
    subtitle: 'What changed in the configuration: a timeline of edits with diffs',
    explainTitle: 'What this is',
    explain:
      'Before every write the panel backs up the file, so the copies are snapshots over time. The timeline is built from them: which file, when, and what changed. A copy is compared against the previous copy of the same file, and the freshest one against the current file on disk. The timeline covers Claude files and the active provider files (AGENTS.md/GEMINI.md, config.toml, mcp.json, opencode.json, .aider.conf.yml). Secrets never appear: neither .mcp-secrets.env nor the provider API key store.',
    empty: 'No changes yet',
    emptyText:
      'No edit has been backed up yet. As soon as the panel writes something to the configuration, the timeline will appear here.',
    base_current: 'vs current file',
    base_previous: 'vs previous copy',
    base_initial: 'first known version',
    noChanges: 'no changes',
    loadingDiff: 'Loading diff…',
    diffError: 'Failed to load the diff',
    diffLabel: 'Diff of {{file}}',
    skip_initial: 'This is the first known version — nothing to compare against.',
    skip_binary: 'Binary file — diff is not shown.',
    'skip_too-large': 'File is too large — diff is not shown.',
    providerFile: '{{provider}} provider file',
    readOnlyProvider:
      'Provider file — view only: reverting from here is disabled so another CLI’s copy can never land in the Claude configuration.',
    revertHunk: 'Revert this change',
    revertHunkConfirmTitle: 'Revert only this change?',
    revertHunkConfirmText:
      'In {{file}} this one block will return to the copied state; the other changes stay as they are. The current state is saved as a separate copy — the revert is reversible too. The edit takes effect after Claude Code restarts.',
  },
  overview: {
    title: 'Configuration overview',
    subtitle: 'What is currently wired into your Claude Code',
    configPath: 'Configuration directory',
    detectedAuto: 'detected automatically',
    detectedEnv: 'from environment variable',
    detectedManual: 'set manually',
    notFound: 'not found',
    missingFiles: 'Missing files',
    brokenHooks: 'hooks with a broken path',
    mcpFailed: 'servers not responding',
    unusedScripts: 'not bound to any event',
    groupsHint: 'setting bundles',
    groupsEmpty: 'none yet',
    allScriptsUsed: 'all bound to hooks',
    backups: 'Backups',
    backupsLast: 'latest',
    backupsNone: 'no backups yet',
    // Quick actions on tiles and the changes summary.
    quickAdd: 'Add',
    quickClaudeMd: 'CLAUDE.md',
    quickHistory: 'Open history',
    changesTitle: 'Changes in {{days}} days',
    changesHint: 'Open change history',
    changesNone: 'No changes',
  },
  rules: {
    title: 'Rules',
    subtitle: 'Personal rules from CLAUDE.md — active in every project',
    explainTitle: 'What this is',
    explain:
      'CLAUDE.md is read at the start of every session. Everything here acts as standing instructions for Claude: language, restrictions, workflow.',
    addRule: 'Add rule',
    mode_simple: 'Simple',
    mode_builder: 'Builder',
    mode_bulk: 'Several at once',
    builderTitle: 'Rule blocks',
    builderHint:
      'Assemble the rule from blocks — allowed, forbidden, with care. The text builds itself.',
    section_allow: 'Allowed',
    section_deny: 'Forbidden',
    section_caution: 'With care',
    section_custom: 'Custom section',
    sectionTitlePlaceholder: 'Section name',
    itemPlaceholder: 'One rule item',
    addItem: 'Item',
    addSection: 'Add block:',

    ruleTitle: 'Title',
    ruleBody: 'Rule text',
  },
  claudeMd: {
    title: 'CLAUDE.md',
    subtitle: 'The whole global instructions file — exactly as Claude Code reads it',
    // Per-provider adaptation (Codex→AGENTS.md, Gemini→GEMINI.md). Claude uses the
    // keys above so its look and copy stay exactly as before.
    titleFor: 'Global instructions — {{fileName}} ({{provider}})',
    subtitleFor: 'The whole global instructions file — exactly as {{provider}} reads it',
    explainFor:
      'This is the active provider’s global instructions file ({{path}}). The Rules section turns it into cards; here it is open in full: preamble, arbitrary sections, order and formatting. Edit it by hand — a backup is made before writing. The directory is created on save if it does not exist yet.',
    cliMissing:
      '{{provider}} was not found on this system — the file will be created at {{path}} on save.',
    explainTitle: 'What this is',
    explain:
      'This is the same ~/.claude/CLAUDE.md the Rules section turns into cards. Here the file is open in full: preamble, arbitrary sections, order and formatting. Edit it by hand — a backup is made before writing.',
    chars: 'Characters: {{count}}',
    unsaved: 'unsaved changes',
    revert: 'Revert changes',
    saved: 'CLAUDE.md saved',
  },
  bulk: {
    modeSingle: 'One',
    modeMany: 'Several at once',
    inputLabel: 'A list — one {{kind}} per line',
    hint: 'Each line is a separate entry. Empty lines are skipped.',
    recognized: 'recognised',
    withErrors: 'with an error',
    createAll: 'Create all ({{count}})',
    failed: 'not created',
    failedHint: 'The server rejected these lines — the rest were created. Fix them and try again.',
    sharedDecision: 'The action applies to every line in the list.',
    unbalanced: 'unbalanced brackets',
    needEquals: 'no = sign',
    emptyTitle: 'empty title',
    badKey: 'invalid variable name',
  },
  sandbox: {
    title: 'Sandbox',
    subtitle:
      'An isolated check: Claude Code runs with a temporary configuration containing only what you are testing. Your real settings are untouched.',
    contents: 'What is loaded',
    empty: 'Nothing loaded yet',
    preparing: 'Preparing the sandbox…',
    isolationTitle: 'Sandbox boundaries',
    isolationText:
      'A separate settings directory and its own working folder. Real settings are read-only, the token file is out of reach, and everything created is wiped when you leave the sandbox — and in any case no later than two hours of idling.',
    tabProbe: 'Event run',
    tabTools: 'Tools',
    tabChat: 'Conversation',
    probeHint:
      'A hook receives an event and answers with a decision, so it can be tested directly — instantly and without calling the model. Pick cases or run them all.',
    runAll: 'Run all',
    runSelected: 'Run selected',
    modeFixtures: 'Fixtures',
    modeCustom: 'Custom input',
    customLabel: 'JSON event',
    customHint: 'A Claude Code hook event, for example: {"hook_event_name": "PreToolUse", …}',
    customTitle: 'Custom input',
    runCustom: 'Run',
    customInvalidJson: 'Could not parse JSON — check the syntax.',
    customNotObject: 'The event must be a JSON object like {"hook_event_name": "…"}.',
    timedOut: 'The hook did not answer in time and was stopped',
    decision: {
      block: 'stopped it',
      ask: 'asked for confirmation',
      pass: 'let it through',
      error: 'did not run',
    },
    connecting: 'Starting the server and requesting its tools…',
    tool: 'Tool',
    chooseTool: '— choose a tool —',
    arguments: 'Call arguments',
    argumentsHint: 'JSON with the arguments. An empty object if none are needed.',
    argumentsInvalid: 'The arguments are not valid JSON — the call was not sent',
    argumentsNotObject: 'The arguments must be a JSON object like {"key": "value"}',
    callTool: 'Call',
    callOk: 'The tool answered',
    callFailed: 'The tool returned an error',
    schema: 'Argument schema',
    chatHint:
      'Rules and skills do not run on their own — they change how the model behaves. Ask something where the thing you are testing should show up.',
    prompt: 'Prompt',
    promptPlaceholder: 'For example: run the command rm -rf ./temp',
    runPrompt: 'Send to the sandbox',
    waiting: 'Claude is answering…',
    answerPlaceholder: 'The sandbox answer will appear here',
    runFailed: 'The server could not start the sandbox (code {{status}})',
    emptyResponse: 'Empty server response',
    expired:
      'The sandbox was wiped after two hours of idling: a copy of your account access must not sit on disk for hours. Close the window and open it again — its contents will be assembled anew.',
    deleteFailed:
      'The sandbox was not deleted, a copy of your account access is still inside. {{reason}}',
    accessTitle: 'Account access',
    access_file: 'Claude Code settings file',
    access_keychain: 'macOS keychain',
    access_panel: 'Set by hand in the panel settings',
    access_apiKey: 'API key from the environment',
    access_none: 'Not found',
    noAccess:
      'A sandbox conversation will not work: Claude Code will answer «Not logged in». Set the access up in Settings → Claude Code access.',
  },
  chat: {
    title: 'Chat',
    newChat: 'New chat',
    searchChats: 'Search chats',
    searchPlaceholder: 'title, project or text',
    searchInMessages: 'text in messages',
    searchMode: 'Search mode',
    searchByTitle: 'By title',
    searchByMessages: 'In messages',
    searchMessagesHint: 'Type at least 2 characters to search the conversation',
    placeholder: 'Ask anything — dictate it or attach a file',
    hint: 'Enter to send, Shift+Enter for a new line',
    send: 'Send',
    stop: 'Stop',
    queue: {
      title: 'Queued: {{count}}',
      add: 'Add to the queue',
      hint: 'The agent is busy — the message goes out as soon as the current turn ends',
      cancel: 'Remove from the queue',
    },
    attach: 'Attach a file',
    thinking: 'Thinking',
    /** Пока ответа ещё нет: без этого пустая лента выглядит зависшей. */
    pending: 'Claude is thinking',
    pendingTools: 'Claude is working with files',
    errorTitle: 'The agent stopped with an error',
    progress: {
      title: "The agent's plan",
      count: '{{done}} of {{total}} done',
      agents: 'Subagents: {{count}}',
      working: 'The agent is working',
      noTasks: 'The agent has not set itself any tasks yet',
      tree: 'Work handed out',
      result: 'What it returned',
      status: {
        pending: 'not started',
        in_progress: 'in progress',
        completed: 'done',
      },
      agentStatus: {
        running: 'working',
        done: 'done',
        failed: 'failed',
      },
    },
    questionTitle: 'Your choice is needed',
    questionMulti: 'multiple choices allowed',
    pickOption: 'Answer with this option',
    permissionTitle: 'The agent needs permission',
    permissionLost:
      'The decision never reached the agent: the request had already been dropped — it timed out or the conversation was restarted. If the agent is still waiting, send the prompt again.',
    permissionUnreachable:
      'The decision was not sent: no connection to the panel server. The agent keeps waiting for an answer.',
    allow: 'Allow',
    deny: 'Deny',
    model: 'Model',
    modelHint: 'Model for this conversation. Empty — as set in Settings.',
    modelClaudeDefault: 'Opus 4.8 (1M)',
    effort: 'Thinking effort',
    effortAuto: 'default',
    effortHint: 'How deeply the agent reasons about the answer. Empty — as set in Settings.',
    fromSettings: '{{value}}',
    effort_low: 'Low',
    effort_medium: 'Medium',
    effort_high: 'High',
    effort_xhigh: 'Very high',
    effort_max: 'Max',
    copyMessage: 'Copy message',
    editMessage: 'Edit and send as a new branch',
    copyArtifact: 'Copy contents',
    tabPreview: 'Preview',
    tabSource: 'Source',
    emptyTitle: 'Chat with Claude Code',
    emptyText:
      'A full conversation: attach a PDF, an image or some markup, ask for a page or a document — and see the result in the preview straight away.',
    suggestions: {
      page: 'Build a page with a chart from this data',
      explain: 'Explain what this code does',
      summarize: 'Summarise the attached document',
    },
    sandboxHint: 'This chat keeps its files in a separate folder; your projects stay untouched',
    sandboxLabel: 'Panel chat',
    messageCountPartial:
      'Long conversation: the list reads the head and tail of the file, so there are at least this many messages.',
    allowEdits: 'Allow editing project files',
    readOnly: 'Read-only',
    editsAllowed: 'Edits allowed',
    autoApprove: 'Auto-approve permissions',
    autoApproveOn: 'Permissions auto',
    autoApproveOff: 'Permissions manual',
    autoApproveHint:
      'The panel approves safe requests itself. Git writes (commit, push, merge), deletions, migrations, MCP writes and anything covered by ask/deny rules from settings.json still ask.',
    retry: 'Retry',
    retryHint: 'Restart with the same prompt',
    continue: 'Continue',
    continueWord: 'continue',
    continueHint: 'Ask the agent to pick up where it stopped',
    allowAndContinue: 'Allow and continue',
    allowAndContinueHint: 'Restart with full access — the agent does everything without asking',
    today: 'Today',
    yesterday: 'Yesterday',
    thisWeek: 'This week',
    earlier: 'Earlier',
    justNow: 'just now',
    minutesAgo: '{{count}} min ago',
    limitResets: 'limit until {{time}}',
    resizePreview: 'Resize the preview',
    loadOlder: 'Load older',
    export: 'Export',
    exportHint: 'Download the conversation as a file (Markdown)',
    deleteArtifact: 'Delete file “{{name}}”',
    deleteArtifactTitle: 'Delete file?',
    deleteArtifactConfirm:
      'File “{{name}}” will be removed from the chat folder. This cannot be undone.',
    artifactDeleted: 'File “{{name}}” deleted',
    notSent: {
      busy: 'The previous answer is still being generated — your message was not sent. The running answer is shown: use “Stop” to interrupt it.',
      files:
        'The panel cannot pass these attachments: {{names}}. Message not sent. Allowed extensions: {{supported}}.',
      tooLarge:
        'The panel does not pass attachments over {{limit}}, so the file was not attached: {{names}}.',
      other: 'Message not sent: {{message}}',
    },
    kind: {
      html: 'page',
      markdown: 'markup',
      pdf: 'document',
      image: 'image',
      code: 'code',
      data: 'data',
      other: 'file',
    },
  },
  resources: {
    newFile: 'New file',
    assistantTitle: 'Structure assistant',
    assistantHint:
      'Describe the task — the assistant creates and fills files wholesale. Existing files are kept.',
    assistantPlaceholder:
      'For example: split this skill into topic modules and link them from SKILL.md',
    assistantRun: 'Build',
    assistantWorking:
      'The assistant is building the structure — this takes up to a couple of minutes…',

    startFromTemplate: 'Start from a structure template:',
    emptyStart: 'Or create an empty file',

    treeHint: 'Files — open, edit, create or delete them here',
    readOnlyHint: 'These files are read-only: Claude Code installs and updates them',
    noFiles: 'No nested files',
    binaryFile: 'Binary file — cannot be shown as text',
    deleteFileWarn:
      'The file {{path}} will be removed from disk. There is no undo — only a backup.',
    deleteFolderWarn:
      'The folder {{path}} will be removed entirely, with every file inside it ({{count}}). There is no undo — only a backup.',
  },
  scripts: {
    title: 'Scripts',
    subtitle: 'Files that hooks run',
    explainTitle: 'What lives here',
    explain:
      'Every file in the hooks/ folder of your Claude Code configuration. Hooks on the neighbouring page decide when a script runs — here you edit the code itself. A script with no event bound to it simply sits in the folder and does nothing.',
    subtitleNoHooks: 'Your own script files in the panel folder',
    explainNoHooks:
      'Every file in the hooks/ folder of the panel directory. This section belongs to the panel itself: your own scripts live and get edited here — Node.js, PowerShell, shell or Python. The selected provider has no hooks, so nothing binds them to events: you run them yourself.',
    addScript: 'Add script',
    mode_constructor: 'Builder',
    mode_bulk: 'Several at once',
    templatesTitle: 'Ready-made scaffolds',
    templatesHint: 'Pick a code template — then tweak the condition and text.',
    fileName: 'File name',
    fileNameHint: 'With an extension: .mjs for Node.js, .ps1 for PowerShell, .sh for the shell.',
    renameHint: 'Changing the name creates a new file — the old one stays where it is.',
    code: 'Script code',
    used: 'In use',
    unused: 'Not bound',
    formHint: 'The file is saved to the hooks/ folder. A backup is made first.',
    deleteScript: 'The file will be removed from the hooks/ folder.',
    deleteUsedWarning:
      'This script is called by a hook. Once deleted the hook will stop working — the file will not be found.',
  },
  hooks: {
    title: 'Hooks',
    subtitle: 'Commands that run on Claude Code events',
    explainTitle: 'How it works',
    explain:
      'A hook is a shell command bound to an event. PreToolUse fires before a tool call and can require confirmation, PostToolUse fires after. The matcher narrows an event down to specific tools.',
    event: 'Event',
    matcher: 'Matcher',
    command: 'Command',
    scriptMissing: 'Script file not found',
    addHook: 'Add hook',
    moveUp: 'Move up in the event order',
    moveDown: 'Move down in the event order',
    mode_constructor: 'Builder',
    mode_bulk: 'Several at once',
    presetsTitle: 'Ready-made hooks',
    presetsHint: 'Pick a preset — every field fills in, then tweak the details.',
    matcherHint:
      'Narrows the event: a tool name, or several separated by a pipe. Empty means it always fires.',
    noMatcherSupport: 'This event always fires — it takes no matcher.',
    commandHint:
      'Shell command. Exit code 2 blocks the action and asks for confirmation; other codes just report.',
    canBlock: 'Can block the action',
    customMatcher: 'Custom tool',
    scriptName: 'Hook file name',
    scriptNameHint:
      'The file is created for you in hooks/ with a .mjs extension. Leave empty if the command runs an existing program.',
    description: 'What this hook does',
    descriptionPlaceholder: 'for example: blocks recursive deletion',
    whatItDoes: 'What should happen',
    template_message: 'Show a hint',
    template_guard: 'Block dangerous actions',
    template_shell: 'Run a command',
    template_blank: 'Empty scaffold',
    templateHint_message:
      'The text goes into the agent context — used to restate rules and add needed facts.',
    templateHint_guard:
      'If the command contains one of the listed strings, the action stops and asks for your confirmation.',
    templateHint_shell: 'Runs your command and shows its output. The action is not blocked.',
    templateHint_blank:
      'Creates a file with the scaffold: input parsing and exit codes already in.',
    messageText: 'Hint text',
    messagePlaceholder: 'Remember the rule: MR descriptions are written in Russian',
    guardPatterns: 'What to intercept',
    guardPatternsHint: 'Comma separated. Fires when the string appears in a command or path.',
    guardMessage: 'Message on trigger',
    guardMessagePlaceholder: 'Dangerous operation — confirm manually',
    shellCommand: 'Command',
    shellCommandHint: 'Runs in a shell. The output goes into the agent context.',
    blankHint: 'The file is created with a scaffold — write the code yourself in any editor.',
    fileCreated: 'File created',
  },
  commands: {
    title: 'Commands',
    subtitle: 'Everything you can invoke with a slash: {{count}} commands',
    explainTitle: 'Where commands come from',
    explain:
      'The list merges four sources: your skills, command files, commands from installed plugins and the built-in commands of the CLI itself. The section is read-only: a skill is edited in the Skills section, a plugin in the Plugins section, and a built-in command has no file to edit at all. The built-in catalog is maintained by the panel — the CLI does not expose its own list — so a command from a newer version may be missing here.',
    searchPlaceholder: 'Name, description or owner',
    filter: {
      all: 'All',
      skill: 'Skills',
      command: 'Command files',
      plugin: 'Plugins',
      builtin: 'Built-in',
    },
    source: {
      builtin: 'built-in',
      skill: 'skill',
      command: 'command file',
      plugin: 'plugin',
    },
    kind: {
      skill: 'bundled skill',
      workflow: 'agent workflow',
    },
    removed: 'removed from the CLI',
    disabled: 'disabled',
    owner: 'From',
    aliases: 'Also known as',
    family: 'Nearby',
    related: 'See also',
    open: 'Open',
    emptyTitle: 'Nothing found',
    emptyText: 'Try another query or clear the source filter.',
  },
  skills: {
    title: 'Skills',
    subtitle: 'Instruction sets Claude pulls in based on their description',
    explainTitle: 'How it works',
    explain:
      'A skill is a folder with a SKILL.md file. The description field decides when Claude applies it, so it must describe the situation precisely. A disabled skill moves to skills-disabled and becomes invisible.',
    addSkill: 'Create skill',
    files: 'files',
    newFile: 'New file',
    treeHint: 'Skill files — open, edit, create or delete them here',
    description: 'Description — when to apply',
    descriptionHint:
      'The key field: Claude uses it to decide whether to pull the skill in. Describe the situation and the wording users will come with ("Use WHEN the user asks…").',
    skillName: 'Skill name',
    skillNameHint: 'Latin letters with dashes — becomes the folder name in skills/',
    skillBody: 'Instructions',
    saveFrontmatter: 'Save and continue',
    modeSimple: 'Simple skill',
    modeSimpleHint: 'A single SKILL.md',
    modeBuilder: 'Builder',
    modeBuilderHint: 'A folder of topic modules',
    createAndBuild: 'Create and build structure',
    pickTemplate: 'Structure template',
    pickTemplateHint:
      'Pick a shape — it unfolds right after creation. You can skip and build by hand.',
    structureTitle: 'File structure',
    structureHint:
      'A skill can be a folder of modules. Build the structure from a template, the assistant, or by hand — SKILL.md already exists.',
    skillBodyHint: 'The body of SKILL.md: what exactly to do, step by step. Markdown.',
    templates: {
      title: 'SKILL.md template',
      hint: 'Fills the instructions with a ready skeleton — tweak it afterwards.',
      blankTitle: 'Empty skeleton',
      blankBody:
        '# {{name}}\n\n## When to apply\n\nDescribe the situation in which Claude should pull this skill in.\n\n## What to do\n\nSteps or rules.\n',
      toolTitle: 'Tool skill with steps',
      toolBody:
        '# {{name}}\n\n## When to apply\n\nUse WHEN the user asks… — describe the trigger in the words they will come with.\n\n## Steps\n\n1. First step.\n2. Second step.\n3. What counts as the result.\n\n## What not to do\n\nExplicit prohibitions and common mistakes.\n\n## How to verify the result\n\nA command, test, or sign that the work is done.\n',
      ruleTitle: 'Rule instruction',
      ruleBody:
        '# {{name}}\n\n## Rule\n\nState the rule in one or two sentences — what to always or never do.\n\n## Why\n\nWhy this rule exists and what it prevents.\n\n## Examples\n\n- Good: …\n- Bad: …\n',
      checklistTitle: 'Check / checklist',
      checklistBody:
        '# {{name}}\n\n## When to apply\n\nBefore handing off work or during review … — describe the trigger moment.\n\n## Checklist\n\n- [ ] First check item\n- [ ] Second item\n- [ ] Third item\n\n## If something is off\n\nWhat to do when an item fails.\n',
    },
    rename: 'Rename',
    renameLabel: 'New name (skill folder)',
    renameHint:
      'The folder name in skills/ — also the identifier. Renames the folder and moves its marks.',
    renamePlaceholder: 'e.g. perf-audit',
  },
  providerMcp: {
    title: 'MCP servers · {{provider}}',
    subtitle: 'External tool providers for {{provider}}',
    explain:
      'This provider stores its MCP servers in {{fileName}} ({{format}} format). The panel edits only the servers section and leaves the rest of the file untouched. New servers are picked up after the CLI restarts.',
    transportHint:
      'stdio — the server runs as a process; http — connect to an already running address',
    cliMissing:
      '{{provider}} CLI was not detected. Saving still works — the file will be created at {{path}}.',
    readOnly:
      'The format of {{path}} was not recognized — the section is read-only and writing is disabled for safety.',
    fromBlockFile: 'from block file: {{path}}',
    blockSkipped: 'The panel does not manage block file {{path}}. {{reason}}',
  },
  // Instructions as a LIST OF REFERENCES (Aider): not a single-file editor but
  // management of the list of files the CLI config attaches. Named honestly.
  providerInstructions: {
    title: 'Attached instruction files · {{provider}}',
    subtitle: '{{provider}} reads these files as context',
    explainTitle: 'How it works',
    explain:
      '{{provider}} has no single instructions file like CLAUDE.md. Context files are declared by the read option in the {{fileName}} config — the panel edits exactly that LIST OF REFERENCES: add a file, remove one, change the order (which is the order they are attached in). Comments and every other key of the config stay in place, and a backup is made before each write. The contents of a listed file can be opened and edited right here — but only if the file already exists: the panel never creates files for you. Changes apply after restarting the CLI.',
    configPath: 'Config holding the list:',
    configMissing: 'file does not exist yet — it will be created on save',
    exists: 'file present',
    missing: 'file missing',
    reason_binary: 'Not a text file — the panel does not open it.',
    reason_too_large: 'Too large to edit in the panel.',
    reason_directory: 'This is a directory, not a file.',
    reason_unsafe_path:
      'The file lies outside the project — the panel neither opens nor writes it.',
    editFile: 'Edit contents',
    closeFile: 'Collapse',
    moveUp: 'Move up',
    moveDown: 'Move down',
    addLabel: 'Path to the file',
    addHint:
      'An absolute path, or a relative one resolved against {{baseDir}}. The full path is shown in the list.',
    addEntry: 'Add to the list',
    duplicate: 'That path is already in the list.',
    removeEntry:
      'Remove the file from the read list? The file itself stays on disk — only the reference in the config disappears.',
    empty: 'The list is empty: the config attaches no instruction files yet.',
    readOnly:
      'The format of {{path}} was not recognized — the section is read-only and writing is disabled for safety.',
  },
  // Instructions as a RULES DIRECTORY (Cursor, CURSOR-1): not a single file and
  // not a list of references, but a directory of `.mdc` files with frontmatter.
  providerRules: {
    title: 'Rules · {{provider}}',
    subtitle: '{{provider}} rules directory: .mdc files with frontmatter',
    explainTitle: 'How it works',
    explain:
      '{{provider}} has no single instructions file like CLAUDE.md. Rules live in the {{rulesDir}} DIRECTORY: every .mdc file is one rule, opening with a frontmatter block of three fields (description, file globs and an "always apply" flag) followed by plain markdown with the rule text. Nested subdirectories are supported. The panel edits only those three fields and the rule text: comments and any other frontmatter keys stay in place, and a backup is made before each write. A plain .md file in this directory is ignored by Cursor - such files are listed separately and never edited. Changes apply after restarting the CLI.',
    rulesDir: 'Rules directory:',
    dirMissing: 'the directory does not exist yet - it will be created when a rule is saved',
    dirUnreadable:
      'The directory {{path}} cannot be read - the section is read-only and writing is disabled for safety.',
    empty: 'No rules yet: create the first one and an .mdc file will appear in the directory.',
    badgeAlwaysApply: 'always applied',
    badgeMalformed: 'frontmatter not parsed',
    badgeNoFrontmatter: 'no frontmatter',
    globsPrefix: 'files:',
    edit: 'Edit',
    view: 'View',
    close: 'Collapse',
    deleteRule:
      'Delete the rule file? The panel makes a backup before deleting; the directory itself stays.',
    otherKeys: 'own frontmatter keys: {{keys}}',
    readOnlyMalformed:
      'The panel could not parse this frontmatter, so the file is shown in full and read-only: rewriting markup it does not understand would be unsafe. Fix the file in an editor and the rule becomes editable again.',
    readOnlyNoFrontmatter:
      'The file has no frontmatter block between "---" lines, so Cursor does not pick it up as a rule. The panel shows the file in full, read-only - it will not add frontmatter on your behalf.',
    fieldPath: 'Rule path inside the directory',
    hintPath:
      'Relative to {{rulesDir}}. A subdirectory is allowed - frontend/react.mdc; it is created on save. The .mdc extension is appended automatically.',
    fieldDescription: 'Description',
    hintDescription:
      'A short summary of the rule. The model uses it to decide whether to attach the rule when no globs are set.',
    placeholderDescription: 'React component rules',
    fieldGlobs: 'File globs',
    hintGlobs:
      'The rule attaches when a matching file is in play. Separate several patterns with commas. Empty - never attached by pattern.',
    fieldAlwaysApply: 'Always apply',
    hintAlwaysApply: 'The rule is added to every conversation regardless of globs.',
    fieldBody: 'Rule text (markdown)',
    createTitle: 'New rule',
    createRule: 'Create rule',
    duplicate: 'A rule with that path already exists.',
    unsafePath: 'The path must stay inside the rules directory: no ".." and no absolute paths.',
    ignoredTitle: 'Cursor does not read these files',
    ignoredExplain:
      'Only .mdc files with frontmatter count as rules. Everything else in the directory is ignored by Cursor - the panel lists them but never edits or deletes them.',
  },
  providerHooks: {
    title: 'Hooks · {{provider}}',
    subtitle: '{{provider}} hooks: the experimental.hook key in opencode.json',
    explainTitle: 'How it works',
    explain:
      '{{provider}} organises hooks differently from Claude: they live in the experimental.hook key of {{filePath}}. There are exactly two events. "File edited" (file_edited) maps a file pattern to a list of actions: edit a file matching the pattern and the actions run. "Session completed" (session_completed) is simply a list of actions to run when work finishes. A command is given as a LIST OF ARGUMENTS, not a shell string: the program first, then its arguments one per field - so spaces inside an argument are safe. The panel edits only this key: the rest of the file, other experimental keys and unknown events stay put, and a backup is made before writing. Changes take effect after the CLI restarts.',
    experimentalNote:
      'The key lived under experimental, which {{provider}} declares unstable - and that is exactly what happened: as of 25 July 2026 experimental.hook is gone from both the configuration reference and the published schema, and experimental itself is closed to unknown keys there. The panel no longer writes it and only shows what is already in the file.',
    writeDisabledHint:
      'The documented way to attach an action to an event is now plugins alone: the "Plugins" section manages both the file directory and the npm package list. Hooks already written are left alone - they stay in the file as they are and can still be edited by hand.',
    filePath: 'Configuration file:',
    absent: 'no hooks in the file yet',
    readOnly:
      'The format of {{path}} was not recognised - the section is read-only, writing is disabled for safety.',
    eventLocked:
      'The panel did not recognise the shape of this event, so it leaves it alone: it is shown read-only and stays in the file as is.',
    fileEdited: {
      title: 'File edited (file_edited)',
      hint: 'A file pattern plus the actions that run after a matching file is edited. For example "*.ts" and prettier --write.',
      pattern: 'File pattern',
      addPattern: 'Add pattern',
      addAction: 'Add action',
      empty: 'No patterns yet: add the first one and actions will run after matching files change.',
    },
    sessionCompleted: {
      title: 'Session completed (session_completed)',
      hint: 'Actions that run once the session ends. No patterns here - just a list.',
      addAction: 'Add action',
      empty: 'No actions yet.',
    },
    action: {
      title: 'Action',
      remove: 'Remove action',
      command: 'Command',
      commandHint:
        'One argument per field: the first field is the program itself, the rest are its arguments. No shell is involved, so "prettier --write" as a single string will not work - that is two fields.',
      argvFirst: 'Program',
      argvNth: 'Argument {{index}}',
      addArg: 'Add argument',
      environment: 'Environment variables',
      environmentHint:
        "Optional. Passed to the action's process; they do not affect the CLI's own environment.",
      envKey: 'Name',
      envValue: 'Value',
      addEnv: 'Add variable',
    },
    preserved: {
      title: 'The panel does not touch these',
      text: 'Entries the panel does not manage: unknown events inside hook and other experimental keys. They stay in the file as is and are shown read-only.',
    },
    rules: {
      explain:
        'For {{provider}} a hook is a rule: an event, an optional matcher, a shell command and a timeout. The rules live in {{filePath}}; the event list comes from the CLI documentation and is offered in the dropdown. The matcher is a regular expression over the event target (a tool name, for instance) and exists only for events that support one - the others would silently ignore it, so the panel does not show the field there. The command is run by a shell, as a single line. The panel manages only rules of the shape it knows: an event it could not parse is shown separately and stays in the file untouched. A backup is made before writing, and changes take effect after the CLI restarts.',
      title: 'Rules',
      hint: 'Event, optional matcher, command and timeout. An empty list removes the hooks section from the file entirely.',
      event: 'Event',
      matcher: 'Matcher (regular expression)',
      command: 'Shell command',
      timeoutMs: 'Timeout, ms (default {{default}})',
      timeoutSec: 'Timeout, s ({{min}}-{{max}}, default {{default}})',
      add: 'Add rule',
      empty: 'No rules yet: add the first one and the command will run on the chosen event.',
      disabledAll:
        'The file has disableAllHooks: true - the CLI will run no hook at all while that key is on. The panel does not change it: it is the master switch for the whole section and turning it off should be a deliberate act.',
      preservedText:
        'Events whose shape the panel could not parse (several actions in a group, an action that is not of type command, foreign fields). They stay in the file as is and are shown read-only.',
    },
  },
  providerPlugins: {
    title: 'Plugins · {{provider}}',
    subtitle: '{{provider}} plugins: files in the plugins directory and npm packages in the config',
    explainTitle: 'How it works',
    explain:
      'These are plugins of {{provider}} itself, not extensions of the panel. There are two documented ways to add one. First, drop a JS or TS file into {{pluginsDir}}: everything there is loaded by the CLI at startup. Second, list npm package names in {{configPath}} under the plugin key; both plain and scoped packages such as @org/name are supported. The panel manages both: files can be created, edited and deleted (a backup is made before writing and before deleting), and the package list can be edited as a whole. A file path must stay inside the plugins directory: "..", absolute paths and foreign extensions are rejected. Changes take effect after the CLI restarts.',
    pluginsDir: 'Plugins directory:',
    dirMissing: 'the directory does not exist yet - it will be created when a file is saved',
    dirUnreadable:
      'Directory {{path}} cannot be read - file management is unavailable, writing is disabled for safety.',
    installed: {
      explain:
        'For {{provider}} a plugin is a ready-made package: it brings skills, MCP servers, hooks and slash commands. What is installed lives in {{pluginsDir}}, each plugin with its own JSON manifest. The panel shows the list and what each plugin brings, but changes NOTHING there: plugins are installed, enabled and disabled with the /plugins command inside the CLI itself, and the shape of the installed-plugins registry is not documented - the panel will not write into it blind.',
      readOnly:
        'This section is for viewing only: install, enable and disable plugins with the /plugins command inside the CLI.',
      empty: 'No plugins installed.',
      broken: 'manifest unreadable',
      skills: 'brings skills',
      sessionSkill: 'session-start skill: {{skill}}',
      mcp: 'MCP servers: {{list}}',
      hooks: 'hook rules: {{count}}',
      commands: 'adds commands',
      registry: 'Installed-plugins registry: {{path}} - the panel never writes it.',
    },
    ignoredTitle: 'The panel does not manage these files',
    ignoredExplain:
      'The panel edits only .js, .ts and .mjs. Anything else in the directory is listed but never touched.',
    file: {
      edit: 'Edit',
      content: 'File contents',
      delete:
        'Delete this plugin file? The panel makes a backup first; the directory itself stays in place.',
      empty: 'No plugin files yet: create the first one and it will appear in the directory.',
      createTitle: 'New plugin file',
      fieldPath: 'File path inside the directory',
      hintPath:
        'Relative to {{pluginsDir}}. A subdirectory is allowed - git/notify.ts; it is created on disk when you save. The .ts extension is appended automatically unless you give your own (.js, .ts or .mjs).',
      create: 'Create file',
      duplicate: 'A file with that path already exists.',
      unsafePath: 'The path must stay inside the plugins directory: no ".." and no absolute paths.',
    },
    packages: {
      title: 'Plugins from npm',
      hint: 'Package names from the plugin key. Plain and scoped (@org/name) packages work the same. The panel edits only this key; it cannot install packages - the CLI does that.',
      field: 'Package name',
      add: 'Add to the list',
      empty: 'The list is empty: no npm plugins are attached.',
      duplicate: 'That package is already in the list.',
      invalid: 'A package name must not contain spaces or quotes.',
      readOnly:
        'The format of {{path}} was not recognised - the list is read-only, writing is disabled for safety.',
      preservedTitle: 'The panel does not touch these',
      preservedText:
        'Entries of the "name + options" form: the documentation does not describe their shape, so the panel keeps them as is and never rewrites them.',
    },
  },
  // Skills of the CLI itself (OpenCode, OPENCODE-5): a directory of folders with
  // SKILL.md. Not the Claude skills section — that has its own model and routes.
  providerSkills: {
    title: 'Skills · {{provider}}',
    subtitle: '{{provider}} skills: folders with SKILL.md in the skills directory',
    explainTitle: 'How it works',
    explain:
      'These are the skills of {{provider}} itself. A skill is a folder in {{skillsDir}}, with a SKILL.md file inside carrying a YAML front matter. The panel recognizes and edits two required front-matter fields — name and description; the license, compatibility, metadata and any other fields it keeps as is and shows read-only. The skill name must equal the folder name and follow the rules: 1–64 characters, lowercase letters, digits and single hyphens, no leading or trailing hyphen and no double hyphen. The CLI decides when to load a skill from its description, so it is required. The panel creates, edits and deletes skills; a backup is made before every write and delete. Changes take effect after the CLI restarts.',
    skillsDir: 'Skills directory:',
    dirMissing: 'the directory does not exist yet — it is created when you save a skill',
    dirUnreadable:
      'The directory {{path}} cannot be read — skills cannot be managed, writing is disabled for safety.',
    externalTitle: 'Your Claude skills already work in {{provider}}',
    externalExplain:
      'Besides its own directory, {{provider}} also loads skills from these folders, so your already configured Claude skills work in it without moving anything. This section does not manage them — the Claude skills section does; nothing is written here.',
    externalMissing: 'folder missing',
    ignoredTitle: 'The CLI will not pick up these folders',
    ignoredExplain:
      'These folders have no SKILL.md file, so the CLI does not treat them as skills. The panel shows them but never touches them.',
    empty: 'No skills yet: create the first one — a folder with SKILL.md will appear.',
    edit: 'Edit',
    view: 'Open',
    createTitle: 'New skill',
    createSkill: 'Create skill',
    fieldName: 'Skill name',
    hintName:
      'Becomes the folder name and the path <name>/SKILL.md in {{skillsDir}}. Lowercase letters, digits and single hyphens are allowed (1–64 characters).',
    nameInvalid:
      'Name: only lowercase letters, digits and single hyphens, no hyphen at the edges and no "--" (up to 64 characters).',
    nameLocked:
      'A skill name is its folder name. To rename a skill, create a new one and delete the old one.',
    duplicate: 'A skill with this name already exists.',
    fieldDescription: 'Description',
    hintDescription:
      'The CLI decides when to load the skill from this. Required, up to 1024 characters.',
    placeholderDescription: 'When and why to use this skill',
    descriptionRequired: 'Description is required.',
    fieldBody: 'Skill instructions (markdown)',
    otherKeys: 'Front-matter fields the panel keeps as is: {{keys}}',
    badge: {
      no_frontmatter: 'no front matter',
      malformed: 'front matter unparsed',
      missing_name: 'no name',
      missing_description: 'no description',
    },
    badgeNameMismatch: 'name ≠ folder',
    deleteSkill:
      'The skill folder and every file in it will be removed from disk. A copy of the folder is kept in claude-control/backups — restoring it from there is manual only.',
    readOnly: {
      no_frontmatter:
        'The file has no YAML front matter between "---" lines — OpenCode will not load such a skill, and the panel does not rewrite it. Read-only.',
      malformed:
        'The skill front matter could not be parsed — the panel does not rewrite such a file. Read-only.',
      missing_name:
        'The skill front matter has no required name field — the panel does not rewrite such a file. Read-only.',
      missing_description:
        'The skill front matter has no required description field — the panel does not rewrite such a file. Read-only.',
    },
  },
  providerEnv: {
    title: 'Environment variables · {{provider}}',
    subtitle: 'Environment variables for {{provider}}',
    explainTitle: 'How it works',
    // The explanation depends on the provider's file format — the page picks one.
    explain_toml:
      '{{provider}} stores its environment variables in {{fileName}} (the shell_environment_policy.set table). The panel edits only these variables and leaves the rest of the environment policy (inherit, exclude, etc.) untouched. Changes are picked up after the CLI restarts.',
    'explain_aider-yaml':
      '{{provider}} stores its environment variables in {{fileName}} (the set-env key, entries shaped KEY=value). The panel edits only that key: comments and every other setting in the config stay in place. Changes are picked up after the CLI restarts.',
    explain_dotenv:
      '{{provider}} stores its environment variables in the plain {{fileName}} file. The panel edits it line by line: only the lines of the affected variables change, while comments, blank lines and ordering stay as they were; new variables are appended at the end. Changes are picked up after the CLI restarts.',
    addVar: 'Add variable',
    key: 'Variable name',
    value: 'Value',
    deleteVar: "Delete this variable from the provider's configuration?",
    duplicateKey: 'Variable {{key}} already exists — choose another name.',
    cliMissing:
      '{{provider}} CLI was not detected. Saving still works — the file will be created at {{path}}.',
    readOnly:
      'The format of {{path}} was not recognized — the section is read-only and writing is disabled for safety.',
  },
  providerPermissions: {
    title: 'Permissions & approvals · {{provider}}',
    subtitle: 'Approval policy and sandbox mode for {{provider}}',
    explainTitle: 'How it works',
    explain:
      '{{provider}} permissions are set by two keys at the root of {{fileName}}: the approval policy (when the CLI asks for confirmation) and the sandbox mode (file-system and network boundaries). The panel edits only these two root keys; it never touches profiles ([profiles.*]) or other settings. Changes take effect after the CLI is restarted.',
    usingDefaults:
      'The keys are not set in the file yet — Codex defaults are shown. They will be written only after you save.',
    cliMissing:
      '{{provider}} CLI was not detected. Saving still works — the file will be created at {{path}}.',
    readOnly:
      'The format of {{path}} was not recognized — the section is read-only and writing is disabled for safety.',
    approval: {
      label: 'Approval policy (approval_policy)',
      untrusted: {
        label: 'untrusted — ask almost always',
        description:
          'Most cautious: the CLI asks for confirmation for nearly every command except known-trusted ones. Safest, but many prompts.',
      },
      'on-request': {
        label: 'on-request — when the model asks (default)',
        description:
          'The default: the model decides when to request confirmation or escalate. A sensible balance of control and convenience.',
      },
      never: {
        label: 'never — never ask',
        description:
          'The CLI never asks for confirmation and never escalates. Convenient for automation, but removes manual control — use deliberately.',
      },
    },
    sandbox: {
      label: 'Sandbox mode (sandbox_mode)',
      'read-only': {
        label: 'read-only — read only',
        description:
          'The CLI can read files but cannot write to disk or access the network. The safest mode.',
      },
      'workspace-write': {
        label: 'workspace-write — write inside the workspace (default)',
        description:
          'The default: writing is allowed within the workspace directory; network is restricted by default. A sensible balance for working on a project.',
      },
      'danger-full-access': {
        label: 'danger-full-access — full access (dangerous)',
        description:
          'DANGEROUS: the sandbox is disabled — the CLI gets unrestricted access to the file system and network. Commands can modify any file and reach any resource. Enable only if you fully trust the task and environment.',
      },
    },
    // Gemini permission model: approval mode + allowlist and blocklist of tools.
    gemini: {
      subtitle: 'Approval mode and allowed tools for {{provider}}',
      explain:
        '{{provider}} permissions live in {{fileName}}: the approval mode general.defaultApprovalMode plus two tool lists — coreTools (what is allowed) and excludeTools (what is blocked). The blocklist wins over the allowlist: a tool present in both is blocked. The panel edits only these three keys; MCP servers and every other setting in the file stay untouched. Changes are picked up after the CLI restarts.',
      usingDefaults:
        'The keys are not set in the file yet — Gemini defaults are shown. They will be written only after you save.',
      yoloNote:
        'The yolo mode (no confirmations at all) is never written by the panel: in Gemini it is a command-line flag only, and in settings.json it makes the CLI fail on startup. If you need it, run gemini with the --yolo flag.',
      mode: {
        label: 'Approval mode (general.defaultApprovalMode)',
        default: {
          label: 'default — ask every time (default)',
          description:
            'The default: the CLI asks for confirmation before every tool call — both file edits and shell commands. The most controlled mode.',
        },
        auto_edit: {
          label: 'auto_edit — file edits without prompts',
          description:
            'File edits are applied automatically while shell commands still require confirmation. Faster to work with, but files change without your consent — keep the project under version control.',
        },
        plan: {
          label: 'plan — read-only planning',
          description:
            'The CLI changes nothing: it only reads files and proposes a plan. The safest mode — good for exploring unfamiliar code.',
        },
      },
      toolsPlaceholder: 'one tool name per line',
      coreTools: {
        label: 'Tool allowlist (coreTools)',
        hint: 'One name per line, e.g. run_shell_command or ReadFile. When the list is not empty, only the listed tools are allowed — this is the safest way to restrict the CLI. An empty list means no restriction (the key is removed from the file).',
      },
      excludeTools: {
        label: 'Tool blocklist (excludeTools)',
        hint: 'One name per line. Listed tools are blocked; the blocklist wins over the allowlist. Blocking by list is less reliable than allowing: a tool added in a future CLI release becomes available automatically.',
      },
    },
    // Qwen Code permission model: tools.approvalMode plus three rule lists —
    // permissions.allow / ask / deny.
    qwen: {
      subtitle: '{{provider}} approval mode and access rules',
      explain:
        '{{provider}} permissions live in {{fileName}}: the approval mode tools.approvalMode and three rule lists — permissions.allow (run without asking), permissions.ask (always confirm) and permissions.deny (block). Deny wins over the rest: a deny rule holds even in autonomous modes. A rule is written as a tool with an optional specifier in parentheses, e.g. Bash(git push *) or Read(/src/**). The panel edits these keys only; MCP servers, the model and every other setting in the file stay untouched. Changes apply after restarting the CLI.',
      usingDefaults:
        'The keys are not set in the file yet — Qwen Code defaults are shown. They are written only after you save.',
      mode: {
        label: 'Approval mode (tools.approvalMode)',
        default: {
          label: 'default — ask every time (default)',
          description:
            'The default: the CLI asks for confirmation before every action — both file edits and shell commands. The most controlled mode.',
        },
        plan: {
          label: 'plan — read and plan only',
          description:
            'The CLI executes nothing: it only analyses the code and proposes a plan. The safest mode — good for exploring an unfamiliar codebase.',
        },
        'auto-edit': {
          label: 'auto-edit — file edits without asking',
          description:
            'File edits are applied automatically, shell commands still require confirmation. Faster to work with, but files change without your consent — keep the project under version control.',
        },
        auto: {
          label: 'auto — autonomous mode',
          description:
            'The CLI works autonomously and decides what to run. Hard rules from the deny list still apply — they are your safety net in this mode.',
        },
        yolo: {
          label: 'yolo — approve everything (dangerous)',
          description:
            'DANGEROUS: EVERYTHING is approved, including shell commands and edits to any file. The model can run any command with your privileges. Enable it only in an isolated environment and for a task you fully trust.',
        },
      },
      rulesPlaceholder: 'one rule per line, e.g. Bash(git status)',
      allow: {
        label: 'Allow without confirmation (permissions.allow)',
        hint: 'One rule per line: Bash(git status), Read(/src/**). Listed rules run without asking. An overly broad rule (plain Bash, say) defeats the approval mode — narrow it down in parentheses. An empty list removes the key from the file.',
      },
      ask: {
        label: 'Always ask (permissions.ask)',
        hint: 'One rule per line. The CLI asks for confirmation for these, even when the mode is otherwise automatic. An empty list removes the key from the file.',
      },
      deny: {
        label: 'Deny (permissions.deny)',
        hint: 'One rule per line. Deny wins over the other lists and holds in every mode, including auto and yolo. An empty list removes the key from the file.',
      },
    },
    // Continue permission model: three lists (allow / ask / exclude) in a separate
    // permissions.yaml. Continue has no approval-mode switch at all.
    continue: {
      subtitle: '{{provider}} tool permission rules',
      explain:
        '{{provider}} permissions live in a separate file, {{fileName}}, and consist of three lists: allow — the tool runs straight away, ask — the CLI asks for confirmation, exclude — the tool is hidden from the agent entirely. There is no approval-mode switch like other CLIs have: the lists are the whole model. A rule is a tool name, optionally narrowed in parentheses: Bash, Read(*), Write and so on. By default reads are allowed while writes and shell commands are asked about; in headless mode (cn -p) tools under ask are unavailable — there is nobody to confirm. The panel edits these three keys only; comments and the rest of the file are preserved.',
      usingDefaults:
        'The permissions file does not exist yet — Continue defaults are shown. It is created only when you save.',
      rulesPlaceholder: 'one rule per line, e.g. Read(*)',
      allow: {
        label: 'Allow without confirmation (allow)',
        hint: 'One rule per line: Bash, Read(*), Write. Listed tools run straight away. An empty list removes the key from the file.',
      },
      ask: {
        label: 'Ask for confirmation (ask)',
        hint: 'One rule per line. The CLI asks before every call. Note: in headless mode (cn -p) such tools are unavailable altogether — there is nobody to confirm.',
      },
      exclude: {
        label: 'Hide the tool (exclude)',
        hint: 'One rule per line. The tool is not shown to the agent at all — it does not know it exists. The strictest of the three lists.',
      },
    },
    // Cursor permission model: two lists allow/deny under permissions, no mode.
    cursor: {
      subtitle: '{{provider}} allow and deny rules',
      explain:
        '{{provider}} permissions are the permissions key in {{fileName}} and exactly two lists: allow — the action runs without asking, deny — it is blocked. Cursor has no mode switch and no "ask" list: anything in neither list the CLI asks about itself. Deny beats allow: a rule present in both lists is denied. Rule forms are Shell(command), Read(path), Write(path), WebFetch(domain), Mcp(server:tool); globs *, ** and ? are allowed inside. The panel edits only the permissions key — the version, editor settings and everything else in the same file stay untouched.',
      usingDefaults:
        'The permissions key is not set in the file — Cursor asks for confirmation on its own. The panel writes nothing until you save the lists.',
      rulesPlaceholder: 'one rule per line, e.g. Shell(git status)',
      ruleKinds: 'Documented rule forms: {{kinds}}',
      allow: {
        label: 'Allow without confirmation (allow)',
        hint: 'One rule per line: Shell(git status), Read(src/**), Write(docs/**). Listed actions run immediately. An empty list removes the key from the file.',
      },
      deny: {
        label: 'Deny (deny)',
        hint: 'One rule per line. Deny beats allow: a rule present in both lists counts as denied. This is the place for the irreversible — Shell(rm -rf*), Write(.env).',
      },
    },
    // Goose permission model: a single root key GOOSE_MODE, no lists at all.
    goose: {
      subtitle: '{{provider}} approval mode',
      explain:
        '{{provider}} permissions are a single GOOSE_MODE key in {{fileName}}. Goose has no rule lists: the mode alone decides what the CLI does with tool calls. auto — run everything without asking (this is how non-interactive and scheduled sessions go), approve — decide by the configured tool permissions, smart_approve — auto-approve calls judged safe and ask about the rest, chat — never run tools at all, conversation only. The panel edits exactly that key: extensions, provider, model and comments of the same file stay untouched. Per-tool permissions live separately (permission.yaml): the panel shows them but never writes that file. Changes take effect after the CLI restarts.',
      usingDefaults:
        'The GOOSE_MODE key is not set in the file — the default mode is shown. The panel writes nothing until you pick a mode and save.',
      mode: {
        label: 'Approval mode (GOOSE_MODE)',
        auto: {
          label: 'auto — no questions',
          description:
            'Goose runs commands and edits files without asking. Fast and dangerous: in this mode the agent can run any command as you.',
        },
        approve: {
          label: 'approve — configured permissions only',
          description:
            'Decisions come from the configured tool permissions; automatic "is this safe" detection is not used.',
        },
        smart_approve: {
          label: 'smart_approve — smart approval',
          description:
            'Calls judged safe (read-only) are approved automatically; everything else goes to confirmation.',
        },
        chat: {
          label: 'chat — no tools',
          description: 'Tools are never run: plain conversation only. The strictest mode.',
        },
      },
      tools: {
        title: 'Per-tool permissions',
        readOnly:
          'Read-only: these lists live in {{path}}, and the file format is not covered by the Goose documentation — the panel never writes it. Configure them with goose configure → Tool Permission.',
        alwaysAllow: 'Always allow',
        askBefore: 'Ask before',
        neverAllow: 'Never allow',
        empty: 'No individual tool is configured — the selected mode decides.',
      },
    },
    // Kimi Code permission model: the default_permission_mode key plus an ORDERED
    // array of [[permission.rules]] (decision + pattern) in config.toml.
    kimi: {
      subtitle: '{{provider}} approval mode and tool rules',
      explain:
        '{{provider}} permissions live in {{fileName}} and have two parts. The default_permission_mode key sets the baseline: manual — ask before every action, auto — the agent decides by the rules, yolo — never ask. The [[permission.rules]] entries refine the mode for individual tools: a pattern (Read, Bash(git push*), mcp__server__tool) and a decision of allow / ask / deny. Rule order matters — they are checked top to bottom, so keep specific rules above general ones. The panel edits only those two places: models, providers, hooks and MCP timeouts of the same file stay untouched, and a backup is made before each write. Changes apply after restarting the CLI.',
      usingDefaults:
        'Neither a mode nor any rules are set in the file — the default mode (manual) is shown. The panel writes nothing until you save.',
      mode: {
        label: 'Approval mode (default_permission_mode)',
        manual: {
          label: 'manual — always ask',
          description:
            'Kimi asks for confirmation before every action. The strictest and most predictable mode — a good place to start.',
        },
        auto: {
          label: 'auto — the agent decides',
          description:
            'The agent acts on its own, guided by the rules below: whatever no rule blocks runs without asking. A reasonable trade-off if the rules are set carefully.',
        },
        yolo: {
          label: 'yolo — never ask (dangerous)',
          description:
            'DANGEROUS: nothing is confirmed, including shell commands and edits to any file. The agent can run any command as you. Isolated environments only.',
        },
      },
      rules: {
        title: 'Tool rules ([[permission.rules]])',
        hint: 'Checked top to bottom: the first matching rule wins. Keep specific rules above general ones. A pattern is a tool name, optionally narrowed by an argument in brackets: Read, Bash(git push*), mcp__server__tool. Empty rows are dropped on save; an empty list removes the whole rules block from the file.',
        pattern: 'Tool pattern',
        placeholder: 'e.g. Bash(rm -rf*)',
        decision: 'Decision',
        add: 'Add rule',
        moveUp: 'Move up',
        moveDown: 'Move down',
      },
      decision: {
        allow: { label: 'allow — permit' },
        ask: { label: 'ask — confirm' },
        deny: { label: 'deny — block' },
      },
    },
    // OpenCode permission model: the `permission` key — a level per tool, plus a
    // command pattern list for bash.
    opencode: {
      subtitle: '{{provider}} tool permissions: file edits, shell commands, network',
      explain:
        '{{provider}} permissions live under the permission key of {{fileName}}. Every tool gets its own level: allow — run without asking, ask — confirm every call, deny — block completely. For the bash tool a list of command patterns can be used instead of a single level: allow "git *" while denying "git push *". The panel edits the permission key only — the model, MCP servers, agent settings and every other key of the file stay untouched, and a backup is made before each write. Changes apply after restarting the CLI.',
      usingDefaults:
        'The permission key is not set in the file — OpenCode restricts nothing. The panel writes nothing until you pick a level and save.',
      unset: {
        label: 'not set — no restriction',
        description:
          'There is no key for this tool in the file: OpenCode does not restrict it. Choosing "not set" removes the key on save.',
      },
      level: {
        allow: {
          label: 'allow — run without asking',
          description:
            'The tool runs immediately, with no confirmation. Fast, but manual control is gone — use deliberately.',
        },
        ask: {
          label: 'ask — confirm every call',
          description:
            'The CLI asks for confirmation before every call. The most controlled option.',
        },
        deny: {
          label: 'deny — block',
          description: 'The tool is blocked entirely: the CLI cannot use it.',
        },
      },
      patterns: {
        label: 'by command patterns (advanced form)',
        description:
          'Instead of a single level, a list of command pattern → level. Safe commands can be allowed while dangerous ones stay blocked.',
        pattern: 'Command pattern',
        level: 'Level',
        placeholder: 'e.g. git push *',
        add: 'Add pattern',
        hint: 'The "*" pattern is the rule for every other command. Documented example: "*" — ask, "git *" — allow, "git push *" — deny. Empty patterns are dropped on save; if none is left, the tool key is removed from the file.',
      },
      tool: {
        edit: {
          label: 'File edits (edit)',
          hint: 'Creating and changing files on disk.',
        },
        bash: {
          label: 'Shell commands (bash)',
          hint: 'Running commands on the system — the most sensitive tool.',
        },
        webfetch: {
          label: 'Network fetches (webfetch)',
          hint: 'Downloading pages and files by URL.',
        },
      },
      preserved: {
        title: 'Entries the panel never changes',
        text: 'The permission key contains entries whose shape the panel does not manage: other tool names, or the advanced form where the panel does not support it. They are kept in the file as they are — the panel never rewrites or deletes them; edit those by hand.',
      },
    },
  },
  providerDetect: {
    installed: 'installed',
    configOnly: 'config found',
    missing: 'not found',
    recommended: 'recommended',
    activeMissing:
      'The {{provider}} CLI ({{command}}) was not found on this system. Configuration sections still work with the config files, but the assistant and launching will require installing the CLI or an API key.',
  },
  providerKeys: {
    title: 'Provider API keys',
    hint: "The active provider's key is used by the panel assistant. Keys are stored encrypted in the panel and never returned — only a mask is shown here. If no key is set but the provider CLI is installed, the assistant runs via the CLI.",
    apiKind: {
      anthropic: 'Anthropic API',
      openai: 'OpenAI API',
      google: 'Google API',
      'openai-compat': 'OpenAI-compatible',
      none: 'no model API',
    },
    statusStored: 'set in panel: {{masked}}',
    statusEnv: 'found in environment ({{envVar}}): {{masked}}',
    statusNone: 'no key set',
    inputLabel: '{{provider}} API key',
    inputPlaceholder: 'paste the key',
    envHint: 'If not set here, the key is picked up from environment variables: {{vars}}',
    clear: 'Clear',
  },
  assistantKey: {
    title: '{{provider}} assistant needs access',
    description:
      'Neither a CLI login (subscription) nor an API key was found for {{provider}}. Preferably sign in to the provider CLI — it works via your subscription, with no per-token billing. Otherwise, as a fallback, paste an API key (stored encrypted in the panel).',
    unsupported:
      '{{provider}} has no model API of its own, and running the assistant via CLI is not supported.',
    unsupportedHint: 'Choose another provider in Settings — the assistant will work with it.',
    subscriptionTitle: 'Option 1 (recommended): sign in to the CLI (subscription)',
    subscriptionHint:
      'Install the "{{command}}" CLI and sign in — the assistant will use your subscription, with no separate paid key.',
    cliLoginGeneric:
      'Run "{{command}}" in a terminal and complete the sign-in/subscription as the CLI prompts, then come back here.',
    cliLogin: {
      claude:
        'Run "claude" and sign in to your Claude account when prompted — the panel picks up the subscription.',
      codex:
        'Install the Codex CLI and run "codex login" (sign in to your OpenAI account/subscription).',
      gemini: 'Run "gemini" and complete the Google sign-in in the browser when prompted.',
      qwen: 'Run "qwen" and pick a sign-in method when prompted (Alibaba ModelStudio via OAuth, or a third-party API key).',
      continue:
        'Install the Continue CLI ("npm i -g @continuedev/cli") and run "cn login" to sign in to your Continue account; an Anthropic key works as a fallback.',
      goose:
        'Install Goose ("goose" in PATH) and run "goose configure" — the provider and its key are set up inside Goose itself.',
      kimi: 'Install Kimi Code ("kimi" in PATH) and run "kimi login", or set a Moonshot key (KIMI_API_KEY / MOONSHOT_API_KEY).',
      opencode: 'Install OpenCode and configure sign-in/provider with "opencode auth login".',
      aider: 'Install Aider and configure model access per its documentation.',
    },
    apiTitle: 'Option 2 (fallback): paid API key',
    apiKeyHowGeneric: 'Get an API key from your provider dashboard and paste it below.',
    apiKeyHow: {
      anthropic: 'Anthropic key — in the console at console.anthropic.com → API Keys.',
      openai: 'OpenAI key — at platform.openai.com/api-keys.',
      google: 'Google (Gemini) key — in Google AI Studio (aistudio.google.com/apikey).',
      'openai-compat': 'OpenAI-compatible key — in your model provider dashboard.',
    },
    inputLabel: '{{provider}} API key',
    inputPlaceholder: 'paste the key',
    cliMissing: 'The "{{command}}" CLI was not found in PATH — so a key is needed.',
    openSettings: 'Open settings',
  },
  basicChat: {
    title: '{{provider}} assistant',
    experimental: 'Experimental',
    experimentalHint:
      'Basic mode for a non-Claude provider: a plain text reply via the provider CLI or its API. The rich chat with tools and streaming output is available only for Claude.',
    empty: 'Type a message — the assistant will reply via the active provider.',
    noneHint:
      'First connect the CLI subscription or a provider API key (see the instructions dialog).',
    placeholder: 'Message the assistant…',
    send: 'Send',
    you: 'You',
    thinking: 'The assistant is thinking…',
    failed: 'Failed to get an assistant reply.',
    mode: {
      cli: 'via CLI (subscription)',
      api: 'via API',
    },
    // How the CLI ran: a process per question, or a local server session.
    transport: {
      'one-shot': 'one-shot run',
      session: 'CLI session',
    },
    reason: {
      cli_error: 'The provider CLI exited with an error.',
      api_error: 'The model API returned an error.',
      cli_not_scriptable: 'This CLI has no non-interactive run mode.',
      no_key_no_cli: 'Neither a CLI subscription nor an API key is available.',
      unsupported: 'The provider does not support the assistant.',
      ok: '',
    },
  },
  mcp: {
    title: 'MCP servers',
    subtitle: 'External tool providers for Claude',
    explainTitle: 'How it works',
    explain:
      'An MCP server gives Claude a set of tools: access to GitLab, Jira, Telegram and others. Servers start together with Claude Code, so new ones appear only after a restart.',
    checkHealth: 'Check',
    healthTimeout: 'The server did not answer in time — check the URL and the MCP network timeout',
    connected: 'Responding',
    failed: 'Not responding',
    unknown: 'Not checked',
    tools: 'tools',
    authorize: 'Authorize',
    authorized: 'Authorized',
    signOut: 'Sign out',
    oauthCleared: 'Authorization cleared',
    popupBlocked: 'The browser blocked the sign-in window — open the authorization page yourself',
    openAuthPage: 'Open the sign-in page',
    oauthNoUrl: 'The server returned no authorization address — sign-in did not start',
    transport: 'Transport',
    command: 'Start command',
    addServer: 'Add server',
    modeSingle: 'Builder',
    modeImport: 'Several from JSON',
    importLabel: 'Paste the mcpServers block from the server docs',
    importHint:
      'Understands both a {{"mcpServers": …}} wrapper and a plain servers object. Transport is detected automatically.',
    importFound: 'servers found',
    importAll: 'Add all ({{count}})',
    presetsTitle: 'Ready-made servers',
    presetsHint: 'Click one — the fields fill in. Then put in your own variable values and tokens.',
    serverName: 'Server name',
    serverNameHint: 'This name goes into the config and into permission rules',
    transportHint:
      'stdio — the server runs as a process; sse and http — connect to an address already running',
    args: 'Arguments',
    argsHint: 'Space separated. Arguments containing spaces go in quotes',
    url: 'Address',
    env: 'Environment variables',
    envHint: 'One KEY=VALUE per line. Do not put secrets here — they belong in .mcp-secrets.env',
    headers: 'Request headers',
    headersHint:
      'One Name=value per line. Needed by servers behind auth: without them the check stops at 401',
    toolsButton: 'Tools',
    toolsTitle: 'Server tools',
    toolsLoading: 'Connecting and requesting the tool list…',
    toolsEmpty: 'The server returned no tools',
    toolsSelectAll: 'Select all',
    toolsClear: 'Clear',
    toolsSelected: 'Selected: {{count}}',
    wholeServer: 'Whole server at once',
    createPermissions: 'Create permissions ({{count}})',
  },
  permissions: {
    title: 'Permissions',
    subtitle: 'What Claude does on its own and what it asks about',
    explainTitle: 'How it works',
    explain:
      'Decision priority: deny beats ask, ask beats allow. A tool listed nowhere requires confirmation by default. MCP rules look like mcp__server__tool.',
    allow: 'Allowed',
    ask: 'Ask',
    deny: 'Denied',
    addRule: 'Add rule',
    pattern: 'Rule',
    patternHint: 'A whole tool name (Bash) or a narrowed one: Bash(git push:*), mcp__server__tool.',
    patternWarning:
      "Doesn't look like a known form (Bash, Bash(git push:*), mcp__server__tool) — check for a typo.",
    decision: 'What to do',
    decisionHint_allow: 'Claude runs it on its own, no questions asked.',
    decisionHint_ask: 'Claude asks for confirmation before running it.',
    decisionHint_deny: 'Claude cannot run it at all, even with confirmation.',
    presetsTitle: 'Ready-made permissions',
    tabAll: 'All rules',
    tabSystem: 'System',
    tabMcp: 'MCP servers',
    systemSubtitle: 'What Claude Code does to this computer',
    notConfigured: 'Not set',
    configure: 'Configure',
    category_filesystem: 'Files',
    category_shell: 'Shell',
    category_git: 'Git',
    category_network: 'Network',
    category_tools: 'Tools',
    risk_low: 'low risk',
    risk_medium: 'medium risk',
    risk_high: 'high risk',
    deletePermission:
      'The rule is removed from settings.json. The tool returns to the default behaviour — confirmation on every call.',
    moveToLocal: 'To local (settings.local.json)',
    moveToShared: 'To shared (settings.json)',
  },
  env: {
    title: 'Environment variables',
    subtitle: 'Environment settings and MCP server secrets',
    explainTitle: 'Where things live',
    explain:
      'Variables from settings.json are visible to Claude Code itself. The .mcp-secrets.env file is read by the MCP server launcher — tokens live there. Secret values are masked and can be revealed on demand.',
    revealValue: 'Reveal value',
    hideValue: 'Hide value',
    source: 'Where to save',
    addVar: 'Add variable',
    varKey: 'Variable name',
    varValue: 'Value',
    varComment: 'Comment',
    varCommentPlaceholder: 'for example: token from GitLab profile settings',
    secretHidden: 'Value hidden — enter it again to change',
    secretRewrite: 'Leave empty if the value should stay as is',
    deleteVar:
      'The variable will be removed from the file. Servers using it will stop receiving this value.',
    moveToLocal: 'To local (settings.local.json)',
    moveToShared: 'To shared (settings.json)',
  },
  groups: {
    title: 'Groups',
    subtitle: 'Your own structure across rules, hooks, skills and servers',
    explainTitle: 'Why this exists',
    explain:
      'A group joins entities of any kind so you can toggle them together and share environment variables. Claude Code itself knows nothing about groups — they live in the app data.',
    addGroup: 'Create group',
    emptyTitle: 'No groups yet',
    emptyText:
      'A group bundles rules, skills, hooks and servers so you can toggle them together and set shared variables. Handy when a set of settings belongs to one task.',
    members: 'members',
    membersTitle: 'Group contents',
    localHooksSkipped:
      'Hooks from settings.local.json are not switched by a group ({{count}}): the panel never writes that file, so they keep firing.',
    conflict:
      'Permission conflict: "{{patterns}}" is set to both allow and deny in the group — Claude Code picks one.',
    groupName: 'Name',
    groupNamePlaceholder: 'for example: Frontend work',
    groupDescription: 'Description',
    groupEnv: 'Group environment variables',
    groupEnvHint:
      'Applied to settings.json while the group is enabled. Handy for keeping sets of settings and switching them as a whole.',
    selectedCount: 'Selected: {{count}}',
    orderTitle: 'Apply order',
    moveUp: 'Move up',
    moveDown: 'Move down',
    removeMember: 'Remove from group',
    kind_rule: 'Rule',
    kind_skill: 'Skill',
    kind_hook: 'Hook',
    kind_mcp: 'Server',
    kind_permission: 'Permission',
    kind_group: 'Group',
    automations: 'Automations',
    automationsExplain:
      'An automation describes "when — what": for example, run a check after a skill is invoked. On save it compiles into a regular hook, so it behaves exactly like a hand-written one.',
    addAutomation: 'Create automation',
    automationName: 'Automation name',
    automationTrigger: 'When to run',
    automationAction: 'What to run',
    compiledInto: 'Compiles into a hook',
  },
  credentials: {
    title: 'Claude Code access',
    purpose:
      'Only sandboxes need this: they run Claude against a separate settings directory, which your normal login does not reach. Chat, plugins and MCP use your real directory and need nothing here.',
    source_file: 'settings file',
    source_keychain: 'macOS Keychain',
    source_panel: 'set manually',
    source_apiKey: 'API key',
    source_none: 'not found',
    setManually: 'Set manually',
    clearManual: 'Remove manual',
    manualFile: 'File',
    manualTitle: 'Access, set by hand',
    manualHint: 'Any of the three shapes will do — pick a template and fill in your own values.',
    templates: 'Templates',
    template_oauth: 'Subscription token',
    template_apiKey: 'API key',
    template_readFrom: 'Your own file',
    jsonLabel: 'JSON',
    jsonHint:
      'claudeAiOauth — the subscription token as in .credentials.json. apiKey — an Anthropic API key. readFrom — a path to your own file, which the panel will read.',
    securityNote:
      'This is real access to your account. The file is saved in your home directory with 600 permissions and is never sent back to the browser. A file like this must not reach a repository.',
    saveFailed: 'Could not save',
  },
  settings: {
    title: 'Settings',
    subtitle: 'Application, accessibility and configuration path',
    account: 'Claude Code account',
    subscription: 'Subscription',
    limitsNote:
      'Limit balances cannot be shown here: they live on Anthropic servers and never reach local files. Exact figures come from the /usage command inside Claude Code.',
    theme: 'Theme',
    themeLight: 'Light',
    themeDark: 'Dark',
    themeSystem: 'Match system',
    accent: 'Accent',
    accentHint: 'Applied on top of the current theme; presets come from the design-system palette.',
    accent_default: 'Default',
    accent_blue: 'Blue',
    accent_green: 'Green',
    accent_purple: 'Purple',
    accent_amber: 'Amber',
    language: 'Language',
    providerTitle: 'Configuration provider',
    providerHint:
      'Which CLI the panel manages. Claude Code is fully supported; the other providers are experimental — some sections are still in development.',
    providerVerified: 'verified',
    providerExperimental: 'experimental',
    providerActive: 'Active',
    providerChoose: 'Choose',
    providerPreviewReady: 'Sections ready: {{ready}}',
    providerPreviewMixed: 'Ready: {{ready}} · in development: {{planned}}',
    providerExperimentalBadge: 'Experimental provider',
    providerExperimentalNote:
      'Some sections are still in development and marked accordingly. The panel does not write anything to this provider’s configuration yet.',
    claudeDir: '.claude directory',
    claudeDirHint:
      'Detected automatically. Fill this in if the directory is non-standard or detection failed.',
    claudeDirPlaceholder: 'For example, ~/.claude or C:\\Users\\name\\.claude',
    apply: 'Apply',
    accessibility: 'Accessibility',
    largeText: 'Large text',
    largeTextHint: 'Scales the whole font ramp up',
    reduceMotion: 'Reduce motion',
    reduceMotionHint: 'Disables animations and transitions',
    highContrast: 'High contrast',
    highContrastHint: 'Strengthens borders and text colour',
    safety: 'Edit safety',
    backupBeforeWrite: 'Back up before writing',
    backupHint: 'A copy is stored in claude-control/backups',
    previewProviderWrites: 'Show a diff before writing to another CLI',
    previewProviderWritesHint:
      'Before saving into a Codex, Gemini or other config the panel shows exactly what ' +
      'will land in the file. Claude has no preview: its sections are the panel’s own and verified.',
    backupKeep: 'How many copies to keep',
    backupKeepHint:
      'Rotation depth: more means further rollback, fewer means fewer copies (incl. secrets) on disk',
    transferTitle: 'Transfer panel settings',
    transferHint:
      'Groups, automations, marks and panel settings — as a file snapshot and back on another machine. Your real Claude Code configs are untouched.',
    transferExport: 'Download snapshot',
    transferImport: 'Load snapshot',
    transferImported: 'Panel settings imported',
    transferImportError: 'Could not read the settings file',
    watchFiles: 'Watch files for changes',
    watchHint: 'Refresh the interface when configs are edited outside the app',
    revealSecrets: 'Reveal secrets by default',
    revealSecretsHint: 'Otherwise values stay masked',
    editorTitle: 'Code editor',
    editorHint: 'Used by the "Open in editor" button. Editors installed on your system are shown.',
    editorAuto: 'Auto',
    editorMissing: 'not found',
    editorCustom: 'Custom command',
    editorCustomHint: 'The editor CLI command if it is not in the list (e.g. mate).',
    spendTitle: 'Spend',
    spendMoney: 'Show in money',
    spendHint: 'Spend is shown in tokens by default',
    mcpTitle: 'MCP servers',
    mcpAutoCheck: 'Check connectivity when the section opens',
    mcpAutoCheckHint:
      'Automatically probe every enabled server when you open the MCP section. Otherwise only the card button does it.',
    mcpTimeout: 'Network connect timeout, ms',
    mcpTimeoutHint:
      'How long to wait for a network server (http/sse) to respond. Launching local (stdio) servers is not limited by this. Range 2000–120000.',
    chatDefaultsTitle: 'Chat: default model and effort',
    chatDefaultsHint:
      'Apply to all chats. A single chat can override them locally — the global settings stay unchanged.',
    chatModel: 'Default model',
    chatModelHint: 'Which model to use for new conversations.',
    chatModelAuto: 'Whatever Claude picks (Opus 4.8, 1M)',
    chatEffort: 'Default thinking effort',
    chatEffortHint: 'How deeply the agent reasons about the answer.',
    chatEffortAuto: 'CLI default',
    pricingTitle: 'Rates used to estimate cost',
    pricingHint:
      'Prices per million tokens behind the cost figures in Analytics. The panel pulls them from the Anthropic site — at most once a day, when you open Settings. Rates are tied to a specific model version, so older runs are priced at the rates that applied back then. You can set your own price: it overrides the list.',
    pricingLive: 'Anthropic price list',
    pricingBuiltIn: 'Built-in table',
    pricingUpdated: 'updated {{date}}',
    pricingRefresh: 'Refresh prices',
    pricingRefreshing: 'Refreshing…',
    pricingOffline:
      'Could not fetch the current price list — costs are computed from the table built into the panel on its build date. Check your internet connection and press “Refresh prices”.',
    pricingModel: 'Model',
    pricingActions: 'Own price',
    pricingOwn: 'own price',
    pricingUntil: 'until {{date}}',
    pricing_input: 'Input',
    pricing_output: 'Output',
    pricing_cacheRead: 'Cache read',
    pricing_cacheWrite: 'Cache write, 5 min',
    pricing_cacheWrite1h: 'Cache write, 1 hour',
    pricingCacheWriteHint:
      'Cache writes are billed by how long the entry lives: in the Anthropic price list the 1-hour rate is 1.6× the 5-minute one, and in transcripts almost all cache writes go to the 1-hour cache. Your own price is used exactly as you type it — the panel never scales it. Leave the 1-hour field empty and 1-hour writes are billed at your 5-minute rate.',
    pricingReset: 'Clear own prices',
    backupsTitle: 'Backups',
    backupsHint:
      'A copy is made before every write to your configuration. Restoring replaces the file with the chosen state and saves the current one as a fresh copy — so even a restore can be undone.',
    backupsEmpty: 'No backups yet',
    backupsRestore: 'Restore',
    backupsManual: 'by hand only',
    backupsConfirmTitle: 'Restore the file to this copy?',
    backupsConfirmText:
      'The file {{target}} will be replaced whole: anything changed after this copy disappears from it. The current state is saved as a separate copy. Changes apply after restarting Claude Code.',
    encryptSecrets: 'Encrypt secret backups',
    encryptSecretsHint:
      'Backups of .mcp-secrets.env are written encrypted (AES-256-GCM). The passphrase is stored nowhere — kept in memory and asked for when you enable it.',
    encryptSecretsNeedsPass:
      'Encryption is on, but no passphrase was entered this session — new secret backups are not being created. Enter the passphrase to resume.',
    encryptSecretsEnterPass: 'Enter passphrase',
    encryptSecretsError: 'Could not save the passphrase',
    encryptSecretsPassTitle: 'Encryption passphrase',
    encryptSecretsPassNew:
      'Set a passphrase — it will encrypt copies of the secrets file. Remember it: without it a copy cannot be restored, and the passphrase itself cannot be recovered.',
    encryptSecretsPassExisting:
      'Enter the same passphrase you set before: copies are encrypted with one passphrase.',
    encryptSecretsPassLabel: 'Passphrase',
    encryptSecretsPassHint: 'At least 8 characters',
    backupsDecryptTitle: 'Decrypt the copy to restore',
    backupsDecryptText:
      'The copy of {{target}} is encrypted. Enter the passphrase it was encrypted with — otherwise it cannot be restored.',
    backupsDecryptError: 'Could not decrypt the copy',
  },
  assistant: {
    title: 'Assistant',
    subtitle: 'Describe what you need — the fields fill themselves',
    placeholder:
      'For example: "I want a rule that tests are always run before claiming something is done". You can dictate it by voice.',
    inputPlaceholder: 'What should be done?',
    send: 'Send',
    startVoice: 'Dictate by voice',
    stopVoice: 'Stop recording',
    speakNow: 'Speak — the text will appear here',
    finalizing: 'Converting speech to text…',
    applyVoice: 'Done',
    speechError: {
      noPermission:
        'The microphone is unavailable: the browser denied access. Allow recording in the site settings and try again.',
      network:
        'The speech recognition service is not responding. Check the internet and try again.',
      unsupported:
        'This browser cannot recognise speech — dictation is unavailable. Type the text or open the panel in Chrome.',
    },
    thinking: 'Thinking…',
    noReply: 'Done.',
    failed: 'Could not get an answer. Check that Claude Code is installed and you are signed in.',
  },
  plugins: {
    title: 'Plugins',
    subtitle: 'Bundles of commands, skills and agents from marketplaces',
    explainTitle: 'How it works',
    explain:
      'A plugin adds a ready-made set of capabilities to Claude Code: commands, skills, subagents, MCP servers. It installs from a marketplace — a repository holding a plugin catalog. All operations run through the official Claude Code CLI, so the state never drifts from what Claude itself sees.',
    installed: 'Installed',
    marketplaces: 'Marketplaces',
    marketplaceAdd: 'Add marketplace',
    marketplaceSource: 'Marketplace source',
    installTitle: 'Install a plugin',
    installLabel: 'Plugin identifier',
    installHint:
      'Give the name as plugin@marketplace. Installation pulls the repository and takes a few seconds.',
    installPlaceholder: 'for example: code-review@claude-plugins-official',
    install: 'Install',
    update: 'Update',
    uninstall: 'Uninstall',
    version: 'version',
    installedAt: 'installed',
    deletePlugin:
      'The plugin will be removed together with all its commands, skills and agents. You can install it again from the same marketplace.',
    commandFailed: 'The command failed',
    noPlugins: 'No plugins installed',
    catalog: 'Catalogue',
    showCatalog: 'Show catalogue',
    catalogHint:
      'Every plugin from the connected marketplaces. Loaded on request: Claude Code refreshes the repositories, which takes up to a minute.',
    catalogLoading: 'Refreshing marketplace repositories — this takes up to a minute…',
    searchCatalog: 'Search the catalogue',
    searchCatalogPlaceholder: 'name or description, for example: playwright',
    catalogCount: 'Showing {{found}} of {{total}}',
    installs: 'installs',
    viewFiles: 'Plugin files',
    filesHint: 'Files of the installed plugin — read-only',
    scaffoldTitle: 'Create a plugin',
    scaffoldHint:
      'Generates a plugin skeleton in the Claude Code format inside the chosen folder: the .claude-plugin/plugin.json manifest and the selected parts. The plugin lands in a subfolder named after the plugin.',
    scaffoldName: 'Plugin name',
    scaffoldNameHint:
      'Becomes the folder name and the manifest name field: lowercase letters, digits and hyphens.',
    scaffoldDescription: 'Description',
    scaffoldDescriptionPlaceholder: 'Briefly: what the plugin does',
    scaffoldAuthor: 'Author',
    scaffoldFolder: 'Destination folder',
    scaffoldPickFolder: 'Choose folder',
    scaffoldComponents: 'What to include',
    scaffoldComponent: {
      commands: 'Commands (commands/)',
      agents: 'Subagents (agents/)',
      skills: 'Skills (skills/)',
      hooks: 'Hooks (hooks/hooks.json)',
    },
    scaffoldCreate: 'Create plugin',
    scaffoldDone: 'Plugin skeleton created',
  },
  models: {
    title: 'Provider models',
    hint:
      'The panel asks the provider what models it has — no more than once a day. ' +
      'A newly released one shows up here and in the model picker without updating ' +
      'the panel itself.',
    refresh: 'Refresh',
    unsupported:
      'This provider has no model catalog: it runs on top of any model, and the ' +
      'panel will not decide for you whose list to show.',
    autoUpdate: 'Update the model list automatically',
    autoUpdateHint:
      'Ask the catalog once a day and, when a concrete model is set as the default, ' +
      'move it to the newer generation of the same family.',
    source: 'Source: models.dev ({{vendors}}), updated {{date}}',
    noSource: 'The catalog has never been downloaded — press “Refresh”.',
    stale: 'older than a day',
    new: 'new',
    context: 'context {{value}}',
    isDefault: 'default',
    makeDefault: 'Make default',
    showAll: 'Show all ({{count}})',
    empty: 'The catalog is empty: the source did not answer and there is no earlier data.',
    promoted: 'Default model updated: {{from}} → {{to}}',
  },
  formatCheck: {
    title: 'Format check against schemas',
    hint:
      'The panel writes other CLIs’ configuration from their documentation, and ' +
      'documentation drifts with releases. This check asks the reverse question: are the ' +
      'keys the panel actually edits still present in that CLI’s officially published ' +
      'schema? A mismatch breaks nothing — it is a reason to look with your own eyes.',
    run: 'Check now',
    checkedAt: 'Checked {{date}}',
    stale: 'data older than a week',
    never: 'The check has never run — press “Check now”.',
    drifted: 'mismatches: {{count}}',
    doneOk: 'Every managed key is in place.',
    doneDrift: 'Mismatches against the schema: {{count}} — see the list.',
    error: 'The check failed: schemas could not be downloaded.',
    keyPresent: '{{path}} — present in the schema',
    keyMissing: '{{path}} — NOT found in the schema',
    state: {
      ok: 'matches',
      drift: 'mismatch',
      'no-schema': 'no schema',
      unavailable: 'not checked',
    },
  },
  writePreview: {
    title: 'What will be written',
    loading: 'Computing the changes…',
    error:
      'The server refused the preview — it would refuse the write for the same reason. ' +
      'The write was cancelled and the file is untouched.',
    summary: 'Changes: +{{added}} / −{{removed}}',
    willCreate: 'The file does not exist yet — the write will create it.',
    unchanged: 'Nothing will change: the file already holds exactly this.',
    truncated: 'The file is too large for a line-by-line comparison — no diff was built.',
    confirm: 'Write',
  },
  providerCheck: {
    title: 'Provider check: {{name}}',
    hint:
      'The panel runs a short checklist right here: finds the CLI and the config ' +
      'files, performs a read-write-read round trip for every supported section ' +
      'and asks the assistant for one reply. Writing happens on a TEMPORARY COPY ' +
      'of the configuration — your files are not modified.',
    run: 'Run check',
    withAssistant: 'Launch the assistant',
    withAssistantHint:
      'One short request to the provider model: spends your subscription or key. ' +
      'Without it the check stays partial — the channel to the model is unconfirmed.',
    never: 'This provider has not been checked here yet.',
    lastRun: 'Last check {{date}} — {{passed}} of {{total}} passed',
    doneVerified: 'Check passed: the provider works on this machine.',
    donePartial: 'Check passed partially — see the step list.',
    doneFailed: 'Check failed: some steps did not pass.',
    error: 'The check could not be run.',
    badgeWithName: '{{name}}: {{state}}',
    badge: {
      verified: 'verified here',
      partial: 'partially verified',
      failed: 'check failed',
    },
    status: {
      pass: 'ok',
      warn: 'warning',
      fail: 'failed',
      skipped: 'skipped',
    },
    step: {
      cli: 'CLI in PATH',
      config: 'Configuration files',
      mcp: 'Round trip: MCP servers',
      permissions: 'Round trip: permissions',
      env: 'Round trip: environment variables',
      instructions: 'Round trip: global instructions',
      assistant: 'Assistant launch',
    },
  },
  analytics: {
    title: 'Analytics',
    subtitle: 'Token spend, sessions and running agents — from local transcripts',
    period: 'Period',
    today: 'Today',
    days7: '7 days',
    days30: '30 days',
    days90: '90 days',
    allTime: 'All time',
    rangeFrom: 'Range start',
    rangeTo: 'Range end',
    exportCsv: 'Export daily data as CSV',
    exportJson: 'Export all data as JSON',
    totalTokens: 'Total tokens',
    requests: 'Model requests',
    outputTokens: 'Generated',
    cacheHit: 'Read from cache',
    cacheHitHint: 'Share of input tokens served from cache instead of being paid for again',
    estimatedCost: 'API equivalent',
    estimatedCostDetail: 'if billed at API rates',
    estimatedCostHint:
      'What the same work would cost through the API at per-token rates. On a subscription no tokens are billed — this figure compares volume, it is not an invoice.',
    byDay: 'Spend by day',
    byDayHint: 'All tokens: input, output and cache traffic',
    byModel: 'By model',
    byProject: 'By project',
    byHour: 'Activity by hour of day',
    byHourHint: 'When the work actually happens — in your machine time',
    topTools: 'Most used tools',
    topSkills: 'Skill usage',
    recentSessions: 'Recent sessions',
    liveAgents: 'Running right now',
    liveAgentsHint:
      'Claude Code processes running on this machine. There is no agent registry, so we count processes.',
    noAgents: 'No running Claude Code processes found',
    agentsSummary: 'Show processes — {{count}}, {{memory}}',
    activeSessions: 'active sessions',
    memory: 'memory',
    scanInfo: 'Scanned {{files}} files in {{ms}} ms',
    sessionActive: 'running now',
    limitsTitle: 'About subscription limits',
    limitsText:
      'Claude Code limit balances live on Anthropic servers and never reach local files — they cannot be shown here. Exact figures are available via the /usage command inside Claude Code. There is also no per-model limit setting in Claude Code: the feature does not exist.',
    noData: 'No data for the selected period',
    ofTotal: 'of the total',
    inputTokens: 'Input tokens',
    cacheRead: 'Cache reads',
    cacheCreation: 'Cache writes',
    estimatedCostShort: 'estimate at API rates',
    sessionsCount: 'Sessions',
    cacheComposition: 'What the spend is made of',
    cacheCompositionHint:
      'Shares of input, output and cache traffic across all tokens in the period',
    activityLess: 'less',
    activityMore: 'more',
  },
  errors: {
    locationInvalid: '.claude directory not found',
    locationHint:
      'Automatic detection failed. Enter the path manually — the app will pick up the configuration right away.',
    loadFailed: 'Failed to load data',
    saveFailed: 'Failed to save',
    serverUnreachable: 'The app server is not responding. Check that it is running.',
  },
  toasts: {
    created: 'Created',
    saved: 'Saved',
    deleted: 'Deleted',
    updated: 'Updated',
    moved: 'Moved',
    renamed: 'Renamed',
    backupSaved: 'backup: {{name}}',
    restored: 'File restored from a backup',
    copied: 'Copied',
    templateApplied: 'Template applied',
    locationChanged: 'Settings directory updated',
    pluginInstalled: 'Plugin installed',
    pluginRemoved: 'Plugin removed',
    marketplaceAdded: 'Marketplace added',
    marketplaceRemoved: 'Marketplace removed',
    pluginUpdated: 'Plugin updated',
    pluginScaffolded: 'Plugin skeleton created',
    openingEditor: 'Opening in VS Code',
  },
  workspace: {
    tabsLabel: 'Workspaces',
    homeTab: 'Chats',
    closeTab: 'Close {{name}}',
    status: {
      running: 'agent working',
      waiting: 'agent waiting for a reply',
      error: 'error or limit',
    },
  },
  projects: {
    title: 'Projects',
    sidebarLabel: 'Chats or projects',
    addFolder: 'Add folder',
    openInEditor: 'Open in editor',
    search: 'Search project',
    searchPlaceholder: 'name or path',
    count: 'Projects: {{count}}',
    chats: 'chats: {{count}}',
    missing: 'not on disk',
    emptyTitle: 'No projects yet',
    emptyText: 'Directories Claude Code has worked in will appear here.',
    newChat: 'New chat in project',
    notifyWaiting: 'Project "{{name}}": agent is waiting for a reply',
    notifyPermission: 'Project "{{name}}": agent needs permission',
    notifyError: 'Project "{{name}}": error or limit',
    notifyDone: 'Project "{{name}}": agent finished',
    starterPrompt:
      'You are working in the project "{{name}}". Read-only for now. Look around and briefly say what this project is and what you suggest starting with.',
    introHint:
      'A new conversation in the project directory. Read-only by default — enable edits with the toggle in the header when ready.',
    actions: {
      review: 'Do a code review: find problems and suggest fixes.',
      bugs: 'Find potential bugs and explain the cause of each.',
      structure: 'Explain the project structure and main modules.',
      tests: 'Run the tests and show what fails.',
    },
  },
  runner: {
    start: 'Run',
    stop: 'Stop',
    starting: 'Starting…',
    open: 'Open',
    notRunnable: 'No dev or start script and no run command set',
    failed: 'Failed to start the project dev server',
    autostart: 'Autostart',
    settings: 'Run settings',
    targets: 'What to run',
    root: 'root',
    chooseTarget: 'Pick what to run',
    sourceSingle: 'A single package: the project root itself is what runs',
    sourcePnpm: 'Packages taken from pnpm-workspace.yaml',
    sourceNpm: 'Packages taken from workspaces in package.json',
    sourceScan: 'No workspace file — the panel looked into apps/, packages/ and services/',
    skipped: 'Not all of them fit the list: {{count}} more are hidden',
    command: 'Command',
    port: 'Port',
    portAuto: 'from output',
    portHint:
      "Empty — the panel reads the port from the server's output, i.e. the one configured in the project. Fill it in if the server never prints an address",
    portHintLast: 'Last run: port {{port}}. Empty — the panel reads the port from output again',
    output: 'Process output',
    saved: 'Run settings saved',
    noAddress: 'address unknown',
    noAddressHint:
      'The server is running but never printed an address. Pin a port in the run settings and the link will appear',
    portBusy: 'Port {{port}} is busy',
    portOurs: 'started by the panel',
    freePort: 'Free it and start',
    portStillBusy: 'Port {{port}} is still busy — the process survived. Close it by hand',
    note: "The panel does not assign the port: the app comes up on its own port and the panel reads the address from the output. Autostart is about the panel's NEXT start, and it opens no browser window",
  },
  git: {
    title: 'Project git',
    hint: 'Project git: currently {{branch}}',
    branch: 'Branch',
    detached: 'Detached HEAD',
    noBranch: 'No branch',
    clean: 'No changes',
    dirty: 'Changed files: {{count}}',
    behind: 'behind by {{count}}',
    ahead: 'ahead by {{count}}',
    files: 'Changed files',
    filesTruncated: 'First {{count}} shown — the rest are visible in git',
    staged: 'staged',
    status: {
      added: 'Added',
      modified: 'Modified',
      deleted: 'Deleted',
      renamed: 'Renamed',
      typechange: 'Type changed',
      untracked: 'New, outside git',
      conflict: 'Conflict',
    },
    pull: 'Pull changes',
    pullCurrent: 'Current branch',
    pullAction: 'Pull',
    newBranch: 'New branch',
    newBranchPlaceholder: 'feature/name',
    create: 'Create',
    commit: 'Commit message',
    commitPlaceholder: 'What was done',
    commitAction: 'Commit',
    note: 'A commit takes every change in the working tree. Pull may merge — the panel does not resolve conflicts. No pushes or branch deletions here',
  },
  projectConfig: {
    title: 'Projects — configuration',
    subtitle:
      "A specific project's rules, permissions, hooks and MCP servers: its CLAUDE.md, .claude/settings.json and .mcp.json",
    addProject: 'Add project',
    explainTitle: 'What is this',
    explain:
      'Besides the user-level ~/.claude, the panel manages a specific project’s config. Rules come from the project’s CLAUDE.md, permissions and hooks from .claude/settings.json, MCP servers from the root .mcp.json. The .claude directory is created on first write. Changes apply after restarting Claude Code.',
    emptyTitle: 'No projects yet',
    emptyText: 'Add a project folder to manage its configuration separately from the user level.',
    count: 'Projects: {{count}}',
    removeDescription:
      'The project will be removed from the panel registry. The project files (CLAUDE.md, .claude, .mcp.json) are NOT touched — only the path is forgotten.',
    pickTitle: 'Pick a project',
    pickText: 'On the left is the list of added projects. Select one to view and edit its config.',
    levelBadge: 'project level',
    tab_rules: 'Rules',
    tab_mcp: 'MCP servers',
    tab_permissions: 'Permissions',
    rulesHint: "The project's root CLAUDE.md in full — as Claude reads it in this project.",
    mcpHint: "The project's MCP servers from the root .mcp.json.",
    mcpEmpty: "The project's .mcp.json has no servers yet.",
    addMcp: 'Add server',
    permissionsHint:
      "The project's permissions from .claude/settings.json (and settings.local.json).",
    permissionsEmpty: "The project's settings.json has no permission rules yet.",
    addPermission: 'Add permission',
  },
  // Project level for non-Claude providers: their own project files (COMMON-2).
  providerProject: {
    subtitle: "A specific project's configuration — in the active provider's project files",
    explain:
      "Besides the global config, the panel manages a specific project's config in the active provider's files: project instructions (AGENTS.md for Codex and OpenCode, GEMINI.md for Gemini), the project's MCP servers (.codex/config.toml, .gemini/settings.json, opencode.json, .cursor/mcp.json), for Gemini the project's environment variables (.gemini/.env) and permissions (.gemini/settings.json), for OpenCode the project's permissions in the same opencode.json, and for Aider the .aider.conf.yml in the repository root (the read list of attached files plus set-env variables). Only what is documented for that CLI is edited; other keys and comments in the file are preserved, and a backup is made before every write. Changes apply after restarting the CLI.",
    unsupported:
      'The active provider has no project-level configuration: no documented project files were found for it, so the panel neither reads nor writes anything.',
    tab_instructions: 'Project instructions',
    tab_instructionsList: 'Attached files',
    tab_instructionsRules: 'Rules (.mdc)',
    tab_env: 'Environment variables',
    tab_permissions: 'Permissions & approvals',
    tab_hooks: 'Hooks',
    tab_plugins: 'CLI plugins',
    tab_skills: 'Skills',
    instructionsHint:
      "The project's root {{fileName}} in full — as the CLI reads it in this project.",
    mcpHint: "The project's MCP servers from its file ({{format}} format).",
    mcpEmpty: 'The project file has no MCP servers yet.',
    envHint:
      "This project's environment variables. The file is edited line by line: comments and ordering are preserved.",
    envEmpty: 'The project file has no environment variables yet.',
    permissionsHint:
      "This project's permissions and approvals. The panel edits only the approval mode and the tool lists; every other setting in the file is left alone.",
  },
  onboarding: {
    introTitle: 'Welcome to Claude Control',
    introSubtitle: 'A panel for your Claude Code configuration, all in one place.',
    point1: 'View and edit rules, hooks, skills, MCP servers and permissions.',
    point2:
      'Everything reads and writes your local Claude Code files — nothing leaves your machine.',
    point3: 'Backups are made before edits, so any change is easy to roll back.',
    locationTitle: 'Configuration folder',
    locationSubtitle: 'Point the panel at your .claude directory.',
    locationHint:
      'Usually detected automatically. If it is wrong or missing, choose the folder manually.',
    chooseFolder: 'Choose folder',
    providersTitle: 'Detected CLIs',
    providersSubtitle: 'Which tool the panel will manage.',
    providersHint:
      'The panel checked which CLIs are installed on this system. This is a hint — you can pick any provider, or skip this step entirely.',
    providersNone:
      'No CLI was found in PATH. The panel still opens: its sections work with the configuration files.',
    providersChoose: 'Choose',
    providersDefaultNote:
      'By default the panel works with Claude Code. You can always switch providers in Settings.',
    next: 'Next',
    back: 'Back',
    done: 'Done',
  },
  envTransfer: {
    title: 'Environment transfer',
    hint: "Any provider's configuration — instructions, rules, skills, hooks, MCP and permissions — leaves as a single archive and unpacks on another machine. Secrets are never packed: instead the panel lists what has to be entered by hand.",
    activeBadge: 'active',
    export: 'Export',
    import: 'Import',
    pickFolder: 'Where to save the archive',
    pickFolderHint: 'Pick a folder — the archive lands there and the panel shows the full path.',
    pickArchive: 'Choose an environment archive',
    pickArchiveHint: 'Find the zip built by the panel on the other machine.',
    previewTitle: 'What will leave: {{provider}}',
    previewDesc: 'Before the archive is built you can see which files go in and what stays out.',
    previewCount: 'Files: {{count}}, size before compression: {{size}}',
    previewEmpty: 'Nothing to transfer: this provider has no configuration on disk.',
    previewLocations: 'Taken from:',
    locationMissing: 'not on disk',
    chooseFolder: 'Pick a folder and save',
    doneTitle: 'Archive built',
    doneDesc: 'Files inside: {{count}}',
    donePath: 'The archive is here:',
    checklistTitle: 'What you will have to enter by hand',
    checklistHint:
      'Tokens and keys are never packed. The archive contains a README you can hand to the assistant on the new machine so it lays everything out itself.',
    checklistEmpty: 'Nothing: no secrets were found in the configuration.',
    checklistReason_redacted: 'values replaced with the __REDACTED__ marker',
    'checklistReason_env-file': 'environment variables',
    'checklistReason_secret-file': 'a secrets file was not transferred',
    planTitle: 'Unpack environment: {{provider}}',
    planDesc:
      'Built {{date}} on {{platform}}. Checked entries will be written, the rest stays as it is.',
    planCounts: 'New: {{added}} · identical: {{same}} · will overwrite: {{differs}}',
    planUnresolved: 'nowhere to put: {{count}}',
    selectAll: 'Check all',
    selectNone: 'Uncheck all',
    applySelected: 'Write checked ({{count}})',
    status_new: 'new',
    status_same: 'identical',
    status_differs: 'overwrites',
    status_unresolved: 'no target',
    importDone: 'Files written: {{count}}. Everything overwritten went into backups.',
  },
  folderPicker: {
    title: 'Choose a project folder',
    hint: 'Open any folder on disk as a project — even one Claude has not worked in yet.',
    roots: 'Pick a drive or folder',
    up: 'Up',
    empty: 'No subfolders inside',
    pick: 'Open this folder',
  },
  agents: {
    title: 'Agents',
    active: 'Active agents: {{count}}',
    empty: 'No active agents',
    stopAll: 'Stop all',
    totalCost: 'Total this session',
    total: 'Total this session',
    chat: 'Chat',
    sound: 'Sound',
    soundHint: 'Notification sound: an agent is waiting, failed or finished',
    volume: 'Notification volume',
    volumeHint: 'Signal volume: 100% is the base tone, 200% by default',
    volumeTest: 'Test the sound',
  },
  parallel: {
    button: 'Run in several',
    title: 'Run in several projects',
    hint: 'One request — a separate agent in each selected project. Track them in the panel and by the tab dots.',
    prompt: 'What to do',
    promptPlaceholder: 'For example: do a code review and suggest fixes',
    pickProjects: 'Projects selected: {{count}}',
    launch: 'Run in {{count}}',
  },
  bulkPresets: {
    hint: 'Tick the presets you need — I will create them all at once. Each can be edited afterwards.',
    createSelected: 'Create selected ({{count}})',
    creating: 'Creating… {{done}} of {{total}}',
  },
};
