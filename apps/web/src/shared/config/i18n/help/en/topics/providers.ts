import type { providersRu } from '../../ru/topics/providers';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const providersEn: typeof providersRu = {
  topic: {
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
      'not an unfinished screen. No section is in this state right now: for every CLI a ' +
      'section is either ready or hidden — although the hints on the Providers tab still ' +
      'speak of sections “in development”.',
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
      'Works for Claude, OpenCode, Qwen Code and Kimi Code, and the concept is the same — a folder with a ' +
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
    mapCommands: 'Commands',
    mapCommandsValue:
      'Works for Claude, Gemini, Qwen Code and OpenCode. For Claude the list is assembled ' +
      'from several sources: built-in commands, the commands/ directory, skills and ' +
      'plugins. For the others the panel shows what the CLI documents: for Gemini and Qwen ' +
      'Code, .toml files in ~/.gemini/commands/ and ~/.qwen/commands/ (a subdirectory gives ' +
      'a name like /git:fix); for OpenCode, .md files in ~/.config/opencode/commands/ plus ' +
      'the command key in opencode.json. Codex, Continue, Goose, Kimi Code, Cursor and Aider ' +
      'have no such section.',
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

    filesTitle: 'The CLIs’ own files',
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
    runnerNone: 'Neither one — the panel shows how to log in, or where to get a key if you cannot',
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
      'deliberate: an empty screen beats a guess at somebody else’s format. No CLI has such ' +
      'a section right now.',
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

    guideTitle: 'What this document holds',
    guideText:
      'A diagram of what one pick in the list changes; a path of seven frames from a ' +
      'real panel — from the selector to the redrawn menu; what this section is NOT; ' +
      'what the panel stores about a provider on its own side; the capability map and ' +
      'each CLI’s files; a table of refusals. Choosing a MODEL lives in the “Models” ' +
      'tab, corporate access in “Contour”: this is about choosing a CLI.',

    switchMapTitle: 'What one pick in the list changes',
    switchMapCaption:
      'The switch changes three things at once and leaves a fourth alone — the foreign ' +
      'files on disk. The diagram covers what happens between the click and the redrawn menu.',
    pathTextTitle: 'The same path in words',
    pathTextText:
      'Clicking “Select” writes one line into the panel’s state.json — the provider id. ' +
      'The menu is then assembled from that id (a section the CLI does not have ' +
      'disappears; a section “in development” opens a placeholder), the assistant starts ' +
      'looking for that CLI and that key, and history and search switch to the new ' +
      'provider’s files. Nothing is written into the CLI’s own configuration at that ' +
      'moment: the first write there happens when you open a section and press “Save”.',

    guide: {
      switchTitle: 'Path: switch to a foreign CLI and see what became different',
      switchCaption:
        'Settings → the “Providers” tab. Seven frames: the list, the warnings right ' +
        'after the pick, the check and its verdict, keys, the format comparison and the ' +
        'redrawn menu.',
      switchSelector: '1. The list of CLIs and the price of the pick',
      switchSelectorText:
        'Every card states plainly how many panel sections are ready for that CLI: ' +
        'Claude Code reads “Sections ready: 13”, Codex 7, Cursor and Aider 5. The ' +
        '“installed” badge comes from finding the binary in PATH, “recommended” marks ' +
        'the only fully verified one.',
      switchChosen: '2. Two warnings instead of silence',
      switchChosenText:
        'Right after the pick two cards appear: “Experimental provider” (some sections ' +
        'are still in development and nothing is written there yet) and “CLI not found” ' +
        'naming the file it looked for — codex.cmd on Windows. The second does not stop ' +
        'you editing configuration: without the CLI only the assistant is limited.',
      switchCheck: '3. A check before the first real write',
      switchCheckText:
        'The “Check” button runs a “read → write → read” round over every supported ' +
        'section. The write goes to a TEMPORARY COPY of the configuration: your files ' +
        'are not touched. The “Run the assistant” toggle is separate — that is one live ' +
        'request to the model, spending your subscription or key.',
      switchResult: '4. The verdict in words, not in colour',
      switchResultText:
        'The frame says “3 of 6 passed” and carries the “partially verified” badge: the ' +
        'round over files closed, the binary is not in PATH. Every step spells out the ' +
        'consequence — “configuration sections are not broken by this, only running the ' +
        'assistant through the CLI is”. The verdict is remembered and replaces the ' +
        'permanent “experimental” on the card.',
      switchKeys: '5. The key lives in the panel, not in a foreign config',
      switchKeysText:
        'Each provider’s key is stored encrypted inside the panel and handed out masked ' +
        'only. It never reaches the foreign config. Unset, it is picked up from an ' +
        'environment variable and the panel names which one: ANTHROPIC_API_KEY, ' +
        'OPENAI_API_KEY. With neither key nor variable but a CLI present, the assistant ' +
        'goes through the CLI.',
      switchFormat: '6. Formats checked against the schemas',
      switchFormatText:
        'The panel writes foreign configs from documentation, and documentation moves ' +
        'with releases. The comparison asks the reverse question: are the keys the panel ' +
        'edits still in the official schema? OpenCode reads “matches” with the keys ' +
        'listed; Codex, Gemini and Qwen read “no schema” — stated outright rather than ' +
        'passed off as success.',
      switchPanel: '7. The menu has been redrawn',
      switchPanelText:
        'The result of the switch is the left menu: AGENTS.md instead of CLAUDE.md, ' +
        'fewer sections, and “Codex (OpenAI): partially verified” in the header. ' +
        'Sections the CLI does not have are not greyed out — they are simply gone.',
    },

    notTitle: 'What this section is not',
    notCaption: 'Four questions brought here most often whose answer lives somewhere else.',
    notColumn: 'Not here',
    notMeaningColumn: 'Where it actually is',
    notInstall: 'Not an installer',
    notInstallText:
      'The panel looks for the binary in PATH and says whether it found it. Installing, ' +
      'updating or logging into a foreign CLI is done by that CLI’s own means.',
    notModels: 'Not the model picker',
    notModelsText:
      'A provider is a CLI and the format of its files. Which model answers is set in ' +
      'the “Models” tab and in the CLI’s own configuration.',
    notMigrate: 'Not a config migration',
    notMigrateText:
      'Switching copies no rules, skills or permissions from one CLI to another: the ' +
      'formats differ and a silent transfer would make things worse. Two providers’ ' +
      'configurations can be compared in the “Compare” section.',
    notPlatformHere: 'Not corporate access',
    notPlatformHereText:
      'Choosing a provider has nothing to do with whose gateway requests travel through. ' +
      'The contour with its own models and keys is a separate section.',

    ownStorageTitle: 'What the panel stores about a provider on its own side',
    ownStorageCaption:
      'All of it sits in the panel’s service directory inside the configuration ' +
      'directory and has nothing to do with the CLI’s own files.',
    storageActive: 'The active provider',
    storageActiveValue: 'agentdeck/state.json → settings.provider (one string — the id)',
    storageChecks: 'Check verdicts',
    storageChecksValue: 'agentdeck/state.json → providerChecks (id → steps, time, verdict)',
    storageKeys: 'API keys',
    storageKeysValue:
      'agentdeck/provider-keys.enc (AES-256-GCM) + provider-keys.key with 0600 permissions',
    storageFormatCache: 'Format comparison cache',
    storageFormatCacheValue: 'agentdeck/format-check.json (refreshed weekly or by the button)',
    storageNever: 'Where it is never written',
    storageNeverValue:
      'The key — into the CLI’s config or into logs; the provider pick — into foreign files',

    canSwitch: 'Switch the active CLI and come back with the same click',
    canWriteForeign: 'Edit a foreign CLI’s configuration in its native format',
    canProbe: 'Run the check over a temporary copy — before the first real write',
    canKey: 'Keep each provider’s key encrypted inside the panel',
    canFormats: 'Compare the keys it edits against the CLI’s published schema',
    canFallback: 'Pick the key up from an environment variable and name that variable',
    cantInstallCli: 'Install, update or authorise a foreign CLI',
    cantMigrateConfig: 'Move rules and permissions from one CLI to another',
    cantWriteStub: 'Write anything into a section marked “in development”',
    cantRestoreForeign: 'Restore a foreign config from a backup — neither file nor single change',
    cantInventSchema: 'Invent a schema URL where no official schema exists',

    refusalsTitle: 'Refusals and what they mean',
    refusalsCaption:
      'The panel refuses in words, not in silence. On the left what you see, on the ' +
      'right why and what to do about it.',
    refusalsColumn: 'What is shown',
    refusalsMeaningColumn: 'Reason and way out',
    refusalNoCli: '“not found” on the provider card',
    refusalNoCliText:
      'The binary is not in the PATH of the process that started the panel’s server. ' +
      'Configuration sections work regardless; for the assistant, install the CLI or set ' +
      'a key. Restart the panel afterwards: PATH is read at startup.',
    refusalStubSection: 'The section opens a placeholder',
    refusalStubSectionText:
      'That section’s format for that CLI has not been worked out yet. The placeholder ' +
      'sends nothing on purpose — a guess at someone else’s format breaks configuration ' +
      'silently.',
    refusalNoApi: '“has no model API of its own — a key cannot be set”',
    refusalNoApiText:
      'The provider has no API channel of its own: there is nowhere and no reason to keep ' +
      'a key. Its assistant runs through the CLI only.',
    refusalKeyLength: '“The key is empty or exceeds the allowed length”',
    refusalKeyLengthText:
      'An empty string, or more than 8192 characters. Nothing is written to the file in ' +
      'that case — the previous key stays where it was.',
    refusalNoSchema: '“No schema is officially published — nothing to compare against”',
    refusalNoSchemaText:
      'Neither a network error nor an all-clear. The CLI publishes no schema, and the ' +
      'panel will not invent its URL — comparing against a stranger’s file would produce ' +
      'a false “matches”.',
    refusalRestoreForeign: 'A foreign config’s backup has no “Roll back” button',
    refusalRestoreForeignText:
      'Backups of foreign CLIs are taken and stored under their own name, but restoring ' +
      'is built for Claude’s files only. The content can be put back by hand from the ' +
      'backup file.',
  },

  shots: {
    switch: {
      '01-selector':
        'The provider list: Claude Code shows “Sections ready: 13” and the “recommended” badge, Codex 7',
      '02-chosen':
        'Right after the pick: the “Experimental provider” and “CLI not found (codex.cmd)” cards',
      '03-check':
        'The check card before the run: a round over a temporary copy, a separate toggle for the assistant',
      '04-check-result':
        'The verdict: “3 of 6 passed”, the “partially verified” badge, each step with its consequence in words',
      '05-keys':
        'Provider keys: Claude’s reads “set in the panel” as a mask, the rest name their environment variable',
      '06-format':
        'Format comparison: OpenCode “matches” with the keys listed, Codex and Gemini read “no schema”',
      '07-panel':
        'The panel after the switch: AGENTS.md instead of CLAUDE.md in the menu, “Codex (OpenAI): partially verified” in the header',
    },
  },

  diagrams: {
    'what-switching-changes':
      'One pick in the list: what the panel rewrites, what the menu redraws and what it never touches on disk',
  },
};
