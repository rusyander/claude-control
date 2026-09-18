import type { panelAgentRu } from '../../ru/topics/panelAgent';

/** Typed against the Russian module: a key forgotten in translation fails the build. */
export const panelAgentEn: typeof panelAgentRu = {
  topic: {
    title: 'Panel agent',
    summary:
      'A window where the panel is driven by words: the agent asks for an action, the panel ' +
      'shows a card and runs it only after your click',
    lead:
      'The «Panel agent» button is on every page. You type or dictate in plain words — «add a ' +
      'project», «connect a contour», «delete a rule», «how do I set up a hook?» — and the ' +
      'agent answers from the panel help or does it with the same actions the section buttons ' +
      'use. It writes nothing on its own: every action that changes something arrives as a ' +
      'card showing what will be written and waits for your «Run» — in the window on the ' +
      'computer or in the phone app. The agent never receives keys or secrets — you enter ' +
      'them in the panel’s own fields.',
    guideTitle: 'How this page is organised',
    guideText:
      'First the diagram: the path of one action from your message to the file on disk. Then ' +
      'two paths in real screenshots — «I want the panel to do this» and «the agent refused ' +
      'or did not do something». After them — how to ask «how do I», the actions of every ' +
      'section, the confirmation card, the route, files, limits and refusals.',
    askTitle: 'Ask how to do something',
    askCaption:
      'The agent reads the same help you do — and answers from it, not from the model’s ' +
      'memory',
    askHow: '«How do I…?» — an answer from help',
    askHowText:
      '«How do I set up a hook on Bash?» — the agent searches the panel help, reads the topic ' +
      'it found and answers with its steps, naming the topic. This is reading: no cards, ' +
      'nothing changes.',
    askDo: '«Do…» — an action with a card',
    askDoText:
      'Ask for the same thing in words — the agent does it with an action from the list ' +
      'below, and everything that changes arrives as a card.',
    askNot: 'Not in help — it says so',
    askNotText:
      'If no help topic answers the question, the agent says so instead of inventing a button ' +
      'the panel does not have.',
    whyTitle: 'Why a window when there are buttons',
    whyWords: 'Words are faster than forms',
    whyWordsText:
      '«Add project C:/work/shop and open it» is one sentence instead of a page switch, a ' +
      'button and two fields. The agent finds the section and opens it next to the window.',
    whySame: 'The same actions as the buttons',
    whySameText:
      'The agent has no path of its own to files: it asks for an action, and the panel runs it ' +
      'through the same route as the section’s button — same validation, same backup copy, ' +
      'same entry in Change history.',
    whyTrace: 'Everything it did is visible',
    whyTraceText:
      'Each action lands as a line in the Action trail: what, with which outcome and who ' +
      'decided — you with a click, or the panel without a question because it was a read.',

    pathMapTitle: 'The path of one action',
    pathMapCaption:
      'The model only asks. The panel executes, and a changing action waits for your click',
    pathTextTitle: 'The same path in words',
    pathTextText:
      'The message passes the data mask, then the panel starts Claude Code with no built-in ' +
      'tools: all it has is the bridge to the panel’s actions. The model picks an action. A ' +
      'read runs at once; a change or a dangerous action is shown as a card with a preview and ' +
      'waits up to 10 minutes. After «Run» the panel checks the target has not changed, runs the ' +
      'action through the section’s route, opens the page with the result and writes a line to ' +
      'the action trail.',

    keysMapTitle: 'Keys and files',
    keysMapCaption: 'What the agent never receives and what it leaves on disk',

    actionsTitle: 'What the agent can do — by section',
    actionsCaption:
      'Exactly this list — every panel section, nothing more. The risk class decides whether ' +
      'the panel asks: read — no question, change — a card focused on «Run», danger — focused ' +
      'on «Reject»',
    actionsSection: 'Section',
    actionsWhat: 'Actions and risk class',
    riskRead: 'read',
    riskChange: 'change',
    riskDanger: 'dangerous',
    secNavigation: 'Navigation',
    secNavigationText:
      'Where am I, list sections, open a page, overview, panel search, analytics summary, ' +
      'provider comparison — read. A changing action opens the section with the result by ' +
      'itself.',
    secProjects: 'Projects and chats',
    secProjectsText:
      'Projects, chats, running runs, git state and worktrees — read. Add a project — change; ' +
      'afterwards that project opens, and «and open its chat» opens the project tab in chat. ' +
      'Remove a project from the registry and start a chat with a task — danger: the chat ' +
      'card shows the whole prompt, the run spends the limit.',
    secRules: 'Rules',
    secRulesText:
      'List — read. Save a rule and switch it on/off — change, with a CLAUDE.md diff. Delete — ' +
      'dangerous.',
    secSkills: 'Skills',
    secSkillsText: 'List — read. Save a skill — change. Delete a skill folder — dangerous.',
    secHooks: 'Hooks',
    secHooksText:
      'List — read. Write and enable/disable a hook — change, with the settings.json diff. ' +
      'Delete — danger. A hook is a command Claude Code runs by itself: read it in full on ' +
      'the card.',
    secEnv: 'Environment variables',
    secEnvText:
      'List — read, secret values hidden. Write a variable — change; a secret one is written ' +
      'without a value, and the panel opens the value field for you. Delete — danger.',
    secClaudeMd: 'CLAUDE.md',
    secClaudeMdText:
      'Read the file — read. Rewrite it whole — danger, with a diff; a single rule goes ' +
      'through «Rules».',
    secScripts: 'Scripts and commands',
    secScriptsText:
      'Commands, scripts and a script’s text — read. Write a script — change. Delete — ' +
      'danger.',
    secGroups: 'Groups',
    secGroupsText: 'List — read. Write and enable/disable a group — change. Delete — danger.',
    secPlugins: 'Plugins',
    secPluginsText:
      'Installed and available — read. Enable/disable and update — change. Install, ' +
      'uninstall, connect or disconnect a marketplace — danger: a plugin brings code that ' +
      'runs later.',
    secHistory: 'History and backups',
    secHistoryText:
      'Change feed, diff, backup list — read. Revert a hunk and restore a file from a backup ' +
      '— danger.',
    secSettings: 'Settings and provider',
    secSettingsText:
      'Read settings — read. Change allowed keys — change. Switch the active CLI — danger: ' +
      'the whole panel, chat and the agent itself change.',
    secEndpoints: 'Own endpoints',
    secEndpointsText:
      'List and connection check — read. Write a profile — change, without a token: the panel ' +
      'opens the token field. Apply to a CLI and delete — danger.',
    secIntegrations: 'Integrations',
    secIntegrationsText:
      'List and connection check — read. Write settings — change, without a token: the panel ' +
      'opens the token field. Disconnect and forget the token — danger.',
    secDlp: 'Data protection',
    secDlpText: 'Rules and proxy state — read. Write rules and start/stop the proxy — change.',
    secHelp: 'Help',
    secHelpText:
      'Help search, topic list, reading a topic — read, no cards: this is how the agent ' +
      'answers «how do I».',
    secMcp: 'MCP servers',
    secMcpText:
      'List — read, with secret values hidden. Save a server — change. Delete — dangerous.',
    secPermissions: 'Permissions',
    secPermissionsText: 'List — read. Add a permission rule — change. Remove — dangerous.',
    secContour: 'Contour',
    secContourText:
      'Contour list, status, address probe — read. Save a draft — change, without the key. ' +
      'Enable a contour — dangerous: after it CLI requests go to the company contour.',
    secTests: 'Testing',
    secTestsText:
      'Groups, cases, coverage, runs, case lint — read. Case draft and stopping a run — ' +
      'change. Starting a run and deleting a case — danger.',
    cardTitle: 'The confirmation card',
    cardCaption: 'What it shows and why Enter rejects a dangerous action by default',
    cardHeader: 'What',
    cardWhat: 'How it behaves',
    cardChange: 'Change',
    cardChangeText:
      'Heading «The agent asks for confirmation», a human description of the action, its input ' +
      'fields and, when a file is edited, a «What will change» block with the diff. Focus is on ' +
      '«Run». On a line of its own, «Besides the file» names the consequences the diff does not ' +
      'show: a panel mark being removed, an OAuth login being deleted, marks moving on a rename, ' +
      'a group that holds the switch off anyway. The panel writes those lines itself, so they ' +
      'are translated along with the interface instead of staying Russian in an English window.',
    cardDanger: 'Dangerous',
    cardDangerText:
      'Heading «Dangerous action — check carefully». Focus is on «Reject»: Enter pressed out of ' +
      'habit deletes nothing.',
    cardFocus: 'Focus and your typing',
    cardFocusText:
      'While you type in the agent’s input, an arriving card does not take focus — Enter goes ' +
      'into your message, not into a decision.',
    cardDiff: 'A long diff',
    cardDiffText:
      'A diff the panel could not show in full keeps «Run» locked: you cannot confirm what you ' +
      'cannot see. Make an edit that large in the section itself.',
    cardStale: 'The card went stale',
    cardStaleText:
      'If the target changed between showing and clicking — the file was edited in an editor, ' +
      'the contour record or cases changed — the panel writes nothing and says the target ' +
      'changed. The agent re-reads and shows a fresh card.',
    cardTimeout: 'Waits until…',
    cardTimeoutText:
      'The card waits 10 minutes for a click; the end time is written on it. No decision — the ' +
      'outcome is «timed out», nothing was run.',
    cardOnlyWindow: 'Who decides',
    cardOnlyWindowText:
      'Only a human decides — with a click in the panel window or a button in the phone app ' +
      'paired by token with remote access on. Whoever decides first wins; the other place ' +
      'gets «already decided». A request from the agent bridge is refused even with a token, ' +
      'and the card keeps waiting.',
    routeTitle: 'Where the conversation goes',
    routeCaption:
      'The agent takes the same route as the panel assistant — one choice in settings for both',
    routeHeader: 'Assistant choice',
    routeWhat: 'What the agent does',
    routeDefault: 'Default provider',
    routeDefaultText:
      'The active CLI is Claude Code; the request goes to the vendor cloud with Claude Code’s ' +
      'own login.',
    routeContour: 'Contour',
    routeContourText:
      'Claude Code is pointed at the panel’s local gateway, which inserts the contour key. The ' +
      'agent process gets a placeholder instead of the key. Gateway down or no key — refusal: ' +
      'no silent fallback to the vendor cloud.',
    routeEndpoint: 'Own endpoint',
    routeEndpointText:
      'Refused: the endpoint token would have to be handed to the CLI process. Switch the ' +
      'assistant back to the default provider or to a contour.',

    notTitle: 'What the panel agent is NOT',
    notCaption: 'Neighbours it gets confused with',
    notColumn: 'Not this',
    notMeaningColumn: 'Difference',
    notChat: 'Chat',
    notChatText:
      'Chat works with project code: reads files, runs commands. The panel agent sees no code ' +
      'and never appears in the chat list — it edits only the panel’s settings.',
    notAssistant: 'Section assistant',
    notAssistantText:
      'The assistant explains and suggests text but runs nothing. The agent runs — through a ' +
      'card.',
    notAutopilot: 'Autopilot',
    notAutopilotText: 'Without your click it changes nothing. Only reads run without a question.',
    notKeys: 'A place for keys',
    notKeysText:
      'A key in a message to the agent never reaches the model — it is masked. Secrets are ' +
      'entered in panel fields the agent opens itself: the contour key in the «Contour» ' +
      'wizard, an MCP secret in the server form, a secret variable’s value in «Environment ' +
      'variables», endpoint and integration tokens in «Settings».',
    storageTitle: 'What it writes on disk',
    storageCaption:
      'The panel has no database of its own: only the files below and the files the action ' +
      'itself edits',
    storageJournal: 'Action trail',
    storageJournalValue: '~/.claude/agentdeck/agent-actions.jsonl',
    storageConversations: 'Conversations (History tab)',
    storageConversationsValue: '~/.claude/agentdeck/panel-agent/<id>.json',
    storageBackups: 'Copy before the edit',
    storageBackupsValue: '~/.claude/agentdeck/backups',
    storageTargets: 'Files the action edits',
    storageTargetsValue:
      'CLAUDE.md, skills, settings.json (hooks, permissions, env), .mcp-secrets.env, ' +
      '.claude.json, scripts, plugins, state.json (groups, settings, endpoints, ' +
      'integrations), contours, test cases',
    storageWhen: 'When it reaches Claude',
    storageWhenValue:
      'Rules, skills, permissions and MCP — on the next Claude Code start; a running session ' +
      'picks them up after a restart',
    storageNever: 'Never there',
    storageNeverValue:
      'Keys and secrets in the trail or conversations; a transcript of the turn in ~/.claude/projects',

    limitsTitle: 'Limits and how to undo',
    limitsCaption: 'What works, what does not — and what to do',
    limitsColumn: 'Case',
    limitsMeaningColumn: 'What happens and what to do',
    limitUndo: 'Undo what was done',
    limitUndoText:
      'A file edit can be reverted in «Change history» — the copy before the edit is there — ' +
      'or ask the agent: it can revert a hunk and restore a file from a backup; both are ' +
      'danger actions with a card. Only you restore an encrypted backup: it needs the ' +
      'passphrase. Remove a project in «Projects», a contour draft on its card.',
    limitHooks: 'Settings only you change',
    limitHooksText:
      'The config directory, revealing secrets, backups before writing and their encryption, ' +
      'rule auto-approval, the prompt gate, model prices, the gateway and remote access are ' +
      'not changed by the agent — it asks you to do it in «Settings». The agent writes hooks, ' +
      'but read the hook command in full on the card: Claude Code will run it.',
    limitStartChat: 'Starting a chat',
    limitStartChatText: 'Claude Code only. For another CLI start the chat in the Chat section.',
    limitPhone: 'Phone',
    limitPhoneText:
      'The «Agent» tab in the app: conversation, waiting cards with a badge on the tab, ' +
      'history and trail — the same agent and the same files as the window. Cards can be ' +
      'decided from the phone too: «Run» and «Reject» work as in the window. Pages and key ' +
      'fields the agent opens open on the computer. A turn runs while the app is on screen: ' +
      'going to the background drops the connection and stops the agent; what was said stays ' +
      'in history.',
    limitMask: 'What is masked in a message',
    limitMaskText:
      'While «Data protection» has no rules, only keys, tokens and a login with password in ' +
      'an address are masked — links, addresses, e-mail and ids reach the agent as is: they ' +
      'are the task data. Own section rules mask more; keys are always masked, even on top of ' +
      'own rules.',
    limitVoice: 'Voice',
    limitVoiceText:
      'A microphone next to the field. Speech is recognised by the browser (Web Speech API — ' +
      'most reliable in Chrome) or by the phone system; the panel gets text only. The text lands ' +
      'in the field and is not sent by itself — you send it, and it then goes through the same ' +
      'data mask as typed text. While dictating, Send is unavailable. If the browser denied the ' +
      'microphone or cannot recognise speech, the reason is written under the field.',
    limitWindow: 'Window',
    limitWindowText:
      'The window sits on the right, about 440 pixels wide; the page shrinks beside it and stays ' +
      'live — a page the agent opens is visible at once.',
    limitCode: 'Project code',
    limitCodeText:
      'The agent does not read project files: it sees only git state and the list of ' +
      'worktrees. Work with code happens in chat.',
    refusalsTitle: 'Refusals and why',
    refusalsCaption:
      'All but the last happen before the start: the window shows «The agent did not answer» ' +
      'with the reason, nothing is written',
    refusalsColumn: 'Refusal',
    refusalsMeaningColumn: 'Reason and what to do',
    refusalProvider: 'Another CLI is active',
    refusalProviderText:
      'The agent works only with Claude Code for now. Switch the active CLI in Settings.',
    refusalCli: 'Claude Code not found',
    refusalCliText:
      'It is not in the PATH of the panel process. Install the CLI and restart the panel; an API ' +
      'key will not help — without the CLI the agent has no actions.',
    refusalEndpoint: 'Own endpoint selected',
    refusalEndpointText:
      'The endpoint key would have to be handed to the agent process. Switch the assistant back ' +
      'to the default provider or to a contour.',
    refusalContour: 'Contour unreachable',
    refusalContourText:
      'The panel gateway is down or the contour key is not saved. Start the gateway or save the ' +
      'key on the contour card.',
    refusalMask: 'Masking rules broken',
    refusalMaskText:
      'The Data protection rules file cannot be read. No message goes out without the mask — fix ' +
      'the rules in that section.',
    refusalBusy: 'The agent is still answering',
    refusalBusyText: 'A turn is running in this conversation. Wait for it or press «Stop».',
    refusalTimeout: 'Timed out',
    refusalTimeoutText:
      'The card was not decided within 10 minutes — the action did not run. Ask the agent again.',

    compromiseTitle: 'Compromise: «The agent does not approve itself — on the process’s word»',
    compromiseText:
      'A card is decided by a request with the window’s allowed Origin or from a paired phone ' +
      '— a valid token and no Origin, only with remote access on; never with the agent bridge ' +
      'mark. The model does not choose these headers, but a local process of the same user ' +
      'can forge them or read the token file. The panel’s trust boundary is the machine user: ' +
      'such a process edits the same files without the agent.',
    guide: {
      firstTitle: 'Path 1. I want the panel to do this from my words',
      firstCaption:
        'From the button on the page to a completed action, a rejected deletion, the trail and history',
      firstLauncher: 'A button on every page',
      firstLauncherText: 'In the side menu, above the sections — «Panel agent».',
      firstEmpty: 'The window next to the page',
      firstEmptyText:
        'The window opens on the right, the page stays visible. Under the tabs — which page the ' +
        'agent considers open.',
      firstChange: 'A change card',
      firstChangeText:
        'The agent asks to add a project. The panel shows what it will write: folder and name. ' +
        'You are still in the input, so the card did not take focus.',
      firstDone: 'Done — the page with the result',
      firstDoneText:
        'After the click the project is registered, and the panel opened Projects next to the window.',
      firstDiff: 'A file edit: the diff in the card',
      firstDiffText:
        'The rule goes into CLAUDE.md — the card shows the lines to be added and the file.',
      firstSaved: 'The rule in its section',
      firstSavedText: 'After «Run» the rule shows in Rules — just like one added by hand.',
      firstDanger: 'A dangerous action',
      firstDangerText:
        'Deleting the rule: a different heading and the diff of removed lines. You sent the request and left the input — the card put focus on «Reject».',
      firstRejected: 'Enter rejected',
      firstRejectedText:
        'Enter out of habit pressed «Reject» — the file is untouched, the agent asks what to do instead.',
      firstJournal: 'Action trail',
      firstJournalText:
        'Each action as a line: risk class, outcome and who decided — a human, or «no question» ' +
        'for a read.',
      firstHistory: 'Conversation history',
      firstHistoryText:
        'Conversations are kept by the panel, not by Claude Code: open and re-read any of them.',

      guardsTitle: 'Path 2. The agent refused or «did not do something»',
      guardsCaption:
        'Keys, a stale card, an MCP secret and refusals before the start — all protection, not breakage',
      guardsContour: 'A contour draft without a key',
      guardsContourText:
        'The card says it plainly: you type the key, and enabling is a separate action.',
      guardsKeyField: 'The panel opens the key field',
      guardsKeyFieldText:
        'After saving, the panel opens its own key field. The agent does not see it and only learns ' +
        'whether a key is saved.',
      guardsMasked: 'A key from chat goes out as a label',
      guardsMaskedText:
        'A key pasted into a message is replaced by a label in the conversation — exactly what the model got.',
      guardsStale: 'The card went stale',
      guardsStaleText:
        'The file was edited in an editor while the card waited. «Run» wrote nothing — the panel says why.',
      guardsMcpCard: 'An MCP server with an empty secret',
      guardsMcpCardText:
        'The agent saves the server but leaves the token empty — the panel will not accept a secret from the model.',
      guardsMcpSecret: 'Type the secret in the server form',
      guardsMcpSecretText:
        'After saving, the panel opens the form of that server: the empty secret field is on top with the cursor already in it. ' +
        'The value is written on “Save”; the agent never sees it. The agent window says “The key field is open” ' +
        'only when the field was actually found.',
      guardsOtherCli: 'Another CLI is active',
      guardsOtherCliText: 'The turn does not start: the agent works only with Claude Code for now.',
      guardsDlp: 'Masking rules broken',
      guardsDlpText:
        'Without the mask no message goes to the agent — the window names where to fix it.',
      guardsCli: 'Claude Code not found',
      guardsCliText:
        'The CLI is not on the panel process PATH — the turn does not start. Install Claude Code and restart the panel.',
      guardsEndpoint: 'The assistant uses its own endpoint',
      guardsEndpointText:
        'The endpoint key would have to be handed to the agent process, so the turn does not start. Switch the assistant back to the default provider or to a contour.',
      guardsContourDown: 'Contour unreachable',
      guardsContourDownText:
        'The assistant goes through a contour, but the gateway is down or there is no key — the panel never silently falls back to the vendor cloud.',
      guardsBusy: 'The agent is still answering',
      guardsBusyText:
        'A turn is already running in this conversation (for example, from another tab). Wait for it to end and send again.',
    },
  },

  shots: {
    first: {
      '01-launcher': 'The «Panel agent» button in the side menu — on every page',
      '02-empty':
        'The agent window to the right of Overview: tabs «Conversation», «History», «Action trail» and «Page: Overview»',
      '03-change-card':
        'Card «The agent asks for confirmation» for adding a project, class «change»',
      '04-done': 'After «Run»: the project in Projects, the page opened next to the window',
      '05-diff-card': 'A CLAUDE.md edit: the «What will change» block with the rule’s added lines',
      '06-rule-saved': 'The new rule in the Rules section',
      '07-danger-card':
        'Deleting the rule: «Dangerous action — check carefully», class «dangerous»',
      '08-rejected': 'Enter rejected the deletion; the agent asks what to do instead',
      '09-journal':
        'Action trail: outcome and «decided by a human» for changes, «no question» for reads',
      '10-history': 'History: a conversation with its message count, ready to open',
    },
    guards: {
      '01-contour-card': 'A contour draft card: the key is typed by you after saving',
      '02-key-field': 'The panel opened its own contour key field — the agent does not see it',
      '03-key-masked': 'In the saved conversation a label stands where the key was',
      '04-stale': 'The card went stale: the target changed after it was shown, nothing was written',
      '05-mcp-card': 'MCP server gitlab: in the .claude.json diff GITLAB_TOKEN is empty',
      '06-mcp-secret':
        'Form of the gitlab server: the empty GITLAB_TOKEN secret field on top, cursor in it — the human types the value',
      '07-other-cli':
        '«The panel agent works only with Claude Code for now: another CLI is active»',
      '08-dlp-broken':
        '«The data masking rules are broken: without the mask no message goes to the agent»',
      '09-cli-not-found': '«Claude Code was not found in PATH: the agent has nothing to work with»',
      '10-endpoint-unsupported':
        '«The assistant uses its own endpoint: its key would have to be handed to the agent process»',
      '11-contour-unreachable':
        '«The assistant goes through a contour, but the gateway is down or there is no key»',
      '12-busy': '«The agent is still answering in this conversation — wait for the turn to end»',
    },
  },

  diagrams: {
    'action-path':
      'The path of one action: mask, Claude Code without its own tools, the action registry, the card, execution and the trail',
    'keys-and-files':
      'What the agent never receives (contour key, MCP secrets, a key from chat) and which files the panel writes',
  },
};
