import type { phoneRu } from '../../ru/topics/phone';

/** Typed against the Russian topic: a key cannot be forgotten in translation. */
export const phoneEn: typeof phoneRu = {
  topic: {
    title: 'Phone',
    summary:
      'An Android app over the same panel: what is running, who is waiting for an answer, ' +
      'chat, tests and analytics — from anywhere on your Tailscale network',
    lead:
      'The phone app is not a second panel but a window into this one. It has no server, no ' +
      'database and no copy of your conversations of its own: every screen is a request to the ' +
      'panel server on your computer. That is why the phone shows the same chat, the same agent ' +
      'questions, the same projects and numbers as the desk — while configuration (rules, ' +
      'hooks, MCP, permissions) is still edited in the panel. Tailscale is how the phone ' +
      'reaches the computer: the panel stays on 127.0.0.1, no port is opened, and the phone is ' +
      'let in by a token the panel shows as a QR code.',
    guideTitle: 'How this page is laid out',
    guideText:
      'First, why the app exists and the path of one request: phone → Tailscale → panel → CLI. ' +
      'Then three paths in real frames of both sides: pairing the phone, an ordinary day with ' +
      'the phone in hand, and what you see when the panel does not answer. After them: what ' +
      'each screen holds, what works without a connection, what the app is not, where things ' +
      'are stored, the limits and the refusals word for word.',

    whyTitle: 'Why it exists',
    whyAway: 'Work runs without you',
    whyAwayText:
      'A split, a test run or a long agent turn takes tens of minutes. There is no reason to ' +
      'sit at the screen for it: the phone home shows what is running and what is waiting, and ' +
      'a notification arrives when the work is done, has failed or has hit a question.',
    whyAnswer: 'Answer, not just find out',
    whyAnswerText:
      'An agent question, a permission request and «first edit in the main copy» are answered ' +
      'right from the phone. The answer goes out as the same message the desk chat would send ' +
      '— the agent carries on without waiting for you to get back to the desk.',
    whySame: 'One set of data, nothing is copied',
    whySameText:
      'The phone reads the panel server, not a copy of its own: a conversation started at the ' +
      'desk continues on the phone and back. If the phone drops off, nothing is lost on the ' +
      'computer, because nothing was moved off it in the first place.',

    mapTitle: 'The path of one request',
    mapCaption:
      'Who talks to whom and where the token is checked. Click the diagram to read every label ' +
      'at full size.',
    mapTextTitle: 'The same in words',
    mapTextText:
      'The phone sends a request to the https address of the machine on your Tailscale ' +
      'network. On that same machine tailscale serve accepts it and passes it to ' +
      '127.0.0.1:5178 — the panel server. The server lets the request in only if its token is ' +
      'in the Authorization header (with «Require a token» on). From there everything is as ' +
      'from the browser: the server reads the Claude Code files, starts the CLI for a chat turn ' +
      'and streams the events back. Notifications take a different road: the panel sends the ' +
      'Expo service only the event kind and the project folder name, and Expo wakes the phone.',

    screensTitle: 'What each screen holds',
    screensCaption:
      'Five tabs at the bottom and a few screens on top of them. Everything else in the panel ' +
      'is desk work and is deliberately not carried over to the phone.',
    screenColumn: 'Screen',
    screenWhatColumn: 'What it shows and what it can do',
    screenHome: 'Home → «Projects & chats»',
    screenHomeText:
      'Live conversations across all projects at once: what is running, what is waiting for ' +
      'you, what ran in the last day. Paired with several computers — a row of their names sits ' +
      'above the tabs, a tap selects one. On top, a summary: how many conversations are running, ' +
      'how many need you (a tap leads to «Questions») and in how many projects. Under «New ' +
      'chat» you see the project it will start in, and «change» leads to the projects. ' +
      'Conversations of a project copy sit under their main ' +
      'project. Refreshes every 5 seconds; the number on the tab is how many answers are ' +
      'waiting for you. A conversation running in a terminal or VS Code is «working» too: its ' +
      'steps appear in the chat by themselves. With «The agent on the computer» on in Settings ' +
      'and the panel hooks in the Claude Code settings, you control it from here: a question or ' +
      'a permission request stands both on the phone and in the window on the computer, and the ' +
      'first decision wins; what you write in the chat the agent reads after its next step, ' +
      'without waiting for the turn to end, and under the field you see whether a message still ' +
      'waits for a step or has been passed on. A session started before the hooks were added ' +
      'does not see them: once the agent finishes a step and the message is still waiting, the ' +
      'phone says it will arrive only after the session restarts. Without the hooks the ' +
      'request card is read-only.',
    screenQuestions: 'Home → «Questions»',
    screenQuestionsText:
      'Everything that waits for a human, one card per chat: agent questions with options, ' +
      'permission requests and «first edit in the main copy». Cards come oldest first; the ' +
      'answers of one chat are collected and sent as one message.',
    screenChat: 'Chat',
    screenChatText:
      'The same conversation as in the panel: the messages, the agent turn live, which agents ' +
      'and subagents are running, the model and the spend. You can write, stop, queue a ' +
      'message while the agent is busy and attach files. Proposal cards are not shown — one ' +
      'line stands in for them. With another CLI active in the panel (Codex, Qwen Code and ' +
      'others) the project’s conversation list gets a «<CLI> conversations» block: a new ' +
      'conversation, the messages, «Pass into the answer» in the middle of an answer where ' +
      'the CLI can take it, a queue, the «The CLI asks for permission» card and a line saying how the CLI ' +
      'will treat edits. A conversation of a CLI that is not active in the panel is read-only. ' +
      'Once a turn has ended, «Restart in a clean session» sits under the messages — for Claude ' +
      'and for another CLI when the conversation was started in a project: as in the panel, the ' +
      'agent is first asked to update the checkpoint, and a fresh checkpoint starts the ' +
      'continuation as a new conversation right away, with the phone moving into it.',
    screenAgent: 'Agent',
    screenAgentText:
      'The panel agent: a request in words becomes an action in the panel. Anything that ' +
      'changes something arrives as a card and waits for your decision; the number on the tab ' +
      'is how many cards are waiting.',
    screenProjects: 'Projects',
    screenProjectsText:
      'The same projects as in the panel, with their chat count and what is running in them ' +
      'now. «+» on a card starts a new chat in the project, «Continue» opens the latest one. A ' +
      'tap on the card opens the project page: «Chats», «Git» and «Copies» tabs, «New chat» and ' +
      '«Code» buttons. Folders where the agent ran but which are not among the panel projects ' +
      'sit in the collapsed «From chat history» block — a folder can be added to the projects ' +
      'from there. The «Folders» tab is a disk browser: open any folder, start a chat in it or ' +
      'add it to the projects.',
    screenTests: 'Tests',
    screenTestsText:
      'Project cases by group with filters, case editing, a manual run step by step and the ' +
      'run history. The report, plans and environments stay in the panel.',
    screenAnalytics: 'Analytics',
    screenAnalyticsText:
      'Four tabs over one chosen period (today, 7/30/90 days, all time or your own dates): ' +
      '«Overview» — spend, tokens, requests, cache, charts by day and by hour; «Spend» — by ' +
      'model and project; «Tools» — tools and skills; «Sessions» — what is running now and the ' +
      'latest sessions.',
    screenSettings: 'Settings',
    screenSettingsText:
      'Split into tabs. «Link» — the selected computer (name, «online / not answering», address, ' +
      '«Rename», «Pair again», «Forget this computer»), the «Computers» list with selection and ' +
      '«Add a computer», «Power» of the selected computer and outside access. «Alerts» — enable on this phone, test, devices and «The agent on the ' +
      'computer» (the panel writes its hooks into the Claude Code ' +
      'settings itself; if they are still missing, the card shows the ready command for the ' +
      '«Hooks» section: PermissionRequest with timeout 3600, ' +
      'PostToolUse and Stop with timeout 10). «Contour» — its state and budget, read-only; the ' +
      'tab is absent while there are no contours. «General» — the app language and version.',

    computersTitle: 'Several computers',
    computersCaption:
      'The phone pairs with each computer separately and always works with one — the selected one.',
    computersColumn: 'Action',
    computersMeaningColumn: 'How it works',
    computersPair: 'Add',
    computersPairText:
      'Settings → «Link» → «Add a computer» and the code from that computer’s panel. The ' +
      'computer joins the list under the name it gives itself; the name on the phone can be ' +
      'changed («Rename») — the machine keeps its own.',
    computersSwitch: 'Select',
    computersSwitchText:
      'A row in the «Computers» list or a name in the row on top of Home (the row appears with ' +
      'two computers or more). Home, projects, chats, questions, tests and analytics switch to ' +
      'the selected one at once; each computer keeps its own open project and conversation.',
    computersRunning: 'Running work',
    computersRunningText:
      'Switching stops nothing: work runs on its own machine. The phone only detaches from it ' +
      'and picks up whatever runs on the selected one.',
    computersSame: 'Same computer, another address',
    computersSameText:
      'A computer is recognised by its machine number, not its address: paired again over ' +
      'Tailscale instead of the home network, it stays one row with your name and the new address.',
    computersForget: 'Forget',
    computersForgetText:
      '«Forget this computer» erases its address, token and open project from the phone. The ' +
      'first remaining one becomes selected.',

    powerTitle: 'Computer power from the phone',
    powerCaption:
      'Settings → «Link» → «Power»: put the selected computer to sleep. Its system decides what ' +
      'exactly is available.',
    powerColumn: 'System',
    powerMeaningColumn: 'What the button does',
    powerWindows: 'Windows',
    powerWindowsText:
      'Hibernate: everything open is saved to disk and the power goes off completely; the ' +
      'power button brings it back. With hibernation off in the system there is no button and ' +
      'the card names the command: powercfg /hibernate on in an administrator terminal. Sleep ' +
      'is not offered on Windows: the system has no standard sleep command, and the workaround ' +
      'call hibernates anyway while hibernation is on.',
    powerMac: 'macOS',
    powerMacText:
      'Sleep (pmset sleepnow). How deep it goes is decided by hibernatemode, which the card ' +
      'shows: 3 — the laptop default (a copy of memory on disk, survives a flat battery), 25 — ' +
      'true hibernation, 0 — sleep without a copy. Only the owner changes the mode: sudo pmset ' +
      '-a hibernatemode 25.',
    powerLinux: 'Linux',
    powerLinuxText:
      'Hibernate and sleep through systemd-logind (systemctl hibernate / suspend) — each only ' +
      'if the system allows it without a password. If it asks for an administrator password or ' +
      'there is no swap for hibernation, the row names the reason and there is no button. ' +
      'The panel never overrides the system’s own blocks (a package upgrade, a disk write): ' +
      'the computer stays awake and the refusal shows in the card.',
    powerOff: 'Power off completely',
    powerOffText:
      'Deliberately not offered: the phone cannot switch the computer back on, while hibernate ' +
      'and sleep at least keep everything open.',
    powerConfirm: 'Confirmation',
    powerConfirmText:
      'The button first opens a question with the computer’s name; the command leaves only ' +
      'after «Yes, do it». The panel waits two seconds so the answer reaches the phone and ' +
      'drops its own sleep block. If an agent is working, the question warns that sleep will ' +
      'stop it. Pressing again within half a minute does not queue a second command — ' +
      'otherwise the computer would hibernate again right after waking. A refusal by the ' +
      'system shows in the card the next time it opens.',

    offlineTitle: 'When the panel does not answer',
    offlineCaption:
      'The computer fell asleep, the panel is restarting, the phone is off the network. The ' +
      'app makes nothing up: what arrived before the break is shown, what did not is named.',
    offlineColumn: 'What happens',
    offlineMeaningColumn: 'What you see',
    offlineLast: 'Home and lists',
    offlineLastText:
      'The last thing that arrived stays, under the strip «The panel did not answer — showing ' +
      'the last data received». Pull the screen down to ask again. There is no copy of the ' +
      'data on the phone disk: restart the app without a connection and the screens are empty.',
    offlineStream: 'A running chat turn',
    offlineStreamText:
      'The turn stream reconnects by itself («Connection lost, reconnecting…») and resumes ' +
      'from the last event it received — nothing is lost and nothing repeats. A stream silent ' +
      'for more than 30 seconds counts as a break too. Once the attempts run out — «Lost the ' +
      'connection to the panel», and the conversation is re-read from the server when the ' +
      'panel answers again.',
    offlineAgent: 'A panel agent turn',
    offlineAgentText:
      'Sending the app to the background or losing the connection does not stop the turn: the ' +
      'agent finishes what it started on the computer, and the phone, back on screen, attaches ' +
      'to the turn again and draws what happened meanwhile. A turn with no phone waits ten ' +
      'minutes for it, then is stopped; what was said stays in «History». A finished turn hands ' +
      'its ending to the phone for one more minute, after that only «History» has it.',
    offlineQueue: 'A message while the agent is busy',
    offlineQueueText:
      'Goes to the agent at once: it reads it at its next step and carries on with the same ' +
      'turn. Offline, with an attachment or with another CLI it goes into a queue that is ' +
      'sent when the turn ends. The queue lives on the phone and ' +
      'survives an app restart, but only for 2 hours: anything older is dropped so that the ' +
      'agent does not receive something long out of date.',
    offlineAnswered: 'An answer to a question',
    offlineAnsweredText:
      'An accepted answer hides the card at once, before the server removes the question on ' +
      'its side. Not accepted — the card says «Not sent» with the reason, and the answer can ' +
      'be sent again.',
    offlinePush: 'Notifications',
    offlinePushText:
      'The panel sends them. If the panel is asleep nothing arrives, even if an agent is ' +
      'waiting somewhere. Tapping a notification opens its conversation: a Claude chat in its ' +
      'project, another CLI’s conversation on its own screen; a notification from another ' +
      'computer selects that computer first. The phone itself polls the ' +
      'computer in the background in one case only: you left an open conversation of another ' +
      'CLI in the middle of an answer — then the end of the answer and a permission request ' +
      'come as the phone’s own notification. Android 15 cuts the app’s connection a few ' +
      'seconds into the background, so this catches only a short answer; a long one only ' +
      'the panel’s notification does.',
    offlineAwake: 'Keeping the panel awake',
    offlineAwakeText:
      'The computer must not go to sleep, and the panel itself should not run unattended: the ' +
      'pnpm keepalive watchdog restarts a fallen half of the panel, pnpm keepalive:install ' +
      'starts it at sign-in.',

    notTitle: 'What the app is not',
    notCaption: 'Four expectations people usually bring to it the first time.',
    notColumn: 'Expectation',
    notMeaningColumn: 'What it actually is',
    notSecondPanel: 'A second panel in the pocket',
    notSecondPanelText:
      'No: rules, CLAUDE.md, skills, hooks, MCP, permissions, variables, groups and settings ' +
      'are edited only in the panel. The phone has what you need while work is running.',
    notOwnServer: 'Works on its own',
    notOwnServerText:
      'No: without a running panel on the computer the app has nowhere to go. It has no cloud ' +
      'server of its own and will not have one — a decision, not a gap.',
    notCloud: 'A cloud service',
    notCloudText:
      'No: requests travel over your Tailscale network straight to your machine. Only ' +
      'notifications leave it, to the Expo service — the event kind, the project folder name ' +
      'and a random machine number (the phone tells by it which computer the notification is ' +
      'from; the machine name does not leave).',
    notKeys: 'A place for keys',
    notKeysText:
      'No: the contour key, MCP secrets and integration tokens are entered only in the panel ' +
      'on your own machine. The phone shows the contour state but never sees or accepts the ' +
      'key.',

    storageTitle: 'Where it lives',
    storageCaption: 'What appears on the computer and on the phone after pairing.',
    storagePanelToken: 'Panel token',
    storagePanelTokenValue: '~/.agentdeck/api-token (mode 0600, never in backups)',
    storageSettings: 'Access settings',
    storageSettingsValue: 'state.json → remoteAccess: on or off, outside address, notifications',
    storageDevices: 'Paired devices',
    storageDevicesValue: 'state.json → push tokens of the phones that allowed notifications',
    storageMachine: 'Machine number',
    storageMachineValue:
      '~/.agentdeck/machine-id — random, created on the first request; does not move with a settings transfer',
    storagePhone: 'On the phone',
    storagePhoneValue:
      'The computer list, the address and token of each — in the system secure storage; ' +
      'language, the message queue and the open project of each computer — in the app storage',
    storageNever: 'Stored nowhere',
    storageNeverValue:
      'Copies of conversations, code and project files: the phone reads them from the panel ' +
      'every time',

    limitsTitle: 'Limits',
    limitsCaption: 'What does not work today and why — so you do not find out on the go.',
    limitsColumn: 'Limit',
    limitsMeaningColumn: 'What it means',
    limitAndroid: 'Android only',
    limitAndroidText:
      'The ready build is an Android APK: the button in Settings → «Phone» or pnpm mobile:apk ' +
      'puts it in the repository root, from where it is installed over adb or downloaded. No ' +
      'iPhone build ships with it.',
    limitTailscale: 'Tailscale on both devices',
    limitTailscaleText:
      'The phone and the computer must be on the same tailnet, with HTTPS Certificates turned ' +
      'on in its admin console: without a certificate tailscale serve will not come up on 443.',
    limitOneToken: 'One token for everyone',
    limitOneTokenText:
      'The panel has one token. «Rotate token» disconnects every paired phone at once — ' +
      'unpairing one while keeping the others is possible only for notifications.',
    limitPushLang: 'Notifications in Russian',
    limitPushLangText:
      'The panel composes the notification title, and for now only in Russian — whatever the ' +
      'app language.',
    limitPushExpo: 'Notifications need Expo',
    limitPushExpoText:
      'Delivery is done by the Expo service; the build needs an EAS projectId. Without it the ' +
      'app works but notifications do not, and the settings say why.',
    limitCards: 'No proposal cards',
    limitCardsText:
      'A task split, skill and group proposals appear in the phone chat as one line. They can ' +
      'be accepted only in the panel.',
    limitTheme: 'One theme',
    limitThemeText: 'The app is always dark: it has no theme switch.',

    refusalsTitle: 'Refusals word for word',
    refusalsCaption: 'What the screen says and what to do about it.',
    refusalsColumn: 'Text',
    refusalsMeaningColumn: 'Cause and way out',
    refusalToken: '«The token was rejected — pair the app again»',
    refusalTokenText:
      'The panel answered 401: the token was changed with «Rotate token» or typed with a ' +
      'mistake. Settings → «Pair again» and a fresh code from the «Remote access» card.',
    refusalSilent: '«not answering» / «The panel’s server is unreachable»',
    refusalSilentText:
      'The request did not reach the panel: the computer is asleep, the panel is not running, ' +
      'Tailscale is off on one of the devices or tailscale serve is not running (pnpm remote).',
    refusalNotCode: '«This is not the panel’s code»',
    refusalNotCodeText:
      'The camera read someone else’s QR code. Point it at the code from the «Remote access» ' +
      'card.',
    refusalAddress: '«The panel address is required»',
    refusalAddressText:
      'The address field is empty. The address is the one the panel card shows as «Outside ' +
      'address».',
    refusalNoTailscale: '«Tailscale was not found on the machine»',
    refusalNoTailscaleText:
      'The computer has no Tailscale or it is not signed in — the panel has no outside ' +
      'address, and there is nothing to pair with.',
    refusalPush: '«Notifications are blocked in the system settings»',
    refusalPushText:
      'The notification permission was declined. Allow it in the Android settings for the app ' +
      'and press «Enable on this phone» again.',

    warnTitle: 'The token opens the whole panel API',
    warnText:
      'It reads secrets, edits hooks and starts the agent — it is not a password to one ' +
      'section. Do not show the QR code to anyone and do not forward it. Lost the phone? ' +
      '«Rotate token» in the panel: the old one stops working at once.',

    guide: {
      pairTitle: 'Path 1. Pair the phone',
      pairCaption:
        'Once per phone. The panel is already running on the computer, Tailscale is installed ' +
        'on both devices, pnpm remote has been run.',
      pairOff: 'The «Remote access» card',
      pairOffText:
        'Settings → «Access» tab. While the switch is off, only this machine can reach the API. ' +
        'The panel found the outside address in Tailscale by itself — it is hidden in the ' +
        'frame; yours will show your machine name.',
      pairOn: 'Turn on «Require a token»',
      pairOnText:
        'From now on every request must carry the token — from the phone and from the browser ' +
        'on this same computer (the panel hands the token to the browser itself, nothing to do).',
      pairCode: 'Show the pairing code',
      pairCodeText:
        'The QR code carries the address and the token; under it is the same token as text in ' +
        'case the camera is not allowed. In this help the code is blurred and the token hidden: ' +
        'it is a key to the whole API.',
      pairPhone: 'On the phone: Settings → «Pair»',
      pairPhoneText:
        'Until the app is paired, every tab says «Panel is not connected» and leads here.',
      pairScreen: 'Point the camera or type it in',
      pairScreenText:
        'The camera reads the code and connects by itself. Without a camera — the address and ' +
        'token in the «Or by hand» fields and «Connect». The address here is the emulator’s ' +
        'service address; yours will be the machine’s https address in Tailscale.',
      pairOnline: 'Done: «online»',
      pairOnlineText:
        'The address and token went into the phone secure storage, and the computer joined the ' +
        'list under the name it gives itself (here «desk»). Further down the «Link» tab: the ' +
        '«Computers» list (the next one is added the same way, with the code from its panel), ' +
        '«Power» and outside access; notifications, the contour and the language are on the ' +
        'neighbouring tabs.',
      pairPower: '«Power»: a question first',
      pairPowerText:
        'The «Hibernate» button (on a Mac or Linux «Sleep», when the system offers it) does ' +
        'nothing at once: a question opens with the computer’s name and a warning that the ' +
        'phone cannot switch it back on. The command leaves only after «Yes, do it».',

      dayTitle: 'Path 2. An ordinary day with the phone',
      dayCaption:
        'The agent works in a project, you are away from the desk. Every frame is taken from ' +
        'the real app connected to a throwaway panel.',
      dayHome: 'Home: what is running and who is waiting',
      dayHomeText:
        'On top, a summary: how many are running, how many need you, in how many projects. ' +
        'Below, conversations by project: «working», «needs you» or «quiet», how long ago and how ' +
        'many answers are waiting. The number on the «Home» tab is every waiting answer across ' +
        'all projects.',
      dayQuestions: 'Questions: answer without opening the chat',
      dayQuestionsText:
        'One card per chat, one question at a time. The choice goes out as one message with ' +
        'all answers of that chat; a permission — with «Allow» and «Deny».',
      dayChat: 'Chat: the same conversation as at the desk',
      dayChatText:
        'The messages, the agent question right in the feed and the input field. While the ' +
        'agent is busy, what you write goes to it at once and is taken into account at its ' +
        'next step, without waiting for the turn to end.',
      dayAgent: 'The panel agent',
      dayAgentText:
        'A request in words becomes an action in the panel. Changes wait for your decision as a ' +
        'card; the conversation history and the action trail are here too.',
      dayProjects: 'Projects',
      dayProjectsText:
        'Panel projects with their chat count: «+» starts a new chat in the project, «Continue» ' +
        'returns to the latest one, a tap on the card opens the project page with its chats, ' +
        'git and copies.',
      dayTests: 'Project tests',
      dayTestsText:
        'Cases by group, statuses of the last run, filters. A manual step-by-step run and the ' +
        'run history start here too.',
      dayAnalytics: 'Analytics',
      dayAnalyticsText:
        'The same numbers as in the panel, split into «Overview», «Spend», «Tools» and ' +
        '«Sessions» tabs. The dollar amount is an estimate at API rates, not a bill.',

      offTitle: 'Path 3. The panel does not answer',
      offCaption:
        'These frames were taken after the throwaway panel was stopped: this is what a sleeping ' +
        'computer or a switched-off Tailscale looks like.',
      offHome: 'Home keeps the last data',
      offHomeText:
        'The strip «The panel did not answer — showing the last data received», and under it ' +
        'what was there before the break. Pull down once the connection is back.',
      offSettings: 'Settings: «not answering»',
      offSettingsText:
        'Settings ask the panel again every 15 seconds: if it is silent, «not answering» shows ' +
        'within half a minute, no need to pull the screen. The address is in place, the connection is not. No need to pair again: as ' +
        'soon as the panel wakes up, the app carries on by itself.',
    },
  },

  shots: {
    pair: {
      '01-remote-off':
        'The «Remote access» card is off: the outside address was found in Tailscale, «Require a token» is unchecked',
      '02-remote-on': '«Require a token» is on — the card is marked «on»',
      '03-pairing-code':
        'Pairing code: a QR with the address and token (blurred in this help), the token text hidden',
      '04-phone-not-paired': 'App settings before pairing: «Not connected» and «Pair»',
      '05-phone-pair-screen':
        'The «Connecting» screen: the camera for the panel code and the «Or by hand» fields — address and token',
      '06-phone-online':
        'After «Connect»: the «Link» tab — computer «desk» online, its address and the «Computers» list',
      '07-phone-power-confirm':
        '«Power»: the question «Put “desk” to hibernate?» with a warning and the buttons «Yes, do it» and «Cancel»',
    },
    day: {
      '01-home':
        'Home, «Projects & chats»: the summary on top, project conversations below — working, waiting for you',
      '02-questions': 'Home, «Questions»: a chat card with the agent question and answer options',
      '03-chat': 'Chat on the phone: messages, the agent question in the feed and the input field',
      '04-agent': 'The «Agent» tab: a conversation with the panel agent, «History» and «Trail»',
      '05-projects': 'The «Projects» tab: project cards with their chat count, «+» and «Continue»',
      '06-tests': 'Project tests: cases by group and statuses of the last run',
      '07-analytics':
        'The «Analytics» tab, «Overview»: spend, tokens, requests, cache and the chart by day',
    },
    offline: {
      '01-home-silent': 'The panel is stopped: home shows the last data received and says so',
      '02-settings-silent':
        'Settings: computer «desk» and its address are in place, the connection «not answering», no «Power» card',
    },
  },

  diagrams: {
    'phone-path':
      'Phone → Tailscale → panel server on 127.0.0.1 → Claude Code; the token, notifications via Expo and what is stored where',
  },
};
