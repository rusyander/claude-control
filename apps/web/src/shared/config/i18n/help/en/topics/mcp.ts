import type { mcpRu } from '../../ru/topics/mcp';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const mcpEn: typeof mcpRu = {
  topic: {
    title: 'MCP servers',
    summary: 'External tools: giving Claude access to your tracker, database or browser',
    lead:
      'An MCP server is a program that hands Claude new tools: file an issue in a ' +
      'tracker, query a database, drive a browser. Skills and rules change ' +
      'behaviour; a server extends capability. Without one, Claude physically ' +
      'cannot reach your GitLab.',

    guideTitle: 'How to read this page',
    guideText:
      'Two diagrams first: what the “Check” button actually does, and who really keeps ' +
      'the server running. Then two paths in screenshots — “connect” is walked once per ' +
      'server, “not answering” is where you return every time a card turns red. After ' +
      'the screenshots: what the section writes on disk, the refusals with their causes, ' +
      'and the things people trip over.',

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

    notTitle: 'What this section is NOT',
    notCaption: 'The neighbours MCP gets confused with most often.',
    notColumn: 'Neighbouring section',
    notMeaningColumn: 'What it does instead',
    notPermissions: 'Permissions',
    notPermissionsText:
      'Here a server is connected whole; which of its tools Claude may use is decided by ' +
      'permissions. “Answers” and “allowed” are different things, and the “Tools” button ' +
      'leads exactly there.',
    notEnv: 'Environment',
    notEnvText:
      'The token lives there and only a ${VAR} reference comes here. The server ' +
      'configuration file is shared, and a secret in it would travel with any settings dump.',
    notProjects: 'Projects',
    notProjectsText:
      'This section manages the shared ~/.claude.json. A project’s own servers live in its ' +
      '.mcp.json and are edited under Projects — with neither a connection check nor OAuth.',
    notIntegrations: 'Integrations',
    notIntegrationsText:
      'Jira, Confluence and Telegram are connected there and work through the panel’s own ' +
      'API, not through MCP. It looks similar; the mechanics differ.',
    notSandbox: 'The sandbox',
    notSandboxText:
      'The flask on a card opens exactly that: call one tool and look at the real answer. ' +
      'It is a manual probe, not a part of connecting.',

    mapTitle: 'How it works',
    mapCaption:
      'A card shows a badge and one line of reason. Which fork the panel took to get there, ' +
      'and who holds the server during real work, is on the diagrams.',
    pathTextTitle: 'The same path in words',
    pathTextText:
      'On “Check” the panel takes the server entry, expands its ${VAR} references (the ' +
      'panel’s own environment as the base, then settings.json, settings.local.json, and ' +
      '.mcp-secrets.env with the last word) and, if everything expanded, connects over the ' +
      'declared transport. Then comes a real MCP handshake: initialize, then a request for ' +
      'the tool list — with the same official client Claude Code uses. The session closes ' +
      'right after the answer: the panel does not keep the server running. The outcome is ' +
      'stored in the panel state, which is why after a reload the card shows the previous ' +
      'check rather than “not checked”. The server’s working hours have nothing to do with ' +
      'the panel: every ENABLED server is started and held by Claude Code at session start.',

    guide: {
      connectTitle: 'Path 1. Connect a server: from an empty section to tool permissions',
      connectCaption:
        'Walked once per server. It is also where you see where the token belongs and why ' +
        '“answers” does not yet mean “usable”.',
      connectEmpty: 'An empty section',
      connectEmptyText:
        'Not a single server — “Empty” and the “Add server” button. The sidebar counter ' +
        'counts connected entries, disabled ones included.',
      connectForm: 'The builder: preset, transport, command',
      connectFormText:
        'Ready-made servers fill the fields for you. The name becomes the identifier and ' +
        'the prefix in permissions; the transport decides which fields are shown. The line ' +
        'under the variables field asks outright not to type secrets there.',
      connectImport: 'Or paste someone else’s JSON whole',
      connectImportText:
        'The “Several from JSON” tab understands both the mcpServers wrapper and a bare ' +
        'object of servers. Parsing happens as you type: the panel shows what it found and ' +
        'which transport it assigned to each entry.',
      connectCard: 'The card after saving',
      connectCardText:
        'There is no connection state yet: the panel claims nothing until it has checked. ' +
        'A network server that wants OAuth grows an “Authorize” button beside it.',
      connectHealth: 'Press “Check”',
      connectHealthText:
        'The badge shows not “the port is open” but the result of a real MCP handshake: how ' +
        'many tools the server returned and when. Zero tools on a successful connection ' +
        'usually means a bad token.',
      connectTools: '“Tools” turns the answer into permissions',
      connectToolsText:
        'The list comes from the server itself, with its own descriptions. Tick what you ' +
        'need, pick a decision — and the panel creates rules shaped mcp__server__tool. The ' +
        '“Whole server at once” checkbox makes a single rule for everything.',

      troubleTitle: 'Path 2. Not answering: four causes and what to do',
      troubleCaption:
        'You arrive here with a red badge. The cause sits on the card in one line, and each ' +
        'one is cured differently.',
      troubleFailed: 'The process never started',
      troubleFailedText:
        'The reason arrives in the system’s own words: no such command in PATH, no rights, ' +
        'crashed at start-up. On Windows this is the usual npx and uvx story — they are ' +
        '.cmd shims.',
      troubleVar: 'A variable did not expand',
      troubleVarText:
        'The check stops BEFORE connecting and names the variable. Otherwise the server ' +
        'would have received the literal string “Bearer ${BILLING_TOKEN}”, honestly answered ' +
        '401 — and you would be hunting a bad token instead of a missing variable.',
      troubleRejected: 'The token was rejected',
      troubleRejectedText:
        'A 401 from a server whose OWN Authorization header is set. So the token itself is ' +
        'the problem: expired, wrong, or short of a scope.',
      troubleOauth: 'OAuth sign-in required',
      troubleOauthText:
        'The same 401, but the entry carries no header of its own — the server is asking you ' +
        'to sign in. “Authorize” opens the sign-in window, the panel stores the token and ' +
        'refreshes it later. If a blocker ate the window, the sign-in address appears on the ' +
        'card as a link.',
      troubleDisabled: 'A disabled server is silent in a different way',
      troubleDisabledText:
        'The toggle moves the entry into mcpServersDisabled of the same file: Claude Code ' +
        'cannot see it, there is nothing to check, and the settings are kept whole.',
      troubleHeaders: 'Where this gets fixed',
      troubleHeadersText:
        'In the server form: request headers for http and sse, environment variables for ' +
        'every transport. The value still goes in as a ${VAR} reference, while the value ' +
        'itself lives in the Environment section.',
    },

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
    canTools: 'Turn the server’s tool list into permissions without typing patterns by hand',
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
    cantSecrets: 'Keep passwords here: values from this form land in the shared configuration file',
    cantPerTool:
      'Enable individual tools of a server: a server connects whole, and limits are ' +
      'set through permissions',
    cantDuplicate:
      'Add a second server under a taken name: the name is the identifier, so saving ' +
      'over an existing one (a disabled namesake included) is refused',
    cantKeepRunning:
      'Keep a server running: the check closes its session at once, and during real work ' +
      'the server is started and held by Claude Code',

    storageFile: 'Where it is stored',
    storageFileValue: '~/.claude.json — outside the .claude directory',
    storageWhy: 'Why separately',
    storageWhyValue: 'this is a shared Claude Code file; the panel only rewrites its own section',
    storageOff: 'Disabled ones',
    storageOffValue: 'move to the mcpServersDisabled key, which Claude Code ignores',
    storageHealth: 'The check outcome',
    storageHealthValue: 'agentdeck/state.json → mcpHealth: status, reason, tool count and time',
    storageTokens: 'OAuth tokens',
    storageTokensValue:
      'in the panel’s own data, apart from the configuration — they are not in ~/.claude.json',
    storageRestart: 'When it takes effect',
    storageRestartValue: 'after Claude Code is restarted',

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

    refusalsTitle: 'Refusals and what to do',
    refusalsCaption: 'The reason line from the card on the left; the cure on the right.',
    refusalsColumn: 'What the card says',
    refusalsMeaningColumn: 'What to do',
    refusalProcess: 'MCP error -32000: Connection closed',
    refusalProcessText:
      'The process never started, and the system’s own text stands next to it. Check the ' +
      'command the way you would in a terminal: the right PATH, the package installed, a ' +
      'path with spaces not swallowed.',
    refusalVar: 'Variables ${…} are not set',
    refusalVarText:
      'The panel names them. Create the variable in the Environment section — or in the ' +
      'environment the panel was started from — and check again.',
    refusalRejected: 'The server rejected the Authorization header (401)',
    refusalRejectedText:
      'The header is there but the token did not fit: expired, wrong, or without the right ' +
      'scope. Fixed by the variable’s value, not by the server entry.',
    refusalOauth: 'OAuth authorization required',
    refusalOauthText:
      'No header of its own, and the server is asking you to sign in. Press “Authorize”; on ' +
      'stdio this fork never happens — there is nowhere to sign in.',
    refusalZero: 'Answers, but zero tools',
    refusalZeroText:
      'The handshake went through and the list came back empty. Usually the token is valid ' +
      'in shape but grants access to nothing — check the token’s scopes on the service side.',
    refusalInvisible: 'The agent does not have the server',
    refusalInvisibleText:
      'Claude Code takes the tool list at session start. Open a new conversation: a server ' +
      'connected just now will not appear in one already running.',

    fieldsTitle: 'Fields of a server',
    fieldsCaption:
      'Names match the mcpServerDraftSchema schema. Health and tools are response fields ' +
      '(mcpServerSchema): the form has none, they appear after a check.',
    fieldName:
      'The server name in the configuration. Also the identifier and the prefix used in ' +
      'permissions.',
    fieldTransport: 'How the panel talks to the server: stdio, sse or http.',
    fieldCommand: 'The launch command. For stdio only, npx for example.',
    fieldArgs: 'Command arguments. Typed as one space-separated line.',
    fieldUrl: 'The server address. For sse and http only.',
    fieldEnv:
      'Environment variables, one KEY=VALUE per line. What belongs here are references ' +
      'to variables, not the secrets themselves: ${VAR} or ${VAR:-default}. During a ' +
      'connection check the panel expands them from its own environment and from the ' +
      'Environment section (settings.json → env, settings.local.json, .mcp-secrets.env). ' +
      'An unset variable is named in the failure reason.',
    fieldHeaders:
      'Request headers, one Name=value per line — the same shape as environment ' +
      'variables, with the same ${VAR} expansion. For http and sse only: for stdio the form clears them.',
    fieldHealth: 'Connection state from the last check, plus the reason if it failed. Read only.',
    fieldTools: 'How many tools the server reported during the check. Read only.',

    notesTitle: 'Things people trip over',
    noteSecretTitle: 'Secrets do not belong here',
    noteSecretText:
      'Server configuration lives in a shared file that easily leaks along with a ' +
      'settings dump. The variables field takes the name of a key, while the value ' +
      'itself stays in the Environment section.',
    noteWindowsTitle: 'On Windows the command is looked up the way a terminal does it',
    noteWindowsText:
      'npx, node and uvx are .cmd shims there, and a plain process spawn cannot find them. ' +
      'The panel starts a stdio server through cross-spawn — the same library the official ' +
      'MCP client uses: the command is resolved via PATH and PATHEXT, arguments are escaped ' +
      'by the library, a path with spaces stays one argument. No separate cmd shell is ' +
      'involved, and the stderr of a crashed process is also read in the console code page ' +
      '(CP866), so the reason does not turn into question marks.',
    noteProjectTitle: 'These are the global MCP servers; project ones live in Projects',
    noteProjectText:
      'This section manages the shared ~/.claude.json. A specific project’s MCP servers ' +
      'live in its .mcp.json and are edited in the Projects section: adding, editing and ' +
      'the disable toggle are there, but not the connection check or OAuth.',
    noteTimeoutTitle: 'The connection timeout is configurable',
    noteTimeoutText:
      'The timeout for network servers (http/sse) is set in Settings via ' +
      'mcpNetworkTimeoutMs (2000–120000 ms). Launching local stdio servers stays ' +
      'hard-capped at 45 seconds for the handshake including process start-up: ' +
      '`npx -y` still downloads the package on its first run.',
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
      'Starting a server costs time, so opening the page shows the outcome of the last ' +
      'check on the card — status, reason, tool count and time. The outcome is kept in ' +
      'the panel state and survives a page reload; the Overview counts responding and ' +
      'failed servers from it. A fresh one is a button away, or enable the automatic ' +
      'check on open in Settings (mcpAutoCheck). A 401 from a server with its own ' +
      'Authorization header means a rejected token, not a need for OAuth — the card says so.',
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

  shots: {
    connect: {
      '01-empty': 'The section with no servers: “Empty” and a single “Add server” button',
      '02-form-presets':
        'The builder: six ready-made servers, the name orders, stdio transport, command and arguments',
      '03-import':
        'Someone else’s JSON pasted in: the panel found two servers and worked out each transport',
      '04-card-unknown':
        'Three cards right after saving: the connection is unchecked, and crm offers “Authorize”',
      '05-connected':
        'The same card after the check: “Answers: 5 tools” and the time of the last check',
      '06-tools':
        'Server tools with their descriptions: three ticked, decision “Allowed”, the “Create permissions (3)” button',
    },
    trouble: {
      '01-failed':
        'The process never started: “Not answering” plus the system’s own text — no such command in PATH',
      '02-missing-var':
        'The check stopped before connecting: the panel names the unset variable ${BILLING_TOKEN}',
      '03-token-rejected':
        'The header is there but the server answered 401 — the card says to check the token in the headers',
      '04-oauth':
        'The same 401 without a header of its own reads as “OAuth authorization required”',
      '05-disabled':
        'A disabled server: the “Disabled” badge, the reason gone, the settings kept whole',
      '06-headers':
        'The edit form: the Authorization header references ${BILLING_TOKEN} instead of holding a token',
    },
  },

  diagrams: {
    'probe-path':
      'The “Check” button end to end: ${VAR} expansion, the transport, the MCP handshake and three forks of refusal',
    'who-runs-what':
      'The panel edits the file and places a call; Claude Code starts the server and holds it for the session',
  },
};
