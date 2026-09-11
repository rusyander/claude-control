import type { settingsRu } from '../../ru/topics/settings';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const settingsEn: typeof settingsRu = {
  topic: {
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
    cantToken:
      'See the Claude Code access token: the server reports only the source, never the value. ' +
      'The remote-access token is a different one; the panel shows it behind the pairing button',
    cantSync:
      'Sync settings between machines automatically: there is no live sync, only a ' +
      'manual file transfer',
    cantChange:
      'Edit Claude Code settings field by field: this section is about the panel itself, ' +
      'while the configuration is edited in its own sections',

    storageApp: 'Panel settings',
    storageAppValue: 'stored apart from the Claude Code configuration',
    storageManual: 'Manual access',
    storageManualValue: '~/.agentdeck/credentials.json',
    storageBackups: 'Backups',
    storageBackupsValue: '~/.claude/agentdeck/backups/',
    storageApply: 'When it applies',
    storageApplyValue: 'at once: changing the directory needs no restart',

    tabsTitle: 'Sections of the page',
    tabsCaption:
      'Settings are split across seven tabs — exactly one section is open at a time. The ' +
      'chosen one goes into the address (/settings?tab=…): the link can be shared and ' +
      'survives a reload. Tabs work from the keyboard too: Tab enters the strip, arrows ' +
      'switch sections, Home and End jump to the edges.',
    tabGeneral: 'General',
    tabGeneralText: 'Theme, accent, language, accessibility and the editor files open in.',
    tabAccess: 'Access',
    tabAccessText:
      'The Claude Code account, the access source, the configuration directory and remote ' +
      'access from the phone.',
    tabProviders: 'Providers',
    tabProvidersText:
      'Choosing a CLI, checking it on this machine, provider keys and the config format check.',
    tabModels: 'Models',
    tabModelsText:
      'Default model and effort, the model catalog, a custom endpoint and MCP server checks.',
    tabSpend: 'Spend',
    tabSpendText: 'Spend units — tokens or money — and the rates it is counted by.',
    tabSafety: 'Safety',
    tabSafetyText:
      'Backups before every write and how many are kept, the diff before writing into another ' +
      'CLI, file watching, revealing secrets, backup encryption and the backups themselves.',
    tabTransfer: 'Transfer',
    tabTransferText:
      'A snapshot of the panel settings and moving a provider environment to another machine ' +
      'as an archive.',

    cardsTitle: 'The main cards',
    cardsCaption:
      'The four cards people usually start with: the first is on the General tab, the other ' +
      'three on Access. The rest — remote access, models, provider check, format check, ' +
      'transfer — have their own sections below.',
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

    firstRunTitle: 'First run',
    firstRunCaption:
      'A four-step wizard on top of the panel until it is closed with “Done” or “Skip”. ' +
      'The same trio as the main cards: folder, provider, access.',
    firstRunStep1: '“Welcome to AgentDeck”',
    firstRunStep1Text: 'Three points on what the panel does with your files. The “Next” button.',
    firstRunStep2: '“Configuration folder”',
    firstRunStep2Text:
      'The source badge and the current path. Type a path and confirm with “Apply” (or Enter), ' +
      'pick one with “Choose folder”, or return to the detected one with “Auto-detect”. A refusal ' +
      '— “folder does not exist”, “this is a file, not a folder” — shows next to the field. ' +
      'Without a working folder “Next” stays disabled.',
    firstRunStep3: '“Detected CLIs”',
    firstRunStep3Text:
      'Which CLIs are installed. “Choose” switches the provider at once; the step is optional — ' +
      'by default the panel works with Claude Code. If none is found, the panel still opens.',
    firstRunStep4: '“Claude Code access”',
    firstRunStep4Text:
      'Where the sandbox access comes from. “Set manually” opens the same form as the card in ' +
      'this section; “Remove manual” returns to automatic lookup. “Done” closes the wizard.',
    firstRunReturnTitle: 'The wizard comes back if the folder becomes unavailable',
    firstRunReturnText:
      'The completion flag lives in the panel settings (onboardingDone) and is written once. ' +
      '“Skip”, Escape and the × equal “Done” while the folder is fine; F5 keeps the current step. ' +
      'If the configuration folder disappears or becomes unreadable, the wizard opens again ' +
      'straight on the folder step, and it cannot be closed without a working folder.',

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
    fieldsCaption:
      'Switches save immediately. Only text fields have a button — the directory path, ' +
      'a custom editor command, manual access.',
    fieldTheme: 'The colour theme: light, dark, or follow the system.',
    fieldLanguage: 'The interface language.',
    fieldDir:
      'The path to the configuration directory. Empty means detect it automatically — the ' +
      '“Auto-detect” button in the card returns to it.',
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

    remoteTitle: 'Remote access: the panel from a phone',
    remoteCaption:
      'The “Remote access” card ties the panel to the phone app: same chat, same ' +
      'projects, same analytics — from anywhere your Tailscale network reaches.',
    remoteAddress: 'Outside address',
    remoteAddressText:
      'The server keeps listening on 127.0.0.1 — no port is opened outward at all. What ' +
      'carries the panel outside is tailscale serve: it runs on this same machine and ' +
      'proxies to the loopback, so an address like https://machine.tailnet.ts.net is ' +
      'visible only to devices in your tailnet. Turn it on with pnpm remote (off with ' +
      'pnpm remote:off); the panel finds the machine name itself and shows it on the card.',
    remoteToken: 'The “Require a token” switch',
    remoteTokenText:
      'While it is off nothing changes: only this machine can reach the API. Once on, ' +
      'EVERY request must carry the token — including requests from the browser on this ' +
      'same computer. The browser neither knows nor should know: the dev proxy adds the ' +
      'header, reading the same token file. The token lives in ~/.agentdeck/api-token ' +
      'with mode 0600 and never enters the panel’s backups. It travels in the ' +
      'Authorization: Bearer header; in the URL (?token=) only the event stream /api/events ' +
      'accepts it — the one route the browser opens by address. On every other route a token ' +
      'in the URL is rejected as missing: an address ends up in proxy logs and browser ' +
      'history, a header does not.',
    remotePair: 'Pairing code',
    remotePairText:
      'The button shows a QR code with the address and the token — in the app it is ' +
      'Settings → Pair, and the camera does the rest. The same token is printed under the ' +
      'code, so it can be typed by hand when the camera is denied. “Rotate token” is the ' +
      '“I lost my phone” button: the old one stops working immediately and every paired ' +
      'device must connect again.',
    remoteNotify: 'Notifications',
    remoteNotifyText:
      'The panel pushes when work is done, has failed, waits for a permission or the ' +
      'agent has asked a question. Only the KIND of event and the project folder name ' +
      'leave the machine — no conversation text, no code, no paths. The “Test ' +
      'notification” button exercises the whole path: without it “nothing arrived” is ' +
      'discovered on a real run, which is too late.',
    remoteWarnTitle: 'The token opens the entire panel API',
    remoteWarnText:
      'It is not a password to one section: the same token reads secrets, edits hooks and ' +
      'starts the agent. Do not show the QR code to others, do not forward it in a chat ' +
      'and do not post a screenshot of the settings. The panel shows the token openly on ' +
      'purpose — there is no other way to carry it to the phone, and reading it through ' +
      'the API already requires a token.',

    modelsTitle: 'Provider models',
    modelsCaption:
      'The model list used to be hard-coded into the panel and went stale silently: ' +
      'a model shipped, and there was nowhere to pick it. Now the panel asks a catalog.',
    modelsWhere: 'Where the list comes from',
    modelsWhereText:
      'The open models.dev catalog — the same one OpenCode runs on. The request goes ' +
      'out no more than once a day, everything else comes from the cache; with no ' +
      'network the previous list is shown with its age.',
    modelsPlatform: 'The contour as the source',
    modelsPlatformText:
      'Once a contour is set up, switched on and checked at least once, it can be ' +
      'chosen as the catalog source. The list is then exactly what YOUR key was given — ' +
      'shorter than the open catalog by everything you were not allowed, and carrying ' +
      'the flags the contour declared itself (images, functions, strict JSON). The ' +
      'panel never visits the contour of its own accord: the list comes from the last ' +
      'connection check, and “Refresh” asks again. Switch the contour off or drop its ' +
      'key and the panel falls back to models.dev and says why; the list is never ' +
      'swapped silently. An empty list is an answer too: it means your key was granted ' +
      'no models at all, and grants come from the key’s owner, not from the panel. ' +
      'A contour publishes no prices, so money is computed from the ' +
      'price list on this same tab.',
    modelsRetired: 'A model gone from the contour',
    modelsRetiredText:
      'It stays in the list, marked, with the date it was last seen — but it cannot be ' +
      'chosen: the contour would no longer accept the request. A row that vanished ' +
      'silently would look like a panel bug, and the cause is not in the panel.',
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

    guideTitle: 'How to read this page',
    guideText:
      'The diagram comes first: what the panel does to a file BEFORE every write, and what ' +
      'is left on disk afterwards. Then two paths in screenshots — “first run” is walked ' +
      'once, while the panel still does not know where to look, and “keeping files safe” is ' +
      'for later, when everything works and the question is different: what has the panel ' +
      'already done to my configuration, and how do I undo it. After the screenshots: what ' +
      'this section is NOT, what it writes to disk, refusals with their reasons, and the ' +
      'reference tables.',

    notTitle: 'What this section is NOT',
    notCaption: 'The neighbours Settings is confused with most often.',
    notColumn: 'What people look for here',
    notMeaningColumn: 'Where it actually is',
    notProviders: 'A breakdown of the other CLIs',
    notProvidersText:
      'Here a provider is CHOSEN with one button. What each of them can do, which sections ' +
      'are ready for it and how a live check ends is a separate article, Providers.',
    notEnv: 'The agent’s environment variables',
    notEnvText:
      'The settings on this page are about the panel itself and live in its state.json. The ' +
      'variables Claude Code receives live in settings.json → env and are edited in the ' +
      'Variables section.',
    notDlp: 'What reaches the model',
    notDlpText:
      'Masking secrets here is about the screen: the value in the file stays in plain text. ' +
      'Substituting values inside the request body is the Data protection section.',
    notHistory: 'Who edited the file and when',
    notHistoryText:
      'Here you see the list of copies and a rollback of the WHOLE file. The feed of edits ' +
      'with a line-by-line diff and a single-hunk revert is the Change history section — and ' +
      'it is computed from these very copies.',
    notPlatform: 'The corporate gateway',
    notPlatformText:
      'The Contour tab on this same page has its own article: its own keys, its own model ' +
      'list and its own signed trade-offs.',

    mapTitle: 'What happens before every write',
    mapCaption:
      'The panel edits your real configuration. Everything standing between your click and ' +
      'the file on disk is in one diagram — including what does NOT reach the copy.',
    pathTextTitle: 'The same path in words',
    pathTextText:
      'Every write the panel makes — a rule, a hook, a permission, a variable, an MCP server ' +
      '— starts with a copy of the current file in agentdeck/backups, and only then is ' +
      'the file rewritten. As many copies are kept as “How many copies to keep” says (ten by ' +
      'default); the extra ones go, oldest first. With encryption of secret backups on, the ' +
      'copy of .mcp-secrets.env is written encrypted, and the passphrase is stored nowhere — ' +
      'it lives in the server’s memory until it restarts. The panel’s own settings take no ' +
      'part in this: they live in agentdeck/state.json, no copies are made of them, and ' +
      'Claude Code never reads them. Exporting the environment packs the provider’s files ' +
      'into an archive, replacing secret values with the __REDACTED__ marker.',

    platformLinkTitle: 'The Contour tab is a separate article',
    platformLinkCaption:
      'It is not covered here: the contour has its own access model, and repeating it in ' +
      'shortened form would be worse than not repeating it at all.',

    refusalsTitle: 'Limits and refusals',
    refusalsCaption: 'When the panel refuses to save, and what that means.',
    refusalsColumn: 'What you see',
    refusalsMeaningColumn: 'Why, and what to do',
    refusalDir: 'The first-run wizard opened again',
    refusalDirText:
      'The configuration directory became unreachable: a disk was unplugged, a path was ' +
      'renamed, an environment variable changed. The panel does not show empty sections in ' +
      'silence — it returns to the directory step. Set the path again on the Access tab.',
    refusalPassphrase: '“At least 8 characters”',
    refusalPassphraseText:
      'Encryption of secret backups will not turn on with a short passphrase. The phrase ' +
      'cannot be recovered: forgetting it means the old copies of .mcp-secrets.env can no ' +
      'longer be decrypted — they have to be deleted and collected anew.',
    refusalSecretBackup: '“No copy of the secret is being made right now”',
    refusalSecretBackupText:
      'Encryption is on but the phrase is not in memory — the usual state after a server ' +
      'restart. The panel refuses to write the copy in plain text and asks for the phrase ' +
      'with a button on the card. Until then, edits to secrets go without copies.',
    refusalOrigin: 'The panel stopped answering after a port change',
    refusalOriginText:
      'The server accepts requests only from localhost and 127.0.0.1 on the port it was ' +
      'told about. Changed the front-end port — tell the server too (the WEB_PORT variable), ' +
      'otherwise every request gets a 403.',
    refusalToken: 'Everything on the phone answers “An access token is required”',
    refusalTokenText:
      'The “Require a token” toggle is on: every request must now carry a token. The browser ' +
      'on this machine passes through the allowed-origin list, a phone only through the ' +
      'pairing code. The code is shown by a button and changes together with the token.',
    refusalRestart: 'The edit was saved, and Claude Code does not see it',
    refusalRestartText:
      'Environment variables and part of the CLI settings are read when a session STARTS. ' +
      'The panel writes the file immediately, but an agent that is already running keeps its ' +
      'old environment — a new session has to be started.',

    guide: {
      firstRunTitle: 'Path 1. First run: from the wizard to the eight tabs',
      firstRunCaption:
        'Walked once. Everything the wizard asks about can be changed later on the Access ' +
        'tab — it only keeps you from starting blind.',
      firstRunIntro: 'What the panel does to your files',
      firstRunIntroText:
        'The first screen names three things honestly: the panel reads and writes local ' +
        'Claude Code files, sends nothing outside, and takes a copy before every edit. The ' +
        'step can be skipped, but it is worth reading: this is the contract.',
      firstRunLocation: 'Where the panel looks',
      firstRunLocationText:
        'The one step you cannot skip without consequences: with no directory the sections ' +
        'have nothing to show. The badge on the left names the SOURCE of the path — “from an ' +
        'environment variable”, “set manually” or “home directory”. A manually set path beats ' +
        'the environment variable.',
      firstRunProviders: 'What was found on the machine',
      firstRunProvidersText:
        'The panel looked at which CLIs are installed. This is a hint, not a decision made ' +
        'for you: any provider can be picked, including one that was not found — the ' +
        'configuration sections work with files, not with a binary.',
      firstRunAccess: 'Where account access comes from',
      firstRunAccessText:
        'A step about the sandbox, and only about it. A green badge means everything was ' +
        'found. “Not found” with a file path means the ordinary chat and the sections are ' +
        'fine; sign in with the claude command in a terminal, or set access manually.',
      firstRunTabs: 'Eight tabs',
      firstRunTabsText:
        'After the wizard the page looks like this: general, access, providers, models, ' +
        'integrations, spend, safety, transfer. The Contour tab opens as its own sidebar ' +
        'entry and has its own article.',
      firstRunDir: 'The directory card',
      firstRunDirText:
        'The same path as in the wizard, but here it is always visible — together with its ' +
        'source. Changing the directory applies immediately; the panel needs no restart.',
      firstRunCreds: 'The access card',
      firstRunCredsText:
        'This is also where “Set manually” lives: access set there goes into ' +
        '~/.agentdeck/credentials.json and beats everything else. The token is never ' +
        'handed back out: it is not in any of the panel’s responses.',
      firstRunRemote: 'Access from outside',
      firstRunRemoteText:
        'The card is shot switched off and without the pairing code: the code is a token to ' +
        'the entire panel API. The address in the frame is masked on purpose — yours will ' +
        'carry your machine’s Tailscale name. The panel stays on 127.0.0.1: Tailscale takes ' +
        'it outside, not an open port.',

      safetyTitle: 'Path 2. Keeping files safe: copies, encryption and transfer',
      safetyCaption:
        'Walked once everything already works. The answer to “what has the panel done to my ' +
        'configuration, and how do I get it back”.',
      safetySettings: 'What the panel does before writing',
      safetySettingsText:
        'A copy before every write and the rotation depth are the two main switches on the ' +
        'page. Next to them: the diff before writing into a FOREIGN CLI — Claude has no ' +
        'preview, its sections are the panel’s own and verified.',
      safetyBackups: 'What is left afterwards',
      safetyBackupsText:
        'The list is real: three copies of settings.json in a row are three variable writes ' +
        'made one after another. The time comes from the file name, the size is next to it. ' +
        '“Roll back” restores the whole file and saves the current state as a new copy: even ' +
        'a rollback can be rolled back.',
      safetyEncrypt: 'The passphrase for secret backups',
      safetyEncryptText:
        'The encryption toggle IS this question: the phrase is stored nowhere, so encryption ' +
        'cannot be turned on without setting it. Shorter than eight characters is refused, ' +
        'and a forgotten one cannot be recovered.',
      safetySpend: 'What to count spend in',
      safetySpendText:
        'By default spend is shown in tokens. Money is an estimate from the price list, not ' +
        'a bill: on a subscription nothing is charged, and confusing the two costs more than ' +
        'counting in tokens.',
      safetyTransfer: 'A snapshot of the panel’s settings',
      safetyTransferText:
        'Downloads state.json as a whole: groups, scenarios, marks, panel settings. This ' +
        'snapshot does not touch the real Claude Code configuration — it is about the panel.',
      safetyEnv: 'What leaves with a provider’s configuration',
      safetyEnvText:
        'The preview is computed for real: the panel names the number of files and the size ' +
        'before compression, lists the sources, and separately lists what has to be typed in ' +
        'by hand. Secret values are replaced with the __REDACTED__ marker, and the variable ' +
        'name is spelled out so that it is clear what to fill in on the new machine.',
    },
  },

  shots: {
    'first-run': {
      '01-wizard-intro':
        'Step 1 of 4: three points about what the panel does to your files, and the Next button',
      '02-wizard-location':
        'Step 2 of 4: the configuration directory with a “from an environment variable” badge and the path field',
      '03-wizard-providers':
        'Step 3 of 4: the CLIs found — Claude Code carries the “installed” and “recommended” badges',
      '04-wizard-access':
        'Step 4 of 4: access not found, the path to .credentials.json named, and a “Set manually” button',
      '05-tabs': 'The settings page after the wizard: eight tabs, General open',
      '06-access-dir': 'The “.claude directory” card: the path and a badge for where it came from',
      '07-access-credentials':
        'The “Claude Code access” card: a “not found” badge, the note about the sandbox, and the manual button',
      '08-remote':
        'The “Remote access” card switched off: the outside address is masked in the frame, no pairing code',
    },
    safety: {
      '01-safety':
        'The “Edit safety” card: a copy before writing, a diff for foreign CLIs, rotation depth 10',
      '02-backups':
        'Three copies of settings.json in a row with time, size and a “Roll back” button',
      '03-encrypt':
        'The passphrase dialog: the “At least 8 characters” hint; the phrase is stored nowhere',
      '04-spend': 'The “Spend” card: tokens by default, money behind a separate toggle',
      '05-transfer': 'The “Transfer panel settings” card: a state.json snapshot to a file and back',
      '06-env-transfer':
        'The environment export preview: 1 file, 132 B before compression, the secret value replaced with the __REDACTED__ marker',
    },
  },

  diagrams: {
    'what-happens-before-a-write':
      'One edit’s path: copy → write → rotation, and what reaches neither the copy nor the archive',
  },
};
