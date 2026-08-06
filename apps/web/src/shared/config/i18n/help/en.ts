import type { HelpSchema } from './ru';

/** Типизирован по русской версии: забыть ключ при переводе не получится. */
export const helpEn: HelpSchema = {
  index: {
    subtitle: 'How every section of the panel works',
    lead:
      'The panel has no database of its own: everything you change here is a ' +
      'Claude Code configuration file on your disk. That is why each help ' +
      'article starts by naming the exact file it edits and when the change ' +
      'reaches Claude.',

    howTitle: 'How the app is put together',
    howCaption:
      'There is no database behind the panel, and two things follow from that. ' +
      'The same files can be edited by hand outside the panel, and almost every ' +
      'change reaches Claude only after a restart.',
    howPanel: 'The panel',
    howPanelCaption: 'forms, lists, assistant',
    howFiles: 'Files in ~/.claude',
    howFilesCaption: 'CLAUDE.md, settings.json, skills/…',
    howClaude: 'Claude Code',
    howClaudeCaption: 'reads them when a session starts',
    howEdgeWrite: 'write with a backup',
    howEdgeRestart: 'restart',

    helpTitle: 'How to use the help itself',
    helpButton: 'The “?” button on a page',
    helpButtonText:
      'Next to the heading of every section sits a question mark that opens the ' +
      'walkthrough for that section. The question usually comes up on the page itself, ' +
      'not in the contents.',
    helpLink: 'Links can be shared',
    helpLinkText:
      'The address of an article contains the section name, so a link to the right ' +
      'explanation can be sent to a colleague or saved. Links to a specific rule, skill ' +
      'or server inside the sections work the same way.',
    helpNav: 'Moving to the next section',
    helpNavText:
      'At the bottom of each article are links to the previous and next one. The help ' +
      'can be read straight through without going back to the contents.',
    helpAssistant: 'An assistant in almost every form',
    helpAssistantText:
      'Rules, skills, hooks, scripts, servers, permissions, variables, groups and ' +
      'scenarios can all be filled in by the assistant: describe the task in words and ' +
      'it returns ready fields. It runs on your subscription; no separate key is needed.',

    sectionsTitle: 'Sections',
    sectionsCaption: 'Each card is a detailed walkthrough of its section of the panel.',

    notFoundTitle: 'No such help article',
    notFoundText: 'The link may be out of date. Open the list of sections and pick one.',
  },

  common: {
    back: 'All sections',
    openSection: 'Go to the section',
    openHelp: 'Help for this section',
    storageTitle: 'Where this lives',
    fieldName: 'Field',
    fieldPurpose: 'What it controls',
    required: 'required',
    prevTopic: 'Previous section',
    nextTopic: 'Next section',
    canTitle: 'What you can do here',
    cantTitle: 'What is not here',
    whyTitle: 'Why this exists',
    howTitle: 'How it works',
    recipesTitle: 'How to do it',
    assistantTitle: 'The assistant',
    notesTitle: 'Things people trip over',
    onlyOnCreate: 'when creating only',
    readOnly: 'read only',
  },

  topics: {
    chat: {
      title: 'Chat',
      summary: 'The same claude CLI, plus several agents, projects and one shared history',
      lead:
        'Chat in the panel is not a separate bot and not a wrapper around the API. ' +
        'The panel runs the very same claude you use in the terminal and shows its ' +
        'output as it arrives. Everything else follows from that: conversations ' +
        'live in ordinary Claude Code transcripts, conversations started in the ' +
        'terminal show up here, and you pay through your own subscription rather ' +
        'than separately for the panel.',

      whyParallel: 'Several agents at once',
      whyParallelText:
        'Each project runs its own process. Switching tabs does not stop a run: ' +
        'start an agent in one project, move to another, and come back to a ' +
        'finished answer.',
      whyHistory: 'One place for the whole history',
      whyHistoryText:
        'The panel reads the same transcripts Claude Code writes. A conversation ' +
        'started in the terminal or in an editor shows up here — and the other way ' +
        'around.',
      whyVisible: 'You can see what is going on',
      whyVisibleText:
        'Coloured dots on tabs, the agents panel, the cost of a run, attachments ' +
        'and voice input — none of which the terminal has.',

      canParallel: 'Hold several conversations at once, across different projects',
      canQueue:
        'Add messages while the agent is busy: the send button no longer locks, the ' +
        'addition joins a queue above the input and goes into the same conversation ' +
        'as soon as the current turn ends',
      canProgress:
        "Watch the agent's plan: the strip above the input shows its own checkpoints " +
        '(done, in progress) and the tree of subagents it handed work to, together ' +
        'with what each one returned',
      canChatDots:
        'Tell conversations apart by the dots in the chat list: a project can hold ' +
        'several agents, and it is visible which one is waiting for an answer',
      canVolume:
        'Hear the agent louder: the agents panel has a notification volume (200% by ' +
        'default), and the browser tab is marked with a dot while an agent waits',
      canOpenFolder: 'Open any folder as a project, even one Claude has never worked in',
      canAttach: 'Attach files by dragging them in or with the paperclip',
      canVoice: 'Dictate a request by voice',
      canStop: 'Stop one agent or all of them at once',
      canEditor: 'Open the project in your code editor with one button',
      canContinue: 'Continue any past conversation, including ones started in the terminal',
      canFork:
        'Branch the conversation: editing your own message goes off as a new branch ' +
        'instead of appending to the same one',
      canRetry: 'Repeat a failed request with one button, without retyping it',
      canSpend: 'See what a run cost — in tokens or in money, your choice',
      canAnswerButtons: 'Answer an agent question by clicking an option',
      canModel: 'Pick a model and thinking depth — for the whole panel or for one chat',
      canApprove: 'Allow or deny a specific action right in the conversation',
      canSearchMessages:
        'Search the body of a conversation, not just its title and preview: the ' +
        '“By messages” switch in the chat list, with matches highlighted',
      canLoadMore:
        'Load earlier messages with the “Load more” button — a long conversation is ' +
        'not cut off at the last window',
      canExport: 'Export a conversation to a file — Markdown or JSON',
      canRun:
        'Start the project’s dev server right from its chat tab and jump to the address the ' +
        'server printed itself; in a monorepo — one target per package, several at once',
      canFreePort:
        'See who is holding the port you need (process name and PID) and free it with one ' +
        'button, together with a retry',
      canAutostart:
        'Tick the “Autostart” toggle on a target — its dev server comes up by itself on the ' +
        'panel’s next start, without opening a browser window',
      canGit:
        'See the current branch and the list of changed files, switch branches, create a ' +
        'new one, commit and pull — right from the tab, whenever the project has a .git',

      cantApprove:
        'Grant permissions in advance: the panel asks at the moment of the action, and ' +
        'the standing list of what is allowed lives in the Permissions section',
      cantDelete: 'Delete or rename conversations — transcripts are only ever read',
      cantEditPlan:
        "Edit the agent's plan from the panel: it keeps the checkpoints itself and " +
        'the panel shows their trace from the transcript — a tick here would drift ' +
        'from its own state',
      cantInterrupt:
        'Interrupt the current turn with an added message: the CLI runs the turn to ' +
        'the end, so the addition goes out at the turn boundary — wait, or press Stop',

      storageTranscripts: 'Transcripts',
      storageTranscriptsValue: '~/.claude/projects/<project-path>/<sessionId>.jsonl',
      storageWhatRuns: 'What is launched',
      storageWhatRunsValue: 'claude -p --output-format stream-json',
      storageSandbox: 'Chats outside a project',
      storageSandboxValue: '~/.claude-control/chats/<chat id>/',
      storageStream: 'How the answer arrives',
      storageStreamValue: 'as an SSE stream — text appears as it is generated',

      flowTitle: 'What happens when you send a message',
      flowCaption:
        'The prompt goes to the process through standard input rather than as a ' +
        'command-line argument: long text with quotes would otherwise fall apart in ' +
        'the Windows shell.',
      flowComposer: 'Composer',
      flowComposerCaption: 'text, files, edit mode',
      flowServer: 'POST /api/chat/send',
      flowServerCaption: 'picks the working directory',
      flowProcess: 'The claude process',
      flowProcessCaption: 'the same CLI as in the terminal',
      flowStream: 'Stream on screen',
      flowStreamCaption: 'text, thinking, tools',
      flowTranscript: 'Transcript',
      flowTranscriptCaption: 'the conversation is saved to disk',

      tabsTitle: 'Tabs and projects',
      tabsCaption:
        'The project list does not scan your disk: it is assembled from transcripts ' +
        'already read, by the directory the conversation ran in.',
      tabHome: 'The home “Chats” tab',
      tabHomeText:
        'Conversations without a project. They run in a separate panel folder — ' +
        'Claude Code treats ~/.claude as protected and will not write inside it.',
      tabProject: 'A project tab',
      tabProjectText:
        'The conversation runs right inside the project directory. Only that ' +
        "project's chats are listed, and a new chat is pre-filled with “look around " +
        'and tell me what this project is”.',
      tabAdd: 'Add a folder',
      tabAddText:
        'The button in the project list opens a directory picker across your drives. ' +
        'That is how you start in a folder Claude has never run in.',
      tabsNote:
        'Tabs survive a page reload, and closing a tab closes only the tab — neither ' +
        'chats nor files are touched.',

      toolsTitle: 'The project row: dev server and git',
      toolsCaption:
        'All of it lives in the project tab header and works against the real directory ' +
        'on disk — the panel keeps no copy of the state.',
      toolsRun: 'Starting the dev server',
      toolsRunText:
        'The “Start” button runs the command from package.json (dev, otherwise start) or ' +
        'your own — with the package manager the project actually uses: pnpm, yarn or npm. ' +
        'The panel does NOT assign the port: the app comes up on its own, the panel reads ' +
        'the address from its output and opens the browser once the port answers. A ' +
        'monorepo has several targets — the gear next to the button lists the packages, and ' +
        'they can run at the same time.',
      toolsPort: 'Port already taken',
      toolsPortText:
        'When the server refuses to start (“Port 5173 is already in use”), the panel shows ' +
        'who holds the port — process name and PID — and a “Free it and start” button. It ' +
        'kills nothing on its own: a database or a neighbouring project may live there, so ' +
        'the call stays yours. A port can also be pinned in the target’s settings — then the ' +
        'panel passes PORT and waits for exactly that one.',
      toolsAutostart: 'The “Autostart” toggle',
      toolsAutostartText:
        'It is not about now but about the panel’s next start: a ticked target comes up ' +
        'by itself, with no browser window and no navigation. Close the project tab and the ' +
        'toggle clears on all of its targets.',
      toolsGit: 'Branch, files, commit and pull',
      toolsGitText:
        'The button with the current branch name shows up only when the project has a ' +
        '.git. It carries two numbers: how many files changed and by how many commits you ' +
        'are behind the remote. Everything else opens under it — the list of changed files ' +
        '(the letter on the left: A added, M modified, D deleted, R renamed, ? outside git, ' +
        'U conflict), the list of local branches, the pull row, a “new branch” field and a ' +
        'commit message field.',
      toolsPull: 'The Pull button',
      toolsPullText:
        'By default it pulls into the current branch through its upstream — a plain git ' +
        'pull. The select next to it picks another source: a specific remote branch, which ' +
        'runs git pull origin <branch>. The list holds only branches git has already seen ' +
        'on the remote; the panel pulls no arbitrary ref.',
      toolsNote:
        'A commit takes every change (git add -A) and lands on the current branch. Pull is ' +
        'the only operation that reaches the network and may merge: on a conflict the ' +
        'working tree stays in conflict and you sort it out in a terminal. The panel never ' +
        'pushes or deletes branches.',

      dotsTitle: 'Coloured dots: what the agent is doing',
      dotsCaption:
        'The dot sits on the project tab and in the project list. For a project with ' +
        'several runs, the most alarming state is shown.',
      dotGreen: 'Green',
      dotGreenText: 'The agent is working. The dot pulses while events keep arriving.',
      dotYellow: 'Yellow',
      dotYellowText:
        'The agent asked a question or wants permission and is waiting. A question ' +
        'shows up even for a conversation the panel did not start: it is read from ' +
        'the transcript, so an agent in a terminal or another window calls too.',
      dotRed: 'Red',
      dotRedText:
        'An error, a rate limit — or a stalled run: if no events arrive for two ' +
        'minutes, the panel treats the run as broken and turns the dot red.',
      dotNone: 'No dot',
      dotNoneText: 'Nothing is running in this project right now.',

      panelTitle: 'The agents panel and parallel launch',
      panelAgents: 'Agents panel',
      panelAgentsText:
        'A button in the chat header with a counter. Inside are all active runs, ' +
        'sorted by how alarming they are: errors first, then those waiting for a ' +
        'reply, then those working. Each row shows the project, status, spending and a ' +
        'stop button. Clicking a row opens that project’s tab and shows the live ' +
        'stream of that agent. At the bottom: the session total across all runs.',
      panelParallel: 'Run in several projects',
      panelParallelText:
        'The button lives in the project list on the home tab, not in the header. One ' +
        'request goes to several projects at once: tick the projects, write the task, ' +
        'and an agent starts in each. The window has its own edit toggle, switched off ' +
        'every time it opens. Handy for sweeps like “check every repository for X”.',
      panelNote:
        'Projects missing from disk are not listed at all and never reach a parallel ' +
        'launch: there is nowhere to work in a folder that no longer exists. The ' +
        'conversations survive — find them through the chat search.',

      composerTitle: 'What the input field can do',
      composerEnter: 'Enter and Shift+Enter',
      composerEnterText: 'Enter sends the message, Shift+Enter adds a line break.',
      composerVoice: 'Voice input',
      composerVoiceText:
        'The microphone button starts dictation with a sound track. What you dictate ' +
        'is appended to what you already typed rather than replacing it. It works ' +
        'where the browser supports speech recognition — otherwise the button is off.',
      composerFiles: 'Attachments',
      composerFilesText:
        'The paperclip or a drag onto the field. Up to 20 MB per file; images, PDF, ' +
        'markdown, text, tables, code. The file is stored in a panel folder, and ' +
        'Claude gets the path and reads it from disk itself.',
      composerChips: 'Quick action chips',
      composerChipsText:
        'In an empty chat — ready-made openings: in a project that means review, ' +
        'bug hunting, a structure walkthrough, tests. A chip fills the field but does ' +
        'not send: you can add to it first. Next to them sits a separate “Open in ' +
        'editor” chip — not about the conversation, it just opens the project.',
      composerStop: 'Stop',
      composerStopText: 'While an answer is streaming, the send button becomes a stop button.',

      editsTitle: 'Edit mode: what the agent may change',
      editsCaption:
        'The toggle appears only inside a project: outside one, edits are always ' +
        'allowed because there the files are the result of the work. Inside a project ' +
        'edits are allowed by default too, so check where the toggle stands before ' +
        'giving a task in an unfamiliar repository.',
      editsOff: 'Read only',
      editsOffCaption: 'toggle switched off',
      editsMode: 'permission-mode default',
      editsModeCaption: 'reading, search, analysis',
      editsResult: 'Edits do not go through',
      editsResultCaption: 'there is nowhere to confirm them',
      editsOn: 'Edits allowed',
      editsOnCaption: 'the default position',
      editsOnMode: 'permission-mode acceptEdits',
      editsOnModeCaption: 'edits without asking',
      editsOnResult: 'Project files change',
      editsOnResultCaption: 'the agent writes to disk',
      editsResetTitle: 'The toggle remembers where you left it',
      editsResetText:
        'Its position survives tab switches, other chats and page reloads: it used to ' +
        'reset on every refresh, and the agent stalled over nothing. The flip side is ' +
        'that switching it off is a deliberate act — it never returns to read-only on ' +
        'its own. The exception is the parallel launch window: it has its own toggle, ' +
        'switched off every time it opens.',

      autoApproveTitle: 'Auto-approving permissions',
      autoApproveText:
        'The second toggle in the chat header — «Permissions auto» — takes the routine ' +
        'away: a safe request is approved by the panel itself, and no ' +
        '«Allow/Deny» card appears. What still asks: git writes (commit, push, merge, ' +
        'reset), deleting and overwriting files, migrations and database queries, ' +
        'deployment, MCP writes (issue, MR, wiki page) — and anything covered by your ' +
        'own ask and deny rules from settings.json. An unclear case goes to a human ' +
        'too: a command the panel could not parse counts as dangerous. With edits ' +
        'switched off, file edits stay yours even when auto-approval is on. The ' +
        'toggle takes effect immediately, mid-run included, and its position is ' +
        'remembered.',

      historyTitle: 'How a conversation continues',
      historyCaption:
        'The chat identifier is the transcript file name. That is what the ' +
        'conversation is resumed by.',
      historyId: 'chat id',
      historyIdCaption: 'also the sessionId',
      historyResume: '--resume <id>',
      historyResumeCaption: 'the CLI brings the past session back',
      historyCwd: 'Working directory',
      historyCwdCaption: 'taken from the transcript itself',
      historyFolderTitle: 'A session is bound to its directory',
      historyFolderText:
        'A conversation can only be continued from the folder it started in: the CLI ' +
        'looks for the session among the sessions of the current directory. That is ' +
        'why a chat folder is never renamed, and if the project directory is gone ' +
        'from disk the panel says plainly that there is nothing to continue.',

      retryTitle: 'When a run fails',
      retryCaption:
        'On an error two buttons appear in the header. Both repeat the last request — ' +
        'there is nothing to retype.',
      retryRepeat: 'Retry',
      retryRepeatText:
        'The same request with the same permissions. Useful when the cause was ' +
        'external: the network dropped, a limit was hit, the process died.',
      retryFull: 'Allow and continue',
      retryFullText:
        'The same request but with full access: the agent does everything without ' +
        'asking. The button for when the run stalled on permissions specifically.',
      retryNoteTitle: 'Full access really does mean full access',
      retryNoteText:
        'In that mode neither the edit toggle nor the rules from the Permissions ' +
        'section apply: the agent does whatever it decides to. Worth pressing when ' +
        'you know exactly what it stalled on.',

      spendTitle: 'What it cost',
      spendCaption:
        'Spending is shown in tokens — visible without an API subscription. You can ' +
        'switch it to money in the panel settings.',
      spendRun: 'The badge in the header',
      spendRunText:
        'The current run: tokens or dollars, depending on the chosen unit. It updates ' +
        'as the answer streams.',
      spendSession: '“Session total” in the agents panel',
      spendSessionText:
        'Everything across all runs in the session. The server keeps the count, so ' +
        'reloading the tab does not reset it — the client just pulls the value again.',
      spendLimit: 'The limit badge',
      spendLimitText:
        'Appears only when a limit was hit: it shows when the limit resets. How much of ' +
        'the limit is left cannot be found out locally.',
      spendStep: 'The numbers to the right of an action',
      spendStepText:
        'The price of every step, right in the feed: the muted number is the whole ' +
        'volume that went through the model, the accented one is the new work of that ' +
        'step (fresh input, cache writes, generation). They are split because the full ' +
        'volume is roughly the size of the context on almost every step and consists ' +
        'mostly of cache reads: a cheap action cannot be told from an expensive one by ' +
        'it. Hover the numbers for the breakdown by token kind with shares, the model ' +
        'of that step and the cost at its rate; a click pins the panel. The model ' +
        'counts spend per STEP, so several calls made at once share one number — the ' +
        'panel says so outright instead of splitting it evenly.',

      recipesTitle: 'How to start working with a project',
      recipe1: 'Open the project',
      recipe1Text:
        'The “Chats” tab → the “Projects” section → the project you need. Not in the ' +
        'list? Use “Add a folder” and pick the directory on disk.',
      recipe2: 'Check the edit toggle',
      recipe2Text:
        'It is in the header and switched on by default. To look around first, move it ' +
        'to read-only: the field already holds a question about the project, so send ' +
        'it as is.',
      recipe3: 'Give the task',
      recipe3Text:
        'Once it is clear what to change and where, switch edits back on. The toggle ' +
        'keeps that position until you change it again.',
      recipe4: 'Go do something else',
      recipe4Text:
        'The run does not stop when you switch tabs. When a background agent finishes, ' +
        'asks a question or fails, a notification arrives in its own colour — green, ' +
        'yellow or red. Clicking it opens the project in question.',

      notesTitle: 'Things people trip over',
      noteTabTitle: 'Reloading the page does not kill the agent',
      noteTabText:
        'The process belongs to the server, not to the tab: closing the tab or pressing ' +
        'F5 only detaches the listener. Come back and a running job is picked up, with ' +
        'the stream catching up on what you missed. The accumulated session spend now ' +
        'survives a reload too: the server keeps the count and the tab just pulls it. A ' +
        'run that finished while the page was away comes back to the feed if you return ' +
        'within a grace minute; later, look for the answer in the conversation history.',
      noteQuestionTitle: 'An option is picked with a click',
      noteQuestionText:
        'The card draws the options as buttons: a click sends the chosen text as an ' +
        'ordinary message into the same conversation. While the agent is busy the ' +
        'buttons are disabled — wait for the reply or stop the run. If none of the ' +
        'options fits, type your own answer as usual.',
      noteOutsideTitle: 'A question calls even from a conversation the panel did not start',
      noteOutsideText:
        'The dot, the browser badge and the sound are raised from the transcript, so ' +
        'an agent in a terminal or a neighbouring window calls too: the sound plays ' +
        'once per new question, and the dot stays until you answer. A permission ' +
        'request is not visible this way — it lives only inside the process and never ' +
        'reaches the transcript before it is decided, so the panel knows about it only ' +
        'for its own runs.',
      noteArtifactsTitle: 'The list of created files exists only for chats outside a project',
      noteArtifactsText:
        'Inside a real project the panel deliberately does not show it: dumping a ' +
        'whole repository as a list of “created files” would be useless.',
      noteLimitTitle: 'Spending is shown per run, not for all time',
      noteLimitText:
        'The badge in the header is the current run; “session total” in the agents ' +
        'panel is everything since the page loaded. History across days and the ' +
        'breakdown by model live in the Analytics section.',
      noteMemoryTitle: 'A background agent’s answer is in the history, not the stream',
      noteMemoryText:
        'When a background run ends, the panel frees memory and drops the accumulated ' +
        'stream: the answer is already saved in the transcript. The status and any ' +
        'error text stay.',
      noteHistoryTitle: 'The last 400 messages are shown',
      noteHistoryText:
        'Very long conversations are trimmed from the top: transcripts run to hundreds ' +
        'of megabytes, and there is nothing to read them whole with in a browser.',
      noteLiveTitle: 'A conversation running outside the panel is picked up on its own',
      noteLiveText:
        'The same chat can be driven from a terminal or an editor extension — such a ' +
        'turn has no event stream of its own. The feed still updates: the server ' +
        'watches transcript files and reports changes, and the panel additionally asks ' +
        'for the fingerprint of the open conversation every few seconds — in case file ' +
        'watching is switched off in settings or the stream broke. No page reload needed.',
      noteProviderTitle: 'Other providers have a chat of their own',
      noteProviderText:
        'With a non-Claude provider active, the Chat section shows its own chat: a list of ' +
        'conversations, memory between questions, the reply as the CLI prints it, a working ' +
        'directory and file attachments by path. The panel keeps the transcript there — these ' +
        'CLIs have no readable history of their own — and the context of the next question is ' +
        'assembled from it. What is missing: parsed steps and tools, cost, branching, voice and ' +
        'parallel agents — all of that is read out of the claude streaming protocol, and no ' +
        'other CLI publishes such a format. OpenCode holds a session (opencode serve) instead ' +
        'of a run per question, so its answer arrives whole. The Aider, OpenCode, Continue, ' +
        'Goose and Kimi Code chats are built from the docs and have not been exercised live — ' +
        'those CLIs are not installed on the development machine. Cursor has neither a ' +
        'non-interactive entry point nor a model API of its own.',
    },

    overview: {
      title: 'Overview',
      summary: 'What is wired in right now, and where the configuration was found',
      lead:
        'The start page answers two questions: which configuration directory was found ' +
        'and what is in it. It is the one place where problems that otherwise stay ' +
        'silent become visible: a hook whose script is missing, a script bound to ' +
        'nothing, and the wrong settings directory.',

      whyWhere: 'It shows what you are writing to',
      whyWhereText:
        'The panel can work with several configuration directories. If empty or ' +
        'unfamiliar settings open, the answer is here: which path was chosen and by ' +
        'which rule.',
      whyBroken: 'It catches silent breakage',
      whyBrokenText:
        'A hook with a broken path raises no error — it simply never fires. On the ' +
        'overview that tile turns red, and that is the only signal you get.',
      whyEntry: 'A way into the sections',
      whyEntryText:
        'Every tile is a link. The scale is visible too: how many rules there are, how ' +
        'many are on, how many scripts are unused.',

      canSee: 'See how many settings of each kind exist and how many are enabled',
      canPath: 'Check the configuration directory and which rule selected it',
      canMissing: 'Find out which configuration files are missing',
      canBroken: 'Spot broken hooks, failed MCP servers and unused scripts',
      canBackups: 'See the number of backups and the date of the last one',
      canChanges: 'See a “changed in the last N days” summary that links into the change history',
      canJump: 'Jump into a section or fire a quick action straight from a tile',

      cantEdit:
        'Edit settings right here: a tile leads into a section rather than editing in place',
      cantDeep: 'Work out why one particular setting misbehaves: that lives in its own section',

      sourceTitle: 'Where the configuration directory comes from',
      sourceCaption:
        'Checked in order; the first match wins. Hence a common story: the path was set ' +
        'by hand once and now overrides the environment variable.',
      sourceTop: 'stronger',
      sourceManual: 'a path set in the panel settings',
      sourceEnv: 'the CLAUDE_CONFIG_DIR environment variable',
      sourceHome: 'the ordinary ~/.claude directory',
      sourceNote:
        'If the overview shows zeroes everywhere, start here: most likely the wrong ' +
        'directory was found. The path is changed in the panel settings and applies at once.',

      tilesTitle: 'What the tiles mean',
      tileRules: 'Rules, skills, hooks',
      tileRulesText:
        'Three separate tiles. Each shows the total and how many are on: the gap ' +
        'between the numbers is what sits disabled and has no effect.',
      tileScripts: 'Scripts',
      tileScriptsText:
        'How many files are in the directory and how many are bound to no hook. An ' +
        'unbound file is usually a forgotten setting. When every one is bound, the ' +
        'caption says so.',
      tileHooksBroken: 'Hooks in red',
      tileHooksBrokenText:
        'The tile turns red when a hook’s script is missing from disk. Such a hook fails ' +
        'silently, and nothing else reports it.',
      tileMcp: 'MCP servers and permissions',
      tileMcpText:
        'The number of connected servers and the total count of permission rules, split ' +
        'into allowed and denied.',
      tileGroups: 'Groups',
      tileGroupsText:
        'How many setting bundles exist. While there are none, the caption says so ' +
        'plainly — the tile does not look broken.',

      notesTitle: 'Things people trip over',
      noteZeroTitle: 'Zeroes everywhere almost always means the wrong directory',
      noteZeroText:
        'Look at the directory card: it states which path was chosen and by which rule. A ' +
        'manually set path overrides the environment variable.',
      noteLiveTitle: 'The numbers are counted on the fly',
      noteLiveText:
        'The panel has no database: configuration files are re-read every time the page ' +
        'opens. Hand edits show up immediately.',
      noteMissingTitle: '“Missing files” is not always a problem',
      noteMissingText:
        'Some configuration files are created on first use. An empty rule list only means ' +
        'CLAUDE.md has not been started yet.',
    },

    analytics: {
      title: 'Analytics',
      summary: 'Token usage and activity, counted from local transcripts',
      lead:
        'This section counts from your own files rather than from Anthropic’s data: every ' +
        'model answer in a transcript carries usage information, and the panel adds it up. ' +
        'That is both its strength and its limit: everything that happened on this machine ' +
        'is visible, and nothing that happened on another one.',

      whyLocal: 'Counted from your files',
      whyLocalText:
        'No requests go anywhere and no keys are needed: the source is the transcripts on ' +
        'disk. It works offline.',
      whyWhere: 'Shows where the usage goes',
      whyWhereText:
        'Broken down by day, model, project, hour and tool. One glance is usually enough to ' +
        'see which project eats the most.',
      whyCache: 'Shows what the cache saves',
      whyCacheText:
        'The share read from cache is counted separately. A high share means long ' +
        'conversations cost less than their size suggests.',

      canPeriod:
        'Switch the period: today by default (since midnight), plus a week, ' +
        'a month, a quarter, all time, or custom dates. In the calendar one ' +
        'click reports on that single day, a second click stretches it into a ' +
        'range; "Reset" returns to the default period',
      canDetail: 'Open the detail for a model or a project by clicking its bar',
      canLive: 'See the Claude Code processes actually running now and their memory use',
      canTools: 'See which tools and skills come up most often',
      canSessions: 'Find recent conversations with their git branches and size',
      canExport: 'Export the report to a file — CSV or JSON',

      cantLimits:
        'See what is left of your subscription limits: that lives on Anthropic servers and ' +
        'is not available locally',
      cantBill:
        'See a real bill: this is tokens converted at the Anthropic price list, not an ' +
        'invoice — discounts, batch rates and account-specific terms are not included',
      cantOther: 'Include work from another machine: only the transcripts of this one are counted',

      storageSource: 'Source',
      storageSourceValue: '~/.claude/projects/**/*.jsonl — conversation transcripts',
      storageWhat: 'What is taken from a file',
      storageWhatValue: 'the usage information attached to every model answer',
      storageCache: 'Caching',
      storageCacheValue: 'the summary is cached for a minute; live processes refresh faster',
      storageSkills: 'Skills',
      storageSkillsValue: 'call statistics come from ~/.claude.json',

      flowTitle: 'How the numbers are produced',
      flowCaption:
        'Files can be enormous, so very large transcripts are not read whole: the start and ' +
        'the end are taken. That barely moves the totals and saves the page from a ' +
        'multi-second wait.',
      flowFiles: 'Transcripts',
      flowFilesCaption: 'conversation files on disk',
      flowScan: 'Scan and parse',
      flowScanCaption: 'usage data from answers',
      flowSum: 'Adding up',
      flowSumCaption: 'by day, model and project',
      flowView: 'Charts',
      flowViewCaption: 'what you see on the page',

      metricsTitle: 'What the numbers mean',
      metricTotal: 'Total tokens',
      metricTotalText:
        'The sum of four kinds: input, output, read from cache and written to cache. One ' +
        'request almost always spends several kinds at once.',
      metricCache: 'Cache share',
      metricCacheText:
        'How much of the input came from cache instead of being counted afresh. The higher ' +
        'it is, the cheaper long conversations become.',
      metricCost: 'Cost estimate',
      metricCostText:
        'Tokens converted at API rates. It is a reference figure: on a subscription no money ' +
        'is charged for these requests. The panel pulls the price list from the Anthropic site ' +
        'when you open Settings (at most once a day) and prices each record at the model version ' +
        'named in the transcript: Opus 4.1 costs three times Opus 4.8. Rates are visible and ' +
        'editable there if your terms differ. Cache writes use two rates: the 1-hour cache ' +
        'costs 1.6× the 5-minute one in the price list, and in transcripts almost all writes ' +
        'go to it. Your own price is used exactly as typed and is never scaled.',
      metricRequests: 'Requests and active sessions',
      metricRequestsText:
        'How many calls to the model happened in the period, and how many ' +
        'conversations are running right now. Useful when the token count is high and ' +
        'it is unclear whether that is many conversations or one long one.',
      metricOutput: 'Output tokens',
      metricOutputText:
        'A separate tile: how much the model wrote. This part grows with long answers, ' +
        'while the input part grows with the size of the context.',
      metricHours: 'The hourly chart',
      metricHoursText:
        'The only chart about your routine: which hours of the day the work happens in. ' +
        'Good for noticing that half the spending comes from night-time runs.',
      metricScan: 'The scan line at the bottom',
      metricScanText:
        'How many files the panel walked and in how many milliseconds. It also explains ' +
        'why numbers from giant transcripts are approximate — they are read in parts.',
      metricSessions: 'Sessions',
      metricSessionsText:
        'Conversations in the period with their project, git branches and size. Active ones ' +
        'are marked separately.',

      liveTitle: 'Live agents',
      liveCaption:
        'The one block that shows the present rather than history: Claude Code processes ' +
        'actually running, with their memory use and start time. Agents are recognised ' +
        'by their command line rather than by process name, so runs of a CLI installed ' +
        'through npm show up too.',

      notesTitle: 'Things people trip over',
      noteLimitsTitle: 'Remaining subscription limits cannot be shown',
      noteLimitsText:
        'They live on Anthropic servers and never reach local files. All that is ever ' +
        'visible is the reset time, and only when a limit was hit in the chat itself.',
      noteCostTitle: 'The cost is an estimate, not a bill',
      noteCostText:
        'Tokens are converted at API rates. On a subscription those amounts are never ' +
        'charged: the figure is for comparing projects with each other.',
      noteBigTitle: 'Very large transcripts are read in part',
      noteBigText:
        'For files beyond a few megabytes the start and the end are taken. Otherwise opening ' +
        'the page would take tens of seconds.',
      noteLiveTitle: 'Agents are found by command line, not by process name',
      noteLiveText:
        'A CLI installed through npm runs as node — there is simply no process named ' +
        'claude on the system. While the panel searched by name, the Live agents ' +
        'block stayed almost always empty even while agents were working. The command ' +
        'line is parsed now, and those runs are found. The panel leaves itself out of ' +
        'the list, and the start time is shown only on Windows: on other systems there ' +
        'is nowhere to take it from.',
      noteScopeTitle: 'Only this machine is counted',
      noteScopeText:
        'Work from another computer or another configuration directory will not appear in ' +
        'these numbers.',
    },

    settings: {
      title: 'Settings',
      summary: 'The panel’s own settings, the configuration path, and sandbox access',
      lead:
        'The one section that edits the panel’s settings rather than the Claude Code ' +
        'configuration. It also holds two things everything else depends on: the path to ' +
        'the configuration directory, and account access for the sandbox.',

      whyPath: 'It decides what you are working with',
      whyPathText:
        'The configuration directory determines which rules, skills and hooks the panel ' +
        'sees. It is changed here and applies at once, without a restart.',
      whySandbox: 'It brings the sandbox to life',
      whySandboxText:
        'The sandbox runs Claude with a separate settings directory that your normal access ' +
        'does not reach. The access card exists precisely for that.',
      whyComfort: 'It fits the panel to you',
      whyComfortText:
        'Theme, language, large text, reduced motion, higher contrast — and the editor your ' +
        'projects open in.',

      canPath: 'Set the configuration directory by hand and switch between sets',
      canTheme: 'Pick a theme, a language and accessibility options',
      canEditor: 'Pick a code editor from those found on the system, or give your own command',
      canCreds: 'Set account access by hand when it is not found automatically',
      canSpendUnit: 'Choose how spending is shown: in tokens or in money',
      canBackup: 'Turn on a backup before every write and set how many to keep',
      canEncrypt:
        'Encrypt .mcp-secrets.env backups with the encryptSecretBackups setting: ' +
        'AES-256-GCM under a passphrase, so token backups do not sit in plain text',
      canRevertHunk: 'Revert a single change out of a backup without bringing back the whole file',
      canTransfer:
        'Move the panel settings to another machine: export and import the state.json file',
      canEnvTransfer:
        'Pack any provider’s environment into an archive and unpack it on another machine',
      canModels: 'Refresh the provider’s model list and move the default onto a newer model',
      canCheck:
        'Check a provider on this machine: a read-write round trip on a config copy plus ' +
        'one assistant launch',
      canPreview: 'Show a diff before writing into another CLI’s configuration',
      canWatch: 'Watch the files and refresh the interface when they change outside the panel',

      cantLogin: 'Sign in to a Claude account: authentication is the CLI’s job',
      cantToken: 'See the token: the server reports only the source of access, never the value',
      cantSync:
        'Sync settings between machines automatically: there is no live sync, only a ' +
        'manual file transfer',
      cantChange:
        'Edit Claude Code settings field by field: this section is about the panel itself, ' +
        'while the configuration is edited in its own sections',

      storageApp: 'Panel settings',
      storageAppValue: 'stored apart from the Claude Code configuration',
      storageManual: 'Manual access',
      storageManualValue: '~/.claude-control/credentials.json',
      storageBackups: 'Backups',
      storageBackupsValue: '~/.claude/claude-control/backups/',
      storageApply: 'When it applies',
      storageApplyValue: 'at once: changing the directory needs no restart',

      cardsTitle: 'The cards',
      cardAccount: 'Account',
      cardAccountText:
        'Whose account is in use: email, organisation, subscription type. Taken from the same ' +
        'configuration Claude Code authenticates with.',
      cardDir: 'Configuration directory',
      cardDirText:
        'The path and a badge for the source: detected automatically, taken from an ' +
        'environment variable, or set by hand. A change applies immediately.',
      cardCreds: 'Claude Code access',
      cardCredsText:
        'Needed by exactly one thing — the sandbox. The token is never shown: the panel knows ' +
        'only the source of access, and the reason when there is none.',
      cardEditor: 'Code editor',
      cardEditorText:
        'Editors installed on the system are highlighted, missing ones are dimmed. “Auto” ' +
        'takes the first one found, but you can give your own command.',

      credsTitle: 'Where sandbox access comes from',
      credsCaption:
        'Checked in order; the first one found wins. The difference between systems matters ' +
        'here.',
      credsTop: 'stronger',
      credsManual: 'set by hand in this section',
      credsFile: 'the access file in the configuration directory',
      credsKeychain: 'the macOS keychain',
      credsApiKey: 'an environment variable with an API key',
      credsNote:
        'On Windows and Linux access sits in a file. On macOS there is no file — Claude Code ' +
        'keeps it in the keychain, and the system asks for permission on first use. So ' +
        '“Not logged in” in the sandbox while the chat works is not an account problem.',

      fieldsTitle: 'What you can switch',
      fieldsCaption: 'Every switch saves immediately; there is no save button here.',
      fieldTheme: 'The colour theme: light, dark, or follow the system.',
      fieldLanguage: 'The interface language.',
      fieldDir: 'The path to the configuration directory. Empty means detect it automatically.',
      fieldReveal: 'Show secret values straight away, without clicking the eye.',
      fieldBackup: 'Make a backup of the file before every write.',
      fieldEncrypt:
        'Encrypt .mcp-secrets.env backups (AES-256-GCM under a passphrase). Off by ' +
        'default, and then secret backups sit in plain text. While encryption is on ' +
        'and the passphrase has not been re-entered after a server restart, editing ' +
        'secrets and restoring a backup over them are refused: no copy can be made, ' +
        'writing it in plain text is not allowed, so the panel will not overwrite ' +
        'tokens with no way back.',
      fieldWatch: 'Watch the files and refresh the interface on outside changes.',
      fieldA11y: 'Large text, less motion, higher contrast.',
      fieldEditor: 'The code editor command. Empty means the first one found on the system.',
      fieldCostUnit:
        'How spending is shown in the chat: tokens (the default) or money. Tokens are ' +
        'always visible, while the dollar figure is an estimate at API rates and is ' +
        'never charged on a subscription.',

      modelsTitle: 'Provider models',
      modelsCaption:
        'The model list used to be hard-coded into the panel and went stale silently: ' +
        'a model shipped, and there was nowhere to pick it. Now the panel asks a catalog.',
      modelsWhere: 'Where the list comes from',
      modelsWhereText:
        'The open models.dev catalog — the same one OpenCode runs on. The request goes ' +
        'out no more than once a day, everything else comes from the cache; with no ' +
        'network the previous list is shown with its age.',
      modelsAuto: 'A new model as the default',
      modelsAutoText:
        'When a CONCRETE model is set in the settings and a newer generation of the same ' +
        'family ships, the panel moves the default itself and says so. An alias (opus) is ' +
        'left alone: the CLI already expands it to the latest model.',
      modelsWho: 'Who has one',
      modelsWhoText:
        'Claude, Codex, Gemini, Qwen Code, Kimi Code and OpenCode — their vendor is known. ' +
        'Continue, Goose, Aider and Cursor run on top of any model, so no catalog is shown ' +
        'for them: the panel will not guess whose list to use.',
      modelsOff: 'How to turn it off',
      modelsOffText:
        'The “update the model list automatically” toggle in the same card. Off — no network ' +
        'requests at all, the list refreshes only by button, and the default never changes.',

      checkTitle: 'Provider check',
      checkCaption:
        'Nine of the ten CLIs are marked experimental: their formats come from the docs, ' +
        'but the panel has never executed them on your machine. The button turns that ' +
        'promise into a fact.',
      checkWhat: 'What it does',
      checkWhatText:
        'Looks for the CLI in PATH, checks the configuration files, performs a ' +
        'read-write-read round trip for every supported section and asks the assistant ' +
        'for one short reply.',
      checkSafe: 'What it does NOT do',
      checkSafeText:
        'It does not write to your files. The round trip runs on a temporary copy of the ' +
        'configuration, and the copy is deleted right after — the original stays byte for byte.',
      checkResult: 'What the result means',
      checkResultText:
        '“Verified here” — every step passed, including the model reply. “Partial” — no ' +
        'failures, but something was skipped: no CLI, or the assistant launch was off. ' +
        '“Check failed” — a step failed, and its reason is spelled out.',
      checkBadge: 'Where the result shows',
      checkBadgeText:
        'In the provider selector card and as a strip above EVERY section: another CLI’s ' +
        'settings are edited outside the selector page, and knowing whose format is being ' +
        'written matters there. Claude has no strip — it is the default and stays quiet.',

      formatTitle: 'Format check against schemas',
      formatCaption:
        'The panel writes other CLIs’ configuration from their documentation, and ' +
        'documentation drifts with releases. This check asks the same question in advance — ' +
        'before a broken CLI asks it for you.',
      formatWhat: 'What it does',
      formatWhatText:
        'Downloads the CLI’s officially published schema and verifies that every key the ' +
        'panel actually edits is present in it. OUR keys are compared against the schema — ' +
        'your own config is neither read nor touched.',
      formatWho: 'Why not everyone is checked',
      formatWhoText:
        'The check is possible where a schema is published at a documented address. Today ' +
        'that is OpenCode only. The rest say “no schema” — an honest answer rather than ' +
        '“all good”: an invented schema URL would be worse than a missing one.',
      formatDrift: 'What to do about a mismatch',
      formatDriftText:
        'Nothing urgent: a mismatch blocks nothing and fixes nothing. It means the key is ' +
        'no longer listed in the schema — worth checking the CLI’s documentation before the ' +
        'next write into that section.',
      formatWhen: 'How often',
      formatWhenText:
        'At most once a week and never on your path: the section opens from cache and a ' +
        'stale result refreshes in the background. “Check now” is the only place where the ' +
        'answer waits for the network.',

      previewTitle: 'Preview of a write into another CLI’s config',
      previewCaption:
        'Another CLI’s configuration was written by hand, and “Save” used to show nothing ' +
        'until it was too late. A diff now stands between the button and the file.',
      previewWhen: 'When it appears',
      previewWhenText:
        'On any write into a foreign provider’s sections: MCP, permissions, variables, ' +
        'instructions. Claude has no preview — it is the panel’s default, its formats are ' +
        'verified, and an extra question would be noise.',
      previewHow: 'Where the diff comes from',
      previewHowText:
        'Not a prediction: the panel copies your file into a temporary directory, performs ' +
        'the REAL write on the copy with the same code, reads the result and deletes the ' +
        'copy. What you see is exactly what lands in the file.',
      previewRead: 'How to read it',
      previewReadText:
        'Green with “+” will appear, red with “−” will disappear, grey is the surrounding ' +
        'context. The file path and a line counter sit on top; if the file does not exist ' +
        'yet, it says so.',
      previewOff: 'How to turn it off',
      previewOffText:
        'The “show a diff before writing” toggle in the safety card. Off — the write goes ' +
        'straight through, as before. A backup is still made either way: that is a separate ' +
        'setting.',
      previewNoise: 'The diff is wider than your edit',
      previewNoiseText:
        'Sometimes lines you never touched change: the panel re-serialises a whole TOML or ' +
        'JSON region, so a neighbouring entry may come back spelled differently with the ' +
        'same meaning. That is not a bug — but it is better seen BEFORE the write.',

      transferTitle: 'Moving an environment to another machine',
      transferCaption:
        'Every provider has its own buttons, and each one packs only that provider. ' +
        'The point is to sit down at another computer and work with the same agent ' +
        'under the same settings instead of rebuilding them.',
      transferExport: 'Export',
      transferExportText:
        'A preview first: how many files will travel, from which directories and what ' +
        'will not be in the archive. Then a folder picker — and the panel shows the ' +
        'finished path, so the archive does not have to be hunted for.',
      transferImport: 'Import',
      transferImportText:
        'The panel reads the archive and says, for every file, whether it is new, ' +
        'already identical or about to overwrite yours. Only new files are ticked by ' +
        'default: overwriting your own configuration is a human decision.',
      transferContent: 'What is inside',
      transferContentText:
        'Instructions, MCP servers, permissions, hooks, skills, agents, commands, ' +
        'plugins and rules — everything that makes the agent the same one. Plus a ' +
        'README and a manifest: the archive can simply be handed to the model with ' +
        '“I worked with you on another computer, pick these settings up”.',
      transferPaths: 'Paths are recomputed',
      transferPathsText:
        'The manifest stores configuration locations and relative names inside them, ' +
        'not absolute paths. That is why an archive made on Windows unpacks on macOS ' +
        'or Linux at their own paths.',
      transferSecretsTitle: 'No secrets in the archive — deliberately',
      transferSecretsText:
        'Credential and token files never enter the archive, and values that look like ' +
        'keys are replaced with a __REDACTED__ marker. In their place the archive ' +
        'carries a checklist of what to enter by hand on the new machine.',

      notesTitle: 'Things people trip over',
      noteManualTitle: 'A manually set path overrides the environment variable',
      noteManualText:
        'If you once set a directory here, it beats CLAUDE_CONFIG_DIR. This is the most ' +
        'common reason the panel shows the wrong configuration.',
      noteMacTitle: 'On macOS access lives in the keychain',
      noteMacText:
        'There is no token file there. The system asks for permission on first use — worth ' +
        'granting it permanently, or the sandbox will ask every time.',
      noteSandboxTitle: 'Only the sandbox needs this access',
      noteSandboxText:
        'The ordinary chat works through your normal Claude Code sign-in. If the chat works ' +
        'but the sandbox says “Not logged in”, this card is the place to look.',
      noteBackupTitle: 'Backups are worth leaving on',
      noteBackupText:
        'The panel edits your real configuration. A copy before writing is the only way back ' +
        'if an edit turns out badly.',
      noteProviderTitle: 'The configuration provider',
      noteProviderText:
        'This is also where you pick whose configuration the panel edits: Claude (the default, ' +
        'everything works), Codex, Gemini, Qwen Code, Continue, Goose, Kimi Code, Cursor, OpenCode or Aider. After a ' +
        'switch the sidebar rebuilds around that CLI’s capabilities. The breakdown is in the Providers ' +
        'article.',
    },

    groups: {
      title: 'Groups',
      summary: 'Bundles of settings, and scenarios of the form “when X happens, do Y”',
      lead:
        'The one section Claude Code knows nothing about: groups and scenarios live in ' +
        'the panel’s own data. A group collects settings into a bundle that switches on ' +
        'as one. A scenario is a hook described in plain words — the panel turns it into ' +
        'a real hook in the configuration.',

      whyBundle: 'Switch things on as sets',
      whyBundleText:
        'Rules, skills, hooks and servers for one job go into a group. Switch the group ' +
        'off and everything inside goes with it, with no toggling one by one.',
      whyEnv: 'Swap a whole environment',
      whyEnvText:
        'A group carries its own environment variables. While the group is on they are ' +
        'written into the settings — that is how several environments are kept and swapped ' +
        'with a single toggle.',
      whySimple: 'Automation without syntax',
      whySimpleText:
        'A scenario asks “when” and “what to do” in plain words. There is no need to ' +
        'remember which event and which filter to type.',

      canCollect:
        'Collect five kinds of thing into a group: rules, skills, hooks, servers, permissions',
      canToggleGroup: 'Switch a group off with a toggle — all of its members go dark at once',
      canGroupEnv:
        'Set group variables: switching the group on writes them to settings.json and ' +
        'switching it off removes them, without touching ones set by hand or by another group',
      canToggleAutomation: 'Switch an individual scenario off with a toggle without deleting it',
      canBadge: 'See from a “disabled” badge that a group or a scenario is switched off',
      canConflict:
        'See a warning about a conflict inside a group: two permission members with the ' +
        'same pattern and opposite decisions',
      canSandbox: 'Run a group’s entire contents in the sandbox at once',
      canNest:
        'Nest a group inside a group: a member can be another group, and the panel refuses to create cycles',
      canOrder: 'Set the order of members with the ↑ and ↓ arrows',
      canAutomation: 'Describe a scenario in words and get a working hook',
      canAssistant: 'Fill the group or scenario form with the assistant',

      cantKnow: 'Expect Claude to know about groups: all it sees is the resulting settings',
      cantMagic: 'Get more from a scenario than a hook can do — it is a hook, just more convenient',
      cantOverride:
        'Switch a member back on with its own toggle while a disabled group is ' +
        'holding it down: the group outranks the individual switch',
      cantRevive:
        'Undo a manual switch-off by enabling the group: what you disabled ' +
        'individually stays disabled',

      storageWhere: 'Where they live',
      storageWhereValue: 'in the panel’s data, apart from the Claude Code configuration',
      storageWhy: 'Why separately',
      storageWhyValue:
        'Claude Code has no concept of a group — it only sees the resulting settings',
      storageAuto: 'What reaches the configuration',
      storageAutoValue: 'compiled scenarios — as ordinary hooks in settings.json',
      storageMarker: 'How yours are told apart',
      storageMarkerValue: 'a marker referring back to the scenario is appended to the command',

      flowTitle: 'How a scenario becomes a hook',
      flowCaption:
        'The rebuild happens every time a scenario is saved. Hooks written by hand are ' +
        'left alone: what distinguishes them is the absence of the marker.',
      flowScenario: 'Scenario',
      flowScenarioCaption: 'an event and a command',
      flowCompile: 'Rebuild',
      flowCompileCaption: 'on every save',
      flowHook: 'A hook in settings.json',
      flowHookCaption: 'marked with its origin',
      flowRun: 'It runs',
      flowRunCaption: 'like any other hook',

      groupTitle: 'What a group gives you',
      groupMembers: 'Contents',
      groupMembersText:
        'References to existing things — rules, skills, hooks, servers, permissions. One ' +
        'thing can belong to several groups: no copies are made.',
      groupToggle: 'The group toggle',
      groupToggleText:
        'The switch in the list darkens every member at once: rules move to ' +
        '“Disabled”, skill folders to skills-disabled, servers to mcpServersDisabled, ' +
        'hooks disappear from settings.json. Switching it back on restores all of it. ' +
        'A disabled group carries a badge.',
      groupEnv: 'Group variables',
      groupEnvText:
        'The variables from the form go into settings.json while the group is on and are ' +
        'removed when it is switched off. The panel remembers the ones it set, so ' +
        'variables set by hand or by another group are left untouched.',

      toggleTitle: 'Who outranks whom: the group and the individual toggle',
      toggleCaption:
        'There are two independent reasons for a thing to be off: you switched it off ' +
        'yourself, or a group is holding it down. The panel remembers the two apart, ' +
        'and a thing is on only once both reasons are gone. Hence the four rules ' +
        'below — between them they explain every “I switch it on and nothing happens”.',
      toggleManual: 'A group does not undo a manual switch-off',
      toggleManualText:
        'If a member was switched off by its own toggle, enabling the group will not ' +
        'revive it. These are separate decisions: a group only releases what it ' +
        'darkened itself.',
      toggleTwo: 'Two groups hold in turn',
      toggleTwoText:
        'A member of two disabled groups comes back only when both are enabled. While ' +
        'even one is off, it keeps holding the member down.',
      toggleSingle: 'The individual toggle is weaker than the group',
      toggleSingleText:
        'You cannot switch a member back on with its own toggle while a group is ' +
        'holding it down. The panel answers with success and remembers your choice, ' +
        'but nothing changes on disk — it stays off until the group is enabled.',
      toggleDelete: 'Deleting a disabled group releases its members',
      toggleDeleteText:
        'The group is gone, so nothing holds them, and the members switch on — all ' +
        'except those disabled by hand or held by a second disabled group.',

      automationTitle: 'Scenarios: automation in plain words',
      automationCaption:
        'Scenarios have no magic of their own. Anything a scenario does, a hook does — the ' +
        'value is in not having to remember the syntax. Each scenario has its own ' +
        'toggle: a disabled one is left out of the compiled hooks and carries a badge.',
      autoWhen: 'When',
      autoWhenText:
        'A Claude Code event from a list: before a tool call, at session start, after an ' +
        'answer. The same as a hook event, but picked from a readable list.',
      autoWhat: 'What to do',
      autoWhatText:
        'The shell command that will run. Plus an optional timeout so a stuck command does ' +
        'not hold things up.',
      autoFilter: 'Filter',
      autoFilterText:
        'A narrowing: a tool name or a specific skill. For a skill there is a quick picker — ' +
        'the form fills in the right entry itself.',

      fieldsTitle: 'Fields of a group and a scenario',
      fieldsCaption: 'Names match the groupSchema and automationSchema schemas.',
      fieldName: 'The name of the group or scenario.',
      fieldDescription:
        'What the group is for. It is what reminds you of the point of the bundle a month later.',
      fieldMembers: 'The contents: references to rules, skills, hooks, servers and permissions.',
      fieldEnv: 'Environment variables of the group, one KEY=VALUE per line.',
      fieldTrigger: 'The scenario event and an optional filter.',
      fieldAction: 'The command to run and its timeout.',
      fieldCompiled: 'A reference to the hook the scenario became. Read only.',

      recipesTitle: 'Assembling a bundle for a job',
      recipe1: 'Create a group and say what it is for',
      recipe1Text:
        'The “New group” button, a name and one sentence about the purpose. A worked ' +
        'example for this whole recipe: a “Frontend review” group.',
      recipe2: 'Add the contents',
      recipe2Text:
        'You pick rules, skills, hooks and servers that already exist. Nothing is recreated; ' +
        'the group only refers to them. In our example: an “answer with a diff” rule, a ' +
        'before/after screenshot skill, a hook that forbids git push, and the design-mockup ' +
        'MCP server.',
      recipe3: 'Set variables if you need them',
      recipe3Text:
        'They take effect while the group is on and go away when it is switched off — ' +
        'REVIEW_STRICT=1 for that same hook, say.',
      recipe4: 'Check the bundle in the sandbox',
      recipe4Text:
        'The sandbox button runs the whole set at once — you can see whether the settings ' +
        'argue with each other. After that the group goes on and off with one toggle: on ' +
        'when you sit down to review, off when you go back to normal work, and not a single ' +
        'file is deleted in the process.',

      notesTitle: 'Things people trip over',
      notePermTitle: 'Permissions are not carried into the sandbox',
      notePermText:
        'Even when they belong to the group. An isolated run has boundaries of its own, and ' +
        'replacing them with yours would be wrong.',
      noteRebuildTitle: 'Scenarios are rebuilt on every save',
      noteRebuildText:
        'The panel recreates hooks from them and leaves hand-written hooks as they are. ' +
        'Editing a compiled hook directly is lost at the next rebuild.',
      noteInvisibleTitle: 'Claude does not know about groups',
      noteInvisibleText:
        'It only sees the resulting settings. A group is a way to keep order for yourself, ' +
        'not something you can ask about in a conversation.',
      noteDeleteTitle: 'Deleting asks you to type the name',
      noteDeleteText:
        'Just as for rules, skills and hooks: the delete button opens a dialog that ' +
        'waits until you type the name of the group or scenario. The rules and skills ' +
        'themselves stay — the group only referred to them. And if the group being ' +
        'deleted was disabled, its members switch on: nothing holds them any more.',
      noteConflictTitle: 'The panel only catches a permission conflict on the same pattern',
      noteConflictText:
        'Two permission members with the same pattern and opposite decisions (allow and ' +
        'deny at once) are flagged with a warning right in the group form. Semantic ' +
        'contradictions, though — two rules or skills that argue in substance — it does ' +
        'not see: only a run shows those.',
    },

    plugins: {
      title: 'Plugins',
      summary: 'Ready-made bundles of skills, hooks and servers from community catalogues',
      lead:
        'A plugin is a bundle of settings someone else put together: usually skills, ' +
        'hooks and MCP servers for one particular job. Everywhere else in the panel ' +
        'you configure things yourself; here you take something ready. The section ' +
        'works differently from its neighbours: the panel does not edit files but ' +
        'calls the standard Claude Code commands and shows their output as is.',

      whyReady: 'Ready-made instead of hand-rolled',
      whyReadyText:
        'A bundle for a job — working with a particular framework, say — is already ' +
        'assembled and tested. You never have to work out which skills and hooks it needs.',
      whyUpdate: 'Updated with one button',
      whyUpdateText:
        'The author releases a new version, you press update. Your own configuration ' +
        'cannot do that: it has to be carried over by hand.',
      whyOfficial: 'Through the standard mechanism',
      whyOfficialText:
        'The panel invents no installation of its own; it runs the same commands you would ' +
        'in the terminal. What is installed behaves the same in both.',

      canCatalog: 'Browse the catalogue of available plugins and search it',
      canInstall: 'Install a plugin from the catalogue or by identifier by hand',
      canUpdate: 'Update an installed plugin to a new version',
      canToggle: 'Switch a plugin off without removing it',
      canUninstall: 'Remove an installed plugin',
      canMarketplaces: 'Add and remove marketplace sources right from the panel and see their list',
      canSee: 'See where a plugin came from and when it was last updated',
      canView: 'Inspect the contents of an installed plugin — its skills, hooks and servers',
      canScaffold: 'Scaffold your own plugin and go on refining it in files',

      cantEdit:
        'Edit the contents of an installed plugin: its skills and hooks belong to the author',
      cantPick: 'Take only part of a plugin — it installs whole',
      cantOffline: 'Work offline: both the catalogue and installation reach the source',

      storageWhere: 'Who is in charge',
      storageWhereValue: 'the claude plugin commands — the panel calls them and touches no files',
      storageId: 'Identifier',
      storageIdValue:
        'name@marketplace — plugins with the same name from different sources stay distinct',
      storageSource: 'Source',
      storageSourceValue: 'a marketplace, usually a GitHub repository',
      storageResult: 'What the panel shows',
      storageResultValue: 'the command output as is — the only source of truth about a failure',

      flowTitle: 'What happens on installation',
      flowCaption:
        'This is exactly where the section differs from the others: Claude Code stands ' +
        'between the panel and the files. So the result is reported in its words.',
      flowClick: 'A button in the panel',
      flowClickCaption: 'install or update',
      flowCli: 'claude plugin',
      flowCliCaption: 'the standard command',
      flowFetch: 'Fetched from the marketplace',
      flowFetchCaption: 'usually a repository',
      flowReady: 'The plugin is installed',
      flowReadyCaption: 'it works after a restart',

      fieldsTitle: 'What a plugin shows',
      fieldsCaption: 'There are no creation forms here: apart from installing, it is read only.',
      fieldId: 'An identifier of the form name@marketplace. Used for manual installation.',
      fieldMarketplace: 'The source the plugin came from.',
      fieldVersion: 'The installed version.',
      fieldScope: 'The scope the plugin applies to.',
      fieldInstalled: 'When it was installed and when it was last updated.',
      fieldCount: 'How many times the plugin has been installed. Catalogue entries only.',

      recipesTitle: 'Installing a plugin',
      recipe1: 'Open the catalogue',
      recipe1Text:
        'It loads on a button rather than up front: there are several hundred entries and ' +
        'no reason to fetch them on every visit.',
      recipe2: 'Find what you need with search',
      recipe2Text: 'Search covers the name, the marketplace and the description.',
      recipe3: 'Install it and read the output',
      recipe3Text:
        'The panel shows the command’s answer in full. If something went wrong, the reason ' +
        'is written there rather than in the panel interface.',
      recipe4: 'Restart Claude Code',
      recipe4Text: 'The plugin’s skills and hooks are picked up on the next start.',

      notesTitle: 'Things people trip over',
      noteCliTitle: 'This section depends on the CLI',
      noteCliText:
        'If claude is not found on the system, nothing here works — unlike the other ' +
        'sections, which edit files directly.',
      noteSlowTitle: 'Installation can take a while',
      noteSlowText:
        'The command reaches the network and may take minutes. The panel waits for it ' +
        'and shows the result when it arrives. While any operation runs, the buttons on ' +
        'the whole page are disabled — plugin commands cannot be interleaved.',
      noteContentTitle: 'Plugin contents do not show up as yours in other sections',
      noteContentText:
        'A plugin’s skills and hooks belong to it. Editing them through the panel is not ' +
        'possible — an update from the author would overwrite the changes anyway.',
      noteManualTitle: 'Manual installation is tucked away on purpose',
      noteManualText:
        'Installing by identifier is collapsed and sits after the catalogue: it is worth ' +
        'checking the list first.',
      noteProviderTitle: "Other providers' plugins are their own",
      noteProviderText:
        "Everything described here is about Claude Code's plugins and marketplaces. With " +
        'the OpenCode provider the section opens a different screen: there it is about ' +
        'plugins of the CLI itself, and there are two ways to attach one. First, drop a JS ' +
        'or TS file into the plugins directory (global ~/.config/opencode/plugins/, ' +
        'per-project <project>/.opencode/plugins/): everything there is loaded by OpenCode ' +
        'at startup, and the panel manages those files as a plain file manager — create, ' +
        'open, edit, delete. Second, list npm package names under the plugin key of ' +
        'opencode.json; both plain and scoped packages such as @org/name are supported. ' +
        'The panel cannot install packages — the CLI does that, it only edits the list. ' +
        'OpenCode has no catalogue, no marketplaces and no one-click update. ' +
        'With the Kimi Code provider the section is read-only: the panel reads the ' +
        '~/.kimi-code/plugins/managed/ directory and each plugin’s manifest and lists them — ' +
        'name, version, description and what the plugin brings (skills, a session-start ' +
        'skill, MCP servers, how many hooks it declares, whether it has commands). ' +
        'Installing, enabling and disabling happen in the CLI itself via /plugins: the shape ' +
        'of its installed.json registry is undocumented, and editing that state behind its ' +
        'back would be guesswork, so a write is refused.',
    },

    env: {
      title: 'Environment',
      summary: 'Settings and tokens: two different files and two attitudes to secrets',
      lead:
        'Environment variables are how a value reaches a place it should never be ' +
        'hard-coded into: an access token, an instance address, a mode flag. This ' +
        'section manages two files at once, and the difference between them matters: ' +
        'one is read by Claude Code itself, the other exists purely for secrets and ' +
        'never travels with your configuration.',

      whySeparate: 'Secrets apart from settings',
      whySeparateText:
        'Tokens live in their own file rather than in the shared configuration. You can ' +
        'show, export or copy that configuration without carrying keys along.',
      whyMasked: 'The value is never revealed by accident',
      whyMaskedText:
        'Secrets arrive from the server already masked — only the start and the tail are ' +
        'visible. The full value is fetched separately and only on your action.',
      whyBulk: 'A whole .env moves at once',
      whyBulkText:
        'A batch of variables can be pasted line by line as is. The panel files secrets ' +
        'and ordinary settings into different places itself.',

      canTwo: 'Keep variables in two places: for Claude Code and for launching MCP servers',
      canReveal: 'Reveal the full value of a secret with a button',
      canBulkAdd: 'Paste a batch of KEY=value lines, up to a whole .env',
      canComment: 'Leave a comment: where the value comes from or what it is for',
      canAssistant: 'Fill the form with the assistant by describing the variable in words',
      canAuto: 'Rely on detection: a variable with TOKEN in its name goes to the secrets file',
      canMove: 'Move a variable between settings.json and settings.local.json with a button',

      cantEncrypt:
        'Encrypt the values: the token file is protected by file permissions, not a cipher',
      cantEdit:
        'Adjust a secret without retyping it: the panel does not know the old value — it ' +
        'only ever received it masked',
      cantScope: 'Split variables per project — the set is shared',
      cantSee: 'See which variable actually reached a process: the panel only writes them',

      storageSettings: 'Settings',
      storageSettingsValue: '~/.claude/settings.json → the env key',
      storageLocal: 'The personal file',
      storageLocalValue:
        '~/.claude/settings.local.json → read and written; entries carry a "local" badge',
      storageSecrets: 'Secrets',
      storageSecretsValue: '~/.claude/.mcp-secrets.env',
      storageWhoReads: 'Who reads what',
      storageWhoReadsValue:
        'the first file is read by Claude Code, the second by the MCP server launcher',
      storageDetect: 'How a secret is detected',
      storageDetectValue: 'by name: TOKEN, SECRET, KEY, PASSWORD, PAT, CREDENTIAL',

      flowTitle: 'Where a variable ends up',
      flowCaption:
        'Choosing the file is the real decision in this form. Everything else follows: who ' +
        'reads the value, and whether it is masked in the interface.',
      flowName: 'Variable name',
      flowNameCaption: 'upper case with underscores',
      flowDetect: 'Does it look like a secret?',
      flowDetectCaption: 'checked by name',
      flowSecrets: '.mcp-secrets.env',
      flowSecretsCaption: 'the value is masked',
      flowSettings: 'settings.json',
      flowSettingsCaption: 'the value is shown as is',

      placesTitle: 'Two files, two jobs',
      placeSettings: 'Claude Code settings',
      placeSettingsText:
        'Values Claude Code itself sees at launch. Everything non-secret goes here: modes, ' +
        'addresses, behaviour flags.',
      placeSecrets: 'The token file',
      placeSecretsText:
        'A separate file read by the MCP server launcher. It exists precisely so that keys ' +
        'stay out of the shared configuration, which gets shown, copied and exported more ' +
        'often than people think.',

      fieldsTitle: 'Fields of a variable',
      fieldsCaption: 'Names match the envVarDraftSchema schema.',
      fieldKey: 'The variable name in upper case with underscores.',
      fieldValue:
        'The value. When editing a secret the field is empty: the panel does not know the ' +
        'old one.',
      fieldSource: 'Where to save it: settings — visible to Claude Code, secrets — the token file.',
      fieldIsSecret:
        'Whether the variable counts as a secret. Not set by hand — detected from the name.',
      fieldComment:
        'A comment above the variable in the file: where the value comes from or what it is for.',

      recipesTitle: 'Adding a token for an MCP server',
      recipe1: 'Create a variable with a clear name',
      recipe1Text:
        'GITLAB_PERSONAL_ACCESS_TOKEN — the word TOKEN makes the panel file it under ' +
        'secrets and pick the right file.',
      recipe2: 'Write down where the value came from',
      recipe2Text:
        'The comment is stored next to the variable in the file. Six months later it is the ' +
        'only thing that explains where to reissue the key.',
      recipe3: 'Reference it in the server configuration',
      recipe3Text:
        'In the MCP section, name the variable rather than the value. The token itself must ' +
        'never reach the shared configuration file.',
      recipe4: 'Restart Claude Code',
      recipe4Text: 'Variables are read at startup — a running session will not see new ones.',

      notesTitle: 'Things people trip over',
      noteRewriteTitle: 'A secret is retyped when edited',
      noteRewriteText:
        'The panel received the value masked and cannot put it back: a string of dots would ' +
        'end up in the file. The field is deliberately left empty.',
      noteDetectTitle: 'Secret detection works by name',
      noteDetectText:
        'A variable called API_ENDPOINT lands in ordinary settings even if you keep ' +
        'something sensitive in it. Check the chosen file before saving: the word lists ' +
        'used by the form and by the server do not match exactly, and a name containing ' +
        'CREDENTIAL may be offered as an ordinary setting.',
      noteLocalTitle: 'Variables from settings.local.json are shown, nothing more',
      noteLocalText:
        'The panel reads both the main settings.json and the personal ' +
        'settings.local.json, so the list shows everything that will really reach the ' +
        'environment. Entries from the personal file carry a “local” badge: the value ' +
        'can be revealed, but editing and deleting them is closed, and trying it ' +
        'through the API is refused. The panel never writes to that file — edit it by ' +
        'hand.',
      noteCommentsTitle: 'Comments in the token file survive',
      noteCommentsText:
        'The panel rewrites the file but carries the comments above variables across. Hand ' +
        'edits are not lost.',
      noteRevealTitle: 'Revealing a value is a separate request',
      noteRevealText:
        'The full text of a secret does not travel with the list: it is fetched only on a ' +
        'click. The default behaviour can be changed in the application settings.',
      noteProviderTitle: 'Other providers, other file',
      noteProviderText:
        'With the Codex provider the variables live in the shell_environment_policy.set table ' +
        'of config.toml, with Aider in the set-env key of .aider.conf.yml (the global one ' +
        'or the one in the repository root), with Gemini ' +
        'in the plain ~/.gemini/.env file (and the per-project .gemini/.env), with Qwen Code ' +
        'in ~/.qwen/.env (and the per-project .qwen/.env), with Continue in ~/.continue/.env ' +
        '(and the per-project .continue/.env, the source of ${{ secrets.NAME }} values). Comments, ' +
        'blank lines and ordering survive the write: only the lines of the affected ' +
        'variables change. For OpenCode the section is “in development”; for Cursor it is ' +
        'hidden. Secrets in .mcp-secrets.env ' +
        'and masking are Claude capabilities too. For Goose the section is hidden as well: it ' +
        'loads no .env of its own — values come from the process environment and secrets from ' +
        'the OS keyring. Kimi Code is hidden for the same reason: it reads no .env of its ' +
        'own, provider keys sit right in config.toml, and the panel never writes secrets ' +
        'into a foreign config.',
    },

    mcp: {
      title: 'MCP servers',
      summary: 'External tools: giving Claude access to your tracker, database or browser',
      lead:
        'An MCP server is a program that hands Claude new tools: file an issue in a ' +
        'tracker, query a database, drive a browser. Skills and rules change ' +
        'behaviour; a server extends capability. Without one, Claude physically ' +
        'cannot reach your GitLab.',

      whyTools: 'New abilities, not new instructions',
      whyToolsText:
        'A connected server adds tools Claude did not have. It is the only way to give ' +
        'it access to an external system.',
      whyCheck: 'Checked before the work',
      whyCheckText:
        'The connection button shakes hands with the server over the MCP protocol and ' +
        'asks for its tool list. Whether it really answers is visible before you find ' +
        'out in the middle of a task.',
      whyImport: 'Moves as a ready configuration',
      whyImportText:
        'Server setup usually arrives as a chunk of JSON. You can paste it whole — no ' +
        'need to pick the fields apart by hand.',

      canPreset: 'Fill the form from a preset for common servers',
      canImport:
        'Paste a whole JSON configuration: the “Several from JSON” mode creates every ' +
        'server described in it',
      canAssistant: 'Fill the form with the assistant by describing the server in words',
      canHealth:
        'Check the connection with a real MCP handshake on any transport and see the ' +
        'number of tools',
      canProbe:
        'Call a server tool in the sandbox and see the real answer — the same on ' +
        'stdio, http and sse',
      canToggle: 'Switch a server off without deleting its configuration',
      canTransport: 'Connect a server over one of three transports',
      canHeaders: 'Set request headers for http and sse — for authorisation, for instance',
      canOAuth:
        'Sign in interactively over OAuth to a network server: the panel opens the ' +
        'authorization window, stores the token and refreshes it on expiry. If the ' +
        'window is blocked, the sign-in address shows up on the card as a link',
      canAutoCheck:
        'Turn on an automatic connection check when the section opens — the mcpAutoCheck ' +
        'setting in Settings (off by default, so servers are not started needlessly)',

      cantInstall:
        'Install the server itself: the panel configures a connection, it does not ' +
        'install software',
      cantSecrets:
        'Keep passwords here: values from this form land in the shared configuration file',
      cantPerTool:
        'Enable individual tools of a server: a server connects whole, and limits are ' +
        'set through permissions',
      cantDuplicate:
        'Add a second server under a taken name: the name is the identifier, so saving ' +
        'over an existing one (a disabled namesake included) is refused',

      storageFile: 'Where it is stored',
      storageFileValue: '~/.claude.json — outside the .claude directory',
      storageWhy: 'Why separately',
      storageWhyValue: 'this is a shared Claude Code file; the panel only rewrites its own section',
      storageOff: 'Disabled ones',
      storageOffValue: 'move to the mcpServersDisabled key, which Claude Code ignores',
      storageRestart: 'When it takes effect',
      storageRestartValue: 'after Claude Code is restarted',

      flowTitle: 'How a server’s tools reach Claude',
      flowCaption:
        'A server is a separate process. Claude Code starts it at launch, asks for the ' +
        'tool list, and calls the tools as they are needed.',
      flowConfig: 'Server configuration',
      flowConfigCaption: 'a command or an address',
      flowStart: 'Claude Code starts it',
      flowStartCaption: 'when a session begins',
      flowList: 'The server lists tools',
      flowListCaption: 'with their arguments',
      flowUse: 'Claude calls them',
      flowUseCaption: 'when the task calls for it',

      transportTitle: 'Three transports: how the panel talks to a server',
      transportCaption:
        'The transport decides which fields the form shows. Showing them all at once was ' +
        'deliberately avoided.',
      transportStdio: 'stdio',
      transportStdioText:
        'The server runs as a local program and talks over streams. Needs a command and ' +
        'arguments. The most common case: the server is fetched with npx.',
      transportSse: 'sse',
      transportSseText:
        'The server is already running and listening on an address, and answers stream ' +
        'back. Needs the address, plus headers if the server sits behind ' +
        'authorisation: they go into the requests and into opening the stream itself. ' +
        'This is how local apps with a developer mode connect.',
      transportHttp: 'http',
      transportHttpText:
        'Ordinary requests to an address. Needs the address and, where required, ' +
        'authorisation headers. Without them a token-protected server will not even ' +
        'let the check through.',

      presetsTitle: 'Ready-made presets',
      presetsCaption:
        'They fill in the transport, the command and the variables. Your name is never ' +
        'overwritten once you have typed one.',
      presetFs: 'File system',
      presetFsText:
        'Access to a chosen directory: reading and writing files outside the working folder.',
      presetGithub: 'GitHub',
      presetGithubText: 'Repositories, issues, pull requests. Needs a personal access token.',
      presetGitlab: 'GitLab',
      presetGitlabText:
        'The same for GitLab: the address of your instance and a personal token. Both go ' +
        'in as variables.',
      presetPostgres: 'PostgreSQL',
      presetPostgresText: 'Database queries over a connection string.',
      presetPlaywright: 'Playwright',
      presetPlaywrightText:
        'Driving a browser: open a page, click, take a screenshot. This is where live ' +
        'layout checking comes from.',
      presetSse: 'Local SSE server',
      presetSseText:
        'A starting point for an application already running and listening on this machine.',

      importTitle: 'The “Several from JSON” mode',
      importCaption:
        'Both shapes are accepted: a wrapper with an mcpServers key, and a plain object ' +
        'of servers. The transport is worked out from the presence of an address rather ' +
        'than a type field — different sources name that field differently.',
      importNote:
        'Servers are created one at a time rather than all at once: the configuration ' +
        'file is shared, and parallel writes would overwrite each other.',

      fieldsTitle: 'Fields of a server',
      fieldsCaption: 'Names match the mcpServerDraftSchema schema.',
      fieldName:
        'The server name in the configuration. Also the identifier and the prefix used in ' +
        'permissions.',
      fieldTransport: 'How the panel talks to the server: stdio, sse or http.',
      fieldCommand: 'The launch command. For stdio only, npx for example.',
      fieldArgs: 'Command arguments. Typed as one space-separated line.',
      fieldUrl: 'The server address. For sse and http only.',
      fieldEnv:
        'Environment variables, one KEY=VALUE per line. What belongs here are references ' +
        'to variables, not the secrets themselves.',
      fieldHeaders:
        'Request headers, one Name=value per line — the same shape as environment ' +
        'variables. For http and sse only: for stdio the form clears them.',
      fieldHealth: 'Connection state from the last check, plus the reason if it failed. Read only.',
      fieldTools: 'How many tools the server reported during the check. Read only.',

      recipesTitle: 'Connecting a server that needs a token',
      recipe1: 'Take a preset',
      recipe1Text:
        'It fills in the transport and the command and tells you which variables are needed.',
      recipe2: 'Put the token in the Environment section',
      recipe2Text:
        'Secrets live in a separate token file, not in the shared configuration. The panel ' +
        'files a variable with TOKEN in its name under secrets by itself.',
      recipe3: 'Reference the variable, not the value',
      recipe3Text:
        'In the server variables field, name the key. The token itself should never reach ' +
        'the configuration file.',
      recipe4: 'Save and check the connection',
      recipe4Text:
        'The check button on the card starts the server and shows the tool count. Zero ' +
        'tools on a successful connection usually means a bad token.',

      notesTitle: 'Things people trip over',
      noteSecretTitle: 'Secrets do not belong here',
      noteSecretText:
        'Server configuration lives in a shared file that easily leaks along with a ' +
        'settings dump. The variables field takes the name of a key, while the value ' +
        'itself stays in the Environment section.',
      noteWindowsTitle: 'On Windows npx runs through a shell',
      noteWindowsText:
        'The panel does that itself, and escapes the arguments itself too: a path with ' +
        'spaces would otherwise split into two arguments.',
      noteProjectTitle: 'These are the global MCP servers; project ones live in Projects',
      noteProjectText:
        'This section manages the shared ~/.claude.json. A specific project’s MCP servers ' +
        'live in its .mcp.json and are edited in the Projects section — but that is still ' +
        'raw there: no connection check, no OAuth, no soft-disable toggle.',
      noteTimeoutTitle: 'The connection timeout is configurable',
      noteTimeoutText:
        'The timeout for network servers (http/sse) is set in Settings via ' +
        'mcpNetworkTimeoutMs (2000–120000 ms). Launching local stdio servers stays ' +
        'hard-capped at 45 seconds.',
      noteHandshakeTitle: 'The connection check is a handshake, not a port ping',
      noteHandshakeText:
        'The panel greets the server over the MCP protocol using the official library ' +
        'and asks for its tool list — the same for stdio, http and sse. Previously ' +
        'http and sse were only asked “is this address alive”, so any unrelated web ' +
        'server on the same port passed the check. What follows in practice: a green ' +
        'answer now means there really is an MCP server there, and the tool count ' +
        'beside it is what it actually reported.',
      noteHealthTitle: 'The connection check does not run by itself',
      noteHealthText:
        'Starting a server costs time, so opening the page shows the state from the last ' +
        'check. A fresh one is a button away.',
      noteRestartTitle: 'Tools appear after a restart',
      noteRestartText:
        'Claude Code asks for the tool list when a session starts. A server connected just ' +
        'now is not there in an open conversation.',
      noteProviderTitle: 'The shape is simpler with other providers',
      noteProviderText:
        'MCP exists for Codex (TOML), Gemini, Qwen Code, Cursor, OpenCode, Continue, Goose and Kimi Code, and the panel edits ' +
        'their ' +
        'files directly. Continue has its own shape: not “name → entry” but a mcpServers ' +
        'LIST in config.yaml, with the name inside each entry; plus separate block files in the ' +
        'mcpServers folder — they appear in the same list marked with the file an entry comes ' +
        'from and are edited right there, while new servers always go into config.yaml. A block ' +
        'the panel could not parse (a uses: reference instead of an entry, a duplicate name) is ' +
        'named and left alone. With Goose the servers live among ' +
        'the extensions of config.yaml: the CLI’s own built-in extensions (developer, memory) ' +
        'are neither shown nor ever touched. Kimi Code keeps its servers in a SEPARATE ' +
        'mcp.json in the same directory (config.toml only holds timeouts): the usual ' +
        'name-to-entry shape, with the remote address in url. The connection check, OAuth, disabling a server and browsing its ' +
        'tools stay Claude capabilities, though: for the others this is a plain list of ' +
        'servers. Aider has no MCP setting at all and the section is hidden.',
    },

    permissions: {
      title: 'Permissions',
      summary: 'What Claude does without asking, what it asks about, and what it never does',
      lead:
        'A permission is a tool pattern plus a decision about it: allow, ask, or deny. ' +
        'Rules and skills explain to Claude how to behave; permissions draw a line it ' +
        'will not cross even if it decides that would be better. This is the one ' +
        'section where a refusal is mechanical.',

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

      canThree: 'Assign one of three decisions: allow, ask, deny',
      canPattern: 'Narrow a rule to a specific command: not all of Bash, only git push',
      canPreset: 'Configure a common action from a ready list in one click',
      canBulk:
        'Create a batch of rules as a list, one per line: one decision is chosen for ' +
        'the whole list',
      canMcp: 'Manage permissions for MCP server tools on a separate tab',
      canMove: 'Move a permission between settings.json and settings.local.json with a button',
      canSee: 'See which common actions are still unconfigured',
      canValidate:
        'Get a warning when a pattern does not look like the known forms: ' +
        'Bash(…), mcp__server__tool, Read(…)',
      canAssistant: 'Fill the form with the assistant by describing the rule in words',

      cantWhy: 'Find out why Claude asked for confirmation of a particular action',
      cantOrderCustom: 'Set your own resolution order: the priority of decisions is fixed',
      cantProject:
        'Split permissions per project here: this set is user-level, ' +
        'while project permissions live in the Projects section',

      storageFile: 'Where it is stored',
      storageFileValue: '~/.claude/settings.json → permissions.allow, .ask, .deny',
      storageLocal: 'The personal file',
      storageLocalValue:
        '~/.claude/settings.local.json → read and written; entries carry a "local" badge',
      storageId: 'Rule identifier',
      storageIdValue: 'the decision and the pattern together — it changes with the decision',
      storageMove: 'Changing the decision',
      storageMoveValue: 'the rule physically moves between the three lists',
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
      tabMcp: 'MCP',
      tabMcpText:
        'Permissions for the tools of connected servers, grouped by server. Kept apart ' +
        'because otherwise they swamp the general list.',
      tabAll: 'All',
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

      fieldsTitle: 'Fields of a rule',
      fieldsCaption: 'Names match the permissionDraftSchema schema.',
      fieldPattern:
        'The pattern: a whole tool name or a narrowed one, or an MCP server tool in the ' +
        'form mcp__server__tool.',
      fieldDecision: 'The decision: allow — no questions, ask — confirm first, deny — refuse.',
      fieldGroups: 'Groups the rule belongs to.',

      recipesTitle: 'Closing the dangerous and opening the routine',
      recipe1: 'Start on the System tab',
      recipe1Text:
        'It shows what is still unconfigured. The “Configure” button opens the form with ' +
        'the pattern already filled in — nothing to invent.',
      recipe2: 'Deny the irreversible',
      recipe2Text:
        'Deleting files from the shell and pushing to a remote usually go into deny: you ' +
        'can always run them by hand when you really mean to.',
      recipe3: 'Allow the routine',
      recipe3Text:
        'Confirming reads and git status every time is pointless — move them to allowed.',
      recipe4: 'Leave the rest on “ask”',
      recipe4Text:
        'The middle decision is more useful than it looks: the action still happens, but ' +
        'you see it before it does.',

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
      noteLocalTitle: 'Permissions from settings.local.json are shown, nothing more',
      noteLocalText:
        'The panel reads both files — otherwise the list could not answer “why is ' +
        'this allowed”. Entries from the personal file carry a “local” badge: they ' +
        'are visible and they count, but editing and deleting them is closed, and ' +
        'trying it through the API is refused. The panel never writes to that file — ' +
        'edit it by hand. Priority is shared regardless: a deny in the personal file ' +
        'beats an allow in the main one exactly as it would otherwise.',
      noteChatTitle: 'There is nothing to confirm in the panel chat',
      noteChatText:
        'The “ask” decision is meant for an interactive terminal. The panel chat has no ' +
        'confirmation buttons, so there the edit toggle does the job wholesale.',
      noteProviderTitle: 'Codex uses a different model',
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

    scripts: {
      title: 'Scripts',
      summary: 'The code hooks run: written, edited and tested here',
      lead:
        'A hook answers “when to run”; a script answers “what exactly to do”. These ' +
        'are ordinary files in the hooks/ directory: you can write them yourself, or ' +
        'let the panel create one for you from a hook template. This section shows ' +
        'the whole directory, including files not wired to any hook.',

      whyEdit: 'Edited in one place',
      whyEditText:
        'No hunting for the file on disk and opening an editor: the code is visible ' +
        'and editable right in the card, next to the file tree.',
      whyOrphans: 'Unused files are visible',
      whyOrphansText:
        'The panel matches files against hooks and marks the ones nothing points to. ' +
        'Such a file was either never wired up or is left over from a deleted hook.',
      whyTest: 'Tested without the model',
      whyTestText:
        'A script can be run against a prepared event straight from its card: you see ' +
        'the output, the exit code and the decision. Fast, and it uses none of your limit.',

      canWrite: 'Write and edit code right in the panel',
      canTemplate: 'Start from a ready scaffold instead of an empty file',
      canBulkTemplates: 'Create several scaffolds at once by ticking the ones you want',
      canProbe: 'Run a script against nine prepared events',
      canSee:
        'See the whole hooks/ directory, including unwired files and scripts in nested folders',
      canExpand: 'Expand a file’s contents right in the list, without opening the form',
      canRename: 'Rename a file while editing — unlike skills, the name is not locked here',
      canLang:
        'Use more than Node: .mjs, .cjs, .js, .ts, .sh, .ps1 and .py are listed — and .ts, ' +
        '.mts and .cts run through node --experimental-strip-types, with no separate ' +
        'TypeScript build',
      canAssistant: 'Ask the assistant to write the body of the script from a description',

      cantSchedule: 'Run a script on a schedule — only on a Claude Code event',
      cantInstall: 'Install dependencies: a script gets whatever is already on the system',
      cantDebug: 'Step through it in a debugger — only output and the exit code are visible',
      cantAuto:
        'Expect a file created here to work on its own: it still has to be bound to an ' +
        'event by a hook',

      storageFolder: 'Directory',
      storageExt: 'What counts as a script',
      storageExtValue: 'files with the extensions .mjs .cjs .js .ts .sh .ps1 .py',
      storageDesc: 'Where the description comes from',
      storageDescValue: 'the first comment lines at the top of the file',
      storageUsed: 'How “in use” is decided',
      storageUsedValue: 'the file name appears in the command of at least one hook',

      flowTitle: 'How a script receives an event and answers',
      flowCaption:
        'A script talks to Claude Code through streams: the event arrives on input, the ' +
        'answer leaves on output. Nothing extra to wire up.',
      flowStdin: 'stdin',
      flowStdinCaption: 'the event as JSON',
      flowCode: 'Your code',
      flowCodeCaption: 'decides what to do',
      flowStdout: 'stdout',
      flowStdoutCaption: 'text or a JSON decision',
      flowExit: 'Exit code',
      flowExitCaption: '0 to pass, 2 to refuse',

      answersTitle: 'Two ways to answer',
      answersCaption:
        'Both work. The second one came later and is easier: the decision and the reason ' +
        'travel together, without leaning on a numeric code.',
      answerExit: 'With an exit code',
      answerExitText:
        'Exit with code 2 and write the reason to stderr. The action stops, and Claude ' +
        'sees the reason.',
      answerJson: 'With a JSON answer',
      answerJsonText:
        'Print a decision to stdout with a permissionDecision field — deny, ask or ' +
        'allow — plus an explanation. The exit code then does not matter.',

      templatesTitle: 'Ready scaffolds',
      templatesCaption:
        'Available when creating only, so a template button never wipes code you have ' +
        'written. The file name is filled in only if the field is still empty.',
      bulkTitle: 'Several at once',
      bulkText:
        'The second creation mode: tick several scaffolds and the panel creates them ' +
        'one by one, showing progress. Handy when you want the whole set rather than ' +
        'one file at a time.',
      tplBlank: 'Blank scaffold',
      tplBlankText:
        'Reads the event from stdin, with comments pointing at where things are and room ' +
        'for your logic.',
      tplGuard: 'Command guard',
      tplGuardText:
        'Checks the command against dangerous patterns and answers with a JSON decision ' +
        'asking for confirmation. No exit code needed — the decision travels in the answer.',
      tplFormat: 'Format on save',
      tplFormatText:
        'Takes the path of the changed file, filters by extension and runs prettier over ' +
        'it. A formatter error is deliberately swallowed so it never gets in the way.',
      tplBrief: 'Session briefing',
      tplBriefText:
        'Reads nothing and immediately prints extra context for the session — a reminder ' +
        'to check the working notes.',

      fieldsTitle: 'Fields of a script',
      fieldsCaption:
        'There are only two fields: the rest is file information the panel shows itself.',
      fieldName:
        'The file name with its extension, for example notify.mjs. The extension decides ' +
        'what runs the file.',
      fieldContent: 'The full script code.',
      fieldPath: 'The path on disk. Read only.',
      fieldIsUsed:
        'Whether the file is bound to at least one hook. Worked out by matching against ' +
        'hook commands.',
      fieldSize: 'File size and last modification date. Shown in the list row.',

      recipesTitle: 'Writing your own script',
      recipe1: 'Create a file from a scaffold',
      recipe1Text:
        'Take the blank scaffold — it already reads the event and points at where the ' +
        'command and the file path live.',
      recipe2: 'Write the logic and save',
      recipe2Text: 'The decision can come back as exit code 2 or as a JSON answer — both work.',
      recipe3: 'Run it against the prepared events',
      recipe3Text:
        'The sandbox button on the card. It has a safe command, a destructive one and a ' +
        'token write — you see what the script caught.',
      recipe4: 'Bind it to an event',
      recipe4Text:
        'A file does not run by itself. Create a hook pointing at this script, or it stays ' +
        'marked “unused”.',

      notesTitle: 'Things people trip over',
      noteUnusedTitle: '“Unused” is not an error, but worth a look',
      noteUnusedText:
        'That mark goes on files whose name appears in no hook command. Usually it means ' +
        'a forgotten binding or a leftover from a deleted hook.',
      noteDeleteTitle: 'Deleting a script in use breaks its hook silently',
      noteDeleteText:
        'The hook stays in the settings but has nothing to run — and no error appears. The ' +
        'panel warns separately about this kind of deletion.',
      noteInterpreterTitle: 'The extension decides what runs it',
      noteInterpreterText:
        '.mjs, .cjs and .js go through node, .ts, .mts and .cts through ' +
        'node --experimental-strip-types, .py through python, anything else through ' +
        'bash. .ps1 is the special case: powershell on Windows, pwsh on Linux and macOS ' +
        'if it is installed. The panel checks for it before running and says so plainly ' +
        'when it is missing, instead of failing with a cryptic error. Other interpreters ' +
        'may be missing too.',
      noteRestartTitle: 'Editing code needs no restart',
      noteRestartText:
        'A script is read from disk when it runs, so new code takes effect on the next ' +
        'event. A restart is only needed when the hooks themselves change.',
      noteProviderTitle: 'The section works with every provider',
      noteProviderText:
        'Scripts are the panel’s own files, not a foreign config, so the section is there ' +
        'with Codex, Gemini, Qwen Code, Cursor, OpenCode or Aider too. Claude alone keeps the ' +
        'sandbox, the “called by a hook” flag and the hook scaffolds: the other CLIs have ' +
        'no hooks, so plain standalone scripts are offered instead.',
    },

    hooks: {
      title: 'Hooks',
      summary: 'Commands that run by themselves on Claude Code events',
      lead:
        'A hook is a command tied to an event: before a tool is called, after a file ' +
        'is written, when a session starts. Unlike rules and skills this is not a ' +
        'request to the model but ordinary code that always runs. So hooks are for ' +
        'the things you cannot leave to judgement: hard stops, auto-formatting, ' +
        'preparing context.',

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
      cantBlockAll: 'Block an action on any event: only two of the nine can stop anything',
      cantStable:
        'Rely on a stable link for two identical hooks: the identifier is derived from ' +
        'the content, and full duplicates differ only by a suffix',
      cantLocal:
        'Edit or delete hooks from settings.local.json: they are listed with a ' +
        '“local” badge, but the panel never writes to that file',

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

      flowTitle: 'How a hook fires',
      flowCaption:
        'Exit code 2 means refusal. On the events that can block, it stops the ' +
        'action; on the rest it only writes to the log.',
      flowEvent: 'Event',
      flowEventCaption: 'PreToolUse, for example',
      flowMatcher: 'Filter',
      flowMatcherCaption: 'does the tool match',
      flowScript: 'Your script',
      flowScriptCaption: 'gets the event on stdin',
      flowDecision: 'Decision',
      flowDecisionCaption: 'pass, ask, or refuse',

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
        'When Claude has finished answering. Wrap-up work: collect a report, signal ' +
        'completion.',
      evtSubagentStop:
        'When a subordinate agent has finished. Handling the results of background tasks.',
      evtSessionStart:
        'When a session starts or resumes. Preparing context: repository state, open ' +
        'tasks, an environment check.',
      evtSessionEnd: 'When a session ends. Tidying up: save notes, close temporary files.',
      evtPreCompact:
        'Before an overflowing context is compacted. The last chance to write what ' +
        'matters to a file — after compaction the details are gone.',

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
        'They fill in the event, filter, template and every related field at once. ' +
        'Available when creating only, so a configured hook is never overwritten.',
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
        'in hooks/ and fills in the launch command itself.',
      fieldTemplate: 'What the hook does: message, guard, shell command, or a blank scaffold.',
      fieldDescription:
        'One sentence about what the hook is for. It goes into the header of the ' +
        'created script.',
      fieldMessage: 'The text of the message, or the explanation given when blocking.',
      fieldGuardPatterns:
        'What to intercept — patterns separated by commas. For the guard template only.',
      fieldCommand: 'A ready command, when no script file needs to be created.',
      fieldTimeout: 'How many seconds to wait for the script before cutting it off.',
      fieldGroups: 'Groups the hook belongs to.',

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
        'Its text is kept by the panel, not by the configuration file. Editing the file ' +
        'by hand outside the panel will not show disabled hooks.',
      noteLocalTitle: 'Hooks from settings.local.json are shown, nothing more',
      noteLocalText:
        'The panel reads both the main settings.json and the personal ' +
        'settings.local.json — otherwise the list would lie about what actually ' +
        'fires. Entries from the personal file carry a “local” badge: you can see ' +
        'them, but their edit and delete buttons are closed, and trying it through ' +
        'the API is refused. The file is personal and the panel never writes to it — ' +
        'edit it by hand. For the same reason a local hook is always shown as ' +
        'enabled: the panel’s toggle cannot reach it.',
      noteScriptTitle: 'Deleting a hook does not delete its script',
      noteScriptText:
        'The file stays in hooks/ and shows up in the Scripts section marked “unused”. ' +
        'That is deliberate: another hook may need it.',
      noteExitTitle: 'Exit code 2 means refusal',
      noteExitText:
        'On PreToolUse and UserPromptSubmit it stops the action, and the text from ' +
        'stderr explains why. On the other events nothing is blocked.',
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
    },

    skills: {
      title: 'Skills',
      summary: 'Instructions that switch on for a task instead of applying all the time',
      lead:
        'A skill is a folder with an instruction that Claude pulls in not always, ' +
        'but when the task matches its description. A rule applies in every ' +
        'conversation and takes up context; a skill sits aside and its text is ' +
        'loaded only when it is needed. That makes skills the right place for long ' +
        'multi-step processes that would never fit in a rule.',

      whyOnDemand: 'Switches on for the task',
      whyOnDemandText:
        'Claude reads the descriptions of all skills and takes the one that fits ' +
        'the request. Twenty detailed instructions do not get in each other’s way, ' +
        'because only one is active at a time.',
      whyProcess: 'Holds a whole process',
      whyProcessText:
        'A skill can lay out the order of work step by step and carry examples, ' +
        'file templates and configs — it is a folder, not a single field.',
      whyPortable: 'Moves as one piece',
      whyPortableText:
        'A skill is an ordinary directory with markdown inside. Copy it to another ' +
        'machine, put it in a repository, or link a folder that lives elsewhere.',

      canCreate:
        'Create a skill as one file, with a ready-made structure, or from a SKILL.md template',
      canRename:
        'Rename a skill: the panel moves the folder and updates references to it in groups',
      canTree: 'Edit any file of the skill right in its card, as a tree',
      canAssistant: 'Ask the assistant to build the structure from a description of the task',
      canSearch: 'Search by the name and description of a skill',
      canToggle: 'Switch a skill off without deleting it from disk',
      canRestore: 'Restore a deleted skill from a backup with one button',
      canSandbox: 'Check in the sandbox whether the description actually fires',
      canLink:
        'Keep a skill elsewhere: a symlink or junction inside skills/ is read by the ' +
        'panel as an ordinary folder',

      cantAutoRead:
        'Count on Claude reading nested files by itself — it only takes them through ' +
        'a link from SKILL.md',
      cantGuarantee:
        'Know in advance whether a skill will be picked: the model decides from the ' +
        'description, and only a run shows it',
      cantVersions: 'Keep versions and an edit history inside the panel',

      storageFolder: 'Skill folder',
      storageMain: 'Main file',
      storageMainValue: 'SKILL.md with a YAML header of name and description',
      storageDisabled: 'Disabled ones',
      storageOff: 'What Claude reads',
      storageOffValue: 'the skills/ directory only — anything else is invisible',

      flowTitle: 'How a skill gets into the work',
      flowCaption:
        'The second step is the key one. Only the descriptions go into context up ' +
        'front; the full text of the instruction is loaded after the skill has been ' +
        'chosen.',
      flowFolder: 'Skill folder',
      flowFolderCaption: 'SKILL.md and nested files',
      flowDescriptions: 'Claude reads the descriptions',
      flowDescriptionsCaption: 'of every skill at once',
      flowMatch: 'The task matched',
      flowMatchCaption: 'the model decides from description',
      flowBody: 'The instruction is loaded',
      flowBodyCaption: 'the skill text is in play',

      descriptionTitle: 'The description is the field that matters',
      descriptionCaption:
        'It alone decides whether the skill is used. The body of the skill has no ' +
        'say in it: nobody has read it yet.',
      descGood: 'A description that works',
      descGoodText:
        'It names the situation and the words the user arrives with: “Use WHEN the ' +
        'user asks to write e2e tests, cover a flow with Playwright”.',
      descBad: 'A description that will not fire',
      descBadText:
        '“Helps with tests” gives nothing to catch on. The model cannot tell this ' +
        'skill from the three next to it and picks none of them.',
      descTip: 'Check it on the spot',
      descTipText:
        'Run the skill in the sandbox: the panel builds a provoking task out of the ' +
        'description and shows whether the skill took it on.',

      templatesTitle: 'Structure templates',
      templatesCaption:
        'Chosen when creating a skill in builder mode, and expanded as soon as the ' +
        'skill appears on disk.',
      tplMinimal: 'Simple skill',
      tplMinimalText: 'A single SKILL.md. Right when the instruction fits on one page.',
      tplRefs: 'Skill with modules',
      tplRefsText:
        'SKILL.md plus references/rules.md and references/examples.md. Rules and ' +
        'examples live separately, and SKILL.md links to them.',
      tplFull: 'Skill with configs and templates',
      tplFullText:
        'Adds config/ and templates/ directories — for ready-made files the skill ' +
        'suggests copying into a project.',
      templatesNote:
        'A template never overwrites what you wrote: a file with content is skipped ' +
        'and only the missing ones are created.',

      fieldsTitle: 'Fields of a skill',
      fieldsCaption: 'Names match the skillDraftSchema schema.',
      fieldName:
        'A latin name with dashes. It is also the folder name and the identifier. ' +
        'Locked once the skill exists.',
      fieldDescription:
        'When to use the skill: the situation and the words of the user. The model ' +
        'decides from this field whether to load the skill.',
      fieldBody:
        'Instructions in markdown: what to do step by step, what not to do, how to ' +
        'verify the result.',
      fieldFiles:
        'Nested files of the skill: examples, configs, templates. Edited as a tree in ' +
        'the card. Deleting a file or folder in the tree asks for confirmation with the ' +
        'name typed in: a folder goes with everything inside it.',
      fieldGroups: 'Groups the skill belongs to.',

      offTitle: 'What happens when you switch a skill off',
      offCaption:
        'Here switching off physically moves the folder. Claude scans only skills/, ' +
        'so a moved skill simply does not exist for it.',
      offToggle: 'Toggle switched off',
      offMove: 'skills-disabled/',
      offMoveCaption: 'the whole folder moved',
      offResult: 'The skill is invisible',
      offResultCaption: 'files are intact, the toggle brings it back',

      assistantTitle: 'Two assistants',
      assistantCaption:
        'One fills in form fields, the other assembles files. They are different ' +
        'things and worth keeping apart.',
      assistantForm: 'Form assistant',
      assistantFormText:
        'Fills in the name, description and text of the skill from your account of ' +
        'the task. You see the result before saving, and can keep refining it.',
      assistantStructure: 'Structure assistant',
      assistantStructureText:
        'Returns not fields but a list of files with content, and lays them out in ' +
        'the skill folder. Existing files are updated, new ones added, nothing is ' +
        'deleted on its own. It works step by step: the structure can be refined in ' +
        'the same conversation.',
      assistantNote:
        'The structure assistant sees the current tree and edits it sensibly, but ' +
        'large files are shown to it trimmed — a very long file may not be understood ' +
        'in full.',

      notesTitle: 'Things people trip over',
      noteNestedTitle: 'Nested files are read only through a link',
      noteNestedText:
        'Claude Code does not walk the skill folder by itself. If nothing in SKILL.md ' +
        'links to references/rules.md, that file is never read — it just sits there.',
      noteNameTitle: 'The name cannot be changed',
      noteNameText:
        'The skill name is the directory name and the identifier. For an existing ' +
        'skill the field is locked: changing it would create a second folder rather ' +
        'than rename the first.',
      noteDeleteTitle: 'Deleting wipes the whole folder, but takes a backup first',
      noteDeleteText:
        'Every nested file goes at once. Before that the folder is copied whole into ' +
        'claude-control/backups — as it is for rules and hooks. You can bring it back ' +
        'with the “Restore” button in the backups list on the settings page — the folder ' +
        'is unpacked back into skills/. No copy is made if backups before writing are ' +
        'switched off in the settings. To disable a skill for a while, use the toggle — ' +
        'it deletes nothing.',
      noteDescTitle: 'A skill that never fires is almost always a description problem',
      noteDescText:
        'If the instruction is good but Claude keeps ignoring it, rewrite the ' +
        'description rather than the body: that is what the decision is made on.',
      noteProviderTitle: 'With other providers the skills are their own',
      noteProviderText:
        'Everything here is about the Claude skills section (a folder with SKILL.md, enable by ' +
        'moving into skills-disabled, groups, templates). With the OpenCode provider the section ' +
        'opens a different screen: its CLI skills live in ~/.config/opencode/skills/<name>/SKILL.md ' +
        '(and <project>/.opencode/skills/ per project). The concept is the same, but the panel ' +
        'edits only the two required front-matter fields — name and description; license, ' +
        'compatibility, metadata and any foreign fields it keeps and shows read-only. The name ' +
        'must equal the folder name and follow the rules (lowercase letters, digits and single ' +
        'hyphens, 1–64 characters). Worth knowing: OpenCode also loads skills from ~/.claude/skills ' +
        'and ~/.agents/skills, so your Claude skills already work in it — the panel says so and ' +
        'writes nothing into those directories. With Qwen Code and Kimi Code the screen is ' +
        'the same, only the directories differ: ~/.qwen/skills/ and <project>/.qwen/skills/ ' +
        'for Qwen, ~/.kimi-code/skills/ and <project>/.kimi-code/skills/ for Kimi — which, ' +
        'like OpenCode, also picks up the shared ~/.agents/skills, and the panel writes ' +
        'nothing there either. One difference: Kimi’s docs cap description at 240 ' +
        'characters, and the panel checks exactly that bound.',
    },

    commands: {
      title: 'Commands',
      summary: 'Everything you type after “/”, in one searchable list',
      lead:
        'A slash command is not a thing of its own on disk: the same “/” menu is ' +
        'assembled from skills, command files, plugins and the built-in commands of ' +
        'the CLI itself. The palette shows only a name, so there is usually nowhere ' +
        'to learn what a command does, whose it is and where to edit it. This ' +
        'section shows the whole set at once: source, description, owner, file path ' +
        'and a button that jumps to the section where the command lives.',

      whyOne: 'One list instead of four places',
      whyOneText:
        'Skills, command files, plugins and built-ins live in different places yet ' +
        'are invoked the same way. Here they are merged into one list sorted by name.',
      whyWhose: 'Origin is visible',
      whyWhoseText:
        'Every row carries a source badge and an owner: a skill, a file in commands/, ' +
        'a plugin command or a built-in CLI command. It is immediately clear where a ' +
        'command came from and why it disappears once a plugin is switched off.',
      whyJump: 'Editing is one click away',
      whyJumpText:
        'When a command has a file, the button opens it in its home section — a skill ' +
        'in Skills, a plugin command in Plugins, with the item already selected.',

      storageSkills: 'Skills',
      storageFiles: 'Command files',
      storagePlugins: 'Plugins',
      storageBuiltin: 'Built-ins',
      storageBuiltinValue:
        'no file — they are baked into the CLI, the panel keeps its own list with descriptions',

      flowTitle: 'How the list is assembled',
      flowCaption:
        'The panel reads the active provider’s directories every time the section is ' +
        'opened: nothing is cached and nothing is copied anywhere.',
      flowDisk: 'Directories on disk',
      flowDiskCaption: 'skills/, commands/, plugins/',
      flowMerge: 'The panel merges them',
      flowMergeCaption: 'source, description, owner',
      flowSearch: 'Search and filters',
      flowSearchCaption: 'by name, description, owner',
      flowOpen: 'Jump to editing',
      flowOpenCaption: 'to the section where it lives',

      sourcesTitle: 'Four sources',
      sourcesCaption:
        'The name follows from the source: a skill uses its folder name, a file uses ' +
        'its path through a colon, a plugin puts its own name before the colon.',
      sourceSkill:
        'A skill folder: ~/.claude/skills/<name>/SKILL.md. The description comes from ' +
        'the description field, the command name equals the folder name.',
      sourceCommand:
        'A file ~/.claude/commands/<folder>/<name>.md. A nested folder becomes part of ' +
        'the name: commands/git/commit.md is invoked as /git:commit.',
      sourcePlugin:
        'A command or skill of an installed plugin. The plugin name comes first; a ' +
        'disabled plugin stays in the list with a badge.',
      sourceBuiltin:
        'Commands of the CLI itself. They have no file and cannot be edited — the panel ' +
        'keeps its own list of them with descriptions in both languages.',
      badgeSkill: 'skill',
      badgeCommand: 'file',
      badgePlugin: 'plugin',
      badgeBuiltin: 'built-in',

      canList: 'See every command of the active provider in a single list',
      canSearch: 'Search by name, description, owner and aliases — with or without the leading “/”',
      canFilter: 'Keep only skills, files, plugins or built-ins — with counts',
      canFamily: 'See which commands this one is grouped with',
      canOpen: 'Jump to editing a skill or a plugin with one button',
      canDisabled: 'See disabled skills and plugins — they are badged, not hidden',
      canProvider: 'Open the same list for Gemini, Qwen and OpenCode — from their command folders',

      cantEdit: 'Edit a command here — the section only reads, editing happens in its home section',
      cantRun: 'Run a command from here — invoking stays with the chat and the CLI',
      cantTranslate:
        'Translate foreign descriptions: a skill’s or plugin’s description is shown exactly ' +
        'as written in its file',
      cantFresh:
        'Learn about a brand-new built-in without updating the panel: the CLI does not expose its list',

      familyTitle: 'Command groups',
      familyCaption:
        'Commands often come in sets. The panel derives the group itself, from the name ' +
        'and the owner, and shows the siblings right in the row.',
      familyPrefix: 'By the start of the name',
      familyPrefixText:
        'Commands sharing a first word count as one group: /design-sync and /design-login. ' +
        'A group of one is not shown.',
      familyOwner: 'By owner',
      familyOwnerText:
        'Everything a single plugin brings is one group regardless of names. That makes it ' +
        'visible that removing the plugin takes all of its commands with it.',

      notesTitle: 'Worth knowing',
      noteReadOnlyTitle: 'The section changes nothing',
      noteReadOnlyText:
        'There are no forms and no save buttons here: it is a display case. Any edit goes ' +
        'through the Skills or Plugins section the button leads to.',
      noteAutoTitle: 'Your commands show up on their own',
      noteAutoText:
        'The list is read from disk every time the section is opened. A new skill, a new ' +
        'file in commands/ or an installed plugin appears here with no setup — anyone who ' +
        'installs the panel sees their own commands, not someone else’s.',
      noteBuiltinTitle: 'Built-ins are checked against the docs',
      noteBuiltinText:
        'The list of built-in commands is maintained by the panel — the CLI cannot enumerate ' +
        'them. It is checked against the Claude Code reference and updated together with the ' +
        'panel, so a command from a fresh CLI release may show up here later.',
      noteDescTitle: 'The description comes from the file',
      noteDescText:
        'For skills and plugins the panel shows their own description and does not translate ' +
        'it: the language of the file is the language you see. Switching the language changes ' +
        'the interface and the descriptions of built-in commands.',
      noteProviderTitle: 'With other providers',
      noteProviderText:
        'Gemini and Qwen keep commands in commands/**/*.toml files (description comes from the ' +
        'description field, otherwise from the first line of prompt), OpenCode in commands/*.md ' +
        'and in the command key of opencode.json. For the remaining CLIs the format of user ' +
        'commands is not covered by their documentation, so the section is hidden there: the ' +
        'panel does not invent a format the docs do not describe.',
    },

    rules: {
      title: 'Rules',
      summary: 'Standing instructions in CLAUDE.md that Claude always takes into account',
      lead:
        'A rule is a standing instruction that Claude Code reads at the start of ' +
        'every session. Everything written here applies by default: the language ' +
        'to answer in, what is off limits, how to work, what counts as verified. ' +
        'It is not a prompt for one conversation but behaviour you never have to ' +
        'repeat.',

      whyRepeat: 'Stop repeating yourself',
      whyRepeatText:
        'What you explain to Claude in every conversation — the language to answer ' +
        'in, what is off limits, how to verify — is written once and then holds on ' +
        'its own.',
      whyEverywhere: 'The same in every project',
      whyEverywhereText:
        'Personal rules are read in any folder where Claude Code runs. Moving to ' +
        'another project does not start with explaining everything again.',
      whyVisible: 'Visible and reversible',
      whyVisibleText:
        'It is an ordinary markdown file: a rule can be read with your own eyes, ' +
        'switched off with a toggle and restored from a backup.',

      canWrite: 'Write rules as text, with the builder, or a batch at once',
      canToggle: 'Switch a rule off without losing its text',
      canSearch: 'Search by the heading and the body of a rule',
      canSandbox: 'Check a rule with a real conversation in the sandbox',
      canGroup: 'Collect rules into groups and switch them on as sets',
      canEditByHand: 'Edit CLAUDE.md by hand — the panel picks the changes up',

      cantProject:
        'Project-level rules here: this section manages your own ~/.claude/CLAUDE.md, ' +
        'while a specific project’s CLAUDE.md is edited in the Projects section',
      cantPriority:
        'Priority between rules: Claude reads the whole file, and a contradiction ' +
        'between two rules is not resolved for you',
      cantHistory:
        'A per-rule edit history: what accumulates is copies of the whole CLAUDE.md — a ' +
        'restore brings back the file of that moment, not one corrected rule',
      cantForce: 'A guarantee of compliance: a rule is an instruction, not a technical limit',

      storageFile: 'File',
      storageUnit: 'One rule',
      storageUnitValue: 'a markdown section starting with ##',
      storageReader: 'Who reads it',
      storageReaderValue: 'Claude Code, when a session starts',
      storageBackup: 'Backups',

      flowTitle: 'How a rule reaches Claude',
      flowCaption:
        'The file stays ordinary markdown: the panel parses it into rules and ' +
        'writes it back without breaking the format. You can open and edit it by ' +
        'hand — the panel will pick the changes up.',
      flowForm: 'Form in the panel',
      flowFormCaption: 'title and text',
      flowFile: 'CLAUDE.md',
      flowFileCaption: 'a ## Heading section',
      flowStart: 'Session start',
      flowStartCaption: 'Claude Code reads the file',
      flowAnswer: 'Every answer',
      flowAnswerCaption: 'the rule applies',
      flowEdgeSave: 'save',
      flowEdgeRestart: 'restart',
      flowEdgeAlways: 'always',

      modesTitle: 'Three ways to write a rule',
      modesCaption:
        'The choice of mode appears only when creating a rule. An existing rule ' +
        'is edited in a plain text field.',
      modeSimple: 'Plain text',
      modeSimpleText: 'A single field, markdown allowed. Best when the wording is already clear.',
      modeBuilder: 'Builder',
      modeBuilderText:
        'Blocks for “allowed”, “not allowed” and “with care”. The panel turns them ' +
        'into markdown with headings and drops empty entries. Best when the rule is ' +
        'a list of limits.',
      modeBulk: 'Bulk list',
      modeBulkText:
        'One line per rule in the form “Title :: text”. Creates a batch at once — ' +
        'handy for moving over a ready-made set.',
      modesNote:
        'All three modes produce the same thing — ## sections in CLAUDE.md. The ' +
        'mode only changes how comfortable it is to type.',

      fieldsTitle: 'Fields of a rule',
      fieldsCaption:
        'Field names match the ruleDraftSchema schema, so they are searchable in code.',
      fieldTitle:
        'The rule heading. It becomes the ## heading in the file, and the ' +
        'identifier for links like /rules?id=… is derived from it.',
      fieldBody: 'The rule text in markdown: what to do, what not to do, how to verify the result.',
      fieldEnabled:
        'Whether the rule is on. A disabled rule is not deleted — it moves to the ' +
        'end of the file.',
      fieldGroups:
        'Groups the rule belongs to. Through a group it can be switched on and off ' +
        'together with other settings.',

      offTitle: 'What happens when you switch a rule off',
      offCaption:
        'Switching off is not deleting. The text stays in the file and returns to ' +
        'its place when the toggle goes back on.',
      offToggle: 'Toggle switched off',
      offToggleCaption: 'the rule is hidden from Claude',
      offSection: '## Disabled rules',
      offSectionCaption: 'a section at the end of CLAUDE.md',
      offResult: 'Claude does not read it',
      offResultCaption: 'the text is kept',

      assistantTitle: 'The assistant',
      assistantCaption:
        'The rule form has an assistant: the right half of the window is a normal ' +
        'chat that fills in the fields on the left.',
      assistantAsk: 'You describe the task',
      assistantAskCaption: 'by typing or by voice',
      assistantRun: 'The panel runs Claude',
      assistantRunCaption: 'on your subscription',
      assistantReply: 'The model returns fields',
      assistantReplyCaption: 'title and body',
      assistantFill: 'Fields are filled in',
      assistantFillCaption: 'changed ones are highlighted',

      assistantStep1: 'Describe the task in plain words',
      assistantStep1Text:
        'For example: “always answer in Russian, including the choice options”. ' +
        'There is no need for formal wording.',
      assistantStep2: 'Look at what was filled in',
      assistantStep2Text:
        'Changed fields get green badges. The form does not save itself — you see ' +
        'the result before anything is written to the file.',
      assistantStep3: 'Refine it in the same conversation',
      assistantStep3Text:
        '“Make it stricter”, “add something about tests” — the assistant remembers ' +
        'the previous messages and edits the text it already produced.',
      assistantStep4: 'Save',
      assistantStep4Text: 'Until you press save, CLAUDE.md is untouched.',

      assistantKeyTitle: 'No separate API key is needed',
      assistantKeyText:
        'The assistant runs the same claude you use in the terminal, on your ' + 'subscription.',
      assistantMemoryTitle: 'The conversation lasts as long as the window is open',
      assistantMemoryText:
        'Close the form and the next conversation with the assistant starts from ' +
        'a blank slate.',

      checkTitle: 'How to check that a rule works',
      checkCaption: 'The check runs in isolation and does not touch your real ~/.claude directory.',
      checkStep1: 'Press the sandbox icon on the rule card',
      checkStep1Text: 'The sandbox is a temporary configuration containing only what you selected.',
      checkStep2: 'Ask something the rule should affect',
      checkStep2Text:
        'If the rule is about the language of the answer, ask anything and look at ' +
        'the language you get back.',
      checkStep3: 'Compare with the usual behaviour',
      checkStep3Text:
        'The difference between the sandbox run and a normal conversation is exactly ' +
        'what the rule contributes.',

      notesTitle: 'Things people trip over',
      noteRestartTitle: 'Changes apply after a restart',
      noteRestartText:
        'Claude Code reads CLAUDE.md when a session starts. An open conversation ' +
        'keeps working by the old rules — that is not a fault.',
      noteRenameTitle: 'Renaming changes the identifier',
      noteRenameText:
        'The identifier is derived from the heading. After a rename, a link like ' +
        '/rules?id=old-name will no longer open the rule.',
      noteDuplicateTitle: 'Identical headings get a suffix',
      noteDuplicateText:
        'A second rule with the same heading becomes -2, a third -3. Otherwise an ' +
        'edit to one would land in the other.',
      noteDeleteTitle: 'Deleting cuts the section out of the file',
      noteDeleteText:
        'A copy of the file stays in claude-control/backups, but the rule will be ' +
        'gone from CLAUDE.md itself. To disable it temporarily, use the toggle.',
      noteWordingTitle: 'Word it so it can be checked',
      noteWordingText:
        'A rule applies in every conversation. “Answer in Russian” can be checked, ' +
        '“write well” cannot — and Claude has no way to comply with the second.',
    },

    claudeMd: {
      title: 'CLAUDE.md',
      summary: 'The same rules file, whole and unchanged: preamble, order, formatting',
      lead:
        'The Rules section splits CLAUDE.md into cards, and that is enough while ' +
        'the file consists of rules. But it also holds things that do not fit into ' +
        'cards: the opening preamble, your own headings, the order of sections, ' +
        'blank lines and links. Here the file is open as plain text — exactly as ' +
        'Claude Code itself reads it.',

      whyWhole: 'The whole file is visible',
      whyWholeText:
        'A list of cards shows the rules but not the file. The preamble, custom ' +
        'sections and whatever sits between them are visible only here.',
      whyRaw: 'The text is saved as is',
      whyRawText:
        'The panel writes exactly what is in the field: no rebuilt headings, no ' +
        'reordered sections. The formatting you shaped by hand stays yours.',
      whyFast: 'A quick edit without a form',
      whyFastText:
        'Changing a single word in the middle of a rule, fixing a typo or swapping ' +
        'two paragraphs is easier in the text itself than through a card form.',

      canSeeAll: 'Read the global CLAUDE.md in full, preamble and service sections included',
      canEditAnything: 'Edit any part of the file, including what the Rules section does not show',
      canOrder: 'Reorder sections and set your own sequence of rules',
      canRevert: 'Discard unsaved edits and go back to what is on disk',
      canFixParse:
        'Repair the file by hand if edits made outside the panel left it parsing wrongly',

      cantProject: 'Open a project CLAUDE.md — this is the global one from ~/.claude only',
      cantPreview: 'Get a markdown preview or syntax highlighting: this is a plain text field',
      cantToggle: 'Switch a single rule off or put rules into a group — that is the Rules section',
      cantHistory:
        'Browse an edit history here: copies go to backups, and rollback lives in Settings',

      storageFile: 'File',
      storageFormat: 'Format',
      storageFormatValue: 'plain markdown; rules are second-level sections',
      storageReader: 'Who reads it',
      storageReaderValue: 'Claude Code itself, in full, when a session starts',
      storageBackup: 'Copy before writing',

      flowTitle: 'What happens when you save',
      flowCaption:
        'The backup is made before the write, not after: the file you are editing is ' +
        'a live configuration, and there has to be something to roll back to.',
      flowEditor: 'Edit in the field',
      flowEditorCaption: 'the whole text',
      flowBackup: 'Backup copy',
      flowBackupCaption: 'claude-control/backups',
      flowFile: '~/.claude/CLAUDE.md',
      flowFileCaption: 'overwritten as is',
      flowSession: 'New session',
      flowSessionCaption: 'reads the updated file',
      flowEdgeSave: 'the Save button',
      flowEdgeWrite: 'write',
      flowEdgeRestart: 'restart',

      pairTitle: 'How this differs from the Rules section',
      pairCaption:
        'The file is the same one; the difference is in how it gets written. That is ' +
        'what decides the fate of your formatting.',
      pairRules: 'The Rules section',
      pairRulesText:
        'A card per rule: toggle, groups, assistant, a link to a specific rule. On save ' +
        'the file is rebuilt — preamble, then sections shaped as “## ПРАВИЛО: heading”. ' +
        'A second-level heading of your own becomes a rule with that same name after ' +
        'such a rebuild.',
      pairFile: 'This section',
      pairFileText:
        'One text field for the whole file. No toggles, no groups, no assistant — but ' +
        'the text reaches disk byte for byte. Reach for it when the structure of the ' +
        'file matters more than managing an individual rule.',
      pairNoteTitle: 'Do not keep both sections open at once',
      pairNoteText:
        'The field here holds the text that loaded when the page opened. Save a rule in ' +
        'the other tab, then save here, and the write from this page returns the file to ' +
        'its loaded state, overwriting the edit made in Rules.',

      recipesTitle: 'How to edit the file by hand',
      recipe1: 'Open the section and read what the file contains',
      recipe1Text:
        'The character count is shown at the bottom. An empty file and a forty-thousand ' +
        'character one are different conversations: all of it goes into the context of ' +
        'every session.',
      recipe2: 'Make your edit in the text',
      recipe2Text:
        'While edits are unsaved, a note next to the counter says so, and the Discard ' +
        'edits button brings back the loaded text.',
      recipe3: 'Save',
      recipe3Text:
        'A backup copy is created in ~/.claude/claude-control/backups/ before the write. ' +
        'The list of copies and the rollback live in Settings.',
      recipe4: 'Restart Claude Code',
      recipe4Text:
        'CLAUDE.md is read when a session starts. A running conversation will not see the ' +
        'new text — neither in the terminal nor in the panel chat.',

      notesTitle: 'Details people trip over',
      noteRestartTitle: 'Changes reach Claude only after a restart',
      noteRestartText:
        'The file is written immediately, but a session reads it once, at startup. Check ' +
        'your edit in a new conversation, or it will look as if the rule does not work.',
      noteDisabledTitle: 'The “Отключённые правила (Claude Control)” section is not junk',
      noteDisabledText:
        'It is where the panel keeps the text of rules switched off by toggle: they must ' +
        'not stay in the file itself, or Claude would follow them. Delete that section by ' +
        'hand and the text of the disabled rules is gone — the toggle cannot bring it back.',
      noteStaleTitle: 'The text in the field is a snapshot from the moment you opened it',
      noteStaleText:
        'The panel does not watch the file. If it was changed elsewhere — by an editor, ' +
        'another agent or the Rules section — reload the page before editing, otherwise ' +
        'saving restores the older version.',
      noteBackupTitle: 'A copy is made on every save',
      noteBackupText:
        'Even if you changed a single character. Copies live in ' +
        '~/.claude/claude-control/backups/ and are rolled back from Settings — that is the ' +
        'safety net for editing by hand.',
      noteHeadingTitle: 'Second-level headings are rules',
      noteHeadingText:
        'The Rules section shows any “## Heading” as a rule, and the “ПРАВИЛО:” prefix is ' +
        'optional — it is stripped on read and added back on write. For a subheading inside ' +
        'a rule use the third level, “### ”.',
      noteProviderTitle: 'Other providers, three different instruction models',
      noteProviderText:
        'The section is universal, but the CLIs organise instructions differently and the ' +
        'panel shows the model that actually exists. ONE FILE: Claude (CLAUDE.md), Codex and ' +
        'OpenCode (AGENTS.md), Gemini (GEMINI.md), Qwen Code (QWEN.md) — everything above is ' +
        'about them. LIST OF ' +
        'REFERENCES: Aider has no single instructions file — context files are declared by ' +
        'the read option in .aider.conf.yml, and the section edits exactly that list (add, ' +
        'remove, reorder); the contents of a listed file can be opened separately, if that ' +
        'file already exists. RULES DIRECTORY: Cursor keeps rules in ~/.cursor/rules (and ' +
        '<project>/.cursor/rules), where every .mdc file is one rule: frontmatter on top ' +
        'with a description, file globs and an "always apply" flag, markdown text below. ' +
        'There the section becomes a manager for that directory: list, create, edit, delete; ' +
        'subdirectories are supported, and a plain .md is ignored by Cursor — the panel ' +
        'lists such files separately and never touches them. Details are in the Providers ' +
        'article.',
    },

    search: {
      title: 'Search',
      summary: 'One line searches across every configuration section at once',
      lead:
        'Search answers the question “where did I configure this”, without walking the ' +
        'sections one by one. A single line runs across rules, skills, hooks, scripts, ' +
        'permissions, variables, MCP servers and plugins, and clicking a hit opens it ' +
        'right in its own section.',

      whyOne: 'One entry instead of walking sections',
      whyOneText:
        'No need to remember where a setting lives: the query runs across all sections ' +
        'at once, and the results are grouped by type.',
      whyCross: 'Finds by name and by content',
      whyCrossText:
        'It searches the heading and the body alike: a hook command, a permission ' +
        'pattern, a variable name, an MCP server URL.',
      whySafe: 'Never reveals secrets',
      whySafeText:
        'For environment variables it searches and shows the key name only — the value, ' +
        'even masked, never reaches the result.',

      storageWhere: 'What it searches',
      storageWhereValue:
        'the current configuration, not a separate store — search has no index of its own',
      storageScope: 'Sections',
      storageScopeValue: 'rules, skills, hooks, scripts, permissions, variables, MCP, plugins',
      storageMin: 'Minimum',
      storageMinValue: 'a query of two characters or more — shorter does not run',
      storageSecrets: 'Secrets',
      storageSecretsValue: 'for variables, key names only, no values',

      canAll: 'Search all eight configuration sections at once with one line',
      canGrouped: 'See results grouped by section, with a snippet around the match',
      canOpen: 'Open a hit right in its section — with the entry highlighted',
      canLive: 'Search the current state: it reads the same files the sections do',

      cantBody: 'Search the body of a chat — that is a separate search in the chat list',
      cantSecrets: 'Find a secret value: for variables only the key names are available',
      cantEdit: 'Edit a hit straight from the results — editing lives in the section itself',

      notesTitle: 'Things that trip people up',
      noteSecretTitle: 'Secret values never reach this',
      noteSecretText:
        'For environment variables the search works with key names only. Even a masked ' +
        'value does not go into the results.',
      noteChatTitle: 'A different search covers chats',
      noteChatText:
        'This section searches the configuration. To find a conversation by what it ' +
        'discussed, there is a search over message bodies in the chat list.',
    },

    compare: {
      title: 'Configuration comparison',
      summary: 'What one CLI has and the other does not — and how to move it across',
      lead:
        'The section is about TWO providers at once, so it does not depend on the active one. ' +
        'The left side defaults to the active CLI, the right side is any other. The panel reads ' +
        'both sides and shows the difference per section; opening the page changes nothing.',

      whyMemory: 'Otherwise it lives in your head',
      whyMemoryText:
        'Finding out which MCP servers Claude has and Codex does not meant opening sections one ' +
        'by one and comparing by eye. Here both sides are on one screen.',
      whyMeaning: 'Compared by meaning, not by text',
      whyMeaningText:
        'The same server is written differently in TOML and in JSON. The panel compares parsed ' +
        'values rather than file lines — otherwise everything would come out as different.',
      whyMove: 'The transfer sits where the difference is visible',
      whyMoveText:
        'Tick the entries and press the button for the direction you need. Copying by hand ' +
        'between formats is the easiest way to lose a server to a stray quote.',

      readTitle: 'How to read the columns',
      readCaption: 'The label on the right says what is wrong with the entry — or that nothing is.',
      readSame: 'identical',
      readSameText: 'The entry exists on both sides and the values match in meaning.',
      readDiffers: 'differs',
      readDiffersText:
        'Same name, different parameters: another command, another address, other variables. ' +
        'Such a row is marked with a stripe on the left.',
      readOnly: 'left only / right only',
      readOnlyText: 'The other side has no such entry at all — a candidate for the transfer.',
      readSecret: 'secret values',
      readSecretText:
        'Variables that look like keys and tokens are shown masked and checked by presence only. ' +
        'The panel neither shows nor compares a secret value.',

      moveTitle: 'How to move an entry',
      moveCaption: 'The write is always the second step — after the diff of the target file.',
      moveStep1: 'Tick the entries',
      moveStep1Text:
        'Blocked ones cannot be ticked: the line underneath says why they cannot be moved.',
      moveStep2: 'Press the button for the direction',
      moveStep2Text:
        'The panel computes the diff on a temporary copy of the target file and shows all of it.',
      moveStep3: 'Confirm with the write button',
      moveStep3Text:
        'Only now does the real file change — with a backup, if backups are on in the settings. ' +
        'Cancel writes nothing.',

      canCompare: 'Compare MCP servers, variables, permissions and global instructions',
      canMcp: 'Move MCP servers both ways, Claude included',
      canInstructions: 'Copy the global instructions text (CLAUDE.md into AGENTS.md and back)',
      canPreview: 'Show the real diff of the target file before writing',
      cantEnv:
        'Move environment variables: they hold keys, and the panel writes no secrets into ' +
        'foreign configurations',
      cantPermissions:
        'Move permissions: the CLIs have different approval models, and a translation would be ' +
        'a guess',
      cantDisabled: 'Move disabled servers or the sse transport, which other CLIs do not have',

      noteTitle: 'Moving instructions overwrites the whole file',
      noteText:
        'It is a copy, not a merge: the source text replaces the target text. The diff before the ' +
        'write says so plainly — read it if the target file had something of its own.',
    },
    history: {
      title: 'Change history',
      summary: 'A feed of configuration edits with a line-by-line diff over the backups',
      lead:
        'Before each write the panel keeps a backup of the file. The feed is built from ' +
        'those backups: what changed and when, and how an edit differs from the previous ' +
        'one. The diff reads chronologically forward, so “+N/−M” is how many lines this ' +
        'edit added and removed.',

      whyWhat: 'You can see what changed',
      whyWhatText:
        'The feed collects edits per configuration file: settings.json, CLAUDE.md, ' +
        '.mcp.json and their local pairs.',
      whyDiff: 'A line-by-line diff',
      whyDiffText:
        'For each edit you see the added and removed lines, not just the fact that ' +
        'something changed.',
      whyFree: 'It launches nothing',
      whyFreeText:
        'This is reading already-taken backups: the section does not call the CLI and ' +
        'does not touch files, so it opens fast and without side effects.',

      storageSource: 'Source',
      storageTracked: 'Tracked',
      storageTrackedValue: 'settings.json, settings.local.json, CLAUDE.md, .mcp.json',
      storageSecrets: 'Excluded',
      storageDir: 'When available',
      storageDirValue: 'even when backup creation is off — the old backups are still there',

      canFeed: 'Browse the feed of edits per configuration file',
      canDiff: 'Open the line-by-line diff of a single edit',
      canCounts: 'See “+N/−M” — how many lines an edit added and removed',
      canOffline: 'Read the history even when creating new backups is off',

      cantSecrets: 'See a diff of .mcp-secrets.env — secrets are deliberately not diffed',
      cantRestore: 'Roll a version back from here — restoring lives in the Settings section',
      cantBig: 'Get a diff of a very large or binary file — it is not parsed',

      notesTitle: 'Things that trip people up',
      noteSecretTitle: 'Secrets are not diffed',
      noteSecretText:
        'The .mcp-secrets.env file is not among the tracked ones: a line-by-line diff ' +
        'would reveal token values right in the UI.',
      noteRestoreTitle: 'Restore is in Settings',
      noteRestoreText:
        'History shows what changed. Bringing a whole file back to a past backup is done ' +
        'from the Settings section.',
      noteBigTitle: 'Large files are not parsed',
      noteBigText:
        'A file that is too large or binary does not go into a diff — the feed stays ' +
        'cheap and does not drag junk into the UI.',
    },

    projects: {
      title: 'Projects',
      summary: 'The project level: a folder’s own CLAUDE.md, MCP servers and permissions',
      lead:
        'Beyond the user-level ~/.claude, the panel can manage a specific project’s ' +
        'configuration. Register a folder and edit its own CLAUDE.md, .mcp.json and ' +
        '.claude/settings.json. This is added on top of the user level, without ' +
        'touching it.',

      whyLevel: 'Settings next to the code',
      whyLevelText:
        'A project’s rules, MCP servers and permissions live in its directory and travel ' +
        'with the repository.',
      whyAdditive: 'On top of the user level',
      whyAdditiveText:
        'The project level is added to your own ~/.claude rather than replacing it: the ' +
        'shared settings stay in place.',
      whySame: 'The same forms',
      whySameText:
        'A project’s files use the same format as the user level, so rules, MCP and ' +
        'permissions are edited with the familiar forms.',

      storageRules: 'Rules',
      storageMcp: 'MCP servers',
      storagePerms: 'Permissions',
      storageCreate: 'The .claude directory',
      storageCreateValue: 'created on the first write if the project does not have it yet',

      canRegister: 'Register a project folder by its absolute path',
      canRules: 'Edit the project’s CLAUDE.md',
      canMcp: 'Manage the project’s MCP servers in its .mcp.json',
      canPerms: 'Configure the project’s permissions in .claude/settings.json',
      canAdditive: 'Work with a project without touching the user level',

      cantGroups:
        'Groups, soft-disable, the health check, OAuth and the sandbox — not on projects yet',
      cantHooks: 'Project hooks — they are not surfaced in the UI yet',
      cantHealth:
        'Check the connection to a project’s MCP server — health is available on the ' +
        'user level only',

      fieldsTitle: 'Fields',
      fieldPath: 'The absolute path to the project directory',
      fieldName: 'A short project name — the last path segment by default',

      notesTitle: 'Things that trip people up',
      noteRawTitle: 'The project level is still raw',
      noteRawText:
        'Here you edit a project’s rules, MCP servers and permissions. Groups, ' +
        'soft-disable, the health check, OAuth and the sandbox are not on the project ' +
        'level yet.',
      noteUserTitle: 'The user level is separate',
      noteUserText:
        'The Rules, MCP and Permissions sections still manage ~/.claude. The project ' +
        'level does not replace them, it complements them.',
      noteProviderTitle: 'Another provider means its own project files',
      noteProviderText:
        'Everything above describes Claude. With another CLI active the project registry ' +
        'is the same, but you edit ITS project files: project instructions (AGENTS.md for ' +
        'Codex and OpenCode, GEMINI.md for Gemini) and the project’s MCP servers ' +
        '(.codex/config.toml, .gemini/settings.json, .qwen/settings.json, opencode.json, ' +
        '.cursor/mcp.json, .continue/mcpServers/mcp.json). ' +
        'Gemini adds the project’s environment variables (.gemini/.env) and permissions, ' +
        'and Qwen Code does exactly the same in its own files (QWEN.md, ' +
        '.qwen/settings.json, .qwen/.env); ' +
        'OpenCode adds the project’s permissions in the same opencode.json (the permission ' +
        'key). Aider’s project level is the .aider.conf.yml in the repository root: the read list ' +
        'of attached files and the set-env variables. Instead of a project instructions file ' +
        'Cursor gets the rules directory <project>/.cursor/rules/*.mdc — the same one as ' +
        'globally, with the same path safety. For Continue the project level is the only ' +
        'one it has: the rules directory <project>/.continue/rules/*.md, the MCP file ' +
        '.continue/mcpServers/mcp.json and the .continue/.env variables. Goose’s project level ' +
        'is a single <project>/.goosehints file next to the global one. Kimi Code gets ' +
        'AGENTS.md and the MCP file <project>/.kimi-code/mcp.json in the project; it has no ' +
        'project permissions, since the CLI reads exactly one user-level config.toml. Nobody but Claude ' +
        'gets project hooks.',
    },

    dlp: {
      title: 'Data protection',
      summary:
        'A local proxy between the CLI and the model: it sees the request body and rewrites it by rules',
      lead:
        'The panel raises a listener on 127.0.0.1. Point a CLI at that address instead of the ' +
        'model address and all its traffic goes through the panel, which then sees the BODY of ' +
        'every request: the prompt, the contents of files the agent read, tool output, call ' +
        'arguments. Whatever the rules match is either replaced by a placeholder or stops the ' +
        'request entirely. This is the deepest of the three mechanisms in this area — and the ' +
        'one whose limits matter most: it finds exactly what you described, and nothing beyond.',

      whyBody: 'The body, not just the prompt',
      whyBodyText:
        'A prompt hook sees the line a human typed. The proxy sees everything the agent ' +
        'assembled on its own: files it read, command output, tool contents. Those are what ' +
        'usually leak — not what was typed by hand.',
      whyBack: 'The placeholder is restored',
      whyBackText:
        'A surname becomes [ИМЯ_1] in the request; [ИМЯ_1] becomes the surname again in the ' +
        'reply. The model works with the placeholder, the human reads the real text — including ' +
        'in a streamed reply where the placeholder is split across frames.',
      whyNoTls: 'No TLS interception',
      whyNoTlsText:
        'The CLI talks plain http to a local address, and the proxy makes its own https call ' +
        'upstream. No substituted certificates, no trusted roots, no MITM — which is why the ' +
        'whole setup is one changed address.',

      threeTitle: 'Three different things, easy to confuse',
      threeCaption:
        'The panel does all three, but they solve different problems and fail differently. ' +
        'None of them replaces the other two.',
      threeHeader: 'Mechanism',
      threeWhat: 'What it decides',
      threeEndpoint: 'Your own endpoint',
      threeEndpointText:
        'WHERE the request goes. A model on your own hardware or a company gateway — the data ' +
        'never leaves the perimeter. The request contents are untouched.',
      threeProxy: 'This proxy',
      threeProxyText:
        'WHAT goes in the request. Works with any address, the vendor cloud included: it finds ' +
        'what the rules describe and replaces or refuses.',
      threeGate: 'Prompt gate',
      threeGateText:
        'What a human TYPED by hand. The hook fires before sending, but it only sees the prompt ' +
        'line — files and tool output pass it by.',

      stepsTitle: 'How to switch it on',
      stepsCaption:
        'Five steps; everything outside the panel is a single address line in the CLI config.',
      step1: 'Set up rules',
      step1Text:
        'The ready-made set — email, phone, INN, SNILS, card, secret keys. INN, SNILS and card ' +
        'numbers are checksum-verified: without that, the rule would catch any number of the ' +
        'right length, and a false positive in data protection is worse than a miss — it breaks ' +
        'work and teaches people to switch protection off.',
      step2: 'Add your own dictionary',
      step2Text:
        'Staff names, project names, internal addresses — one value per line. This is precisely ' +
        'what no built-in pattern knows, and precisely what leaks most often.',
      step3: 'Check against a sample text',
      step3Text:
        'The section shows exactly what the model would see, from the current edits and without ' +
        'touching the network. Better to find a mistake in a rule here than in the journal ' +
        'after a leak.',
      step4: 'Start the proxy',
      step4Text:
        'Say where to forward: the vendor cloud, a local model or an endpoint profile. With no ' +
        'address the proxy will not start — it will not guess the vendor cloud for you.',
      step5: 'Point the CLI at the proxy',
      step5Text:
        'An address like http://127.0.0.1:5179 goes into the CLI as the model address — most ' +
        'easily via an endpoint profile on the settings page. Until that is done the proxy sees ' +
        'nothing, while the section looks like it is working.',

      rulesTitle: 'Kinds of rules',
      rulesCaption: 'Three kinds; they coexist happily in one set.',
      rulesHeader: 'Kind',
      rulesWhat: 'What it matches',
      kindBuiltin: 'Built-in pattern',
      kindBuiltinText:
        'Email, phone, INN, SNILS, card number, secret keys. Wherever the format has a ' +
        'checksum, it is verified.',
      kindTerms: 'Own dictionary',
      kindTermsText:
        'A list of values: surnames, names, addresses. Case-insensitive, whole words; Russian ' +
        'inflections are covered — "Урманова" matches "Урманов", while "Ивановский" does not ' +
        'match "Иванов".',
      kindRegex: 'Own expression',
      kindRegexText:
        'A regular expression for formats not among the built-ins: contract numbers, internal ' +
        'identifiers. Validated before saving.',

      actionsTitle: 'What to do with a match',
      actionsCaption:
        'The action is set per rule. A "refuse" rule wins over any replacement: if a request ' +
        'contains something that must not leave at all, sending it partly masked is pointless.',
      actionsHeader: 'Action',
      actionsWhat: 'What happens',
      actionMask: 'Replace with a placeholder',
      actionMaskText:
        'The value becomes [LABEL_N] — one number per value — and the placeholder is restored ' +
        'in the model reply. Numbers live as long as the proxy runs: stop it and they are gone.',
      actionBlock: 'Refuse the request',
      actionBlockText:
        'The request goes nowhere. The CLI gets a refusal shaped like its own API, so the ' +
        'reason reaches the human instead of turning into "unexpected response".',
      actionFlag: 'Record only',
      actionFlagText:
        'Nothing changes, the match lands in the journal. A break-in mode for a new rule: first ' +
        'see what it catches, only then switch replacement on.',
      actionFlagBadge: 'journal',

      shapesTitle: 'Which requests the panel parses',
      shapesCaption:
        'Body shapes come from the API documentation, they are never guessed. An unfamiliar ' +
        'shape is refused by default — that is the main setting of this section.',
      shapesHeader: 'Path',
      shapesWhat: 'What is parsed',
      shapeAnthropic:
        'system, message texts, tool-result contents and string arguments of tool calls. ' +
        'Thinking blocks are left alone: they carry a signature, and editing would break the reply.',
      shapeOpenai:
        'Message contents and function-call arguments. The same parsing serves any ' +
        'OpenAI-compatible gateway.',
      shapeOther: 'Everything else',
      shapeOtherText:
        'An unfamiliar path or a non-JSON body — this includes Gemini, whose shape the panel ' +
        'does not parse. Such a request is refused by default; passing it through can be ' +
        'enabled separately, and every pass-through lands in the journal.',
      shapeRefused: 'refused',

      filesCaption:
        'Rules live apart from the panel settings on purpose: their dictionaries hold real ' +
        'surnames and phone numbers, while settings travel between machines by export.',
      filesPanelTitle: 'On disk',
      fileRules: 'Rules and dictionaries',
      fileJournal: 'Match journal',
      fileSettings: 'Proxy settings (rules excluded)',
      filesMemoryTitle: 'In memory only',
      fileVault: 'Placeholder vault',
      fileVaultText:
        'The value → [LABEL_N] mapping lives in process memory and is never written to disk. ' +
        'Restart the panel and numbering starts over.',

      limitsTitle: 'Limits — what the proxy does not do',
      limitRulesTitle: 'It finds only what is described',
      limitRulesText:
        'This is not a model and not a heuristic: the proxy will not guess a surname you did ' +
        'not write down, will not notice a typo in it, and will not read a passport photo in an ' +
        'attachment. An empty or incomplete rule set means there is no protection — while the ' +
        'section still says "running".',
      limitParaphraseTitle: 'The model may paraphrase a placeholder',
      limitParaphraseText:
        'Restoration works on exact text. If the reply says "name 1" instead of [ИМЯ_1], or ' +
        'translates the placeholder, there is nothing to substitute into: the human sees the ' +
        'placeholder. It is visible immediately and risks no data, but it looks broken.',
      limitShapeTitle: 'An unfamiliar shape is refused, not passed',
      limitShapeText:
        'By default a request whose body the panel did not parse is refused. That is a ' +
        'deliberate choice: a proxy that silently passes what it did not understand is worse ' +
        'than no proxy. The opposite setting exists, but switch it on knowing what it permits.',
      limitLocalTitle: 'The listener is 127.0.0.1 only',
      limitLocalText:
        'The proxy sees decrypted requests together with keys, so no setting publishes it ' +
        'outside. Sharing it with a team over the network is impossible — a limit, not an ' +
        'unfinished feature.',
      limitJournalTitle: 'No values in the journal',
      limitJournalText:
        'Rule, placeholder and count are written — the journal shows what fired and how often, ' +
        'never what was found. A data-protection journal that stores the data next to it would ' +
        'be the biggest hole in that protection.',

      gateTitle: 'Prompt gate',
      gateCaption:
        'A second mechanism on the same rules: the panel writes a script into the hooks ' +
        'directory and registers it on the UserPromptSubmit event. It needs no proxy — and it ' +
        'replaces none, because it sees incomparably less.',
      gateHeader: 'Side',
      gateWhat: 'How it is',
      gateSees: 'What it sees',
      gateSeesText:
        'Exactly what a human submitted from the input line — typed by hand or pasted. The ' +
        'check runs before the prompt reaches the model.',
      gateBlind: 'What it misses',
      gateBlindText:
        'Files the agent read on its own, command output, tool results, subagent prompts, the ' +
        'rest of the conversation. All of it reaches the model past the gate — only the proxy ' +
        'sees that.',
      gateActions: 'What it can do',
      gateActionsText:
        'Reject the prompt, or warn and send it. The gate can NOT replace text with a ' +
        'placeholder: the UserPromptSubmit event cannot rewrite the prompt — a limit of Claude ' +
        'Code itself, not of the panel.',
      gateWhere: 'Where it lives',
      gateWhereText:
        'The script sits in the configuration hooks directory, its registration in settings.json ' +
        'as an ordinary hook. It is visible in the Hooks section and can be disabled or deleted ' +
        'there; the panel keeps no hidden mechanism.',

      gateLimitTitle: 'A second to bypass — and that is fine',
      gateLimitText:
        'The same meaning in other words gets through: the gate matches rules, it does not ' +
        'understand text. This is a barrier against pasting someone’s passport into a prompt by ' +
        'accident, not against a person who wants the data out. Real content control is the ' +
        'proxy above.',
      gateSharedTitle: 'Rules shared with the proxy',
      gateSharedText:
        'There is no second dictionary: the gate reads the same dlp-rules.json. A rule whose own ' +
        'action is “reject” stops the prompt even when the gate setting says “warn” — otherwise ' +
        'that setting would silently downgrade a ban to a notice.',
      gateSafeTitle: 'Doubt is not a reason to block',
      gateSafeText:
        'If the rules file cannot be read, or the hook input shape is unfamiliar, the prompt ' +
        'goes through and the human is told it was NOT checked. A script that started blocking ' +
        'every prompt after a format change would be switched off the same day — along with the ' +
        'protection.',
    },

    endpoints: {
      title: 'Your own endpoint',
      summary:
        'A model address instead of the vendor cloud: a local model, a company gateway or a proxy',
      lead:
        'An agentic CLI reaches its model at an address, and that address can be changed. ' +
        'An endpoint profile is an address, an API kind and a model, entered once at the ' +
        'panel level and spread across the environment variables of the CLI you pick with ' +
        'a single button. This is how you attach a model running on your own hardware, a ' +
        'company gateway, or a proxy that your requests pass through.',

      whyLocal: 'The request never leaves',
      whyLocalText:
        'If the address points at a model inside your perimeter, neither the prompt nor ' +
        'the contents of the files the agent read ever leave it. This is the only way to ' +
        'get that in full: rules and hooks do not see everything that goes to the model.',
      whyOnce: 'One profile across several CLIs',
      whyOnceText:
        'Every CLI has its own variable name: ANTHROPIC_BASE_URL, GOOGLE_GEMINI_BASE_URL, ' +
        'OPENAI_BASE_URL, AIDER_OPENAI_API_BASE. The profile is entered once, and the ' +
        'panel knows what goes where.',
      whySecret: 'The secret is not written by default',
      whySecretText:
        'Only the address and the model — non-secret values — reach a foreign config ' +
        'file. The token is kept encrypted inside the panel and lands in a CLI file only ' +
        'behind a separate checkbox, with a warning.',

      stepsTitle: 'How to connect one',
      stepsCaption: 'The "Your own endpoint" block sits in Settings, below the model catalog.',
      step1: 'Create a profile and pick the API kind',
      step1Text:
        'The API kind is the schema the endpoint accepts requests in. It decides both the ' +
        'shape of the address and which CLIs can take this profile at all.',
      step2: 'Type the address',
      step2Text:
        'The hint under the field says what the chosen API kind expects: the host root or ' +
        'the address including the version. For a local model this is usually an address ' +
        'on 127.0.0.1.',
      step3: 'Press "Check connection"',
      step3Text:
        'The panel asks the address for its model list. On success a badge appears next to ' +
        'the button and the model field turns into a dropdown of what that address offers.',
      step4: 'Pick a model',
      step4Text:
        'Left empty, the panel does not touch the model variable and the CLI decides for ' +
        'itself. A local server usually needs the name: there is no "default model" there.',
      step5: 'Apply it to the CLI you need',
      step5Text:
        'The list below shows, per CLI, exactly what will be written and into which file. ' +
        '"Apply" writes there with a backup — like every other config edit in the panel.',

      kindTitle: 'API kinds',
      kindCaption:
        'The panel supports three schemas — the ones the CLIs themselves understand. The ' +
        'kind follows the endpoint, not the CLI: one and the same local model often ' +
        'answers in several schemas at once.',
      kindHeader: 'Kind',
      kindWhen: 'When to pick it',
      kindOpenai:
        'The common case: llama.cpp, vLLM, Ollama, LM Studio, corporate gateways — nearly ' +
        'all of them speak the OpenAI schema. The panel reads the model list from /models.',
      kindAnthropic:
        'A proxy or gateway speaking the Anthropic schema. This is the only kind Claude ' +
        'Code accepts.',
      kindGoogle:
        'A gateway speaking the Gemini schema. The model list comes from /v1beta/models. ' +
        'Gemini CLI itself accepts an https address only; localhost is the sole exception.',

      targetsTitle: 'Who accepts a profile',
      targetsCaption:
        'The panel never invents the address variable: only what the CLI itself documents ' +
        'is used. Where no such variable exists, the row says so — instead of guessing.',
      targetsCli: 'CLI',
      targetsVars: 'What gets written',
      targetClaude:
        'ANTHROPIC_BASE_URL, ANTHROPIC_MODEL, ANTHROPIC_AUTH_TOKEN — into ' +
        '~/.claude/settings.json, the env key.',
      targetGemini: 'GOOGLE_GEMINI_BASE_URL, GEMINI_MODEL, GEMINI_API_KEY — into ~/.gemini/.env.',
      targetQwen:
        'OPENAI_BASE_URL, OPENAI_MODEL, OPENAI_API_KEY — or the ANTHROPIC_* triple: Qwen ' +
        'Code takes both kinds. Into ~/.qwen/.env.',
      targetAider:
        'AIDER_OPENAI_API_BASE, AIDER_MODEL, AIDER_OPENAI_API_KEY — into ~/.aider.conf.yml, ' +
        'the set-env key.',
      targetAssistant: 'Panel assistant',
      targetAssistantText:
        'A separate choice in the same block. It writes nothing: the panel calls the ' +
        'address directly, bypassing both the cloud and the provider CLI.',
      targetAnyKind: 'any kind',
      targetSkipped: 'not accepted',
      targetNoVar:
        'Their model address is set in the config file only, by hand: Codex has the ' +
        'model_providers block in config.toml, Continue has apiBase on each model in ' +
        'config.yaml. No environment variable for it is documented, and the panel does not ' +
        'invent one.',
      targetNoEnv:
        'These CLIs have no environment-variable section at all — there is nowhere to write.',

      filesCaption: 'The profile lives in the panel; only the result reaches a CLI config.',
      filePanelTitle: 'Panel',
      fileProfiles: 'Profiles (address, API kind, model)',
      fileToken: 'Token — encrypted, AES-256-GCM',
      fileCliTitle: 'Where a profile is written',

      notesTitle: 'Things people trip over',
      noteProbeTitle: '"Check connection" only fetches the model list',
      noteProbeText:
        'The request asks for the list of models, not for a generation: it costs nothing ' +
        'and burns no tokens. Checking that the model actually answers happens in the ' +
        'chat — a separate action, and that one is billed.',
      noteTokenTitle: 'The "write the token" checkbox is a deliberate step',
      noteTokenText:
        'With it, the token lands in the CLI config file in plain text: foreign CLIs have ' +
        'no secret store of their own. Without it only the address and the model are ' +
        'written, and the token stays in the panel, used for the connection check and by ' +
        'the assistant.',
      noteAssistantTitle: 'The panel and the CLI may look in different directions',
      noteAssistantText:
        'The panel assistant is switched separately and does not follow the profile by ' +
        'itself. That is by design: form hints and agent work are different jobs, and ' +
        'their addresses may differ.',
      noteRestartTitle: 'A CLI reads its variables at startup',
      noteRestartText:
        'The write is instant, but a CLI session already running will not learn about it. ' +
        'Restart the CLI — as after any other change to its environment.',
      notePrivacyTitle: 'Your own address is not the same as masking data',
      notePrivacyText:
        'The profile decides WHERE a request goes, not WHAT is in it. If the address is an ' +
        'external gateway, the data still leaves your perimeter. Substituting names and ' +
        'phone numbers inside the request is a separate job, and a profile does not solve it.',
    },

    providers: {
      title: 'Providers',
      summary: 'The panel configures more than Claude Code — what works with each CLI',
      lead:
        'The Claude provider is active by default, and with it everything is available. ' +
        'But the neighbouring agentic CLIs keep their configuration the same way — an ' +
        'instructions file, MCP servers, environment variables, an approval policy — and ' +
        'the panel edits those files directly, each in its native format. Far from ' +
        'everything is universal, though: every provider gets its own set of sections, ' +
        'and below is an honest account of which.',

      whyOne: 'One UI across several CLIs',
      whyOneText:
        'You no longer have to remember that Codex keeps MCP in TOML, Gemini in JSON, ' +
        'OpenCode under a different key in a different shape, and that Aider writes ' +
        'variables as a YAML list. The forms are the ones you know from Claude, and what ' +
        'gets written is what that CLI actually reads.',
      whyDefault: 'Claude stays the default',
      whyDefaultText:
        'The panel grew out of Claude Code and stays its tool. The provider never ' +
        'switches by itself and nothing is automatic: changing it is your explicit act.',
      whySafe: 'A foreign config does not get damaged',
      whySafeText:
        'A backup before the write, an atomic write, a format check before writing, and a ' +
        'refusal instead of a guess. An unfamiliar file leaves the section read-only.',

      chooseTitle: 'Choosing a provider',
      chooseCaption: 'The switch lives in Settings; the same step appears in onboarding.',
      chooseStep1: 'Open Settings → Configuration provider',
      chooseStep1Text:
        'A card with the list: Claude first as the verified one, then the experimental ones.',
      chooseStep2: 'Look at the badges',
      chooseStep2Text:
        'Each provider shows whether its CLI is installed, whether its configuration ' +
        'directory was found, and which one is recommended. Next to it: how many sections ' +
        'are ready and how many are in development.',
      chooseStep3: 'Press “Choose”',
      chooseStep3Text:
        'The provider setting is saved right away and the sidebar rebuilds around that ' +
        'CLI’s capabilities. No restart of the panel is needed.',
      chooseStep4: 'You can return to Claude at any time',
      chooseStep4Text:
        'Switching back brings every section along: Claude’s settings were never touched ' +
        'while another provider was active.',

      statusTitle: 'What the labels mean',
      statusCaption:
        'Two groups: how well the provider itself is proven, and what is going on with a ' +
        'particular section.',
      statusVerified: 'The provider is verified',
      statusVerifiedText:
        'Its path has been exercised live and is covered by tests. Right now only Claude ' +
        'Code carries this status.',
      statusVerifiedBadge: 'verified',
      statusExperimental: 'The provider is experimental',
      statusExperimentalText:
        'The formats come from that CLI’s documentation and are covered by round-trip ' +
        'tests, but there has been no live run on it. We do not guess — and we do not pass ' +
        'it off as verified either.',
      statusExperimentalBadge: 'experimental',
      statusReady: 'The section works',
      statusReadyText: 'That CLI’s real file is read and written, just like Claude’s.',
      statusReadyBadge: 'ready',
      statusPlanned: 'The section is in development',
      statusPlannedText:
        'Visible with a badge, but it opens a placeholder: the format adapter does not ' +
        'exist yet, so the section neither reads nor writes anything. That is a safeguard, ' +
        'not an unfinished screen.',
      statusPlannedBadge: 'in development',
      statusHidden: 'The section is not there at all',
      statusHiddenText:
        'That CLI has no such entity — there is nothing to port, so the item is removed ' +
        'from the menu rather than shown empty.',
      statusHiddenBadge: 'hidden',

      mapTitle: 'The map: section × provider',
      mapCaption:
        'An honest snapshot as of today. Anything missing from a row is hidden for that ' +
        'CLI: the entity simply does not exist there.',
      mapSection: 'Section',
      mapProviders: 'Who supports it',
      mapInstructions: 'Global instructions',
      mapInstructionsValue:
        'Works everywhere, in three different models. ONE FILE: Claude (CLAUDE.md), Codex ' +
        'and OpenCode (AGENTS.md), Gemini (GEMINI.md), Qwen Code (QWEN.md). LIST OF ' +
        'REFERENCES: Aider has no ' +
        'single file — the panel edits the list of attached files (the read option in ' +
        '.aider.conf.yml) and, separately, the contents of an already existing listed file. ' +
        'RULES DIRECTORY: for Cursor it is ~/.cursor/rules (and the same directory inside a ' +
        'project) with .mdc files — each has its own frontmatter (description, file globs, ' +
        'an "always apply" flag) and a markdown body; nested subdirectories are supported. ' +
        'A plain .md in the rules directory is ignored by Cursor — the panel lists such ' +
        'files separately and never edits them. Continue has no global instructions at all: ' +
        'only the PROJECT rules directory <project>/.continue/rules with .md files is ' +
        'documented, so it lives on the project tab and the global section stays hidden. Goose ' +
        'uses a .goosehints file: the global one sits in its config directory and applies to ' +
        'every session, while <project>/.goosehints overrides it. For Kimi Code it is ' +
        'AGENTS.md in $KIMI_CODE_HOME, and a plain AGENTS.md in the project root.',
      mapMcp: 'MCP servers',
      mapMcpValue:
        'Works: Claude, Codex (TOML), Gemini, Qwen Code, Cursor, OpenCode (its own local/remote ' +
        'shape), Continue (the mcpServers list in config.yaml — the name sits inside the ' +
        'entry and the transport comes from the type field), Goose (the extensions of config.yaml ' +
        '— the panel manages external stdio / sse / streamable_http servers only and never ' +
        'touches built-in extensions), Kimi Code (a separate ~/.kimi-code/mcp.json file, with ' +
        'the remote address in url). Aider has no MCP setting at ' +
        'all — the section is hidden.',
      mapEnv: 'Environment variables',
      mapEnvValue:
        'Works: Claude, Codex (shell_environment_policy.set), Aider (set-env — the global ' +
        '~/.aider.conf.yml and the per-project one in the repository root), Gemini ' +
        '(a plain .env file — the global ~/.gemini/.env and the per-project one), Qwen Code ' +
        '(the same thing: ~/.qwen/.env and the per-project .qwen/.env), Continue ' +
        '(~/.continue/.env and the per-project .continue/.env — the source of ' +
        '${{ secrets.NAME }} values). Hidden ' +
        'for Cursor and OpenCode: OpenCode has nowhere to store variables — it only ' +
        'substitutes {env:VARIABLE} inside opencode.json, i.e. reads the process ' +
        'environment that is already set, and loads no .env of its own. The panel will ' +
        'not create a file nobody reads. Goose is hidden for the same reason: no .env of its ' +
        'own, and its secrets live in the OS keyring. Kimi Code likewise: provider keys sit ' +
        'in config.toml, and the panel writes no secrets there.',
      mapPermissions: 'Permissions and approvals',
      mapPermissionsValue:
        'Works: Claude (allow/ask/deny), Codex (approval_policy and sandbox_mode), Gemini ' +
        '(the approval mode general.defaultApprovalMode plus the coreTools and ' +
        'excludeTools lists), Qwen Code (the tools.approvalMode mode plus the ' +
        'permissions.allow / ask / deny rule lists), Continue (a separate permissions.yaml ' +
        'with three lists allow / ask / exclude and no mode at all), OpenCode (the permission key of ' +
        'opencode.json: an ' +
        'allow / ask / deny level for the edit, bash and webfetch tools, and for bash a ' +
        'list of command patterns instead of a single level), Goose (a single GOOSE_MODE key: ' +
        'auto / approve / smart_approve / chat, no lists at all), Kimi Code (the ' +
        'default_permission_mode key: manual / auto / yolo, plus ordered ' +
        '[[permission.rules]] — a pattern and an allow / ask / deny decision), Cursor (the ' +
        'permissions key of cli-config.json: two lists allow and deny, no mode, deny beats ' +
        'allow). Hidden for Aider.',
      mapChat: 'Chat and assistant',
      mapChatValue:
        'The full chat with streaming, attachments and parallel agents is Claude only. ' +
        'Codex, Gemini, Qwen Code, Continue, Goose, Kimi Code, OpenCode and Aider get a basic experimental assistant: one ' +
        'question, one answer (codex exec, gemini -p, qwen -p, cn -p, opencode run "<prompt>", ' +
        'aider --message, goose run --no-session -t "<prompt>", kimi -p). ' +
        'The Aider, OpenCode, Continue, Goose and Kimi Code assistants are built from the docs and have not been exercised ' +
        'live: those CLIs are not installed on the development machine. Cursor has no model ' +
        'API of its own.',
      mapHooks: 'Hooks',
      mapHooksValue:
        'Works for Claude, Qwen Code, Kimi Code and OpenCode, but the models do not match. ' +
        'Claude has nine events (PreToolUse, PostToolUse and others) with tool matchers and ' +
        'shell commands in settings.json; two of them can block the action. Qwen Code has ' +
        'the root hooks key of settings.json (global and per-project), eighteen events, an ' +
        'optional matcher and a single command action per group, with the timeout in ' +
        'milliseconds; an unfamiliar shape is preserved per event — that whole event turns ' +
        'read-only while the rest stay editable. Kimi Code has an array of [[hooks]] tables ' +
        'in config.toml, sixteen events, a regular-expression matcher and the timeout in ' +
        'seconds (1–600); it has no project hooks, and any deviation from the documented ' +
        'shape turns the whole section read-only — a flat TOML array cannot be rewritten ' +
        'partially without losing foreign entries. OpenCode has the experimental.hook key of ' +
        'opencode.json and exactly two events: "file edited" and "session completed", with a ' +
        'command as an argument list. Since 25 July 2026 that section is read-only: the key ' +
        'disappeared from both the reference and the published schema, and experimental ' +
        'itself is closed to unknown keys — the panel shows what is already in the file but ' +
        'does not write; the documented way to attach an action to an event in OpenCode is ' +
        'now plugins alone. Codex, Gemini, Continue, Goose, Cursor and Aider have no hooks.',
      mapPlugins: 'Plugins',
      mapPluginsValue:
        'Works for Claude, OpenCode and Kimi Code, and they are different things. Claude ' +
        'gets the panel’s own extensions and marketplaces (a wrapper around claude plugin). ' +
        'OpenCode gets plugins of its own CLI: JS/TS files in the plugins directory ' +
        '(global ~/.config/opencode/plugins/ and per-project ' +
        '<project>/.opencode/plugins/) which it loads at startup, plus a list of npm ' +
        'package names under the plugin key of opencode.json. The panel cannot install ' +
        'packages — the CLI does that. For Kimi Code the section is read-only: the panel ' +
        'reads the manifests in ~/.kimi-code/plugins/managed/ and shows what each plugin ' +
        'brings (skills, a session-start skill, MCP servers, how many hooks, whether it has ' +
        'commands), while installing and enabling happens in the CLI itself via /plugins — ' +
        'the shape of its installed.json registry is undocumented. The others have no such ' +
        'section.',
      mapSkills: 'Skills',
      mapSkillsValue:
        'Works for Claude and OpenCode, and the concept is the same — a folder with a ' +
        'SKILL.md and YAML front matter — but the directories and fields differ. Claude has ' +
        'its rich section (file tree per skill, enable by moving into skills-disabled, groups, ' +
        'templates). OpenCode keeps skills in ~/.config/opencode/skills/<name>/SKILL.md (and ' +
        '<project>/.opencode/skills/); the panel edits the two required fields name and ' +
        'description, keeps license/compatibility/metadata and any foreign fields read-only, ' +
        'and requires the name to equal the folder name. OpenCode also loads skills from ' +
        '~/.claude/skills and ~/.agents/skills, so Claude skills already work in it — the panel ' +
        'writes nothing there. Qwen Code and Kimi Code use the same format, only the ' +
        'directories differ: ~/.qwen/skills/ and <project>/.qwen/skills/ for Qwen, ' +
        '~/.kimi-code/skills/ and <project>/.kimi-code/skills/ for Kimi (which also picks up ' +
        'the shared ~/.agents/skills). One difference: Kimi’s docs cap description at 240 ' +
        'characters. The panel holds skill names to the strictest of the rules, so the same ' +
        'skill is valid in any of these CLIs. The other CLIs have no such section.',
      mapScripts: 'Scripts',
      mapScriptsValue:
        'Works everywhere: this is the panel’s own section — your files in its hooks/ ' +
        'folder, not a foreign config. Claude keeps the sandbox, the “called by a hook” ' +
        'flag and the hook scaffolds; the rest get plain standalone scripts instead.',
      mapProjects: 'Projects',
      mapProjectsValue:
        'Works everywhere, but differently. Claude gets the project’s rules, MCP servers ' +
        'and permissions. Codex and OpenCode get project instructions (AGENTS.md) and MCP ' +
        'servers from the project file; after Claude, OpenCode has the widest project ' +
        'level — instructions (AGENTS.md), MCP, permissions and hooks all in ' +
        '<project>/opencode.json, plus plugins (the <project>/.opencode/plugins/ ' +
        'directory and the plugin key). Gemini adds the project’s environment ' +
        'variables (.gemini/.env) and permissions (.gemini/settings.json); Qwen Code does ' +
        'the same in its own files (QWEN.md, .qwen/settings.json, .qwen/.env) plus hooks in ' +
        'that same .qwen/settings.json and skills in .qwen/skills/. ' +
        'Continue lives at the project level only: the rules directory ' +
        '<project>/.continue/rules/*.md, the MCP file .continue/mcpServers/mcp.json and the ' +
        '.continue/.env variables. Goose’s project level is the <project>/.goosehints file. ' +
        'Kimi Code gets AGENTS.md, the MCP file <project>/.kimi-code/mcp.json and skills in ' +
        '<project>/.kimi-code/skills/; it has no project permissions or hooks — the CLI ' +
        'reads those from a single config.toml. ' +
        'Cursor gets the project MCP ' +
        '(.cursor/mcp.json) and the project rules directory .cursor/rules/*.mdc. Aider gets the ' +
        '.aider.conf.yml in the repository root (the config is looked up in the home ' +
        'directory, the git repository root and the current directory): the read list of ' +
        'attached files and the set-env variables.',
      mapClaudeOnly: 'Claude only',
      mapClaudeOnlyValue:
        'Rules, token analytics, the sandbox and plugin marketplaces. This is not ' +
        '“we did not get to it”: the other CLIs either have no such entity or build it on ' +
        'different lines. Hooks, skills and plugins are the exception: Qwen Code, Kimi Code ' +
        'and OpenCode have them, each in its own model, and the panel opens dedicated ' +
        'screens for them.',
      mapPanel: 'Always available',
      mapPanelValue:
        'Overview, search, groups, history, settings and help are the panel’s own ' +
        'sections and do not depend on the provider.',

      gapTitle: 'Why a section exists for one CLI and not for another',
      gapCaption:
        'There is a single rule: the panel writes only what that CLI’s documentation ' +
        'describes. Four live examples of what the rule looks like in practice.',
      gapNone: 'The entity does not exist at all',
      gapNoneText:
        'Codex and Gemini have no notion of a “skill”: there is nowhere to put a SKILL.md ' +
        'folder for the CLI to read. The section is not hidden “for now” — there would ' +
        'literally be nowhere to write. Qwen Code, Kimi Code and OpenCode do document such a ' +
        'folder, so the skills section is there and runs on the same code as Claude’s.',
      gapNoFile: 'The entity exists, but has no place to live',
      gapNoFileText:
        'OpenCode takes environment variables from the shell; the documentation describes no ' +
        'file of its own for them. The panel invents no file and writes nothing on a guess — ' +
        'OpenCode simply has no “Environment” section. Same for the config directory: only ' +
        'documented overrides are honoured (CODEX_HOME, QWEN_HOME, XDG_CONFIG_HOME, ' +
        'OPENCODE_CONFIG), never an invented one.',
      gapReadOnly: 'The format stopped being reliable',
      gapReadOnlyText:
        'OpenCode hooks used to live under the experimental.hook key. The daily check against ' +
        'the published schema showed the key is gone and experimental accepts no extra ' +
        'properties. The section stayed — read-only: showing what is there is fine, writing ' +
        'into a shape the schema does not know is not.',
      gapOwned: 'The CLI owns the state',
      gapOwnedText:
        'Kimi Code plugins are visible to the panel (the manifests are documented), but the ' +
        'list of installed ones is kept by the CLI’s own /plugins command, and the shape of ' +
        'its file is documented nowhere. The panel shows what is installed and never touches ' +
        'the file — an edit would silently drift from what the CLI treats as the truth.',

      filesCaption: 'Exactly where the panel writes for each provider.',
      fileInstructions: 'Instructions',
      fileMcp: 'MCP servers',
      fileEnv: 'Environment',
      fileRules: 'Rules',
      fileRest: 'Everything else',
      fileClaudeRest: '~/.claude/settings.json, ~/.claude.json',
      fileOverride: 'Directory override',
      fileProject: 'Project level',
      fileWindows: 'Path on Windows',

      runnerTitle: 'Your subscription outranks a paid API',
      runnerCaption: 'The order is fixed: free-for-you first, a paid key only as the last resort.',
      runnerTop: 'picked first',
      runnerBottom: 'last resort',
      runnerCli:
        'The provider’s CLI on PATH that you are already logged into — it runs on your ' +
        'subscription',
      runnerApi: 'An API key — only if the CLI was not found; the fallback path, not the main one',
      runnerNone:
        'Neither one — the panel shows how to log in, or where to get a key if you cannot',
      runnerKeyTitle: 'A stored key does not override the CLI',
      runnerKeyText:
        'Even with a key entered, the panel goes through the CLI when it finds one: there ' +
        'is no reason to pay for what the subscription already covers. Keys are stored ' +
        'encrypted, only a mask ever leaves the server, and they never reach the backups, ' +
        'the history, the search or the export.',

      notesTitle: 'Things that trip people up',
      noteMissingTitle: 'A missing CLI is not a breakage',
      noteMissingText:
        'Configuration is just files: you can edit it before the CLI itself is installed. ' +
        'Without the CLI only the assistant is limited — it will ask for a key or show you ' +
        'how to log in. Check that the executable is on PATH and restart the panel.',
      noteSafeTitle: 'A placeholder writes nothing',
      noteSafeText:
        'An “in development” section opens a placeholder and sends no changes. That is ' +
        'deliberate: an empty screen beats a guess at somebody else’s format.',
      noteHistoryTitle: 'History and search follow the provider',
      noteHistoryText:
        'The feed and the search cover Claude’s files plus the working sections of the ' +
        'active provider. Backups of a foreign config are stored under their own name and ' +
        'never mix with Claude’s, but nothing can be restored from them — neither the ' +
        'whole file nor a single change.',
      noteFirstRunTitle: 'Eyeball the first write',
      noteFirstRunText:
        'A foreign CLI’s format is taken from its documentation and checked by round-trip ' +
        'tests, but the first real write into each newly touched file is worth opening and ' +
        'looking at. The backup of the previous version is already taken, so there is ' +
        'somewhere to roll back to.',
    },
  },
};
