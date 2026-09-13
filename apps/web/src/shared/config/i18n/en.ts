import type { TranslationSchema } from './ru';

/** Типизирован по русской версии: забыть ключ при переводе не получится. */
export const en: TranslationSchema = {
  common: {
    duration: { h: 'h', m: 'm', s: 's' },
    appName: 'AgentDeck',
    loadError: 'Could not load this section',
    loadErrorText: 'The server did not answer. Check that it is running and retry.',
    retry: 'Retry',
    notFoundTitle: 'No such page',
    notFoundText: 'The link may be outdated. Open the overview and pick a section in the sidebar.',
    notFoundHome: 'To the overview',
    openHelp: 'Help for this section',
    crashTitle: 'This section failed to render',
    crashText:
      'A bug in the panel code, not in your data. Try again or reload the page; ' +
      'the error text can be copied for a report.',
    crashRetry: 'Try again',
    crashReload: 'Reload page',
    crashCopy: 'Copy error',
    crashCopied: 'Copied',
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
    total: 'total',
    show: 'Show',
    needsRestart: 'Changes apply after restarting Claude Code',
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
      'The rule will be cut from CLAUDE.md. A backup of the file goes to agentdeck/backups, but the rule itself will be gone from the file.',
    deleteSkill:
      'The skill folder will be deleted from disk with everything inside. A copy of the folder goes to agentdeck/backups — restoring it from there is a manual job.',
    deleteHook:
      'The hook will be removed from settings.json. The script file stays on disk but stops being called. A config backup goes to agentdeck/backups.',
    deleteMcp:
      'The server will be removed from the configuration. Its tools stop being available to Claude after a restart.',
    sourceLocal: 'local',
    deleteHookLocal:
      'The hook will be removed from settings.local.json, your personal settings file. The script file stays on disk. A config backup goes to agentdeck/backups.',
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
    instructions: 'Instructions',
    hooks: 'Hooks',
    scripts: 'Scripts',
    skills: 'Skills',
    commands: 'Commands',
    plugins: 'Plugins',
    mcp: 'MCP servers',
    permissions: 'Permissions',
    env: 'Environment',
    projects: 'Projects',
    tests: 'Testing',
    groups: 'Groups',
    history: 'Change history',
    compare: 'Comparison',
    settings: 'Settings',
    dlp: 'Data protection',
    platform: 'Contour',
    help: 'Help',
    sectionMain: 'Main',
    sectionBehavior: 'Agent behaviour',
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
    needsRestartFor: 'Changes apply after restarting {{provider}}',
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
      group: 'Groups',
      test: 'Test cases',
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
    detailsTitle: 'Full notification text',
    copy: 'Copy text',
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
    // English has one/other only; few/many exist to mirror the Russian key set.
    groupsHint_one: '{{count}} setting bundle',
    groupsHint_few: '{{count}} setting bundles',
    groupsHint_many: '{{count}} setting bundles',
    groupsHint_other: '{{count}} setting bundles',
    permissionsAsk: 'ask first',
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
    emptyTitle: 'No rules yet',
    emptyText:
      'The panel counts a section as a rule only when its heading reads «## ПРАВИЛО: …» in CLAUDE.md — the rest of the file is left alone and never listed. Add the first rule with the button above.',
    emptyPlainTitle: 'CLAUDE.md has no rules in the panel’s format',
    emptyPlainText_one:
      'The file is not empty: it has {{count}} «## …» section, but the panel counts a section as a rule only when its heading looks like this:',
    emptyPlainText_few:
      'The file is not empty: it has {{count}} «## …» sections, but the panel counts a section as a rule only when its heading looks like this:',
    emptyPlainText_many:
      'The file is not empty: it has {{count}} «## …» sections, but the panel counts a section as a rule only when its heading looks like this:',
    emptyPlainText_other:
      'The file is not empty: it has {{count}} «## …» sections, but the panel counts a section as a rule only when its heading looks like this:',
    emptyPlainNoSections:
      'The file is not empty but has no «## …» headings at all, and the panel counts a section as a rule only when its heading looks like this:',
    emptyPlainHint:
      'The rest of the file is left alone and never listed. Rename the heading of the section you need after the example, or add the first rule with the button above.',
    openClaudeMd: 'Open CLAUDE.md',
    openRulesHelp: 'How rules work',
    noMatchTitle: 'Nothing found',
    noMatchText: 'No rule title or body matches “{{query}}”.',
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
    changedOnDisk:
      'The file changed on disk while you were editing. Your edits are kept; “Save” will overwrite the newer file.',
    loadFromDisk: 'Load from disk',
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
    clearInput: 'Clear the field',
    queue: {
      title: 'Queued: {{count}}',
      add: 'Add to the queue',
      hint: 'The agent is busy — the message goes out as soon as the current turn ends',
      cancel: 'Remove from the queue',
      next: 'Goes out next',
      later: 'Goes out after that',
    },
    mode: {
      title: 'What sending does',
      hint: 'Send mode: a message to the agent, an image or a deck',
      text: 'Message',
      textHint: 'Goes to the agent in this conversation',
      image: 'Image',
      imageHint: 'The panel draws it from your description',
      imageBlocked: 'Nothing to draw with',
      imagePlaceholder: 'Describe the image — the panel draws it itself, without the agent',
      imagePlaceholderAgent: 'Describe the image — the agent draws it as vector code',
      deck: 'Presentation',
      deckHint: 'Slides on a topic: HTML, PPTX and PDF',
      deckBlocked: 'Nothing to build it with',
      deckPlaceholder: 'Name the topic — the panel builds the slides and hands them over as files',
      revisePlaceholder:
        'Say what to fix: "make the third slide shorter", "add a diagram at the end"',
      reviseTitle: 'Reworking: {{title}}',
      reviseCancel: 'Cancel the rework',
      draw: 'Draw',
      build: 'Build',
      drawing: 'Drawing — this takes minutes; you can leave the page',
      note: 'Available where the capability is declared',
      source: '{{title}} · {{model}}',
      sourceNoModel: '{{title}}',
      sourceAgent: 'The conversation agent draws it: vector code, not a photo',
      deckSourceAgent: 'The conversation agent dictates the slides',
      promptSkipped: 'The mode prompt is not sent here: the images endpoint has no system message',
      blocked: {
        'no-route': 'No active contour and no endpoint profile — nothing to draw with',
        'driver-none': 'This contour does not draw: its driver declares no such capability',
        'no-model': 'The key catalog holds no model with image generation',
        'endpoint-no-url': 'The endpoint profile has no image generation address',
        'gateway-off': 'The panel gateway is off, and the contour request goes through it',
        'endpoint-api-kind': 'This API kind has no separate images endpoint',
        'no-agent': 'Neither a raster route nor a conversation whose agent could be asked',
      },
      noRaster: {
        'no-route': 'no raster: no active contour and no endpoint profile',
        'driver-none': 'no raster: this contour does not draw images',
        'no-model': 'no raster: the key catalog holds no image model',
        'endpoint-no-url': 'no raster: the endpoint profile has no generation address',
        'gateway-off': 'no raster: the panel gateway is off',
        'endpoint-api-kind': 'no raster: this API kind has no images endpoint',
        'no-agent': 'no raster: nothing to draw with',
      },
      noDeck: {
        'no-route': 'No agent conversation, no contour, no endpoint of your own',
        'no-model': 'The contour is active, but no model is named for the request',
        'gateway-off': 'The panel gateway is off, and the contour request goes through it',
        'endpoint-api-kind': 'Only an OpenAI-kind endpoint can hold this conversation',
      },
      noPdf: {
        'no-browser': 'No PDF on this machine: no system browser was found',
      },
      card: {
        title: 'Image',
        by: 'Drawn by {{model}} · {{source}}',
        byNoModel: 'Drawn by {{source}}',
        source: {
          'contour-chat': 'contour, part of the answer',
          'contour-images': 'contour, images endpoint',
          endpoint: 'endpoint profile',
          contour: 'contour',
          agent: 'conversation agent',
        },
        size: '{{width}}×{{height}}, {{size}}',
        download: 'Download',
        failed: 'Did not work out: {{message}}',
      },
      deckCard: {
        untitled: 'Untitled presentation',
        badge: 'Presentation',
        slides: 'Slides: {{count}}',
        open: 'View',
        pptx: 'PPTX',
        pdf: 'PDF',
        pdfHint: 'The first request prints the PDF — a few seconds',
        by: 'Dictated by {{model}} · {{source}}',
        byNoModel: 'Dictated by {{source}}',
        revise: 'Rework',
        revision: 'Revision',
        pictures: 'Pictures the panel drew: {{count}}',
        noPictures: 'No pictures were drawn for the slides — {{reason}}',
        truncated:
          'The deck was trimmed to the panel ceilings: there were more slides, bullets or longer lines',
        pictureReason: {
          'no-route': 'no active contour and no endpoint profile',
          'driver-none': 'this contour does not draw images',
          'no-model': 'the key catalog holds no model with image generation',
          'endpoint-no-url': 'the endpoint profile has no generation address',
          'gateway-off': 'the panel gateway is off',
          'endpoint-api-kind': 'this API kind has no images endpoint',
          'no-agent': 'nothing to draw with',
          'draw-failed': 'the drawing endpoint refused',
        },
      },
      block: {
        picture: 'Drawing from the agent',
        deck: 'Presentation from the agent',
        build: 'Build the files',
        save: 'Save as a file',
        rejected: 'Blocks the panel did not accept: {{count}} — they stay in the text as they came',
      },
    },
    split: {
      title: 'Split the tasks: {{count}} groups',
      apply: 'Split into {{count}} chats',
      keepHere: 'Do it here, one by one',
      keepHerePrompt: 'Do not split — do everything here, one task at a time.',
      createOnly: 'Only create the chats, do not start the agents',
      ask: 'Split the tasks across chats',
      askFailed: 'Could not ask for a split',
      done: 'Chats created: {{count}}',
      alreadyDone: 'Already split: {{done}} of {{count}} groups became chats',
      failed: '“{{title}}” was not created: {{message}}',
      failedAll: 'The split failed: {{message}}',
      notParsed:
        'The panel could not read this split proposal — the block is left above as it came, ' +
        'so there are no buttons. Ask the agent to propose the split again.',
      cascade: {
        kind: {
          mechanical: 'mechanical',
          implementation: 'implementation',
          tests: 'tests',
          investigation: 'investigation',
          design: 'design',
          review: 'review',
        },
        kindUnknown: 'kind not stated',
        model: 'Model for the “{{title}}” group',
        effort: 'Thinking depth for the “{{title}}” group',
        lowered: 'below the ceiling',
        loweredHint:
          'A model weaker than this conversation’s ceiling: the group is told where the bar is — ' +
          'run the project checks and match the result against the task point by point. ' +
          'When it is done, the panel opens a review at the ceiling over the same diff, ' +
          'and turns any findings into a fix run back on this model.',
        cost: 'Chats: {{chats}} · runs right now: {{runs}}',
        loweredCount: 'below the ceiling: {{count}}',
        pipeline: 'up to {{total}} runs with reviews',
        pipelinePlanned: 'up to {{total}} runs: triage, plans, work and reviews',
      },
      triageStarted: 'Split triage started — the groups start on its verdict',
      triageDeferred: 'Tree paused — the triage is created, it starts on “Resume all”',
    },
    /** Продолжение в чистой сессии: карточка, кнопка и отказы автопродолжения. */
    handoff: {
      title: 'Stage closed — continue in a clean session',
      chain: 'step {{depth}} of {{max}}',
      pruned: 'Pruned: {{text}}',
      checkpoint: 'Checkpoint: {{file}}',
      apply: 'Continue in a new chat',
      keepHere: 'Stay here',
      keepHerePrompt: 'Do not start a new session — we continue in this conversation.',
      createOnly: 'Only create the chat, do not start the agent',
      auto: 'Keep going on your own',
      ask: 'Close the stage and continue in a clean session',
      askFailed: 'Could not ask to continue',
      done: 'Work continued in a clean session',
      doneDraft: 'Chat created — the task is in the input box',
      failed: 'Could not continue: {{message}}',
      autoDone: 'Work continued in a clean session — {{name}}',
      autoFailed: 'Could not switch auto-continue',
      /** Кнопка в меню шапки и её исходы. */
      restart: 'Restart the session',
      restartHint:
        'A new conversation of the same project from the checkpoint file — the expensive context stays behind',
      restartRunning: 'A run is still going — wait for the turn to end or stop it',
      restartRequested:
        'The checkpoint is older than your last message — the agent will update it and the panel ' +
        'will restart the session by itself',
      restartFailed: 'Could not restart: {{message}}',
      notParsed:
        'The panel could not read this hand-off proposal — the block is left above as it came, ' +
        'so there are no buttons. Ask the agent to propose it again.',
      /** Почему автопродолжение не сработало: коды приходят с сервера. */
      refusal: {
        run_failed: 'No continuation: the run ended with an error or was stopped',
        chain_cap: 'No continuation: the chain reached its cap',
        checkpoint_missing: 'No continuation: the checkpoint file is missing',
        checkpoint_stale: 'No continuation: the checkpoint file was not updated in this run',
        checkpoint_unchanged:
          'No continuation: the checkpoint file has not changed since the last restart — the agent ' +
          'is going in circles',
        no_project: 'No continuation: the conversation runs outside a project',
        context_high: 'The conversation window has grown — a clean session is cheaper from here',
      },
      /** Триггер по размеру окна: тост кликабельный, клик и есть продолжение. */
      contextHigh: 'Context at {{tokens}}k — tap to continue in a clean chat',
      contextStale:
        'Context at {{tokens}}k, but .agent/PROGRESS.md was not updated in this run — ' +
        'there would be nothing to continue from',
    },
    /** Конвейер подбора модели: «работа → ревью → фикс». */
    cascade: {
      stage: {
        triage: 'triage',
        plan: 'plan',
        review: 'review',
        fix: 'fixes',
      },
      stageFull: {
        triage: 'triage',
        plan: 'plan',
        work: 'work',
        review: 'review',
        fix: 'fixes',
      },
      hub: {
        title_one: 'Split group: {{count}}',
        title_few: 'Split groups: {{count}}',
        title_many: 'Split groups: {{count}}',
        title_other: 'Split groups: {{count}}',
        running: 'run in progress',
        idle: 'no run in progress',
        firstEdit: 'first edit after {{time}}',
        work: 'worked {{time}}',
        triageRunning: 'triage in progress',
        triageApplied: 'triage applied',
        triageMissing: 'no triage received — the groups went as proposed',
        repairs: 'repaired by the panel: {{count}}',
        pending: 'waiting for the triage',
        waiting: 'waiting for: {{names}}',
        held: 'waiting for your answer',
        holdAnswered: 'answered',
        failed: 'did not start: {{message}}',
        base: 'from branch {{branch}}',
        holdPlaceholder: 'The answer goes into the group’s plan and task',
        holdSend: 'Answer',
        holdStarted: 'Answer accepted — “{{title}}” is starting',
        holdQueued: 'Answer accepted — the group starts once its predecessors finish',
        holdFailed: 'Answer not accepted: {{message}}',
      },
      overlap: {
        idle: 'Branch overlap not checked',
        none: 'No overlap between branches',
        title_one: 'Branch overlap: {{count}} file',
        title_few: 'Branch overlap: {{count}} files',
        title_many: 'Branch overlap: {{count}} files',
        title_other: 'Branch overlap: {{count}} files',
        check: 'Check branches',
        hint: 'Count the files several groups touched at once. The panel never touches branches — merging stays with you',
        outside: 'outside ownership: {{names}}',
        mergeOrder: 'Merge order: {{names}}',
        unread: 'Unread: {{names}}',
        clean: 'Branches checked — no shared files',
        failed: 'Check failed: {{message}}',
      },
      tree: {
        pauseAll: 'Stop all ({{count}})',
        resumeAll: 'Resume all ({{count}})',
        pauseHint:
          'Stop every running run of the tree; continuations, stages and new children queue up',
        resumeHint: 'Restart the stopped runs in their own sessions and release the queue',
        resumeHintForeign:
          'Start the stopped runs over and release the queue: this CLI has no session, ' +
          'so continuing means asking the same thing again',
        paused: 'paused',
        pausedToast_one: 'Tree stopped: {{count}} run. Auto-starts are queued.',
        pausedToast_few: 'Tree stopped: {{count}} runs. Auto-starts are queued.',
        pausedToast_many: 'Tree stopped: {{count}} runs. Auto-starts are queued.',
        pausedToast_other: 'Tree stopped: {{count}} runs. Auto-starts are queued.',
        resumedToast: 'Tree resumed: {{resumed}} in their sessions, {{flushed}} from the queue',
        resumedToastForeign:
          'Tree resumed: {{resumed}} started over, {{flushed}} from the queue. ' +
          'This CLI has no session: continuing means asking the same thing again.',
        deferred: 'Tree paused — {{name}}: the chat is created, it starts on “Resume all”',
        failed: 'Failed: {{message}}',
      },
      started: {
        work: 'Plan ready — working: {{name}}',
        workNoPlan: 'No plan received — working without one: {{name}}',
        review: 'Work finished — reviewing it on the ceiling model: {{name}}',
        fix: 'The review found {{count}} findings — fixing: {{name}}',
      },
      triage: {
        title: 'Split triage',
        count_one: '{{count}} group',
        count_few: '{{count}} groups',
        count_many: '{{count}} groups',
        count_other: '{{count}} groups',
        group: 'group {{number}}',
        owns: 'owns',
        after: 'after',
        tasks_one: '{{count}} task',
        tasks_few: '{{count}} tasks',
        tasks_many: '{{count}} tasks',
        tasks_other: '{{count}} tasks',
        hold: 'Question for you',
        conflicts: 'Overlaps',
        order: 'Order: {{list}}',
        notParsed:
          'The panel could not read the triage block — it is left above as it came. ' +
          'The groups start as proposed, without boundaries or waits.',
      },
      plan: {
        title: 'Work plan — goes into the group’s task',
      },
      review: {
        title: 'Work review',
        count_one: '{{count}} finding',
        count_few: '{{count}} findings',
        count_many: '{{count}} findings',
        count_other: '{{count}} findings',
        clean: 'Checked against the task and the diff — nothing to fix, the chain is closed.',
        notParsed:
          'The panel could not read the review verdict — the block is left above as it came. ' +
          'No fix run was started: ask the agent to repeat the block.',
      },
    },
    review: {
      title: 'Merge request review',
      titleNamed: 'Review: {{title}}',
      branch: 'copy on branch {{branch}}',
      offBranch:
        'The copy could not be put on this MR branch — it was cut from the base branch. ' +
        'The findings may have been read from the wrong diff.',
      clean: 'No findings — the group is closed.',
      applyAll_one: 'same decision for {{count}} more group',
      applyAll_few: 'same decision for {{count}} more groups',
      applyAll_many: 'same decision for {{count}} more groups',
      applyAll_other: 'same decision for {{count}} more groups',
      fix: 'Fix in the copy',
      post: 'Post to the MR',
      both: 'Both',
      none: 'Do nothing',
      decided: {
        fix: 'Decided: fixing in the copy',
        post: 'Decided: posted to the MR',
        both: 'Decided: fixing and posting',
        none: 'Decided: do nothing',
      },
      posted: 'The summary comment is written to the MR',
      postFailed: 'The comment was not written: {{message}}',
      push: 'Commit and push to the MR',
      pushed: 'Consent given — the agent commits and pushes the fixes',
      donePlain_one: 'Decision applied: {{count}} group',
      donePlain_few: 'Decision applied: {{count}} groups',
      donePlain_many: 'Decision applied: {{count}} groups',
      donePlain_other: 'Decision applied: {{count}} groups',
      doneToast_one: 'Decision applied: {{count}} group, comments posted: {{posted}}',
      doneToast_few: 'Decision applied: {{count}} groups, comments posted: {{posted}}',
      doneToast_many: 'Decision applied: {{count}} groups, comments posted: {{posted}}',
      doneToast_other: 'Decision applied: {{count}} groups, comments posted: {{posted}}',
      pushToast: 'Consent to commit and push sent to the agent',
      failed: 'Failed: {{message}}',
    },
    attach: 'Attach a file',
    attachments: 'Attached files',
    thinking: 'Thinking',
    /** Пока ответа ещё нет: без этого пустая лента выглядит зависшей. */
    pending: 'Claude is thinking',
    pendingTools: 'Claude is working with files',
    reconnecting: 'Lost the connection to the answer — reconnecting',
    errorTitle: 'The agent stopped with an error',
    copyError: 'Copy the error',
    connectionLost:
      'Lost the connection to the run. The agent may have finished — look in the history.',
    messageCrash: 'This message could not be rendered. The rest of the conversation is intact.',
    branchSwitched: 'Switched to branch {{branch}}',
    showFromHistory: 'Show from the history',
    detachedNotice:
      'The panel restarted: this run was picked up without its output stream. The answer is read from the conversation, permission requests still work; no continuation or pipeline follows this run.',
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
    questionStep: 'question {{current}} of {{total}}',
    questionWait: 'Answer the previous question first',
    questionChange: 'Change',
    questionNext: 'Next',
    questionSubmit: 'Send answers',
    questionOther: 'Answer in your own words',
    questionOtherEdit: 'Edit your own answer',
    questionOtherApply: 'Answer with this',
    questionOtherPlaceholder: 'Write what you actually need',
    questionOtherMine: 'your answer',
    questionSentNote: 'Answer sent — the agent is thinking',
    questionQueuedNote: 'Answer queued — it will be sent when the agent finishes its turn',
    questionSentToNote: 'Answer sent to “{{title}}” — the agent is thinking',
    questionQueuedToNote: 'Answer queued for “{{title}}” — it goes out at the end of the turn',
    questionFromChild: 'Asked by “{{title}}”',
    answerSentToChild: 'Answer sent to “{{title}}”',
    answerQueuedForChild: 'Answer for “{{title}}” is queued — it goes out at the end of the turn',
    pickOption: 'Answer with this option',
    permissionTitle: 'The agent needs permission',
    permissionFromChild: 'Requested by “{{title}}”',
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
    platformModel: 'Through the "{{title}}" contour: {{model}}.',
    platformModelReplaced:
      'Through the "{{title}}" contour: no "{{asked}}" there, the request goes with {{model}}.',
    platformModelUnset:
      'The "{{title}}" contour assigned no model (empty catalog, or the probe never ran) — the request goes as it is.',
    platformNoEffort: 'The "{{title}}" contour takes no reasoning effort — it is not sent.',
    platformRefused:
      'The "{{title}}" contour is required, but {{reason}}: the message will be refused — it goes neither to the contour nor to the vendor cloud. {{fix}}',
    platformRefusedReason: {
      gateway_down: 'the panel gateway is down',
      no_token: 'the contour key is not saved',
    },
    platformRefusedFix: {
      gateway_down: 'Press “Start the gateway” on the contour card (the “Contour” section).',
      no_token: 'Save the key: “Configure” on the contour card → the “Key” step.',
    },
    platformLayers: 'Through the "{{title}}" contour the run goes without ours: {{list}}.',
    platformLayersAll:
      'Through the "{{title}}" contour the run goes without a single layer of ours: no rules, no ' +
      'hooks, no permissions, no skills, no MCP servers, no addition from the panel.',
    copyMessage: 'Copy message',
    editMessage: 'Edit and send as a new branch',
    usage: {
      title: 'Step spend',
      badgeLabel: 'Step spend: {{total}} tokens, details on hover',
      input: 'Fresh input',
      cacheCreation: 'Written to cache',
      cacheRead: 'Read from cache',
      output: 'Generated',
      total: 'Total',
      cost: 'Cost',
      effort: 'Effort',
      shared: 'Shared across {{count}} calls of this step',
      answer: 'Answer',
      badgeLabelTimed: 'Step spend: {{total}} tokens, took {{time}}, details on hover',
      step: 'Step time',
      span: 'from {{from}} to {{to}}',
      run: 'Whole run',
      live: 'running {{time}}',
    },
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
      'The panel itself approves anything that can be undone — commit, push, branch, moving a file, an API call. What still asks is the irreversible: deleting, wiping history, tearing down data and infrastructure, publishing — plus anything covered by ask/deny rules from settings.json. Reading files is always allowed, whatever this toggle says.',
    menu: 'Chat settings',
    menuHint: 'Permission toggles, rules, export, refresh and help',
    menuPermissions: 'Permissions',
    menuActions: 'Conversation',
    rules: {
      title: 'Approve without asking — in every project',
      modelCascade: 'Match the model to the task (this project)',
      modelCascadeHint:
        'The panel gives each split group a model that fits its kind of work — never above the ' +
        'one you picked; work on a weaker model gets a higher bar: project checks run, result ' +
        'matched against the task. Off — every child runs on the model you picked',
      externalWrite: 'Writes to external services',
      externalWriteHint: 'MR comments and threads, Jira tickets, wiki pages — over MCP',
      gitWrite: 'Commits, branches, plain push',
      gitWriteHint: 'commit, push, branch, rebase, cherry-pick, revert',
      filesDelete: 'Deleting files',
      filesDeleteHint: 'rm, del, shred, dd, Remove-Item, reg delete',
      gitHistory: 'Wiping git history',
      gitHistoryHint: 'reset --hard, clean, restore, branch -D, stash drop, push --force',
      database: 'Tearing down database data',
      databaseHint: 'DROP, TRUNCATE, DELETE FROM, migration rollback',
      infrastructure: 'Containers and infrastructure',
      infrastructureHint: 'docker prune, kubectl delete, helm uninstall, terraform destroy, reboot',
      packagePublish: 'Publishing packages',
      packagePublishHint: 'npm/pnpm/yarn publish, unpublish, deprecate',
      externalDestroy: 'Deleting and merging in external services',
      externalDestroyHint: 'Merging an MR, deleting a ticket or a wiki page — not undoable here',
      networkExec: 'Dangerous network commands',
      networkExecHint: 'curl | sh — running what was downloaded, curl -X DELETE',
    },
    retry: 'Retry',
    continueAfterDrop:
      'Continue from where you stopped: the connection dropped and the last answer may be unfinished. Do not redo what is already done.',
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
    test: 'Test',
    summary: '{{total}} files · {{unused}} not bound to any event',
    summaryAllUsed: '{{total}} files · all bound to hooks',
    summaryNoHooks: '{{total}} files',
    search: 'Search scripts',
    searchPlaceholder: 'File name or description',
    noMatches: 'Nothing found for “{{query}}”.',
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
    timeout: 'Timeout, seconds',
    timeoutHint:
      'How many seconds to wait for the script before cutting it off. Empty — the Claude Code default (60).',
    emptyTitle: 'No hooks yet',
    emptyText:
      'settings.json has no hooks section. Add one with the button above — from a preset or the builder — or write it into the file by hand: the list updates on its own.',
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
    files_one: '{{count}} file',
    files_few: '{{count}} files',
    files_many: '{{count}} files',
    files_other: '{{count}} files',
    emptyTitle: 'No skills yet',
    emptyText:
      'The skills/ folder has no folder with a SKILL.md. Create the first skill with the button above or drop a folder in by hand — the list updates on its own.',
    noMatchTitle: 'Nothing found',
    noMatchText: 'No skill name or description matches “{{query}}”.',
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
      // Заготовка про уборку рабочих файлов агента. Готовой её кладём не для
      // красоты: контекст переставляется целиком на каждом ходу, и мусор в
      // PROGRESS/TASKS оплачивается заново до конца разговора.
      hygieneTitle: 'Tidying the agent working files',
      hygieneBody:
        "# {{name}}\n\n## When to apply\n\nBefore EVERY write to the agent's working files (`.agent/PROGRESS.md`, `TASKS.md`, notes) and always at the moment a task is closed.\n\n## Rule\n\nPrune first, then write. Anything appended on top of stale content is context that gets re-read and paid for on every later turn of the conversation.\n\n## Order\n\n1. Read the file in full and separate what is live from what is closed.\n2. Drop finished items from `TASKS.md`; drop closed stages, settled questions and plans that will never happen from `.agent/PROGRESS.md`.\n3. Move every dropped item to `.agent/ARCHIVE.md` as ONE line: date, what was done, where the result lives. The archive is never read whole — it exists for lookup, not for context.\n4. Keep only what is needed to continue from scratch: what is still open, the decisions taken and why, paths into the code, the traps already found.\n5. Only now write the current state.\n\n## What not to do\n\n- Never delete the only record of a decision — move it to the archive as a line instead.\n- Do not turn `PROGRESS.md` into a diary: it answers “what is done, what is left, what to continue with”, not “how the work went”.\n- Do not start a second file for the same purpose — prune this one.\n- Never keep secrets, tokens or keys in the working files.\n\n## How to verify\n\nRead the file as someone who knows nothing about the work: if it is not enough to continue, too much was pruned; if it holds lines that will never be needed again, too little.\n",
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
    subtitleRules: '{{provider}} hooks: the hooks key in settings.json - event, matcher, command',
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
      'The skill folder and every file in it will be removed from disk. A copy of the folder is kept in agentdeck/backups — restoring it from there is manual only.',
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
  endpoints: {
    title: 'Custom endpoint',
    hint: 'The address a CLI calls for the model instead of the vendor cloud: a local model, a corporate gateway or a proxy. A profile is set up once and pushed into a CLI with one button — instead of typing ANTHROPIC_BASE_URL and its counterparts into every environment section by hand.',
    empty: 'No profiles yet. Add the first one — the panel will show which CLIs accept it.',
    add: 'Add profile',
    remove: 'Delete profile',
    ownerLine:
      'This profile is owned by the contour “{{title}}”: the address points at the panel’s local gateway and the key is injected there. Editing the fields here sends the CLI past the contour.',
    ownerActive: 'contour is active',
    ownerIdle: 'contour is not active',
    ownerGone: 'The contour that created this profile is gone — the profile can be deleted.',
    ownerUnknown:
      'This profile is owned by a contour: the address points at the panel’s local gateway and the key is injected there. Which contour exactly, the panel has not read yet.',
    ownerReturned: 'Back on the default provider: CLI files are restored',
    ownerReturnFailed: 'Could not return to the default provider',
    newName: 'Endpoint {{n}}',
    profile: 'Profile',
    name: 'Name',
    apiKindLabel: 'API kind',
    apiKindHint:
      'The schema the endpoint accepts requests in. It decides both what the address means and which CLIs can take this profile.',
    apiKind: {
      'openai-compat': 'OpenAI-compatible',
      anthropic: 'Anthropic',
      google: 'Google Gemini',
    },
    baseUrl: 'Address',
    baseUrlHint: {
      'openai-compat': 'The address including the version — exactly what OPENAI_BASE_URL expects.',
      anthropic: 'Host root, without /v1: the CLI appends the request path itself.',
      google:
        'Host root, without /v1beta. The Gemini CLI accepts https only — localhost is the sole exception.',
    },
    model: 'Model',
    modelAuto: 'let the CLI decide',
    modelHint:
      'The model name on this address. Empty — the panel leaves the model variable alone. After a connection check the models reported by the address appear here.',
    imagesUrl: 'Image generation address',
    imagesUrlHint:
      'The full address of the images endpoint — usually /v1/images/generations. Empty — the chat’s «Image» mode is locked with that reason: the panel does not guess the address from the base one, because a compatible server may have no such endpoint at all, and a guessed address would answer 404 instead of an honest refusal.',
    token: 'Endpoint token',
    tokenPlaceholder: 'paste the token (a local model usually needs none)',
    tokenHint:
      'Stored encrypted in the panel and never returned — only a mask is shown here. Used for the connection check and by the panel assistant.',
    tokenClear: 'Forget token',
    writeToken: "Write the token into the CLI's configuration",
    writeTokenHint:
      "WARNING: with this on, the token lands in the CLI's config file in plain text. By default only the address and the model — non-secret values — are written into someone else's config.",
    probe: 'Check connection',
    probeOk: 'Connected. Models on the address: {{count}}',
    probeFailed: 'Could not reach the address.',
    probeBadgeOk: 'connected, models: {{count}}',
    probeBadgeFailed: 'no connection',
    assistant: 'Panel assistant',
    assistantOff: 'vendor cloud (as before)',
    assistantHint:
      "Where the panel's own assistant (form hints) goes. With a profile selected it uses that address, bypassing both the cloud and the provider CLI.",
    targets: 'Apply to',
    targetReady: 'accepts',
    targetSkipped: 'does not accept',
    apply: 'Apply',
    applied: 'Written to {{path}}',
    applyFailed: 'Could not write.',
    planEmpty: '(empty)',
    planSecret: 'mask; the full value goes into the file',
    reason: {
      no_env_section: 'This CLI has no environment file of its own — there is nowhere to write.',
      no_documented_base_url:
        'This CLI documents no environment variable for the model address: it is set only in its own config file, by hand.',
      api_kind_mismatch:
        'This CLI speaks a different API kind. Create a profile with a matching kind — or apply this one to the CLIs that accept it.',
    },
  },
  platform: {
    title: 'Contour',
    subtitle:
      'A corporate platform behind one key: its models, embeddings and agents, from the panel',
    explainTitle: 'What this section does and what it does not',
    explainText:
      'A contour is somebody else’s platform the panel talks to with a corporate key. The key stays in the panel: CLIs are pointed at its local gateway, never at the contour itself. What the section does NOT do: it changes nothing on the contour side, it never redirects an address you did not tick, and it promises no capability it has not probed. Everything the platform does differently from what a client expects is signed here as a compromise, not hidden.',
    emptyTitle: 'No contour connected',
    emptyText:
      'Connect your corporate platform and the panel will run on its models with a single key: the list arrives already narrowed to what the key may use, and the key itself stays here — it reaches no CLI config. The wizard asks for the address and the key, goes to the contour and shows what it actually offers.',
    connect: 'Connect a contour',
    check: 'Check',
    checkAgain: 'Check again',
    configure: 'Configure',
    disableAll: 'Undo the apply',
    activate: 'Make it active',
    activateNoToken: 'Save the contour key first: there is nothing to ask with',
    activeBadge: 'active',
    deactivate: 'Back to the default provider',
    activatedOk: 'Contour “{{title}}” is active: the model answered',
    activatedSmokeFailed: 'The contour is active, but the test request failed: {{detail}}',
    activateFailed: 'Activation failed: the panel wrote no change at all',
    smokeOk: 'Test request went through: “{{answer}}” in {{seconds}} s, model {{model}}',
    smokeFailed: 'The test request through the gateway did not go through',
    smokeAt: 'asked {{when}}',
    migratedTitle: 'The contour “{{title}}” is now the active one',
    migratedText:
      'Several contours used to be on while the work went through one of them — and which one could only be told from the CLI files. Exactly one is active now. The rest stayed configured, with their keys and budgets; only their switches went off: {{others}}. Any of them can be made active from its own card.',
    migratedDismiss: 'Got it',
    deleteTitle: 'Delete the contour?',
    deleteText:
      'The settings, the key and the probe record go together. The apply is undone first: CLI files return to their original state and the managed profile disappears. A file where you changed the values the panel wrote is left as it is — the panel names it.',
    state: {
      disabled: 'not active',
      unchecked: 'never checked',
      ok: 'online',
      unauthorized: 'key rejected',
      unreachable: 'not responding',
      'no-key': 'no key entered',
    },
    driverLabel: 'Contour type',
    driver: {
      enterprise-platform: 'EnterprisePlatform',
      'openai-compat': 'OpenAI-compatible',
      litellm: 'LiteLLM',
      vllm: 'vLLM',
      ollama: 'Ollama',
      openrouter: 'OpenRouter',
      'azure-openai': 'Azure OpenAI',
      dashscope: 'DashScope (Qwen)',
      together: 'Together AI',
    },
    driverHint: {
      enterprise-platform:
        'The panel knows this platform up front: content checks, knowledge through the key owner, history summarised on its side.',
      'openai-compat':
        'Any compatible gateway. The panel asks for the model list only — everything else honestly stays “not declared”. Your CLI’s tools go to it as a request field, so the tool shim starts off.',
      litellm:
        'LiteLLM proxy. The Anthropic client goes to its native /v1/messages, the OpenAI client to /v1/chat/completions. The address is the proxy root; the panel appends /v1 itself.',
      vllm: 'vLLM server. The Anthropic client goes to the native /v1/messages; thinking is switched with the chat_template_kwargs.enable_thinking field. vLLM accepts tools as a request field only when started with --enable-auto-tool-choice and --tool-call-parser — otherwise turn the tool shim on.',
      ollama:
        'Ollama. The Anthropic client goes to its native /v1/messages, the OpenAI client to /v1/chat/completions. Only models trained for tool calls accept tools as a field; turn the shim on for the rest.',
      openrouter:
        'OpenRouter. The Anthropic client goes to the native /v1/messages, the OpenAI client to /chat/completions. The key comes from your OpenRouter account.',
      'azure-openai':
        'Azure OpenAI, API v1: the address ends with /openai/v1 and the key travels in the api-key header — the preset sets it. The preset declares no native Anthropic endpoint: the Anthropic client goes through the bridge.',
      dashscope:
        'Alibaba Model Studio in OpenAI-compatible mode. Qwen thinking is switched with the enable_thinking field. The preset declares no native Anthropic endpoint: the Anthropic client goes through the bridge.',
      together:
        'Together AI: model list and chat on the OpenAI schema. The preset declares no image endpoint — it returns bytes in a shape other than the one the panel asks for.',
    },
    manifest: {
      summary: 'What the gateway can do: endpoints, thinking, tools',
      intro:
        'The preset already declares what was checked against the gateway docs. Change it only when your gateway differs: no endpoint, another path, its own thinking field.',
      source: 'Checked against: {{source}}',
      notDeclared: 'not declared',
      asPreset: 'As the preset: {{value}}',
      custom: 'Own value',
      none: 'Do not declare',
      customValue: '{{field}} — value',
      anthropicLabel: 'Native Anthropic endpoint',
      anthropicHint:
        'Path after the version, e.g. messages. Without it the Anthropic client goes through the bridge to /chat/completions.',
      imagesLabel: 'Image endpoint',
      imagesHint:
        'Path after the version on the OpenAI schema, e.g. images/generations. The panel asks for bytes as b64_json.',
      imagesInChat: 'image inside the chat answer',
      thinkingLabel: 'Thinking field',
      thinkingHint:
        'Field name in the request body, nested with dots: enable_thinking, chat_template_kwargs.enable_thinking. Without a field the contour has no thinking rule.',
      pathError: 'Path of lowercase latin, digits, “/”, “_” and “-”: messages, images/generations',
      wireError: 'Field name of latin, digits and “_”, nested with dots',
      toolsLabel: 'CLI tools',
      tools: { native: 'as a request field', shim: 'through the shim' },
      toolsHint:
        'As a field — the gateway accepts tools itself. Through the shim — the gateway drops the tools field and calls travel as text.',
      effortLabel: 'Reasoning effort',
      effort: { on: 'sent', off: 'not sent' },
      effortHint: 'Not sent — the panel omits reasoning_effort and says so in the chat header.',
      timeoutLabel: 'Whole-answer limit, seconds',
      timeoutHint:
        'How long the gateway waits before cutting a non-streamed answer itself. Empty — as the preset ({{value}}), 0 — not declared, the panel ceiling applies.',
      timeoutNone: 'not declared',
      timeoutError: 'Whole seconds from 0 to 3600',
      ceilingLabel: 'Ceiling for any answer, seconds',
      ceilingHint:
        'How long before the gateway or a proxy in front of it cuts the connection, streamed answers included. The panel names a declared ceiling when the cut happens. Empty — as the preset ({{value}}), 0 — not declared.',
    },
    titleLabel: 'Name',
    titlePlaceholder: 'EnterprisePlatform · dev',
    idLabel: 'Identifier',
    idHint:
      'The local gateway address is built from it, so latin letters, digits, dash, dot and underscore only. Renaming = delete and create: the key is stored under the old identifier.',
    baseUrlLabel: 'API address',
    baseUrlHint:
      'The root of the contour public API — the panel appends /v1 itself when the path has no version. An admin console address will not do: the check names that, but half an hour is already gone.',
    transport: {
      summary: 'Non-standard gateway: key, version, parameters',
      intro:
        'Needed when the gateway expects the key somewhere other than Authorization: Bearer, or an address without /v1 — Azure OpenAI, a company gateway. For EnterprisePlatform and a plain compatible gateway leave it as is.',
      versionLabel: 'Version in the address',
      version: {
        auto: 'Append /v1 when the path has no version',
        'as-is': 'Address as is — leave the path alone',
      },
      authHeaderLabel: 'Key header',
      authHeaderHint: 'Empty — Authorization. For Azure OpenAI — api-key.',
      authSchemeLabel: 'Word before the key',
      authSchemeHint: 'Only with a custom header. Empty — the key goes bare, as api-key expects.',
      queryLabel: 'Query parameters',
      queryHint: 'Sent with every request: api-version=2024-10-21. The key does not go here.',
      headersLabel: 'Extra headers',
      headersHint:
        'One per line, “Name: value”. Not for the key: it is stored encrypted and travels in its own field.',
      preview: 'The panel will ask for the model list at:',
      previewNone: 'the address is built once “API address” holds an http(s) address',
      error: {
        token: '“{{subject}}” is not a header name: latin letters, digits and dash only',
        line: 'Line {{subject}} is not “Name: value”',
        secret: '“{{subject}}” is where a key travels; the key is entered on the next step',
        reserved: '“{{subject}}” is set by the panel itself',
      },
    },
    error: {
      title_required: 'Without a name one contour cannot be told from the next',
      id_required: 'The identifier is required: the gateway address is built from it',
      id_pattern: 'Latin letters, digits, dash, dot and underscore only',
      baseUrl_required: 'Nothing to check without an address',
      baseUrl_url: 'A full address with an http or https scheme is required',
      budgetSince_pattern: 'A date as YYYY-MM-DD, for example 2026-09-01',
      budgetUsd_number: 'The budget is a number, for example 100 or 10.5',
    },
    checkConnection: 'Check the connection',
    checkSavesDraft:
      'Checking saves the draft: the panel server goes to the contour, not the browser. The contour stays off until the last step.',
    outcome: {
      ok: 'responds',
      unreachable: 'not responding',
      'not-api': 'answers, but not a model API',
      unauthorized: 'key rejected',
      'not-ready': 'contour is not answering right now',
      'no-key': 'the address is right, a key is needed',
    },
    fix: {
      ok: 'The contour responds — nothing to fix.',
      unreachable: 'Check the address, the network and access to the contour from here.',
      'not-api':
        'Looks like an admin console or a login page. The API root is needed — usually the same domain with an api. prefix.',
      unauthorized:
        'There are five causes and the contour tells none of them apart. Probe again — the last one is transient. If that does not help, check the key’s term, budget and owner in the admin console.',
      'not-ready':
        'The contour is alive but will not answer right now: it is starting, hit the key’s rate limit or failed on its side — the cause is in the line above. Probe again a little later.',
      'no-key':
        'The address is a model API, and it refused only because no key was sent. Save the key (“Configure” → the “Key” step) and probe again.',
    },
    tokenLabel: 'Contour key',
    tokenPlaceholder: 'sk-…',
    tokenHint:
      'A saved key is never shown — not here, not in any panel response. Leave the field empty to keep the saved one.',
    tokenStays:
      'The key stays in the panel: CLIs go to its local gateway, and the gateway substitutes the key.',
    tokenSaved: 'key {{masked}}',
    tokenMissing: 'no key saved',
    tokenHowTitle: 'Where to get the key',
    tokenHowAdmin:
      'Everything happens in the contour admin console, usually https://inst.<your-domain>.',
    tokenHowStep: {
      1: 'The model provider is registered and active.',
      2: 'The model is created and answers in the platform chat.',
      3: 'The key has an owner — without one company knowledge is out of its reach.',
      4: 'The key is created, budget and limits are set, the value is copied.',
    },
    tokenHowOwner:
      'The owner is not a formality: knowledge tools act on their behalf, and a key without an owner finds nothing.',
    capabilitiesTitle: 'What is available',
    capabilityColumn: 'Capability',
    stateColumn: 'State',
    detailColumn: 'Details',
    capability: {
      models: 'Models',
      chat: 'Chat models',
      embeddings: 'Embeddings',
      agents: 'Platform agents',
      guardrails: 'Content checks',
      knowledge: 'Company knowledge',
      'client-tools': 'Client tools',
      'image-generation': 'Image generation',
    },
    capabilityState: {
      yes: 'yes',
      no: 'no',
      indirect: 'indirectly',
      unknown: 'not declared',
    },
    capabilityCount: '{{count}}',
    evidence: { answer: 'confirmed by the probe', platform: 'property of the platform' },
    modelsTitle: 'Models for this key: {{count}}',
    notCheckedTitle: 'The contour has not been checked yet',
    notCheckedText:
      'The panel claims nothing about a contour it has not visited. Press “Check the connection” — the matrix fills with your contour’s answer to your key.',
    checkedAt: 'checked {{when}}',
    lastOkAt: 'last successful check — {{when}}',
    justNow: 'just now',
    minutesAgo: '{{count}} min ago',
    hoursAgo: '{{count}} h ago',
    consumersTitle: 'Where the contour works',
    consumersHint:
      'A run gets the gateway address in the environment of ITS OWN process, so “chat through the contour, tests on your own key” is a choice rather than a wish. Clearing a box takes effect from the next launch; running work is left alone.',
    consumersFilesStay:
      'CLI files stay applied: clearing the box does not touch them. To restore the files, press “Undo apply” on the contour card.',
    consumer: {
      chat: 'Chat',
      groups: 'Split groups',
      tests: 'Test agent',
      assistant: 'Panel assistant',
      terminal: 'Terminal (CLI files)',
    },
    consumerScope: {
      run: 'for one run',
      profile: 'through the panel profile',
      files: 'written into the CLI configuration — a run started outside the panel gets it too',
    },
    consumerReason: {
      no_env_section: 'this CLI has no environment file at all',
      no_documented_base_url: 'no documented address variable',
      gateway_dialect: 'speaks a dialect the gateway does not understand',
      file_only: 'globally only: this CLI keeps the address in its file, one per machine',
    },
    consumerTerminalHint:
      'This is the old applying to CLI files. Cleared by default: a write into the shared config also reaches a run the panel knows nothing about.',
    consumerFileWins:
      'This CLI has its files applied, and the file wins: it reads the contour address from its own configuration on every launch, so clearing this box will not bring its runs back. “Undo apply” on the contour card will.',
    targetsTitle: 'Where to apply',
    targetRecommended: 'recommended',
    targetReason: {
      no_env_section: 'this CLI has no environment file at all',
      no_documented_base_url: 'no documented address variable',
      gateway_dialect: 'speaks a dialect the gateway does not understand',
      gateway_down: 'the gateway is down or the contour is not active',
    },
    targetApplied: 'applied',
    targetAppliedTools: {
      native: 'applied, tools go as a field',
      shim: 'applied, tools go through the shim',
      none: 'applied, works as a chat without tools',
    },
    targetNotApplied: 'not applied',
    appliedTitle: 'Applied to',
    appliedLegend:
      '✔ — works fully, ⚠ — tools through the shim or none at all (the mark beside it says which), ○ — can be applied, — unavailable with a reason.',
    planPlaceholder: 'placeholder, the gateway substitutes the key',
    conflictLine: 'taken: {{key}} = {{current}}',
    overwriteLabel: 'overwrite this value',
    skippedTitle: 'Not every target was written',
    skipReason: {
      conflict: 'the place is taken, overwriting was not confirmed',
      consumer_off: 'the consumer is not ticked — you did not ask for a write into files',
      no_env_section: 'this CLI has no environment file at all',
      no_documented_base_url: 'no documented address variable',
      gateway_dialect: 'speaks a dialect the gateway does not understand',
      gateway_down: 'the gateway is down or the contour is not active',
    },
    gatewayUp: 'gateway is up: {{address}}',
    gatewayPortTaken: 'port {{requested}} was busy — the one it got is what gets written',
    gatewayDown: 'the gateway is down — there is nothing to apply to a CLI yet',
    gatewayStart: 'Start the gateway',
    gatewayStarted: 'Gateway is up: {{address}}',
    gatewayDownCard: 'The panel gateway is down',
    gatewayDownCardHint:
      'Chat and CLIs reach the contour only through the gateway. While it is down a required contour refuses to start a run, and a best-effort one lets the work bypass the contour.',
    modeLabel: 'If the contour does not respond',
    mode: { required: 'required', 'best-effort': 'best effort' },
    modeHint: {
      required:
        'Do not work: a contour failure is a failure, there is no silent fallback to the vendor cloud.',
      'best-effort': 'Warn and leave the decision to you.',
    },
    modeRequiredWarning:
      'With the panel off the gateway is closed, and a CLI pointed at it is left without a model: it gets a connection refusal instead of quietly going to the cloud.',
    budgetLabel: 'Key budget, $',
    budgetHint: 'Type the number from the admin console. Zero — do not track.',
    budgetManual: 'The contour exposes no route for the remainder — the number is typed by hand.',
    budgetSinceLabel: 'Budget period from',
    budgetSinceHint:
      'The day the contour starts counting the budget anew (YYYY-MM-DD). Empty — from the start of our records: when the contour resets its own counter is not visible from outside.',
    budgetLine: 'spend ≈ {{spent}} of {{budget}} $',
    spentLine: 'spend ≈ {{spent}} $ — no budget set',
    spendSince: 'period from {{since}}, by our price book — an estimate',
    spendSinceStart: 'from the start of our records, by our price book — an estimate',
    moneyUnpriced: 'left out of the estimate, no price for: {{models}}',
    budgetOverEstimate: 'our estimate has reached the budget',
    budgetNearLimit: 'by our estimate {{percent}} % of the budget is spent',
    budgetMeterLabel: 'Budget spent',
    budgetMeterValue: '≈ {{spent}} of {{budget}} $ — {{percent}} %',
    budgetExhausted: 'the contour refused on a spend limit {{when}}',
    budgetExhaustedLevel: 'the contour refused on the «{{level}}» limit {{when}}',
    budgetExhaustedKey: 'the contour refused {{when}}: the key budget is exhausted',
    budgetExhaustedRecently: 'just now',
    budgetExhaustedClear: 'Clear the mark',
    budgetExceeded: 'budget exhausted',
    journalTitle: 'Apply journal ({{total}})',
    journalEntry: '{{title}} written',
    journalDrifted:
      'the written values changed after the apply — the rollback will not touch the file',
    journalHistoryHint:
      'The file edits themselves live in the History section, together with the copies taken before the edit.',
    rollbackOne: 'Undo',
    wizardTitle: 'Connect a contour',
    wizardEditTitle: 'Contour settings',
    wizardHint: 'Address and key, a probe of capabilities, the choice of consumers — four steps.',
    wizardStep: {
      address: 'Address',
      token: 'Key',
      capabilities: 'What is available',
      targets: 'Where to apply',
    },
    wizardFinish: 'Done',
    next: 'Next',
    back: 'Back',
    factsTitle: 'What is already decided',
    factKey:
      'The contour key stays in the panel: CLIs go to its local gateway, never to the contour itself',
    factTools:
      'Client tools cannot be declared to enterprise-platform as a field: the panel declares them to the model as protocol text and reassembles the call out of the answer — an agent through a contour does edit files. A compatible gateway gets them as a field, as the vendor does',
    factCli:
      'Not every CLI takes a gateway address: four of the ten document no such setting, and the list shows them as a dash with its reason',
    violationsTitle: 'Contour content checks',
    violationsOwner:
      'The checks belong to the company and run on the contour’s side, in the request path: ' +
      'the panel neither calls them, nor configures them, nor can switch them off — what they ' +
      'are and how strict they are is set in the platform’s admin console. All you see here is ' +
      'what they did. Local data-protection rules are a separate thing: those run in the panel, ' +
      'BEFORE anything is sent.',
    violationsRow_one: '{{count}} time, last {{date}}',
    violationsRow_few: '{{count}} times, last {{date}}',
    violationsRow_many: '{{count}} times, last {{date}}',
    violationsRow_other: '{{count}} times, last {{date}}',
    violationsAction: {
      blocked: 'request refused',
      interrupted: 'answer cut short',
      masked: 'data masked',
      unknown: 'the contour did not say what happened',
    },
    violationsEmpty: {
      idle: 'No request has gone through the gateway yet — the panel knows nothing about the checks so far.',
      clean: 'No check has fired on any request the gateway still remembers.',
    },
    violationsUnnamed: {
      blocked_one: 'The contour refused {{count}} request without naming a single check.',
      blocked_few: 'The contour refused {{count}} requests without naming a single check.',
      blocked_many: 'The contour refused {{count}} requests without naming a single check.',
      blocked_other: 'The contour refused {{count}} requests without naming a single check.',
      interrupted_one: '{{count}} answer was cut short by a check the contour did not name.',
      interrupted_few: '{{count}} answers were cut short by checks the contour did not name.',
      interrupted_many: '{{count}} answers were cut short by checks the contour did not name.',
      interrupted_other: '{{count}} answers were cut short by checks the contour did not name.',
      masked_one:
        'In {{count}} answer the contour masked data without naming a check: the model saw something other than what you sent.',
      masked_few:
        'In {{count}} answers the contour masked data without naming a check: the model saw something other than what you sent.',
      masked_many:
        'In {{count}} answers the contour masked data without naming a check: the model saw something other than what you sent.',
      masked_other:
        'In {{count}} answers the contour masked data without naming a check: the model saw something other than what you sent.',
    },
    violationsSince:
      'Counted over the last requests the gateway still remembers, starting {{date}}: the trace is ' +
      'length-capped, and restarting the panel clears it entirely.',
    toolShimTitle: 'Tools through the contour',
    toolShimText:
      'The shim declares tools to the model as protocol text and reassembles the call from its ' +
      'answer — there is no other way on enterprise-platform, and on a compatible gateway you turn it on ' +
      'yourself. The model is free to ignore it: then it describes the action in words, the ' +
      'turn ends successfully, and no file appears.',
    toolShimEmpty: {
      idle: 'No request with tools has gone through the gateway yet — the panel knows nothing about the shim so far.',
      quiet:
        'Requests with tools did go through, but the model made no call and claimed no action in words.',
    },
    toolShimTurns: 'turns with tools: {{turns}}',
    toolShimCalls: '{{calls}} calls across {{requests}} requests with tools',
    toolShimClaimed_one:
      'In {{count}} turn the model described an action and called nothing: the answer looks fine, the work is missing.',
    toolShimClaimed_few:
      'In {{count}} turns the model described an action and called nothing: the answers look fine, the work is missing.',
    toolShimClaimed_many:
      'In {{count}} turns the model described an action and called nothing: the answers look fine, the work is missing.',
    toolShimClaimed_other:
      'In {{count}} turns the model described an action and called nothing: the answers look fine, the work is missing.',
    toolShimFlaw_one: '{{count}} time',
    toolShimFlaw_few: '{{count}} times',
    toolShimFlaw_many: '{{count}} times',
    toolShimFlaw_other: '{{count}} times',
    toolShimSince:
      'Counted over the requests with tools the gateway still remembers, starting {{date}}: the ' +
      'trace is length-capped, and restarting the panel clears it entirely.',
    modelTitle: 'Contour model · {{title}}',
    modelText:
      'What the contour answers with, and for whom. The default model goes into the CLI configs ' +
      'and into the assistant’s profile; a per-consumer override matters where one key serves ' +
      'both your conversation and the test agent. The name map translates the names the panel ' +
      'uses for models into the ones the contour understands — without it a run that picked its ' +
      'own model is refused with “model not found”.',
    planModel: 'The configs will carry the {{model}} model.',
    planModelNone:
      'The configs will carry no model: the contour assigned none, so the CLI goes with its own.',
    modelDefault: 'Default model',
    modelFromCatalog: 'First from the catalog: {{model}}',
    modelNoCatalog: 'No model yet',
    modelMissing: '{{model}} — chosen by you, the contour does not serve it right now',
    modelSource: {
      default: 'Chosen by you — this is what goes into the CLI configs.',
      catalog: 'You did not choose: the panel takes the first suitable model from the catalog.',
      none: 'No model: the CLI goes with its own name, which the contour does not know.',
    },
    modelNeedsProbe:
      'The catalog is empty — check the contour, and there will be something to pick.',
    modelConsumers: 'Model per consumer',
    modelInherit: 'Same as the contour',
    modelMapTitle: 'Name map',
    modelMapText:
      'A run you picked a model for — in the chat header or in a group — leaves with that name, ' +
      'and the contour does not know it. Here you say what “sonnet” means for you. A name with ' +
      'no row in the map is replaced by the contour’s model, and the chat header says so.',
    modelMapRow: '{{from}} → {{to}}',
    modelMapRowMissing: '{{from}} → {{to}} — this model is no longer in the contour’s catalog',
    modelMapRemove: 'Remove',
    modelMapFrom: 'Name in the panel',
    modelMapTo: 'Contour model',
    modelMapPick: 'Pick a model',
    modelMapAdd: 'Add',
    modelEffortOk:
      'The contour accepts reasoning effort: the one picked in the chat travels with the request.',
    modelEffortNo:
      'The contour does not accept reasoning effort: the run goes without it, whatever you pick ' +
      'in the chat header. The panel will not pay for depth that will not happen.',
    rulesTitle: 'Contour rules · {{title}}',
    rulesText:
      'What the contour does to a request on the way. The upper list is the panel’s to set — ' +
      'request fields the contour accepts. The lower one is visible but not managed here: the ' +
      'contour’s owner turns it on at their end.',
    rulesEmpty:
      'This contour declared no rules. That is “unknown”, not “does nothing”: a compatible ' +
      'gateway tells only its list of models about itself.',
    rulesManaged: 'Managed by the panel',
    rulesObserved: 'What the contour does itself',
    rulesOurs: 'Our side',
    rulesShim: 'The panel’s tool shim',
    rulesShimText:
      'The agent’s tools travel to the contour as protocol text, and the panel reassembles the ' +
      'call out of the answer. Turn it off and an agent through the contour only answers — but ' +
      'then the contour’s own tools can be asked for.',
    rulesShimBlocked:
      'The contour has its own tools set — the shim cannot be turned on: two sets on one turn. ' +
      'Clear that list above first.',
    rulesApply: 'Save',
    rulesToolsPlaceholder: 'e.g. web_search',
    rulesToolsBlocked:
      'While the tool shim is on, the contour’s own tool set cannot be added: two sets on one ' +
      'turn are mutually exclusive. Turn the shim off below, under “Our side”.',
    rulesModeIdle: 'With no contour tool names set, the loop mode is not sent anywhere.',
    rulesPresetPlaceholder: 'balanced',
    rulesToolMode: {
      loop: 'loop — the contour runs the cycle itself',
      single_turn: 'single_turn — the call comes back to the client',
    },
    rulesThinkingMode: {
      default: 'Default — not sent, the model decides',
      on: 'Turn on',
      off: 'Turn off',
    },
    rulesConflicts: 'Conflict matrix',
    rulesLevel: {
      exclusive: 'Mutually exclusive',
      warning: 'Warning',
      info: 'For information',
    },
    rulesConflictActive: 'both sides are on right now',
    rulesConflictOurs: 'our side is on; the contour’s side shows only when it fires',
    rulesBlocked:
      'Both sides of a mutual exclusion are on: {{detail}} The run goes with the contour’s tools ' +
      'and the shim stays silent. Pick a side — the panel will not switch the other off for you.',
    rulesFixShim: 'Turn our shim off',
    rulesFixTools: 'Clear the contour’s tools',
    rulesUnsupported:
      'The panel does not manage this rule yet. The contour currently has: {{value}}',
    rulesSaveFailed: 'The rules could not be saved.',
    layersTitle: 'Our layers in the run',
    layersText:
      'What travels from your personal setup into a run through this contour. Dropping a layer ' +
      'saves prompt budget and removes extra tools, but the agent loses your rules and the answer ' +
      'will not show it. Two flags hit wider than `~/.claude`: skills and MCP servers are dropped ' +
      'TOGETHER with the project’s own — said at the switches themselves, and that is the price of ' +
      'the CLI having one flag for both sources. Layers are dropped by Claude Code flags: a ' +
      'foreign CLI run through the contour goes with its own set, and these switches do not touch it.',
    layersAll: 'Our rules travel into the run',
    layersAllText:
      'Turn it off and a run through this contour goes without anything of ours at once, whatever ' +
      'the switches below say.',
    layersAllOff:
      'The master switch is off: not one of our layers travels through this contour, and the ' +
      'switches below decide nothing. Turn it on to choose layer by layer.',
    layerTitle: {
      settings: 'Personal rules, hooks and permissions',
      skills: 'Skills',
      mcp: 'MCP servers',
      systemPrompt: "The panel's addition to the system prompt",
    },
    layerText: {
      settings:
        'Everything from `~/.claude`: CLAUDE.md rules, hooks, permissions, personal skills and ' +
        'personal MCP servers — the panel’s bridge to the contour’s own tools included, it lives ' +
        'there too. The CLI knows one `user` source and drops it whole — with ' +
        '`--setting-sources project,local`. Along with the permissions your `deny` rules stop ' +
        'applying too — the fence you put around the agent. The project CLAUDE.md and repository ' +
        'settings this flag does not touch: those are the rules of the task, not ours.',
      skills:
        'Skills and the `Skill` tool itself — with `--disable-slash-commands`. A separate switch ' +
        'for a reason: built-in skills go away only this way. ALL skills are dropped, the ' +
        'repository’s own (`.claude/skills`) included: the CLI has no flag for just the personal ones.',
      mcp:
        'MCP servers — with `--strict-mcp-config`, and ALL of them: personal, the project’s own ' +
        'from the repository’s `.mcp.json`, and the panel’s bridge to the contour’s own tools. ' +
        'Only the panel’s permission broker stays: without it every permission request would ' +
        'become a silent refusal in the middle of the agent’s work.',
      systemPrompt:
        'What the panel adds of its own: initiatives, task splitting, session continuation. The ' +
        'panel drops it itself — the CLI has no flag for that, which is why it is absent from the ' +
        'flag list.',
    },
    layersFlags: 'The run will carry the flags: {{args}}',
    layersFlagsNone: 'No flags — everything of ours travels into the run.',
    layersPromptOff: 'The panel’s addition is dropped by the panel itself, it has no flag.',
    layersNoRun:
      'Nobody receives them yet: this contour’s route has neither chat, nor split groups, nor the ' +
      'tests agent ticked. The terminal edits configuration files, the assistant travels by the ' +
      'endpoint profile, a foreign CLI runs its own set — layers are dropped by a Claude run only.',
    layersNotes:
      'Three neighbouring settings are deliberately absent here. The prompt gate is physically our ' +
      'hook in `~/.claude/settings.json`: it leaves together with the personal settings and has no ' +
      'switch of its own. Data protection is not a layer at all: it is not traded for prompt ' +
      'budget. The model cascade is switched on per project, not per contour.',
    agentsTitle: 'Contour agents',
    agentsOwner:
      'Agents are built by the company: each has its own knowledge and tools, and they run on ' +
      'the contour’s side. The panel only calls them — an agent can be neither assembled nor ' +
      'configured from here. The list is yours to keep: the key has no “list the agents” route.',
    agentsEmpty:
      'No agent added yet. Take the agent id from the platform’s admin console — it is the UUID ' +
      'on the agent’s card.',
    agentsRemove: 'Remove agent “{{title}}” from the list',
    agentsNewTitle: 'Name',
    agentsNewId: 'Agent id',
    agentsNewIdHint: 'UUID from the platform’s admin console',
    agentsAdd: 'Add',
    agentsPick: 'Agent',
    agentsQuestion: 'Question',
    agentsAsk: 'Ask',
    agentsAsking: 'The agent is thinking…',
    agentsBlocked: {
      disabled: 'The contour is not active — make it active in the card above.',
      'no-token': 'No key saved: run the connection wizard.',
      'no-agent': 'Pick an agent.',
      'no-question': 'Type a question.',
    },
    agentsOutcome: {
      ok: 'Answered',
      unavailable: 'Agents are not in the licence',
      unauthorized: 'Key rejected',
      rejected: 'Request not accepted',
      'agent-error': 'The agent ended with an error',
      'not-ready': 'The contour did not answer',
      failed: 'Never reached the contour',
    },
    agentsSessionGap:
      'The answer is real, but this turn did not make it into the session: the agent will read the next question without it.',
    agentsSession: 'Session {{id}}',
    agentsSessionReset: 'Reset the session',
    agentsSessionKept_one: 'The contour remembers {{count}} message of this conversation',
    agentsSessionKept_few: 'The contour remembers {{count}} messages of this conversation',
    agentsSessionKept_many: 'The contour remembers {{count}} messages of this conversation',
    agentsSessionKept_other: 'The contour remembers {{count}} messages of this conversation',
    agentsCut:
      'The agent did not finish (the contour named the reason: {{reason}}) — this is a fragment, not the whole answer.',
    agentsSessionUnread:
      'The session could not be read — what the contour remembers is unknown right now.',
    agentsBridgeBlocked: 'Nowhere to write the bridge: {{reason}}',
    agentsSessionEmpty: 'The contour remembers no conversation for this session yet.',
    agentsBridgeTitle: 'The MCP bridge',
    agentsBridgeText:
      'The same agents, knowledge and models of the contour — as tools for a local agent. Only the ' +
      'panel’s address goes into the CLI config; the contour key stays here. One record covers ' +
      'every contour: the call itself picks which one.',
    agentsBridgeOn: 'Switch the bridge on',
    agentsBridgeOff: 'Switch the bridge off',
    compromisesTitle: 'Compromises ({{total}})',
    compromisesText:
      'Every workaround and every limitation of the other platform is signed up front, with a condition for revisiting it. A workaround without a signature fails the build — that is how the list stays in step with the code.',
  },
  compromise: {
    markLabel: 'Compromise signature: {{name}} · {{severity}}',
    headline: '{{severity}} · since {{date}}',
    severity: {
      limitation: 'Limitation',
      workaround: 'Workaround',
      risk: 'With risk',
    },
    how: 'How it works',
    why: 'Why it is like this',
    revisit: 'When to revisit',
    more: 'More',
    planned: 'not in the code yet',
    hiddenGroup: 'Without a place of their own on screen',
    hiddenGroupText:
      'These workarounds live in the wiring — there is nothing next to them to mark. They are named in full here: not one of them may disappear quietly.',
    items: {
      'no-client-tools': {
        name: 'Client tools cannot be declared',
        how: 'Applies to a contour whose type does not accept client tools as a field — that is enterprise-platform; a compatible gateway gets them as a field. EnterprisePlatform’s public API does not accept tool descriptions: the platform picks the set itself, and a list sent by the client is dropped on the way in. By the field the vendor API declares them with, tools never reach the model.',
        why: 'We do not change the platform. Worked around by the shim: the panel declares the tools to the model as protocol text and reassembles the call from its answer (“Tools are declared to the model as text”), so an agent through a contour does edit files and does see your MCP servers. But it is a protocol on top of someone else’s, and it is weaker than the vendor one; with the shim off the old behaviour stands — a CLI through a contour works as a chat.',
        revisitWhen:
          'If the contour starts accepting the client’s own tool schemas — at least in the mode where the client executes the calls itself.',
      },
      'rules-partial': {
        name: 'Personal rules, hooks and permissions come off together',
        how: 'A run through the contour can start without our layers: personal `~/.claude` rules, skills, MCP servers and the panel’s own system-prompt addition are switched off on the contour card. Personal rules cannot be dropped separately from hooks and permissions: the CLI knows one `user` settings source and removes it whole, with a single `--setting-sources project,local`. Skills and MCP servers have flags of their own and stay separate switches; the project CLAUDE.md always stays.',
        why: 'Measured on the real CLI rather than read off a flag description: the panel asks for exactly what the CLI can execute. Drawing three switches where one is executed would promise separate removal and remove everything anyway — the screen would say «hooks are in place» for a run without a single hook. The prompt gate goes with them for the same reason: physically it is our hook in `~/.claude/settings.json`.',
        revisitWhen:
          'If the CLI learns to tell the sources apart more finely — a separate flag for memory, hooks or permissions; then the switches split and this note is retired.',
      },
      'no-effort': {
        name: 'The contour takes no reasoning effort',
        how: 'The contour’s public API knows no effort field: the panel never adds it, and the value picked in the chat stays with the panel. A field the foreign CLI sends itself travels upstream as it is — the contour strips unknown keys on the way — and the request trace names it as a loss: a setting that quietly fails to reach the model would read as applied.',
        why: 'Sending an effort the contour is known not to read would draw work on screen that does not happen: the human would pick “max”, get an ordinary answer and believe that is how the model thinks. While the field is absent from the schema, sending nothing and saying so where effort is picked is the honest option. The answer itself stays complete — only the depth of reasoning is lost.',
        revisitWhen:
          'If the contour starts accepting an effort field — its own or the vendor one; then the model card sends the picked value and the signature comes off.',
      },
      'dialect-bridge': {
        name: 'Dialect translation lives on our side',
        how: 'Some CLIs speak the Anthropic dialect while the platform speaks the OpenAI one. Where the platform’s driver declares no native Anthropic endpoint, the panel’s gateway rewrites request and response on the fly; where it does, the request goes out as is and no bridge is needed.',
        why: 'Otherwise only CLIs that already speak OpenAI could use a contour. What the translation loses is listed next to the translation itself, not hidden.',
        revisitWhen:
          'If the platform starts accepting requests in the Anthropic dialect: its driver declares the native endpoint, and the bridge switches off for it by itself.',
      },
      'vendor-sse-frames': {
        name: 'Vendor stream frames are parsed by us',
        how: 'The contour’s stream carries frames with no choices field: status, reasoning, sanitizing, guardrail hits, the final usage chunk. A strict OpenAI client breaks on them, so the gateway parses them itself and emits a clean stream.',
        why: 'The stream format is a property of somebody else’s platform: we cannot change it, and we will not break every CLI over it.',
        revisitWhen: 'If the contour starts emitting a stream strictly per the OpenAI schema.',
        hiddenReason:
          'It lives in the gateway pipeline: there is nothing to mark beside it — the human already sees an ordinary answer stream.',
      },
      'status-451-bridge': {
        name: 'A content-check refusal is translated for the client',
        how: 'The contour’s checks run in-band, and a block arrives as HTTP 451 with the list of violations. Clients do not expect that status, so the gateway turns it into a refusal they understand and the panel shows the reason.',
        why: 'The text the check fired on never leaves the contour — only what exactly was violated.',
        revisitWhen: 'If the contour starts refusing checks with a code clients understand.',
      },
      'gateway-required': {
        name: 'With the panel down, CLIs pointed at the gateway stop working',
        how: 'The contour key never leaves the panel, so CLIs go to its local gateway rather than to the contour. Panel off — gateway silent, and such a CLI is left without a model.',
        why: 'The alternative is spreading a corporate key across nine CLI configs, from where it can never be recalled. Depending on a running panel is the cheaper price.',
        revisitWhen: 'If a way appears to issue CLIs a short-lived token instead of the key.',
      },
      'cli-no-endpoint': {
        name: 'Four CLIs have no way to set the model address',
        how: 'Some CLIs document no way to change the model address — neither an environment variable nor a config key. The panel cannot point them at a contour and does not pretend it can.',
        why: 'An invented config key would break silently with their very next release.',
        revisitWhen: 'If such a CLI documents a variable or a key for the model address.',
      },
      'nonstream-120s': {
        name: 'The contour cuts any answer at two minutes',
        how: 'The contour server holds any answer for at most 120 seconds — whole and streamed alike. The panel talks to a contour by streaming so the answer is visible while it comes, and names a cut at that second as the platform ceiling rather than a network break. The exception is a “single_turn” turn: the contour accepts no stream with it, so that turn goes whole and the answer arrives at once.',
        why: 'The limit sits on the platform side and no request shape gets around it: what is left is to name it and shorten the turn.',
        revisitWhen: 'If the contour’s response ceiling grows or becomes a setting.',
        hiddenReason:
          'There is no mark beside it: the limit shows where it happens — the gateway names the ceiling in the very error the CLI displays.',
      },
      'budget-manual': {
        name: 'The key budget is typed in by hand',
        how: 'The contour exposes the remaining budget on no route at all, and rejects an exhausted key with a 401 indistinguishable from a revoked one. The panel counts the remainder itself: you enter the budget you were given, and spend is estimated by our own price book.',
        why: 'Otherwise a human would learn about an exhausted budget from a refusal in the middle of the work — and mistake it for a broken key.',
        revisitWhen:
          'If the contour publishes a key’s remaining budget, or starts telling the causes of a 401 apart — an exhausted key from a revoked one.',
      },
      'pricing-local': {
        name: 'Prices are counted from our own catalog',
        how: 'The contour does not publish model prices — they live in an internal catalog of the platform. The panel counts money from its own price list. A gateway that publishes a price in its model list (OpenRouter) is counted by that price.',
        why: 'An empty space instead of a cost is worse than an honest estimate called an estimate.',
        revisitWhen:
          'If the contour starts returning model prices for a key — in the model list itself.',
      },
      'telemetry-local': {
        name: 'The contour accepts no client telemetry',
        how: 'There is no intake for client telemetry: spend, errors and response times are written by the panel to this machine.',
        why: 'A picture across the whole team will not come out of the panel — it sees this machine only.',
        revisitWhen: 'If the contour gains an intake for telemetry from an external client.',
      },
      'kb-via-owner': {
        name: 'Company knowledge is reachable only through the key owner',
        how: 'The knowledge base is governed by the key owner: the panel neither picks which knowledge joins a request nor sees the list. An answer may lean on it, while control stays in the contour’s admin console.',
        why: 'Headers with which a client would ask for other knowledge are stripped on the way in.',
        revisitWhen: 'If the contour opens knowledge-base search to an ordinary key.',
      },
      'key-cache-lag': {
        name: 'A revoked key keeps working for a while',
        how: 'The contour caches key validation, so a revoked key still answers for some time after the revocation.',
        why: 'The cache lives in the platform: the panel can neither learn its lifetime nor drop it.',
        revisitWhen: 'If the contour publishes the cache lifetime or a way to drop it.',
      },
      'probe-guess': {
        name: 'A compatible gateway declares no capabilities',
        how: 'An arbitrary OpenAI-compatible address can only return a list of models. Everything else the panel shows as “not declared” — not as “no”, and never as a tick.',
        why: 'Guessing capabilities from a host name would mean promising the unverified.',
        revisitWhen: 'If compatible gateways gain a common way to declare capabilities.',
      },
      'agents-manual-roster': {
        name: 'The agent list is kept by hand',
        how: 'The key’s public surface is seven routes, and “list the agents” is not one of them: you can ask an agent, you cannot enumerate them. The human takes the agent id from the platform’s admin console and types it into the panel; the panel remembers it and puts it into the call.',
        why: 'An empty list with no explanation would read as “the panel lost the agents”. A hand-named agent works; an invented listing route would break silently.',
        revisitWhen: 'If the contour publishes a route that enumerates agents for a key.',
      },
      'context-managed': {
        name: 'The contour summarizes a long history itself',
        how: 'History beyond its limit is summarized by the contour in a separate model call. The only outside sign is a frame in the stream; what exactly went into the summary cannot be seen.',
        why: 'The platform owns the summarizing — the panel can only show that it happened.',
        revisitWhen:
          'If the contour starts signalling that history was modified in both modes — including the truncation it falls back to when summarizing fails.',
      },
      'tool-shim': {
        name: 'Tools are declared to the model as text',
        how: 'A contour whose type does not accept a tool list at all (enterprise-platform), or one where you turned the shim on yourself: the panel declares the tools to the model as protocol text and assembles the call back out of its answer: the agent gets a real tool_use block and edits files. A block left unclosed or unreadable never becomes a call — it stays in the answer as text, and the request trace says why.',
        why: 'Without the shim an agent behind a contour “works like a chat”: it says it will write the file and does not. Synthesis from text is the only way to give it hands without turning off the client CLI’s skills, hooks or MCP.',
        revisitWhen: 'If the contour starts accepting client tools in its own schema.',
      },
      'shim-no-cache': {
        name: 'The tool list is paid for on every turn',
        how: 'Tool schemas travel in every request: the contour has no prompt cache. Measured on real runs: 24 tools — 58 thousand characters of system text and 86 KB per request on every turn (`claude -p` through the gateway), 108,546 characters and 154 KB on an interactive run with the full CLI prompt. Same order either way — tens of kilobytes for every step the agent takes; which is why a run through a contour uses the panel’s short prompt by default instead of the CLI’s.',
        why: 'A prompt cache is a vendor API feature and the contour has none; the panel will not trim schemas on the client’s behalf — a trimmed schema breaks the call silently.',
        revisitWhen: 'If the contour gains a prompt cache or accepts tools as a separate field.',
      },
      'media-by-capability': {
        name: 'Images and slides by the declared capability',
        how: 'RASTER is drawn only by whoever declared it: the contour driver plus a flagged model in the key catalog, or a generation address in the endpoint profile. With no such route the «Image» mode stays, but the conversation agent draws it as vector code — said under the field together with the reason there is no raster. The item is locked only where there is no agent conversation either. A presentation goes by the same measure: the agent, the contour or the endpoint dictates it, the panel builds the files from the structure — and draws the slide pictures through that same raster route while it exists.',
        why: 'A capability may not be guessed from a model name: «vision» in a name means reading images, not drawing them, and such a request is refused with a 400 after the human has already described the picture. Taking the mode away where there IS something to draw with would promise less than the panel can do, though: vector code and a slide structure come from any text model, which is why that route works with any CLI and without a contour.',
        revisitWhen:
          'If the contour starts declaring image generation in the model catalog itself — the flag would then come from there rather than from the driver.',
      },
      'mask-unrestorable': {
        name: 'A data-protection label stops the call',
        how: 'The panel’s data protection and the contour’s substitution both replace e-mails, IP addresses and similar values with labels. The panel restores its own labels itself, and the contour turns its own back into values right in the answer stream. A label nobody restored — ours with no record, or one of the contour’s shape that was not in the request while the contour reported a substitution — never reaches the tool: the call stops, and the reason is in the chat and in the request trace (`mask-unrestorable`).',
        why: 'A call carrying a label instead of the value would run silently and leave the label in a project file, to be found some other day. A stopped turn costs less than a forgery in the code.',
        revisitWhen:
          'If the contour lets a request leave the content between tool markers untouched, or starts sending the substitution map to key clients.',
        hiddenReason:
          'This behaviour has no permanent place on screen: the stop happens in one specific call and is named right there — as a chat message and a line of the request trace.',
      },
    },
  },
  dlp: {
    title: 'Data protection',
    subtitle:
      'A local proxy between the CLI and the model: it sees every request body and rewrites it by rules',
    explainTitle: 'What this section does — and what it does not',
    explainText:
      'The proxy listens on 127.0.0.1. Point a CLI at this address instead of the model address and the panel sees the BODY of every request: the prompt, the contents of files the agent read, tool output. Whatever the rules match is replaced by a placeholder ([NAME_1]) and restored in the response — the model works with the placeholder, you read the real name. A "block" rule stops the request entirely. What it does not do: it does not guess anything the rules do not describe; it does not intercept TLS (the hop upstream is ordinary https, no substituted certificates); it cannot help if the model paraphrases a placeholder in its reply — then there is nothing left to substitute back. Three different things: your own endpoint decides WHERE a request goes; this proxy decides WHAT goes in it; the prompt gate sees only what a human typed by hand. A contour’s own checks are a fourth, and somebody else’s: they run on the company’s side, the panel does not govern them, and what they did is shown in the “Contour” section.',
    statusTitle: 'Proxy',
    running: 'running',
    stopped: 'stopped',
    start: 'Start',
    stop: 'Stop',
    startFailed: 'Could not start the proxy.',
    addressHint:
      'Put this address into the CLI as the model address — for example, via a profile on the settings page.',
    counters: 'requests: {{requests}} · masked: {{masked}} · blocked: {{blocked}}',
    port: 'Port',
    portHint:
      'The listener binds 127.0.0.1 only — it is never published outside. Saved on Enter or when the field loses focus.',
    portInvalid: 'The port is an integer between 1024 and 65535.',
    upstreamUrl: 'Forward to',
    upstreamHint:
      'The real model address: the vendor cloud, a local model or a corporate gateway. Empty — taken from the endpoint profile selected below. Saved on Enter or when the field loses focus.',
    upstreamInvalid: 'The address must start with http:// or https://.',
    settingsFailed: 'Could not save the proxy settings.',
    restartFailed: 'Could not restart the proxy with the new settings — it is stopped.',
    restartOnChange:
      'Any settings change restarts a running proxy; placeholder numbering starts over.',
    upstreamProfile: 'Endpoint profile',
    upstreamProfileNone: 'do not use',
    upstreamProfileHint:
      'The proxy and your own endpoint add up: the CLI looks at the proxy, the proxy at your model, and nothing leaves the machine.',
    passUnknown: 'Pass through unparsed bodies',
    passUnknownHint:
      'Off: a request whose body the panel did not parse is refused. A proxy that silently passes what it did not understand is worse than no proxy — it manufactures confidence.',
    journal: 'Keep a journal',
    journalHint: 'Rule, placeholder and count only. The values themselves are never written.',
    noActiveRules: 'No rule is enabled — the proxy will not start until at least one is.',
    emptyTitle: 'No rules yet',
    emptyText:
      'Start with the ready-made set: email, phone, INN, SNILS, card number and secret keys. INN, SNILS and card numbers are checksum-verified — otherwise the rule would catch any number of the right length.',
    addStarter: 'Add the ready-made set',
    addTerms: 'Own dictionary',
    addRegex: 'Own expression',
    addBuiltin: 'Built-in pattern',
    newTermsName: 'Own dictionary',
    newRegexName: 'Own expression',
    defaultLabel: 'DATA',
    ruleName: 'Rule name',
    ruleEnabled: 'Rule "{{name}}" enabled',
    ruleIncomplete: 'incomplete',
    removeRule: 'Delete rule',
    builtin: 'Built-in pattern',
    builtinName: {
      email: 'Email',
      phone_ru: 'Phone',
      inn: 'INN',
      snils: 'SNILS',
      card: 'Card number',
      secret_key: 'Secret keys',
    },
    builtinLabel: {
      email: 'EMAIL',
      phone_ru: 'PHONE',
      inn: 'INN',
      snils: 'SNILS',
      card: 'CARD',
      secret_key: 'KEY',
    },
    builtinHint: {
      email: 'Email addresses.',
      phone_ru: 'Russian numbers: +7, 8, with and without separators.',
      inn: 'Ten and twelve digits, control digits verified by the tax-service coefficients.',
      snils: 'Eleven digits with the remainder-rule check digit.',
      card: 'Thirteen to nineteen digits verified by the Luhn algorithm.',
      secret_key:
        'Keys shaped like sk-…, ghp_…, AKIA…, Slack tokens (xox…) and PEM private-key blocks inside the request text.',
    },
    terms: 'Dictionary',
    termsHint:
      'One value per line: staff names, project names, addresses. Matched case-insensitively and on whole words; Russian inflections are covered ("Петрова" matches "Петров").',
    pattern: 'Regular expression',
    patternHint: 'Validated before saving. No flags needed — the search runs over the whole text.',
    actionLabel: 'Action',
    action: {
      mask: 'replace with a placeholder',
      block: 'refuse the request',
      flag: 'record only',
    },
    actionHint: {
      mask: 'The value is replaced by a placeholder, and the placeholder is restored to the real value in the model reply.',
      block: 'The request goes nowhere: the CLI gets a readable refusal instead of a model answer.',
      flag: 'Nothing changes — the match only lands in the journal. For breaking in a new rule.',
    },
    label: 'Placeholder',
    labelHint: 'The text will show [{{label}}_1], [{{label}}_2] — one number per value.',
    save: 'Save rules',
    saved: 'Rules saved.',
    saveFailed: 'Could not save the rules.',
    discard: 'Discard changes',
    dirtyWhileRunning: 'The proxy runs on the saved rules — your edits apply once saved.',
    previewTitle: 'Check against a sample text',
    previewHint:
      'Shows exactly what the model would see. Computed from the current edits, before saving, and it never touches the network.',
    previewInput: 'Sample text',
    previewPlaceholder: 'For example: call Ivan Petrov at +7 999 123-45-67',
    previewRun: 'Check',
    previewResult: 'The model will see:',
    previewClean: 'nothing found',
    previewMasked: 'replacements: {{count}}',
    previewBlocked: 'the request would be refused',
    previewHit: '{{rule}} → {{placeholder}} ×{{count}}',
    previewFailed: 'Could not run the check.',
    journalTitle: 'Match journal',
    journalClear: 'Clear',
    journalEmpty: 'Empty so far.',
    journalOff: 'The journal is switched off in the settings above.',
    journalError: 'Could not read the journal.',
    decision: {
      passed: 'passed',
      masked: 'masked',
      blocked: 'blocked',
    },
  },
  gate: {
    title: 'Prompt gate',
    installed: 'installed',
    notInstalled: 'not installed',
    scope:
      'The UserPromptSubmit hook checks ONLY what a human typed by hand. Files the agent read, command output and subagent prompts go past it — that is what the proxy above sees. The hook cannot rewrite the prompt: the event does not allow it, so there are two actions — reject or warn.',
    action: 'On a match',
    actionBlock: 'reject the prompt',
    actionWarn: 'warn and send',
    actionHint:
      'A rule whose own action is “reject” stops the prompt regardless — the shared setting never downgrades it.',
    rules: 'Rules are shared with the proxy: {{count}} enabled, {{blocking}} of them blocking.',
    noRules: 'With no rule enabled there is nothing for the gate to check.',
    claudeOnly:
      'The gate is installed into the Claude Code configuration: no other CLI documents a “prompt submitted” event that can refuse. Switch the provider to Claude to enable it.',
    scriptPath: 'Hook script',
    customized:
      'The script differs from the one the panel writes — it looks hand-edited. The panel leaves it alone.',
    reinstall: 'Restore the panel’s script',
    applied: 'Gate installed.',
    removed: 'Gate removed.',
    applyFailed: 'Could not change the gate.',
    loadError: 'Could not read the gate state.',
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
  providerChat: {
    title: '{{provider}} chat',
    you: 'You',
    noneHint:
      'First connect the CLI subscription or a provider API key (see the instructions dialog).',
    mode: {
      cli: 'via CLI (subscription)',
      api: 'via API',
    },
    conversations: 'Conversations',
    new: 'New',
    noConversations: 'No conversations yet.',
    messageCount: '{{count}} messages',
    startHint:
      'Start a conversation — the transcript is kept, and the provider will remember it in the next question.',
    empty: 'Type a message — the reply appears as the provider prints it.',
    placeholder: 'Message the provider…',
    send: 'Send',
    stop: 'Stop',
    thinking: 'The provider is thinking…',
    failed: 'error',
    restart: 'Restart',
    restartTitle: 'Restart the conversation from a clean slate',
    restartDone:
      'Work continues in a new conversation — a foreign CLI has no session, so this is a new conversation with the checkpoint.',
    restartRequested:
      'The checkpoint file is not ready: the agent was asked to write the state down, then the panel continues on its own.',
    restartFailed: 'Failed to restart the conversation: {{message}}',
    rename: 'Rename',
    renamePrompt: 'Conversation title',
    delete: 'Delete',
    deleteTitle: 'Delete the conversation?',
    deleteDescription: 'The transcript is removed from disk with no way back.',
    deleteFailed: 'Failed to delete the conversation.',
    createFailed: 'Failed to create the conversation.',
    workdir: 'Working directory',
    workdirBadge: 'directory: {{path}}',
    modelBadge: 'model: {{model}}',
    workdirHint: 'The directory the provider CLI runs in — it sees the files of that project.',
    attach: 'Attach a file',
    attachHint: 'The file path goes into the message: agent CLIs read files themselves.',
    attached: 'Attached files: {{count}}',
    clearAttachments: 'Clear',
    // How the reply arrived: CLI stream, local server session, or a direct API call.
    transport: {
      stream: 'CLI stream',
      session: 'CLI session',
      api: 'via API',
    },
    timing: {
      step: 'Answer took {{step}}',
      full: 'Answer took {{step}}, {{total}} in this conversation',
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
    checkedAt: 'Checked: {{time}}',
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
    importFailed:
      'Added: {{added}}, failed: {{failed}}. Fix the entries below and retry — the added ones need no change',
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
    envHint:
      'One KEY=VALUE per line. Do not put secrets here — keep them in the Environment section and reference them as ${VAR}',
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
      'The rule is removed from {{file}}. The tool returns to the default behaviour — confirmation on every call.',
    moveToLocal: 'To local (settings.local.json)',
    moveToShared: 'To shared (settings.json)',
    shadowed: 'Not in effect: overridden by “{{decision}}”',
    formShadowed:
      '“{{decision}}” already exists for {{pattern}} — it is stronger, so this rule would have no effect.',
    formDuplicate: 'This rule already exists in this file.',
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
    file: 'File',
    groupBadge: 'group: {{name}}',
    sourceLocked: 'The file follows the record: the variable goes back where it came from.',
    badKey:
      'A variable name is Latin letters, digits and underscores, not starting with a digit: MY_TOKEN, not “my token”.',
    alreadyExists:
      '{{key}} already exists in {{file}} — open it for editing instead of creating a second one.',
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
    projectsTitle: 'Projects',
    projectsHint:
      'The group switches itself on when an agent starts working in this project — branch copies included. It never switches itself off: the config files are shared and several chats may be running at once.',
    projectsEmpty: 'No projects in the panel registry yet — add them in the Projects section.',
    projectsRemove: 'Remove binding',
    projectsBadge: 'projects: {{count}}',
    scenarioTitle: 'Working order',
    scenarioBadge: 'steps: {{count}}',
    scenarioWhen: 'When to apply',
    scenarioWhenPlaceholder: 'for example: a task with a ticket number',
    scenarioWhenHint:
      'This line becomes the skill description — Claude decides by it whether to follow the working order.',
    scenarioTrigger: 'Trigger on the prompt text',
    scenarioTriggerHint:
      'A regular expression. Filled in — the panel adds a hook that brings the working order up itself; empty — Claude picks the skill up by its description.',
    scenarioTriggerError: 'Not a regular expression',
    scenarioSteps: 'Steps',
    scenarioStepTitle: 'What to do',
    scenarioStepBody: 'Details',
    scenarioStepGate: 'Done when',
    scenarioStepGateHint: 'Proof of completion: without it the agent decides on its own.',
    scenarioStepAdd: 'Add step',
    scenarioStepRemove: 'Remove step',
    scenarioHint:
      'Steps compile into a skill (skills/scenario-…): it becomes a member of the group and goes dark with it.',
  },
  credentials: {
    loadError: 'Could not read the access state — the server did not answer.',
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
    tabsLabel: 'Settings sections',
    tab_general: 'General',
    tabHint_general: 'Theme, accent, language, accessibility and the editor project files open in.',
    tab_access: 'Access',
    tabHint_access:
      'The Claude Code account, where the panel takes access from, which configuration directory it reads and who it lets in from outside.',
    tab_providers: 'Providers',
    tabHint_providers:
      'Which CLI the panel manages, whether it is installed, how it authenticates and whether its config formats match the published schemas.',
    tab_models: 'Models',
    tabHint_models:
      'Default model and thinking effort, the model catalog, a custom endpoint and MCP server checks.',
    prompts: {
      title: 'Application prompts',
      description:
        'The texts the panel speaks to the model with, not on your behalf. The built-in text ships with the panel; your edit lives separately and a panel update leaves it alone.',
      empty: 'The prompt catalog is empty',
      open: 'Open',
      reset: 'Reset to built-in',
      edited: 'Edited',
      builtinChanged: 'Built-in updated',
      builtinChangedHint:
        'The panel was updated and this prompt’s built-in text was rewritten — yours stayed as it was. Re-read the built-in one with “Show built-in”: no need to reset for that.',
      builtinNow: 'The built-in text is in use',
      showBuiltin: 'Show built-in',
      hideBuiltin: 'Hide built-in',
      builtinTitle: 'Built-in text',
      builtinHint:
        'The text shipped with the panel, read-only. “Reset to built-in” returns to it; your edit is in use instead of it right now.',
      resetConfirmTitle: 'Reset the prompt edit?',
      resetConfirmText:
        'Your text will be deleted and the panel will speak the built-in one again. Prompts keep no edit history — the only way back is the copy in the backup folder.',
      unsaved: 'Not saved',
      size: '{{bytes}} B',
      editorHint:
        'Built-in text version: {{version}}. A saved edit goes to the model exactly as written.',
      name: {
        'tool-protocol': 'Tool protocol',
        'contour-agent': 'Agent behind a contour',
        'contour-preamble': 'Contour preamble',
        image: 'Image',
        'image-svg': 'Image in code',
        presentation: 'Presentation',
      },
      hint: {
        'tool-protocol':
          'How a model with no tools of its own calls them in text, and the panel turns that into a real call.',
        'contour-agent':
          'The short system prompt of a run through a contour: it replaces the CLI’s own prompt.',
        'contour-preamble':
          'How a contour differs from a direct vendor request. It travels right after the agent ' +
          'prompt and only together with it: switching the short contour prompt off drops it too.',
        image:
          'The system message of the drawing model. It travels only on the «part of the answer» ' +
          'road: the separate images endpoint has no system message.',
        'image-svg':
          'The rules for drawing in code (SVG), which the conversation agent does itself: the file ' +
          'must stand alone — no outside links, no scripts — or the panel refuses it.',
        presentation: 'A topic becomes slides: titles, bullets, speaker notes.',
      },
    },
    tab_prompts: 'Prompts',
    tabHint_prompts:
      'The texts the panel speaks to the model with, not on your behalf: the tool protocol, the agent behind a contour, the image and presentation modes.',
    tab_integrations: 'Integrations',
    tabHint_integrations:
      'Jira and Confluence, a forge by token, Telegram, test management and CI reports: where the panel takes outside context from and where it hands results back.',
    tab_spend: 'Spend',
    tabHint_spend: 'Which units to show spend in and which rates to count it by.',
    tab_safety: 'Safety',
    tabHint_safety:
      'What the panel does before writing to the configuration and what stays on disk afterwards.',
    tab_transfer: 'Transfer',
    tabHint_transfer:
      'A snapshot of the panel settings and moving a provider environment to another machine.',
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
    claudeDirReset: 'Auto-detect',
    locationLoadError: 'Could not read the configuration location — the server did not answer.',
    loadError: 'Could not load the settings',
    loadErrorText:
      'The server did not answer the settings request. Check that it is running and retry.',
    retry: 'Retry',
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
    backupHint: 'A copy is stored in agentdeck/backups',
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
    taskSplitInitiative: 'Offer to split tasks across chats',
    taskSplitInitiativeHint:
      'Given three or more independent tasks in one message, the agent first offers to spread them ' +
      'across separate chats — each on its own branch and its own copy of the repository. Off means ' +
      'no offer, but the “Split the tasks” button in the composer still works.',
    handoffInitiative: 'Offer to continue in a clean session',
    handoffInitiativeHint:
      'Once a task is closed, the agent first tidies its working files (.agent/PROGRESS.md, ' +
      'TASKS.md — finished items move to .agent/ARCHIVE.md, one line each) and then offers to ' +
      'continue in a new conversation: an old context is paid for again on every turn. The move ' +
      'itself is always your call — the card button, or auto-continue enabled in that conversation.',
    handoffContextLimit: 'Offer to continue once the window reaches',
    handoffContextLimitHint:
      'The second reason to continue is not meaning but size: context is paid for again on every ' +
      'turn, and by 200 thousand tokens almost the whole turn goes on resending the old one. The ' +
      'threshold looks at the run’s last turn; the offer arrives as a notification, and a click ' +
      'starts the continuation. With auto-continue enabled in that conversation the panel continues ' +
      'on its own, under the same safeguards (a fresh mark in .agent/PROGRESS.md, a successful turn, ' +
      'no more than five steps in a row).',
    handoffContextLimitOff: 'Never offer',
    handoffContextLimitValue: '{{tokens}} thousand tokens',
    handoffContextLimitDefault: '{{tokens}} thousand tokens (recommended)',
    handoffAutoDefault: 'Continue on its own in every conversation',
    handoffAutoDefaultHint:
      'On out of the box: in conversations where the card toggle was never touched, the panel ' +
      'continues by itself — the agent closes a stage with the block or in words (“restart the ' +
      'session”, “/clear”), and the work goes on in a clean session with the original task. Turn ' +
      'this off to decide every move by button. A conversation’s own toggle beats the setting ' +
      'either way, and nothing waives the safeguards — a fresh mark in the checkpoint file, a ' +
      'successfully finished turn, a checkpoint that changed since last time, no more than eight ' +
      'continuations in a row.',
    chatEffortAuto: 'CLI default',
    pricingTitle: 'Rates used to estimate cost',
    pricingHint:
      'Prices per million tokens behind the cost figures in Analytics. The panel pulls them from the Anthropic site — at most once a day, when you open Settings. Rates are tied to a specific model version, so older runs are priced at the rates that applied back then. You can set your own price: it overrides the list.',
    pricingPlatform:
      'A contour publishes no prices of its own, so spend through a contour is computed from this same list — as an estimate of “the same work through the API would have cost this much”. The contour’s internal unit is shown as a separate figure under its own label; the panel will not mix the two.',
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
    marketplaceSourceHint: 'owner/repo, https://… or a path',
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
    installPathMissing: 'folder missing',
    updatedAt: 'updated',
    noMarketplaces:
      'No marketplaces connected — add a source and its plugins appear in the catalogue',
    deleteMarketplace:
      'The marketplace will be disconnected. No installed plugin comes from it, so nothing else changes; the source can be added back at any time.',
    deleteMarketplaceWithPlugins:
      'Removing the marketplace makes Claude Code drop every plugin installed from it: {{names}}. Their commands and skills leave the palette; add the source back and reinstall to recover them.',
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
    hintPlatform:
      'The list comes from the contour, already narrowed by your key’s rights. The panel ' +
      'never visits the contour on its own: what you see is the answer from the last ' +
      'connection check, and “Refresh” asks again.',
    source: 'Source: models.dev ({{vendors}}), updated {{date}}',
    sourcePlatform: 'Source: the “{{platform}}” contour — your key’s own list, checked {{date}}',
    noSource: 'The catalog has never been downloaded — press “Refresh”.',
    sourceLabel: 'Where the model list comes from',
    sourceHint:
      'models.dev is an open catalog of every vendor: complete, but it knows nothing ' +
      'about what your key is allowed. A contour hands back the list already narrowed ' +
      'by the key’s rights — exactly what you can use.',
    sourceHintNoPlatform:
      'A contour shows up here once at least one is set up, switched on and holds a key.',
    sourceDev: 'models.dev — the open catalog',
    sourcePlatformOption: 'Contour — my key’s own list',
    sourcePlatformLabel: 'Which contour',
    sourcePlatformHint:
      'The panel never visits a contour on its own: the list comes from the last ' +
      'connection check. Press “Refresh” to ask the contour again.',
    sourcePlatformNone: 'not chosen',
    fallback: {
      'no-platform':
        'A contour is chosen as the source, but not which one — the list below is from ' +
        'models.dev.',
      'platform-gone':
        'The “{{platform}}” contour is gone from the settings — the list below is from models.dev.',
      'platform-off':
        'The “{{platform}}” contour is off or has no key — the list below is from models.dev.',
      'never-checked':
        'The “{{platform}}” contour has never been checked — the list below is from ' +
        'models.dev. Press “Refresh”.',
      'never-answered':
        'The “{{platform}}” contour has never answered — the list below is from models.dev.',
      'check-failed':
        'The “{{platform}}” contour could not even be reached: check its root certificate ' +
        'file on its card. The list below is from models.dev.',
    },
    stale: 'older than a day',
    new: 'new',
    retired: 'gone from the contour',
    retiredSince: 'gone from the contour, last seen {{date}}',
    flag: {
      vision: 'images',
      functionCalling: 'functions',
      jsonMode: 'strict JSON',
    },
    flagOff: ': no',
    context: 'context {{value}}',
    isDefault: 'default',
    makeDefault: 'Make default',
    showAll: 'Show all ({{count}})',
    empty: 'The catalog is empty: the source did not answer and there is no earlier data.',
    emptyPlatform:
      'The contour answered, but your key has been granted no models — that is its answer, ' +
      'not a connection failure. Model grants come from the key’s owner.',
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
    steps: 'Check steps',
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
    rangePlaceholder: 'Custom dates',
    rangeLabel: 'Custom period: pick a day or a range',
    reset: 'Reset',
    resetHint: 'Back to the default period — today',
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
    contourSpend: {
      title: 'Spend through the contour',
      hint:
        'Counted by the panel itself, from the usage frames that went through its gateway — it ' +
        'is not part of the figures above: those come from this machine’s transcripts, and work ' +
        'done through the contour has both. Added up, they would count the same tokens twice.',
      money: 'By our price book — an estimate',
      tokens: 'Tokens',
      unpriced: 'No price for: {{models}} — their {{tokens}} tokens are not converted into money.',
      dayHint: 'requests: {{requests}}',
    },
    lowered: {
      title: 'Lowered fan-out runs',
      hint:
        'Runs that went a rung below the ceiling: they carry a delivery bar — run the project ' +
        'checks and verify the result point by point. The panel only sees commands started ' +
        'through Bash, so «no checks seen» means exactly that, not «the agent skipped them»: a ' +
        'check run by a wrapper script or through an MCP server never reaches this list.',
      withoutChecks: 'no checks seen: {{count}}',
      failed: 'failed: {{count}}',
      checksSeen: 'checks: {{count}}',
      checksUnseen: 'no checks seen',
      crashed: 'run failed',
      noProject: 'no project',
      byKind: 'By work class — what each one cost',
      noKind: 'no class',
      kindRuns: 'runs: {{count}}',
    },
    agentsSummary: 'Show processes — {{count}}, {{memory}}',
    activeSessions_one: '{{count}} active session',
    activeSessions_few: '{{count}} active sessions',
    activeSessions_many: '{{count}} active sessions',
    activeSessions_other: '{{count}} active sessions',
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
    locationHint:
      'Automatic detection failed. Enter the path manually — the app will pick up the configuration right away.',
    saveFailed: 'Failed to save',
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
      quiet: 'agent quiet for five minutes',
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
    emptyTitle: 'No projects yet',
    emptyText: 'Directories Claude Code has worked in will appear here.',
    newChat: 'New chat in project',
    notifyWaiting: 'Project "{{name}}": agent is waiting for a reply',
    notifyPermission: 'Project "{{name}}": agent needs permission',
    notifyError: 'Project "{{name}}": error or limit',
    notifyDone: 'Project "{{name}}": agent finished',
    notifyChildDone: 'Chat "{{title}}": agent finished',
    notifyChildError: 'Chat "{{title}}": error or limit',
    starterPrompt:
      'You are working in the project "{{name}}". Read-only for now. Look around and briefly say what this project is and what you suggest starting with.',
    introHint:
      'A new conversation in the project directory. File edits are allowed — turn them off in the “Chat settings” menu if you only want a look around.',
    actions: {
      review: 'Do a code review: find problems and suggest fixes.',
      bugs: 'Find potential bugs and explain the cause of each.',
      structure: 'Explain the project structure and main modules.',
      tests: 'Run the tests and show what fails.',
    },
  },
  projectCode: {
    open: 'Project code',
    title: 'Project code',
    tabChanged: 'Changed ({{count}})',
    tabAll: 'All files',
    noChanges: 'Neither the agent nor the working tree shows any change.',
    missing: 'gone from disk',
    skipped: 'Edits outside the project: {{count}}',
    fromAgent: 'In this conversation',
    fromGit: 'In the working tree',
    summary: 'Changed files: {{count}}',
    summaryLines: '+{{added}} −{{removed}} lines',
    summaryBranch: 'branch {{branch}}',
    emptyFolder: 'Folder is empty',
    truncated: 'Not all files in this folder are shown',
    nothingOpen: 'No file selected',
    pickFile: 'Pick a file on the left.',
    binary: 'Binary file — nothing to show.',
    tooBig: 'This file is too large to open here.',
    showDiff: 'Agent edits',
    noAgentEdits: 'The agent did not touch this file',
    wholeFile: 'File was overwritten whole: the previous text was not kept',
    unmatched: 'Unmatched edits: {{count}} — the diff is incomplete',
    tooBigDiff: 'Too large to compare',
    readOnly: 'Read-only',
    resize: 'File list width',
    tabCode: 'Code',
    tabPreview: 'Preview',
    previewEmpty: 'Nothing to show: the file is empty.',
    discardTitle: 'Unsaved edits',
    discardText:
      'Unsaved files: {{count}} ({{files}}). Close the window and what you typed is gone ' +
      'for good.',
    discardConfirm: 'Close without saving',
  },
  projectTests: {
    open: 'Tests',
    title: 'Project test cases',
    description:
      'Cases live in {{dir}} inside the project itself: the agent writes them and walks ' +
      'through them, you edit them by hand.',
    empty: 'This project has no tests yet.',
    emptyHint: 'Let the agent look around the app and write the first set — you can edit it after.',
    emptyGroup: 'This group has no cases.',
    broken: 'The group file did not parse: {{error}}',
    brokenHint: 'The panel leaves it alone — fix it by hand so nothing written is lost.',
    addGroup: 'New group',
    groupId: 'Identifier',
    groupIdHint: 'Also the file name: latin letters, digits, hyphen. For example, smoke.',
    groupTitle: 'Title',
    removeGroup: 'Delete group',
    history: {
      open: 'File history',
      title: 'History of group "{{group}}"',
      empty: 'No history yet',
      emptyHint:
        'The cases have not been committed yet — or the project is not under git. The panel keeps no edit history of its own: case versions live in the project repository.',
    },
    removeGroupConfirm: 'Delete the group “{{title}}”?',
    removeGroupText: 'The file {{file}} goes with every case in it. This cannot be undone.',
    generate: 'Generate cases',
    generateHint:
      'The agent looks around the app and proposes cases; it extends existing ones and marks dead ones. They reach the library once you accept them.',
    generateDiff: 'From the diff',
    generateDiffHint:
      'Cases for what changed in the branch against main (or in the working tree when there is only one branch): the agent reads the list of touched files instead of the whole app, and fills codePaths from it.',
    generateRequirement: 'Cover with cases',
    generateRequirementHint:
      'The agent reads the tracker issue and proposes cases for it; the requirement link is filled in, and the row stops being uncovered.',
    generateRegression: 'Regression case',
    generateRegressionHint:
      'File a case that locks the fix in: the reproduction steps and the tester note go into the task. The original case is left alone.',
    explore: 'Explore',
    exploreHint:
      'A free search along a charter: the agent looks for what has no cases yet and files cases for what it finds — failures with the "failed" status and reproduction steps.',
    exploreNeedsScope:
      'Write the charter into the wish field — what exactly to look at. Without one the session turns into wandering around the application.',
    automate: 'Automate ({{count}})',
    automateHint:
      "The agent turns manual cases into automated-test code in the project's own idiom and fills in automation: file, test name and key. The panel matches CI results by them later. Cases already marked automated are skipped.",
    run: 'Run',
    runSelected: 'Run selected ({{count}})',
    runFull: 'Full retest',
    runFullHint: 'Clear the checkmarks and walk everything again.',
    stop: 'Stop',
    scope: 'What to focus on',
    scopeHint: 'For example: chat and analytics only. Empty means everything.',
    running: 'Run in progress',
    runGenerate: 'The agent is writing cases',
    runDone: 'Run finished',
    runStopped: 'Run stopped',
    runError: 'The run broke: {{error}}',
    log: 'Run log',
    logEmpty: 'The agent has printed nothing yet.',
    fullAccessNote:
      'During a run the agent works with full access — there is nobody to ask in the background. ' +
      'It is allowed to change test files only.',
    addCase: 'Add a test',
    editCase: 'Edit test',
    newCase: 'New test',
    caseTitle: 'What we check',
    casePurpose: 'Why',
    caseArea: 'Area',
    caseSteps: 'Steps',
    caseStepsHint: 'One per line.',
    caseExpected: 'Expected result',
    removeCase: 'Delete test',
    removeCaseConfirm: 'Delete the test “{{title}}”?',
    removeCaseText: 'The case disappears from the group file. This cannot be undone.',
    save: 'Save',
    bySource: { agent: 'written by the agent', human: 'written by you' },
    status: {
      unknown: 'not run',
      running: 'running',
      passed: 'passed',
      failed: 'failed',
      skipped: 'skipped',
      blocked: 'blocked',
    },
    counts: '{{passed}} passed · {{failed}} failed · {{skipped}} skipped · {{rest}} not run',
    lastRun: 'Checked {{time}}',
    conventionOff: 'Chat does not keep the cases',
    conventionOffText:
      'A run started here writes the cases itself. An ordinary conversation knows nothing ' +
      'about them: say “run the tests” in chat and it will check but write nothing.',
    conventionInstall: 'Write it into the project’s CLAUDE.md',
    conventionInstallText:
      'A block with the file format and the rules for keeping cases is appended to the ' +
      'project’s CLAUDE.md. It is read in EVERY conversation, so from then on the cases ' +
      'are kept no matter where the request came from. Your own text is left alone and ' +
      'pressing again adds nothing.',
    conventionOn: 'Chat keeps the cases too (written into CLAUDE.md)',
    selectAll: 'Select all',
    clearSelection: 'Clear selection',
  },
  tests: {
    title: 'Testing',
    subtitle:
      'A tester’s workspace over a project from the registry: case library, plans, manual and ' +
      'agent runs, report. The cases live in the project’s own files.',
    project: 'Project',
    dir: 'Cases: {{dir}}',
    noProjects: 'The registry has no projects yet',
    noProjectsHint: 'Add a project in the “Projects” section — the tests come from its files.',
    tab: {
      library: 'Library',
      plans: 'Plans',
      runs: 'Runs',
      report: 'Report',
      coverage: 'Coverage',
    },
    kind: { case: 'case', checklist: 'checklist' },
    priority: { blocker: 'blocker', high: 'high', medium: 'medium', low: 'low' },
    readiness: { draft: 'draft', ready: 'ready', obsolete: 'obsolete' },
    automation: { manual: 'manual', toAutomate: 'to automate', automated: 'automated' },
    library: {
      any: 'any',
      query: 'Search the cases',
      queryHint: 'Title, purpose, steps, tags',
      status: 'Status',
      priority: 'Priority',
      type: 'Type',
      readiness: 'Readiness',
      automation: 'Automation',
      area: 'Area',
      tag: 'Tag',
      archived: 'Show archived',
      muted: 'Quarantine',
      mutedOnly: 'quarantine only',
      mutedWithout: 'without quarantine',
      reset: 'Clear the filter',
      views: 'Saved views:',
      viewsEmpty: 'none yet',
      viewSave: 'Save the view',
      viewSaveHint:
        'The filter is stored as a view: one click brings it back, and a dynamic test plan ' +
        'can be built from it.',
      viewName: 'View name',
      viewRemove: 'Delete the view “{{title}}”',
      sections: 'Sections',
      allSections: 'All sections',
      sectionsEmpty: 'The cases carry no sections.',
      countOf: 'Showing {{shown}} of {{total}}',
      checkAll: 'Select everything shown',
      columnTitle: 'Case',
      columnGroup: 'Group',
      columnStatus: 'Status',
      columnPriority: 'Priority',
      columnReadiness: 'Readiness',
      columnAutomation: 'Auto',
      columnArea: 'Area',
      columnPoints: 'Points',
      columnActions: 'Actions',
      empty: 'Nothing to show',
      emptyFiltered: 'No case matches the filter — drop some of the conditions.',
      emptyGroup: 'This group has no cases yet.',
    },
    bulk: {
      selected: 'Selected: {{count}}',
      action: 'Action',
      actions: {
        tag: 'add a tag',
        untag: 'remove a tag',
        priority: 'set the priority',
        readiness: 'set the readiness',
        automation: 'set the automation',
        section: 'move to a section',
        move: 'move to a group',
        duplicate: 'duplicate',
        archive: 'archive',
        restore: 'restore from the archive',
        mute: 'quarantine',
        unmute: 'release from quarantine',
        delete: 'delete',
      },
      tagValue: 'Tag',
      muteReason: 'Quarantine reason',
      muteReasonHint: 'What we are waiting for. Without a reason nobody ever lifts it.',
      sectionValue: 'Section',
      groupValue: 'Target group',
      pickGroup: 'pick a group',
      apply: 'Apply',
      deleteConfirm: 'Delete the selected cases ({{count}})?',
      deleteText: 'The cases disappear from the group file. This cannot be undone.',
    },
    editor: {
      newHint: 'The new case lands in the open group.',
      lastResult: 'What the run saw',
      lastResultHint: 'Written by the run, not editable by hand.',
      type: 'Type',
      duration: 'Minutes',
      durationHint: 'Estimate',
      purposeHint: 'What cannot be derived from the steps',
      section: 'Section',
      sectionHint: 'A slash-separated path: Chat/Attachments',
      precondition: 'Precondition',
      postcondition: 'Postcondition',
      oracle: 'How it is proven',
      oracleHint: 'On-screen text, a database row, a network response — what the verdict rests on.',
      tags: 'Tags',
      tagsHint: 'Comma-separated',
      attributes: 'The project’s own fields',
      steps: 'Steps',
      stepAction: 'Step {{index}}',
      stepExpected: 'Step expectation',
      stepData: 'Step data',
      stepAdd: 'Add a step',
      stepUp: 'Move step {{index}} up',
      stepDown: 'Move step {{index}} down',
      stepRemove: 'Delete step {{index}}',
      sharedRef: 'shared step',
      sharedDetach: 'Detach',
      sharedPick: 'Insert a shared step',
      sharedNone: 'do not insert',
      parameters: 'Parameters',
      parametersHint:
        'In the steps a parameter is written as %name. The values decide how many times the ' +
        'case is run.',
      parameterName: 'Name',
      parameterValues: 'Values',
      parameterValuesHint: 'Comma-separated',
      parameterAdd: 'Add a parameter',
      parameterRemove: 'Delete the parameter',
      pointsFull: 'full set: {{count}}',
      pointsPairwise: 'pairwise: {{count}}',
      links: 'Links',
      linkType: 'Type',
      linkTypes: { requirement: 'requirement', issue: 'issue', mr: 'MR', doc: 'document' },
      linkUrl: 'URL',
      linkTitle: 'Label',
      linkAdd: 'Add a link',
      linkRemove: 'Delete the link',
      automation: 'Automation',
      automationFile: 'Test file',
      automationTestName: 'Test name',
      automationExternalId: 'Automated test id',
      automationExternalIdHint:
        'Matches a run result to this case even after the file moved: a junit property, ' +
        'an allure label (@allure.id) or “case: gui-001” inside the test name.',
      attachments: 'Attachments',
      attachmentsEmpty: 'No attachments — they appear during a manual run.',
      archived: 'Archived',
      archivedHint: 'Out of the list, but not lost',
    },
    exchange: {
      open: 'Exchange',
      title: 'Import and export',
      hint: 'Results from CI, cases from spreadsheets, the group exported as a file. `pnpm tests` does the same from the command line.',
      results: 'Run results',
      resultsHint:
        'A CI report lands as case statuses and as its own history record — labelled as somebody else’s run.',
      cases: 'Cases into the group “{{group}}”',
      casesHint: 'A table from another system: columns are read from the headers.',
      casesHintMarkdown:
        'Manual cases from the repository itself: ТК-*.md files, nested folders included. The number from the file name is kept, and a repeated import updates the case instead of adding a second one.',
      folder: 'Folder in the project',
      folderHint: 'Where the ТК-*.md files live. Empty — QA',
      export: 'Export of the group “{{group}}”',
      exportHint: 'The server builds the file — named after the group and today’s date.',
      format: 'Format',
      formatName: {
        junit: 'JUnit XML',
        playwright: 'Playwright JSON',
        allure: 'Allure',
        csv: 'CSV',
        xlsx: 'Excel (xlsx)',
        'testrail-csv': 'TestRail CSV',
        markdown: 'Manual cases (ТК-*.md)',
        md: 'Markdown',
      },
      environment: 'Environment',
      anyEnvironment: 'Not set',
      file: 'File in the project',
      fileHint: 'Path from the project root: test-results/junit.xml',
      importFromProject: 'Take from the project',
      pickFile: 'Pick a file',
      download: 'Download',
      read: 'read: {{count}}',
      matched: 'landed on cases: {{count}}',
      created: 'created: {{count}}',
      unmatched: 'not found: {{count}} — {{names}}',
    },
    onboarding: {
      title: 'The suite is empty — three steps to fill it',
      subtitle: 'Cases are files in {{dir}} and travel to git with the code.',
      envTitle: 'Environment',
      envText:
        'Where to run: the stand address and the credentials for it. Without one a run goes blind.',
      envAction: 'Add an environment',
      envDone: 'Done: {{title}}. Its passwords live behind the credentials button on the run bar.',
      envName: 'Local',
      generateTitle: 'Generation',
      generateText:
        'The agent reads the app and proposes cases as a draft. Nothing is written until you accept it.',
      generateAction: 'Generate cases',
      generateDone: 'Draft ready: {{count}} proposals — accept them in the banner above.',
      runTitle: 'First run',
      runText:
        'Once cases exist, the run bar hands them to the agent, and the manual run walks you through them yourself — with keys and a stopwatch.',
    },
    runner: {
      title: 'Manual run',
      subtitle: 'Mark the steps as you go — the panel records the result into the run.',
      noSession: 'No manual run is going',
      noSessionHint: 'Start one from the library or from a test plan.',
      points: 'Points',
      progress: 'Done {{done}} of {{total}}',
      position: 'Pass {{index}} of {{total}} · closed {{done}}',
      cancel: 'Abandon',
      finish: 'Finish',
      precondition: 'Starting state: {{text}}',
      stepData: 'data: {{text}}',
      stepExpected: 'expected: {{text}}',
      stepNote: 'Note on step {{index}}',
      expected: 'Expected result: {{text}}',
      note: 'What actually happened (key {{key}})',
      noteHint: 'This note goes into the defect if the point fails.',
      keyHint: 'Key {{key}}',
      keysHint:
        'Keys: the digit on a button closes the point, {{note}} — note, {{attach}} — file, ← and → move between points. Keys stay silent while typing in a field.',
      attach: 'Attach a file',
      defect: 'File a defect',
      defectCreate: 'File it',
      defectBuilding: 'Building the draft…',
      defectCreated: 'Defect filed: {{url}}',
      defectNoTargets: 'Neither gh nor glab is in PATH — there is nothing to file the defect with.',
      defectTarget: 'Where',
      defectTitle: 'Title',
      defectBody: 'Description',
      defectCopy: 'Copy draft',
      defectTargetHint:
        'gh and glab need no key in the panel. Forge and Jira go by the token saved in Integrations — they work where the CLI cannot be installed.',
      defectTargetName: {
        github: 'GitHub (gh)',
        gitlab: 'GitLab (glab)',
        forge: 'Forge by token',
        jira: 'Jira',
      },
      prev: 'Back',
      next: 'Next',
      verdict: {
        passed: 'Passed',
        failed: 'Failed',
        skipped: 'Skip',
        blocked: 'Blocked',
      },
      start: 'Run it manually',
      startSelected: 'Run manually ({{count}})',
      resume: 'Back to the run',
    },
    plans: {
      create: 'New plan',
      edit: 'Edit',
      title: 'Title',
      product: 'Product',
      version: 'Version',
      dates: 'Dates',
      datesPlaceholder: 'Pick the dates',
      description: 'Description',
      mode: 'Contents',
      modeHint: 'Either a named list of cases or a saved filter view.',
      modeStatic: 'List of cases',
      modeDynamic: 'Saved view',
      view: 'View',
      viewNone: 'not chosen',
      cases: 'Cases in the plan: {{count}}',
      caseCount: 'cases: {{count}}',
      environments: 'Environments',
      environmentsHint: 'Case × environment = a separate point.',
      environmentsEmpty: 'The project has no environments — the plan is run once.',
      empty: 'No test plans yet',
      emptyHint: 'A plan answers “what and by when” and expands into points.',
      points: 'points: {{count}}',
      locked: 'locked',
      startManual: 'Run it manually',
      startAgent: 'Hand it to the agent',
      removeConfirm: 'Delete the plan “{{title}}”?',
      removeText: 'The plan file is deleted. The cases and the run history stay.',
      recipeOpen: 'Build by rule',
      recipeTitle: 'Plan from a rule',
      recipeHint:
        'A pick by countable traits: priority, time, diff, milestone, stability. No agent is started — it is instant and works offline.',
      recipe: 'Rule',
      recipes: {
        smoke: 'Smoke in N minutes',
        diff: 'Regression by diff',
        release: 'Milestone plan',
        flaky: 'Flaky ones',
      },
      recipeAbout: {
        smoke:
          'Take the most important until the budget runs out. A case with no duration counts as 5 minutes.',
        diff: 'Cases touched by the uncommitted edits of the working copy, plus their neighbours by area.',
        release: 'Cases of the milestone requirements plus everything red since the previous one.',
        flaky: 'Cases whose result jumps around: stability below the threshold.',
      },
      budget: 'Budget, min',
      threshold: 'Stability threshold, %',
      recipePreview: 'Preview',
      recipeSave: 'Save as a plan',
      recipeSaved: 'The plan “{{title}}” is saved — edit it like any other.',
      recipePicked: 'cases taken: {{count}}',
      recipeMinutes: 'minutes: {{minutes}}',
      recipeBudget: 'budget: {{minutes}} min',
      recipeNothing: 'The rule picked no cases — look at what did not fit and why.',
      recipeLeft: 'Did not fit: {{count}}',
    },
    runs: {
      environment: 'Environment',
      environmentDefault: 'default',
      environmentAll: 'all',
      release: 'Release',
      releaseHint: 'Milestone: v1.4',
      changedOnly: 'Changed only',
      changedOnlyHint: 'Run only the cases touched by the uncommitted edits of the working copy.',
      branch: 'branch {{branch}}',
      empty: 'No runs yet',
      emptyHint: 'Start an agent or walk the cases manually — the records appear here.',
      mode: {
        generate: 'generation',
        run: 'run',
        explore: 'exploration',
        automate: 'automation',
        manual: 'manual',
        import: 'import',
      },
      actor: { agent: 'agent', human: 'human', ci: 'CI' },
      passed: 'passed: {{count}}',
      failed: 'failed: {{count}}',
      skipped: 'skipped: {{count}}',
      duration: 'duration: {{text}}',
      tokens: 'tokens: {{count}}',
      cost: 'cost: ${{value}}',
      openChat: 'Open the conversation',
      exportMd: 'Report .md',
      exportCsv: 'Report .csv',
      exportPdf: 'Report .pdf',
      noResults: 'This run has no per-case results.',
      pointDuration: '{{seconds}} s',
      draftProposed: 'cases proposed: {{count}}',
      draftAccepted: 'accepted automatically: {{count}}',
    },
    evidence: {
      title: 'How the failures are proven',
      hint:
        'A failure with no screenshot and no step number can neither be reproduced nor filed as a ' +
        'defect. The panel still keeps the result — losing it costs more than calling it incomplete.',
      failed: 'red cases: {{count}}',
      proven: 'with proof: {{count}}',
      detailed: 'with the step analysed: {{count}}',
      missing: 'no proof',
      missingList: 'Proven by nothing:',
      recheck: 'Re-run the unproven',
      recheckHint: 'Start a run over the cases whose failure is backed by nothing.',
      flakyList: 'The two attempts disagreed:',
      step: 'step {{count}}',
      flaky: 'the second attempt disagreed',
      confirmed: 'failure confirmed',
      detail: 'expected: {{expected}} · got: {{actual}}',
      retryNote: 'second time round: {{text}}',
    },
    diff: {
      title: 'Since the previous run',
      open: 'Compare with the previous run',
      hide: 'Hide the comparison',
      loading: 'Working out what changed…',
      base: 'compared with the run from {{date}}',
      newFailures: 'Broke',
      fixed: 'Fixed',
      stillFailing: 'Red again',
      added: 'Appeared in the set',
      removed: 'Gone from the set',
      quiet: 'Nothing changed: {{count}} cases ended exactly as last time.',
      transition: '{{from}} → {{to}}',
      missing: 'not run',
      rerun: 'Rerun the failures ({{count}})',
      rerunHint: 'Start the agent over exactly the red cases of this run.',
    },
    drafts: {
      title: 'Review generated proposals',
      waiting: 'The agent proposed {{count}} changes',
      open: 'Review',
      openApplied: 'What was accepted',
      doneBanner: 'Accepted from the last generation: {{count}}',
      empty: 'No proposals',
      emptyHint: 'Run generation — it brings a draft, and you decide what enters the library.',
      broken: 'The draft did not parse: {{reason}}',
      source: 'File {{file}} · {{total}} changes, {{pending}} awaiting a decision',
      opAdd: 'new',
      opUpdate: 'update',
      pick: 'Select “{{title}}”',
      similar: 'looks like {{caseId}} “{{title}}” ({{percent}}%)',
      applyAll: 'Accept all ({{count}})',
      applyPicked: 'Accept selected ({{count}})',
      applyAuto: 'Accept and keep accepting automatically',
      reject: 'Reject',
      rejectHint: 'Nothing is applied; the draft moves to the archive — the file is not deleted.',
      rollback: 'Undo acceptance ({{count}})',
      rollbackHint:
        'Added cases are removed, updated ones return to their previous state. A case someone has since edited or run stays as it is.',
      applied: 'Cases accepted: {{count}}',
      skipped: '{{caseId}} not accepted: {{reason}}',
      rolledBack: 'Removed: {{removed}}, restored: {{restored}}',
      kept: '{{caseId}} left as is: {{reason}}',
      hold: 'Auto-accept left it to you: {{reason}}',
      allAccepted: 'Every proposal in this draft is already accepted ({{count}}).',
      auto: 'Accept immediately',
      autoHint:
        'Generation lands in the library without review, marked as a draft. Run permissions do not change: group files are written by the panel, and acceptance can always be undone.',
    },
    health: {
      title: 'Set health',
      hint: 'Cases checked: {{count}}. The linter fixes nothing itself — it names the button.',
      clean: 'No findings: the set is clean.',
      fixHint: 'An ordinary bulk action — the same one you have by hand in the library.',
      duplicates: 'Look-alike cases: {{count}}',
      filter: 'With findings',
      filterHint: 'Keep only the cases the linter had something to say about.',
    },
    quarantine: {
      title: 'Quarantine and ageing',
      hint: 'Thresholds: {{streak}} greens in a row suggest lifting quarantine, stability below {{stability}}% suggests setting it. The panel applies nothing on its own.',
      clean: 'Quarantine is in order: nothing to lift or set.',
      liftTitle: 'Ready to come back: {{count}}',
      muteTitle: 'Worth muting: {{count}}',
      staleTitle: 'Drifted from the requirement: {{count}}',
      stale: '{{key}} was edited {{days}} days after the case',
      was: 'Quarantined: {{reason}}',
      reason: 'Quarantine reason',
      reasonHint: 'What it waits for and until when — without it nobody will dare lift it later.',
      mute: 'Quarantine',
      unmute: 'Lift quarantine',
    },
    release: {
      title: 'Release readiness',
      hint: 'One document for the "do we ship" question: the verdict, what blocks it and what proves it. Computed from the runs of THIS milestone.',
      pick: 'Milestone',
      exportMd: 'Document MD',
      exportHtml: 'Document HTML',
      exportPdf: 'Document PDF',
      ready: 'Ready to ship',
      blocked: 'Too early to ship',
      cases: 'cases: {{count}}',
      passed: 'passed: {{count}}',
      failed: 'failed: {{count}}',
      untested: 'untested: {{count}}',
      defects: 'defects: {{count}}',
      runs: 'milestone runs: {{count}}',
      muted: 'quarantined: {{count}}',
      untestedTitle: 'Untested: {{count}}',
      defectsTitle: 'Open defects: {{count}}',
      redTitle: 'Failures: {{count}}',
      mutedTitle: 'Failures in quarantine: {{count}}',
      requirements: 'Requirements: {{count}}',
      requirementCounts:
        'cases {{cases}} · passed {{passed}} · failed {{failed}} · untested {{untested}}',
      more: 'and {{count}} more',
      state: {
        uncovered: 'uncovered',
        red: 'failure',
        partial: 'partial',
        covered: 'covered',
      },
      defectState: {
        open: 'open',
        unknown: 'status not asked',
        closed: 'closed',
      },
    },
    secrets: {
      open: 'Credentials',
      openHint: 'Login, password and tokens of the «{{environment}}» environment',
      title: 'Credentials of «{{environment}}»',
      hint: 'A run against a real stand stops at the login form. The variable name goes into the project file, the value stays in this panel only and never reaches the agent prompt.',
      empty: 'No credentials yet: the run covers only what opens without a login.',
      add: 'New credential',
      name: 'Variable',
      nameHint: 'Latin letters and underscore — the agent reads the value under this name',
      note: 'What for',
      noteHint: 'A note for humans: «test login password»',
      value: 'Value',
      valueHint: 'Stays in this machine’s panel; it is never shown back',
      save: 'Save',
      set: 'set: {{masked}}',
      unset: 'not set on this machine',
      fill: 'Set',
      replace: 'Replace',
      forget: 'Forget',
      forgetHint: 'Drop the name from the project file and wipe the value from the panel',
      where:
        'The value goes into the run process environment. It is not in the log, the history or the prompt — matches are blanked out.',
    },
    settings: {
      open: 'Library settings',
      title: 'Library settings',
      hint: 'Environments, shared steps and custom fields of this project. All of them are files next to the cases: they travel in git with them and the whole team sees them.',
      tab: {
        environments: 'Environments',
        steps: 'Shared steps',
        fields: 'Custom fields',
      },
      brokenTitle: 'A file did not parse',
      brokenHint:
        'An empty list below means «not read», not «nothing is there». While the file is broken the panel does not write into it — fix it by hand, your edit will wait.',
      where: 'The files live in {{dir}} of the checked project.',
      edit: 'Edit',
      save: 'Save',
      add: 'Add',
      cancel: 'Cancel',
      remove: 'Remove',
      removeConfirm: 'Remove',
      env: {
        empty: 'No environments yet: a run happens wherever it was started.',
        add: 'New environment',
        editTitle: 'Editing environment «{{title}}»',
        name: 'Name',
        namePlaceholder: 'Test stand',
        url: 'Address',
        browser: 'Browser',
        os: 'System',
        start: 'Start command',
        startHint: 'How to bring the stand up when it is down',
        default: 'default',
        archived: 'archived',
        makeDefault: 'Make it the default',
        makeDefaultHint: 'Used whenever no environment is chosen explicitly',
        archive: 'Archive',
        unarchive: 'Restore from archive',
        secrets: 'Credentials',
        secretCount: 'credentials: {{count}}',
        removeHint: 'Runs made on it stay in the history.',
        usedByPlans:
          'Plans point at it: {{plans}}. Remove it and the plan is left with no environment — there is nowhere to run it.',
      },
      step: {
        empty: 'No shared steps yet: every case describes the login itself.',
        add: 'New shared step',
        editTitle: 'Editing shared step «{{title}}»',
        name: 'Name',
        namePlaceholder: 'Sign in as the test user',
        lines: 'Steps',
        linesHint: 'One step per line; «action · expected: …» as in the file',
        usedNone: 'used nowhere',
        used_one: 'in {{count}} case',
        used_few: 'in {{count}} cases',
        used_many: 'in {{count}} cases',
        used_other: 'in {{count}} cases',
        removeHint: 'Nothing points at it — it goes without a trace.',
        removeUsed_one:
          '{{count}} case points at it: the reference stays as a caption, but the case loses the step body.',
        removeUsed_few:
          '{{count}} cases point at it: the references stay as captions, but the cases lose the step body.',
        removeUsed_many:
          '{{count}} cases point at it: the references stay as captions, but the cases lose the step body.',
        removeUsed_other:
          '{{count}} cases point at it: the references stay as captions, but the cases lose the step body.',
      },
      field: {
        empty: 'No custom fields yet: the list shows the common columns only.',
        add: 'New field',
        editTitle: 'Editing field «{{title}}»',
        name: 'Name',
        namePlaceholder: 'Stand',
        key: 'Key',
        keyHint: 'Latin letters, digits, dot and dash — every case stores the field under it',
        typeLabel: 'Type',
        type: {
          text: 'text',
          select: 'choice',
          number: 'number',
        },
        options: 'Choices',
        optionsHint: 'Comma separated',
        required: 'required',
        requiredLabel: 'Required',
        removeHint: 'The column disappears; values already in the cases stay in the files',
        where:
          'The field becomes a column in the list and a field in the case editor right after saving.',
        problem: {
          key: 'The key is latin letters, digits, dot, dash and underscore: it goes into every case.',
          duplicate: 'A field with this key already exists.',
          options: 'A choice field needs at least one option.',
        },
      },
    },
    risk: {
      sort: 'Order',
      sortFile: 'As in the file',
      sortRisk: 'By risk',
      budget: 'Minutes',
      budgetApply: 'Fill',
      budgetHint: 'I have N minutes',
      budgetResult:
        'Picked {{count}} cases, {{minutes}} of {{budget}} min. Left out: {{left}} — hover to see the list.',
      score: 'Risk {{score}}',
    },
    report: {
      empty: 'The report is still empty',
      emptyHint: 'It is computed from the run history — make at least one run.',
      status: 'Case state',
      passed: 'passed: {{count}}',
      failed: 'failed: {{count}}',
      unknown: 'not run: {{count}}',
      automation: 'Automation coverage',
      totals: 'Totals',
      runsCount: 'Runs: {{count}}',
      tokens: 'Tokens: {{count}}',
      cost: 'Cost: ${{value}}',
      duration: 'Time: {{minutes}} min',
      lastRun: 'Last run: {{time}}',
      trend: 'Trend across runs',
      trendEmpty: 'No runs yet.',
      trendLabel: 'Composition of the latest runs, {{count}} in total',
      areas: 'Coverage by area',
      areasEmpty: 'The cases carry no areas.',
      areaNone: 'no area',
      areaCounts: '{{passed}} of {{total}} ({{percent}}%)',
      flaky: 'Flaky cases',
      flakyHint: 'Stability is the share of runs where the result did not change.',
      flakyEmpty: 'No flaky cases found.',
      flakyRuns: 'runs: {{runs}}, flips: {{flips}}',
      failures: 'Repeating failures',
      failuresHint:
        'Failures grouped by what the executor wrote down: one breakage usually reddens several cases at once.',
      failuresEmpty: 'No failures with a stated reason.',
      failuresCases: 'cases: {{count}} — {{names}}',
      muted: 'In quarantine: {{count}}',
      releases: 'Releases',
      releasesHint:
        'Runs grouped by release. Untested — cases no run of that release ever touched.',
      releaseCounts: 'runs: {{runs}} · passed {{passed}} · failed {{failed}}',
      releaseUntested: 'untested: {{count}}',
    },
    coverage: {
      jql: 'Requirements query (JQL)',
      jqlPlaceholder: 'project = QA AND statusCategory != Done',
      jqlHint: 'Empty — the project link is used: children of the linked epic or its open issues.',
      apply: 'Show',
      refreshDefects: 'Refresh defect states',
      defects: 'Defects',
      defectsChecked: 'asked: {{count}}',
      defectsClosed: 'closed: {{count}}',
      defectsError: 'Defect states could not be read — check the integration cards.',
      defect: 'defect',
      openDefect: 'open',
      recheckHint: 'The defect is closed while the case is still red — these are worth a recheck.',
      recheckEmpty: 'Nothing to recheck: no closed defects on red cases.',
      recheckRun: 'Recheck ({{count}})',
      recheckRunHint: 'Run the agent over exactly the cases whose defects are already closed.',
      empty: 'No requirements in sight',
      emptyHint:
        'The matrix is built from case links (type “requirement” or “issue”) and from Jira ' +
        'issues when Atlassian is connected and the project is linked.',
      cases: 'cases: {{count}}',
      uncovered: 'uncovered',
      uncoveredHint: 'No live case points at this requirement.',
      orphans: 'Cases without a requirement: {{count}}',
      orphansHint: 'They check something, but why they exist cannot be answered from them.',
    },
    muted: {
      badge: 'quarantine',
      badgeWhy: 'quarantine: {{reason}}',
      short: 'quarantine',
    },
    publish: {
      target: 'Publish to',
      confluence: 'As a Confluence page',
      jira: 'As a Jira comment',
      action: 'Publish report',
      created: 'Published: {{url}}',
      updated: 'Updated: {{url}}',
    },
    baseline: {
      title: 'Baseline screenshots',
      open: 'Screenshots',
      accept: 'Accept baseline',
      accepted: 'Baseline updated',
      emptyTitle: 'No screenshots for this case',
      emptyText:
        'They appear after a run that captures the screen. With no baseline there is nothing to compare against — the first shot becomes one.',
      ratio: 'difference {{value}} against a {{limit}} limit',
      noShot: 'no screenshot',
      pane: {
        baseline: 'Baseline',
        actual: 'Now',
        diff: 'Difference',
      },
      state: {
        match: 'matches the baseline',
        diff: 'differs from the baseline',
        new: 'baseline just recorded',
        error: 'comparison failed',
      },
    },
  },
  integrations: {
    explainTitle: 'What the panel does with these keys',
    explain:
      'A token goes into the same encrypted store as provider keys and never comes back out — not in a server response, not on this screen: only a mask is shown. Connector settings (URL, email, repository) stay in the open, in the panel settings. "Check connection" really calls your system and remembers who the panel signed in as.',
    loadErrorTitle: 'Could not read integrations',
    loadErrorText: 'The server did not answer. Check that it is running and retry.',
    state: {
      ok: 'connected',
      error: 'no connection',
      unchecked: 'not checked',
    },
    deployment: {
      cloud: 'cloud',
      server: 'self-hosted',
    },
    card: {
      enabled: 'Enabled',
      enabledAria: 'Enable "{{name}}"',
      token: 'Token',
      tokenPlaceholder: 'Paste the key',
      tokenSaved: 'Key saved: {{mask}}. A new value replaces it, an empty field leaves it alone.',
      tokenEmpty: 'No key yet. It goes into the encrypted store and never returns to this screen.',
      check: 'Check connection',
      forget: 'Forget key',
      missing: 'Not filled in: {{fields}}',
      account: 'signed in as {{name}}',
      checkedAt: 'checked {{time}}',
      fieldRequired: 'The connector cannot be enabled without this field',
      atlassian: {
        title: 'Jira and Confluence',
        hint: 'Where requirements come from and where defects and reports go. One key for both systems when they share a site.',
        tokenHint:
          'Cloud: an API token from id.atlassian.com together with the email below. Server/DC: a personal access token, leave the email empty.',
      },
      forge: {
        title: 'Forge by token',
        hint: 'GitHub or GitLab directly, without gh and glab installed: needed where the CLI cannot be installed.',
        tokenHint:
          'GitHub: a personal access token with issue rights. GitLab: a project or personal token with the api scope.',
      },
      telegram: {
        title: 'Telegram',
        hint: 'Where the panel writes about finished runs, agent questions and permission requests.',
        tokenHint:
          'A bot token from @BotFather. The bot must be added to the chat, otherwise it cannot post there.',
      },
      webhook: {
        title: 'Webhook',
        hint: 'The same events at an address of your own: Slack, Mattermost, an on-call bot, an internal bus — one POST with JSON.',
        tokenHint:
          'A signing secret, not an access token. Set — the body is signed with the ' +
          'X-AgentDeck-Signature header (HMAC-SHA256, hex). Empty — sent unsigned.',
      },
      tms: {
        title: 'Test management',
        hint: 'Zephyr, Xray or Test IT: pull cases into a panel group and push run results back. A repeated push lands in the same run.',
        tokenHint:
          'Zephyr Scale: its own API key. Xray: key and secret in one line separated by a colon. Test IT: the personal token from the profile. Empty — the Atlassian key is used.',
      },
      ci: {
        title: 'CI reports',
        hint: 'Where to pull the latest build report from, so no file has to be uploaded by hand.',
        tokenHint: 'The same forge token, but allowed to read build artifacts.',
      },
    },
    field: {
      atlassian: {
        baseUrl: 'Site URL',
        email: 'Email',
        deployment: 'Deployment',
        confluenceUrl: 'Confluence URL',
      },
      forge: { kind: 'System', baseUrl: 'Installation URL', repo: 'Repository' },
      telegram: { chatId: 'Chat' },
      webhook: { url: 'Receiver URL' },
      tms: {
        kind: 'System',
        baseUrl: 'Installation URL',
        projectKey: 'Project',
        groupId: 'Test group',
      },
      ci: { kind: 'System', repo: 'Repository', workflow: 'Workflow', artifact: 'Artifact' },
    },
    hint: {
      atlassian: {
        baseUrl: 'https://name.atlassian.net for cloud, your own URL for Server/DC.',
        email:
          'Cloud only: the key works there in a pair with the email. Leave empty for Server/DC.',
        deployment: 'Unset — detected by a live check and remembered.',
        confluenceUrl: 'Fill in when Confluence does not live on the Jira host.',
      },
      forge: {
        kind: 'What is on the other end: GitHub or GitLab.',
        baseUrl: 'Own GitLab — the installation URL. Empty = github.com or gitlab.com.',
        repo: 'owner/repo or a numeric project id. Empty — derived from the checked project origin.',
      },
      telegram: { chatId: 'A numeric chat id or a @channel name.' },
      webhook: { url: 'Where to POST the JSON. http(s) only.' },
      tms: {
        kind: 'Zephyr Scale, Xray or Test IT — the case format follows from it.',
        baseUrl: 'Test IT only: the URL of your own installation. Zephyr and Xray share one API.',
        projectKey:
          'Key of the Jira project holding cases and cycles; for Test IT — the project id.',
        groupId: 'Which panel group to sync with. Empty — the panel asks at exchange time.',
      },
      ci: {
        kind: 'GitHub Actions or GitLab CI.',
        repo: 'owner/repo or a project id. Empty — derived from origin.',
        workflow: 'Workflow or job name. Empty — the last finished run.',
        artifact: 'Artifact name or the path to the report inside it.',
      },
    },
    option: {
      unset: 'Not set',
      atlassian: { deployment: { cloud: 'Cloud', server: 'Server / Data Center' } },
      forge: { kind: { github: 'GitHub', gitlab: 'GitLab' } },
      tms: { kind: { zephyr: 'Zephyr Scale', xray: 'Xray', testit: 'Test IT' } },
      ci: { kind: { github: 'GitHub Actions', gitlab: 'GitLab CI' } },
    },
    telegram: {
      eventsTitle: 'What to write about',
      event: {
        runDone: 'Run finished',
        runError: 'Run failed',
        testFailed: 'Case failed',
        permission: 'Agent asks for rights',
        question: 'Agent asked a question',
      },
      test: 'Send a test message',
      sent: 'Test message sent',
    },
    webhook: {
      test: 'Send a test event',
      sent: 'Test event sent',
      signature:
        'Only the event header leaves the machine: kind, text and the project folder name. No prompt, no agent answer, no paths.',
    },
    mcp: {
      connect: 'Connect Atlassian MCP',
      disconnect: 'Disconnect Atlassian MCP',
      hint: 'The same site and the same key, but available to the agent inside a conversation. The server is added to the MCP section — it can be removed from there too.',
    },
    picker: {
      jira: {
        search: 'Search Jira issues',
        placeholder: 'Issue key or words from the summary',
      },
      confluence: {
        search: 'Search Confluence pages',
        placeholder: 'Words from the page title',
      },
      find: 'Find',
      chosen: 'selected',
      clear: 'Clear selection',
      nothing: 'Nothing found',
    },
    links: {
      title: 'External links',
      description:
        'What the agent cannot know on its own: which issue the work belongs to, where the requirements live and where defects go. This is what reaches it as a line in the task.',
      scope: 'What to link',
      scopeHint: 'A group link overrides the project link for that group cases.',
      scopeProject: 'Whole project',
      jiraTitle: 'Jira',
      confluenceTitle: 'Confluence',
      jiraProject: 'Project for defects',
      jiraProjectHint: 'Where new defects for failed cases are filed.',
      forgeRepo: 'Forge repository',
      forgeRepoHint: 'Fill in when it cannot be derived from the checked project origin.',
      note: 'Note',
      noteHint: 'In your own words: what exactly lives here. Reaches the agent as is.',
      detach: 'Remove link',
      attach: 'Link',
      barTitle: 'External links',
      barGroup: 'Group "{{title}}"',
      empty: 'Nothing linked',
      kind: {
        jiraIssue: 'Issue',
        jiraProject: 'Defects in',
        confluencePage: 'Requirements',
        forgeRepo: 'Repository',
        note: 'Note',
      },
    },
  },
  runner: {
    start: 'Run',
    stop: 'Stop',
    starting: 'Starting…',
    open: 'Open',
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
    push: 'Push branch',
    pushAction: 'Push',
    pushNothing: 'nothing to push',
    newBranch: 'New branch',
    newBranchPlaceholder: 'feature/name',
    create: 'Create',
    commit: 'Commit message',
    commitPlaceholder: 'What was done',
    commitAction: 'Commit',
    note: 'A commit takes every change in the working tree. Pull may merge — the panel does not resolve conflicts. Push sends the current branch only and only forward: --force is never passed. No branch deletions or rebases here',
    worktrees: {
      title: 'Parallel branches',
      main: 'main copy',
      locked: 'locked',
      gone: 'directory gone',
      open: 'Open as a tab',
      remove: 'Remove',
      removeForce: 'Remove with its changes',
      busyHint: 'An agent is working in this copy — stop it first',
      namePlaceholder: 'feature/branch-name',
      add: 'Create a copy',
      note: 'A copy is a separate directory next to the project with its own branch and shared history: its own agent works there without disturbing the others. The branch shown is the one the copy is on right now — inside it the agent is free to switch. The panel never merges branches',
      mirror: 'Refresh local layer',
      mirrorHint:
        'Carry over what is newer in the main copy: .mcp.json under skip-worktree, .claude/, .env, .agent/ and the project patterns. The copy’s own edits are kept',
      mirrorTitle: 'Local layer',
      mirrorHide: 'Hide',
      mirrorNothing: 'Nothing to carry over: the main copy has no local layer',
      mirrorMirrored_one: 'Carried over: {{count}} file',
      mirrorMirrored_few: 'Carried over: {{count}} files',
      mirrorMirrored_many: 'Carried over: {{count}} files',
      mirrorMirrored_other: 'Carried over: {{count}} files',
      mirrorKept_one: 'Unchanged: {{count}} file is already as new in the copy',
      mirrorKept_few: 'Unchanged: {{count}} files are already as new in the copy',
      mirrorKept_many: 'Unchanged: {{count}} files are already as new in the copy',
      mirrorKept_other: 'Unchanged: {{count}} files are already as new in the copy',
      mirrorSkipped_one: 'Skipped: {{count}} file',
      mirrorSkipped_few: 'Skipped: {{count}} files',
      mirrorSkipped_many: 'Skipped: {{count}} files',
      mirrorSkipped_other: 'Skipped: {{count}} files',
      mirrorUnlisted: 'Left behind — git-ignored and not on the list:',
      mirrorUnlistedHint:
        'Needed in the copy — add it under “Copy settings”. node_modules, dist, build, coverage and *.log are never carried over',
      mirrorSettings: 'Copy settings',
      mirrorBuiltin:
        'Built-in, always carried: .mcp.json, .claude/, CLAUDE.local.md, .agent/ (without tmp, screenshots, archive and PROGRESS), .env, .env.*, *.local, *.local.*, .dev/. Files flagged skip-worktree / assume-unchanged — with the flag',
      mirrorInclude: 'Also carry',
      mirrorIncludePlaceholder: '.venv/**\nconfig/local.yaml',
      mirrorExclude: 'Do not carry',
      mirrorExcludePlaceholder: '.env',
      mirrorPatternsHint:
        'One pattern per line, as in .gitignore: without “/” — by name at any depth, with “/” — from the root; * within a segment, ** — any depth. Never: node_modules, dist, build, coverage, *.log, files over 8 MB and links',
      mirrorSave: 'Save',
      mirrorSaved:
        'Copy settings saved — they apply to the next copy, to “Refresh local layer” and to “Retry install”',
      bootstrapCommand: 'Command after creating a copy',
      bootstrapCommandPlaceholder: 'pnpm install --frozen-lockfile --prefer-offline',
      bootstrapCommandHint:
        'Runs in the copy before the agent starts, 10-minute ceiling, through the system shell with CI=1. Empty — by the root lockfile: pnpm-lock.yaml → pnpm install --frozen-lockfile --prefer-offline, package-lock.json → npm ci, yarn.lock → yarn install --immutable; no lockfile — nothing',
      bootstrapTitle: 'Copy preparation',
      bootstrap: {
        running: 'installing',
        ok: 'dependencies ready',
        failed: 'install failed',
      },
      bootstrapExit: 'exit code {{code}}',
      bootstrapTimedOut: 'stopped at the 10-minute ceiling',
      bootstrapLog: 'Log',
      bootstrapHideLog: 'Hide log',
      bootstrapFullLog: 'Full log',
      bootstrapEmptyLog: 'Nothing yet',
      bootstrapRerun: 'Retry install',
      bootstrapReverted: 'Lockfiles rewritten by the install were reverted: {{files}}',
    },
  },
  remote: {
    title: 'Remote access',
    on: 'on',
    off: 'off',
    explain:
      'The phone app connects to this very panel: same chat, same projects, same analytics. The panel stays on 127.0.0.1 — Tailscale carries it outside, not an open port.',
    enable: 'Require a token',
    enableHint:
      'While off, only this machine can reach the API. Once on, every request must carry the token, including requests from the browser on this same computer.',
    address: 'Outside address',
    addressHint: 'Saved on Enter or when the field loses focus.',
    loadError: 'Could not read the remote access state — the server did not answer.',
    serveOn: 'tailscale serve is running',
    serveOff: 'tailscale serve is not running',
    noTailscale: 'Tailscale not found — there is no outside address. Run tools/tailscale-serve.mjs',
    showPairing: 'Show pairing code',
    hidePairing: 'Hide code',
    rotate: 'Rotate token',
    test: 'Test notification',
    testSent: 'Sent to devices: {{count}}',
    noAddressHint:
      'Nothing to pair with while there is no address: the phone has nowhere to connect.',
    qrAlt: 'QR code with the panel address and token',
    qrHint: 'In the app: Settings → Pair. Point the camera at the code.',
    tokenWarning:
      'This token opens the entire panel API. Do not show the screen to others and do not paste the code into a chat.',
    tokenRotated: 'Token rotated — paired phones must connect again',
    notify: 'Send notifications to the phone',
    notifyHint:
      'Only the event kind (done, failed, permission needed, question asked) and the project folder name leave the machine. No text, no code.',
    devices: 'Devices',
    forget: 'Unpair',
  },
  projectConfig: {
    title: 'Projects — configuration',
    subtitle:
      "A specific project's rules, permissions and MCP servers: its CLAUDE.md, .claude/settings.json and .mcp.json. " +
      'Hooks, skills and rule files from .claude are shown read-only',
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
    tab_local: 'From the project',
    rulesHint: "The project's root CLAUDE.md in full — as Claude reads it in this project.",
    mcpHint: "The project's MCP servers from the root .mcp.json.",
    mcpEmpty: "The project's .mcp.json has no servers yet.",
    addMcp: 'Add server',
    permissionsHint:
      "The project's permissions from .claude/settings.json (and settings.local.json).",
    permissionsEmpty: "The project's settings.json has no permission rules yet.",
    addPermission: 'Add permission',
  },
  // The project's own .claude — the «From the project» tab and the block on a group card. Read-only.
  projectLocal: {
    hint: "Skills, hooks and rules from this project's .claude directory — Claude Code loads them together with the user-level ones. The panel only shows them: the set belongs to the project's git and is edited there, like the rest of the code.",
    readOnly: 'read-only',
    fromProject: 'From the project',
    skills: 'Skills',
    hooks: 'Hooks',
    rules: 'Rules',
    countSkills: 'skills: {{count}}',
    countHooks: 'hooks: {{count}}',
    countRules: 'rules: {{count}}',
    noDir: 'The project has no .claude directory',
    noDirText:
      "This is where Claude Code takes the project's own skills, hooks and rules from. Until the directory exists, only the user-level set applies in the project.",
    emptySkills: 'No skills in .claude/skills',
    emptyHooks: 'No hooks in .claude/settings.json',
    emptyRules: 'No rules in .claude/rules',
    files: 'files: {{count}}',
    skillDisabled: 'disabled',
    localSourceHint:
      "A hook from the project's personal .claude/settings.local.json — Claude Code reads it alongside the shared settings.json.",
    scriptMissing: 'script not found',
    pathsHint: 'The rule applies only to files matching these globs',
    showBody: 'Show text',
    hideBody: 'Hide text',
    expand: 'Show the set',
    collapse: 'Hide the set',
    loadError: "Could not read the project's .claude",
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
    introTitle: 'Welcome to AgentDeck',
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
    skip: 'Skip',
    stepOf: 'Step {{current}} of {{total}}',
    cannotSkip:
      'Point the panel at a working .claude folder first — without it there is nothing to show.',
    pathLabel: 'Path to the .claude folder',
    pathPlaceholder: 'For example ~/.claude or C:\\Users\\name\\.claude',
    apply: 'Apply',
    resetAuto: 'Auto-detect',
    pickerTitle: 'The .claude configuration folder',
    pickerHint: 'Find the .claude folder — it usually sits in your home directory.',
    providersLoading: 'Looking for installed CLIs…',
    providersError: 'Could not check the installed CLIs — the server did not answer.',
    providersChooseNamed: 'Choose {{name}}',
    accessTitle: 'Claude Code access',
    accessSubtitle: 'Needed only by the sandbox — chat and the sections work without it.',
    accessHint:
      'The panel checked where Claude Code takes its account access from. A green badge means it was found and nothing needs doing. If there is none, log in with the claude command in a terminal or set it by hand. This step can be skipped.',
    accessLoading: 'Checking access…',
    loadErrorTitle: 'The panel did not load',
    loadErrorText:
      'Could not read the panel settings — the server did not answer. Check that it is running and retry.',
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
    'checklistReason_panel-key': 'the contour key lives in the panel and never enters the archive',
    previewPlatforms: 'Panel contours ({{count}}) — settings without the key:',
    platformsTitle: 'Contours from the archive',
    platformsHint:
      'The contour setting travels, the key does not: it lives in the encrypted store of the panel and is entered again on the new machine.',
    platformsGateway: 'Also take the local gateway setting (port {{port}})',
    promptsTitle: 'Prompt edits from the archive',
    promptsHint:
      'Only your edits travel: built-in texts ship with the panel, and restoring never touches them.',
    promptBytes: '{{bytes}} B',
    promptUnknown: 'no such prompt in this panel — nowhere to write it',
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
    importDone: 'Entries written: {{count}}. Everything overwritten went into backups.',
    importKeysDropped:
      'Contours whose address changed had their key dropped: {{ids}}. Enter the key of the new address.',
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
    noProjects: 'Nowhere to run: the panel has not seen a single project with chats yet',
    title: 'Run in several projects',
    hint: 'One request — a separate agent in each selected project. Track them in the panel and by the tab dots.',
    prompt: 'What to do',
    promptPlaceholder: 'For example: do a code review and suggest fixes',
    pickProjects: 'Projects selected: {{count}}',
    launch: 'Run in {{count}}',
    cascade: {
      label: 'Run with:',
      model: 'Model for every run of the fan-out',
      effort: 'Effort for every run of the fan-out',
      loweredHint:
        'The model is below the conversation ceiling: the task gets a delivery bar — ' +
        'run the project checks, verify the result point by point, and stop and say so ' +
        'when the work turns out to be of another class. ' +
        'No review at the ceiling is started here: the stage pipeline only runs for ' +
        'split children, in their own copy of the branch.',
      ceilingWarn:
        'Agents at the ceiling at once: {{count}}. This is the most expensive launch ' +
        'the panel makes — nothing else eats the rate window faster. A lower rung adds ' +
        'a delivery bar to the task and leaves the window for the next piece of work.',
    },
  },
  bulkPresets: {
    hint: 'Tick the presets you need — I will create them all at once. Each can be edited afterwards.',
    createSelected: 'Create selected ({{count}})',
    creating: 'Creating… {{done}} of {{total}}',
  },
};
