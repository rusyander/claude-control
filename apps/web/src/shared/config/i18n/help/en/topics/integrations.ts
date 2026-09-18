import type { integrationsRu } from '../../ru/topics/integrations';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const integrationsEn: typeof integrationsRu = {
  topic: {
    title: 'Integrations',
    summary: 'Jira, Confluence, a token forge, Telegram, test management and CI reports',
    lead:
      'The panel can already run tests, but everything it produced stayed on this ' +
      'machine: defects needed gh or glab on PATH, reports were files, and requirements ' +
      'lived in a Confluence neither the human nor the agent could see from here. ' +
      'Integrations give the panel ONE credential per external system — and the human in ' +
      'the interface and the agent over MCP then work through the same code path.',

    whyOne: 'One credential per system',
    whyOneText:
      'The token is entered once, in the connector card. From then on the panel buttons ' +
      'and the agent both use it — except the agent never gets the token itself, only ' +
      'the panel’s own MCP server, which goes outside on its behalf.',
    whyBoth: 'Cloud and self-hosted alike',
    whyBothText:
      'Which Atlassian is on the other end is detected by a live check and remembered: ' +
      'the cloud takes Basic auth with an email, Server/DC takes a Bearer token, and ' +
      'their API paths differ. None of that has to be chosen by hand.',
    whySecret: 'The secret is never shown and never forwarded',
    whySecretText:
      'The token is stored encrypted on this machine. What leaves it — in a response, a ' +
      'log or an MCP config — is only a mask like abc…4f21, enough for the owner to ' +
      'recognise their key without seeing it.',

    stepsTitle: 'How to connect',
    stepsCaption: 'The Integrations tab in settings, six cards in one column.',
    step1: 'Fill in the address and account details',
    step1Text:
      'For Atlassian that is the site address and an email (cloud only), for the forge — ' +
      'its kind and repository, for Telegram — the chat id. A missing required field is ' +
      'named under the card, and the connector cannot be switched on until it is filled.',
    step2: 'Paste the token and save',
    step2Text:
      'The token field is always empty: the server never hands the value back. Empty is ' +
      'what it sends, and that means “keep the current one”. Replace a key by typing a ' +
      'new one; drop it with “Forget the key” (which also switches the card off).',
    step3: 'Press “Check connection”',
    step3Text:
      'The only honest answer to “does it work”: the settings can be perfect while the ' +
      'token has already been revoked. The result stays in the card — who you are signed ' +
      'in as, cloud or self-hosted, and when it was checked.',
    step4: 'Attach a project',
    step4Text:
      'The Testing section and the project card carry an “Attach” button: a Jira issue, ' +
      'the Confluence page with the requirements, the project new defects go into. This ' +
      'is exactly what reaches the agent as a line in its task — it cannot know it itself.',

    cardsTitle: 'The six connectors',
    cardsCaption: 'Each is enabled separately; a disabled one gets in nobody’s way.',
    cardsHeader: 'Connector',
    cardsWhat: 'What it gives',
    cardAtlassian: 'Atlassian',
    cardAtlassianText:
      'Searching Jira issues and Confluence pages, reading requirements, filing defects, ' +
      'publishing a run report as a page or a comment.',
    cardForge: 'Token forge',
    cardForgeText:
      'GitHub or GitLab without gh and glab installed: a defect, a comment, an MR linked ' +
      'to a run. Installed CLIs stay as the fallback.',
    cardTelegram: 'Telegram',
    cardTelegramText:
      'A message when a run ends, fails, asks for permission, asks a question, or a test ' +
      'fails. Off by default; sending never delays the work itself.',
    cardWebhook: 'Webhook',
    cardWebhookText:
      'The same events at an address of your own: one POST with JSON. It covers Slack, ' +
      'Mattermost, an on-call bot and an internal bus at once — the panel needs to know ' +
      'none of them. With a secret set, the body is signed.',
    cardTms: 'Test management',
    cardTmsText:
      'Zephyr Scale, Xray or Test IT: pull cases into a panel group and push a run. Test IT ' +
      'has its own URL — it is a company installation, not a cloud. The source of truth for ' +
      'cases stays there, not in the panel, and pushing the same run again lands in the same ' +
      'run instead of creating a second one — even if the previous push broke off midway. ' +
      'The Test IT URL is required: without it the card can neither be enabled nor saved ' +
      'while enabled.',
    cardCi: 'CI',
    cardCiText:
      'The last build’s report is fetched by token and goes into the same results import ' +
      'as a file picked by hand.',

    linksTitle: 'What an attachment holds',
    linksCaption:
      'The project has one, and every test group has its own on top: the “Payments” set ' +
      'is tracked in one epic, “Profile” in another.',
    fieldIssue: 'The issue or epic the work belongs to. Shown as a link.',
    fieldProject: 'The Jira project NEW defects are filed into.',
    fieldPage: 'A Confluence page: both the requirements and the place for the report.',
    fieldRepo: 'The forge repository, when it cannot be derived from the project origin.',
    fieldNote: 'A human note: what exactly lives here.',

    testsTitle: 'What appears in Testing',
    testsCaption: 'An attached project changes six places in the Testing section.',
    testsDefect: 'Choosing a defect target',
    testsDefectText:
      'In the defect window the list of targets comes from the server: Jira, the token ' +
      'forge, gh, glab. With no target at all the draft is still assembled, and a button ' +
      'copies it.',
    testsDefectState: 'What became of a filed defect',
    testsDefectStateText:
      'The “Check defects” button asks the tracker whether the issues attached to red ' +
      'cases are closed and shows the “recheck” list. The case status does not change: ' +
      'the tracker answers “was it fixed”, not “does it work”.',
    testsCoverage: 'Requirements in the coverage matrix',
    testsCoverageText:
      'A connected Jira brings issues nobody linked a case to into the matrix — the real ' +
      'holes. Without it only what is already linked is visible: requirements from case ' +
      'links are enough for “what is tested”, never for “what is untested at all”.',
    testsPublish: 'Publishing a report',
    testsPublishText:
      'Inside an expanded run record: pick the system and press. Where exactly to write ' +
      'is decided by the attachment, and the answer carries the address — so you can see ' +
      'whether a page was updated or a new one created.',
    testsPdf: 'A run as PDF',
    testsPdfText:
      'Next to md and csv. It is rendered by a browser found on this machine; with no ' +
      'browser the panel answers with an honest refusal naming what to install, rather ' +
      'than a broken file.',
    testsBaseline: 'Comparing against a baseline',
    testsBaselineText:
      'A result with screenshots carries a compare button: before, after and the diff ' +
      'side by side. A baseline is only ever accepted by hand — accepting automatically ' +
      'turns the comparison into its own absence.',

    filesTitle: 'Exact paths',
    filesCaption:
      'Settings are visible, the secret is not; everything about cases lives in the ' +
      'tested project itself.',
    filePanelTitle: 'The panel',
    fileSettings: 'Connector settings and attachments',
    fileToken: 'Tokens (encrypted)',
    fileProjectTitle: 'The tested project',
    fileBaselines: 'Baseline screenshots',
    fileAttachments: 'Run screenshots',

    noteTokenTitle: 'The token never leaves',
    noteTokenText:
      'Not in an API response, not in a log, not in a prompt, not in an MCP config. The ' +
      'agent reaches Jira through the panel’s own MCP server, and that server through the ' +
      'panel’s own API; the key itself is never handed to the CLI process.',
    noteWritesTitle: 'The agent writes outward on its own through MCP',
    noteWritesText:
      'Reads are free: searching issues, reading a page. An agent with Atlassian MCP ' +
      'connected is allowed four writes — create a Jira issue, comment on an issue, create ' +
      'a Confluence page and overwrite the body of an existing one. The last two are held ' +
      'back only by the tool description (“only when the human asks directly”), not by the ' +
      'panel: the server cannot tell an agent call from a button press. The agent has no ' +
      'issue transition. Nothing is ever deleted.',
    noteOfflineTitle: 'A dead integration stops nothing',
    noteOfflineText:
      'Every outward request waits at most 15 seconds; there is one retry, and only when ' +
      'the service answered 429, 502 or 503 — a dropped connection is not retried. No answer is a state ' +
      'of the card with a human reason, not a crash: neither a test run, nor a ' +
      'conversation, nor the panel’s startup suffers for it.',
    noteMcpTitle: 'The MCP server is registered by hand',
    noteMcpText:
      'The button in the Atlassian card adds the server as an ordinary one, with a health ' +
      'probe — into the ACTIVE CLI’s MCP configuration, not always into Claude Code’s. A ' +
      'CLI with no MCP section at all gets a refusal that names it: writing into someone ' +
      'else’s file would read as success while the agent gained no tool. After that the ' +
      'panel enables the server itself when a run starts in an attached project, but it ' +
      'never disables anything — switching off stays yours.',
    noteSignatureTitle: 'The webhook signature',
    noteSignatureText:
      'With a secret set, X-AgentDeck-Signature carries an HMAC-SHA256 of the body in ' +
      'hex: the receiver verifies exactly what arrived. The same HMAC also goes in a ' +
      'second header under the product’s former name, so a receiver set up before the ' +
      'rename keeps verifying without edits. With no secret we send unsigned — ' +
      'an internal bus usually expects nothing else, and demanding a key where there is ' +
      'none to be had means turning notifications off altogether.',

    guideTitle: 'What this document holds',
    guideText:
      'A diagram of who calls whom; two paths split by entry — after external context ' +
      '(Jira, Confluence, a forge) and after a notification (a webhook, Telegram); what ' +
      'the tab is NOT; what it writes on disk; tables of cards, links and refusals.',

    wireMapTitle: 'Who calls whom',
    wireMapCaption:
      'Three different directions share one tab, and confusing them is expensive: the ' +
      'panel fetches context itself, hands results over on a button, and pushes ' +
      'notifications as events.',
    pathTextTitle: 'The same path in words',
    pathTextText:
      'It is the panel’s SERVER that goes outside, not the browser and not the agent: the ' +
      'token never leaves the encrypted store and reaches neither a prompt nor a CLI ' +
      'config. The agent gets access to Jira and Confluence only through the separate ' +
      '“Connect Atlassian MCP” button — and then travels through the panel’s proxy, still ' +
      'holding no key. Notifications run the other way: the panel itself POSTs to your ' +
      'address or messages Telegram, and only the event header goes out.',

    guide: {
      contextTitle: 'Path: connect Jira, Confluence and a forge',
      contextCaption:
        'Settings → the “Integrations” tab. Six frames: the empty cards, filling one in, ' +
        'the live check, access for the agent, a self-hosted forge and “forget the key”.',
      contextCards: '1. Six cards, none of them on',
      contextCardsText:
        'Until asked, the panel stays a local application: no integration is enabled and ' +
        'nothing goes outside. The cards differ by purpose — where requirements come ' +
        'from, where defects are filed, where run news is written.',
      contextFilled: '2. Filling in: one field is required, the rest depend',
      contextFilledText:
        'Without the site address the connector cannot be enabled, and the card says so. ' +
        'Email is for cloud only: there the key works paired with it, on Server/DC the ' +
        'field stays empty. “Deployment” still reads “not chosen” — the live check will ' +
        'decide. The token goes into the encrypted store and never returns to the screen.',
      contextChecked: '3. The connection check answers with a fact',
      contextCheckedText:
        'The panel asks Jira “who am I” — cheap and harmless. The card gains “connected”, ' +
        'the detected dialect (“cloud”) and the account name; the token is shown as a stub ' +
        'like atl…42a0. The dialect is remembered: cloud and Server/DC have different ' +
        'paths, and getting it wrong returns 404 on a perfectly good key.',
      contextMcp: '4. The same data for the agent, behind its own button',
      contextMcpText:
        'The “Connect Atlassian MCP” button adds the server to the MCP section like any ' +
        'other, with a health probe. The agent still holds no key: the proxy calls the ' +
        'panel, and the panel calls Atlassian. Removing it happens where any server is.',
      contextForge: '5. A forge by token — without gh or glab installed',
      contextForgeText:
        'The card exists for places where the forge CLI cannot be installed. The ' +
        'installation address is set for a self-hosted GitLab; the repository may be left ' +
        'out — it is then derived from the checked project’s origin. After the check the ' +
        'card keeps the bot name and the time.',
      contextForgotten: '6. “Forget the key” erases the key and switches the card off',
      contextForgottenText:
        'The button erases the key and the check result and also switches the integration ' +
        'off: without a key there is no point in it being on. The address, the system and ' +
        'the repository stay, and the card returns to “not checked” and “no key yet”. To ' +
        'bring it back, type a key and turn the toggle on again.',

      notifyTitle: 'Path: get notifications without giving away too much',
      notifyCaption:
        'The same tab, a different question: not “what will the panel fetch” but “what ' +
        'goes out”. Four frames: receiver and signature, the check, picking events, Telegram.',
      notifyWebhook: '1. The receiver address and the signing secret',
      notifyWebhookText:
        'A webhook is one POST with JSON: Slack, Mattermost, an on-call bot, an internal ' +
        'bus. The secret field here is not an access token but a signing key, and the hint ' +
        'says so. Next to it is the list of what actually goes out: the event kind, the ' +
        'text and the project folder name — no prompt, no agent reply, no paths.',
      notifyChecked: '2. The check is a real send',
      notifyCheckedText:
        'You cannot ask an arbitrary address “who am I”, so the check sends a real event ' +
        'of kind test — that is how the receiver tells it from a live one. The panel ' +
        'retells the answer in words and adds whether the body was signed.',
      notifyEvents: '3. What to write about is picked with checkboxes',
      notifyEventsText:
        'Five events: run finished, run failed, case failed, agent asks for permission, ' +
        'agent asked a question. The list is shared by the webhook and Telegram, but each ' +
        'card ticks its own — an on-call bot usually wants failures only.',
      notifyTelegram: '4. Telegram: the bot must be in the chat',
      notifyTelegramText:
        'The chat is set by numeric id or @channel name, the token comes from @BotFather. ' +
        'The commonest cause of silence is a bot that was never added to the chat: the ' +
        'panel sends, Telegram refuses, and the refusal shows on the card.',
    },

    notTitle: 'What this tab is not',
    notCaption: 'Five expectations it does not meet, every one of them on purpose.',
    notColumn: 'Not here',
    notMeaningColumn: 'How it actually works',
    notSync: 'Not a sync',
    notSyncText:
      'The panel pulls nothing in the background and keeps no copy of your issues. A ' +
      'request goes out when the screen that shows it is open, or a button is pressed.',
    notAuto: 'Not auto-publishing',
    notAutoText:
      'From the panel a defect, a report or a comment leaves only on a click. An agent ' +
      'with Atlassian MCP connected writes on its own — see “The agent writes outward on ' +
      'its own through MCP”. A disabled integration greys the button out together with ' +
      'the reason, rather than failing silently.',
    notAgentKey: 'Not a key for the agent',
    notAgentKeyText:
      'The token lives in the panel. The agent gets access through its own button and ' +
      'travels via the panel’s proxy — no key in its prompt or its configuration.',
    notDelete: 'Not a deletion tool',
    notDeleteText:
      'The panel deletes nothing in Jira or Confluence and merges nothing in a forge. ' +
      'Everything it can do outward is create, comment and overwrite a Confluence page body.',
    notBlocker: 'Not a reason to stop',
    notBlockerText:
      'A dead integration breaks neither a test run, nor a conversation, nor the panel’s ' +
      'start: the refusal shows as card state and work goes on.',

    storageSettings: 'Card settings',
    storageSettingsValue: 'agentdeck/state.json → integrations (addresses, deployment, events)',
    storageTokens: 'Tokens',
    storageTokensValue: 'agentdeck/provider-keys.enc, keys int:<id> (AES-256-GCM)',
    storageHealth: 'Check verdicts',
    storageHealthValue: 'agentdeck/state.json → integrationHealth (state, reason, account)',
    storageLinks: 'Project links',
    storageLinksValue: 'agentdeck/state.json → keyed by the normalised project path',
    storageMcp: 'The “Connect MCP” button',
    storageMcpValue:
      'the active CLI’s MCP configuration; for Claude Code that is .claude.json next to the configuration directory',

    canCheck: 'Check the connection and show which account the panel signed in as',
    canDetect: 'Detect cloud or Server/DC by a live probe and remember the answer',
    canMcp: 'Hand the same access to the agent through a proxy, without giving it the key',
    canNotify: 'Push events to your own address and to Telegram, as picked',
    canSign: 'Sign the webhook body with HMAC-SHA256 when a secret is set',
    canForget: 'Forget the key: token erased, card switched off, address and other fields kept',
    cantSso: 'Sign in via SSO or a password: integrations work by token only',
    cantDelete: 'Delete or close anything in an external system',
    cantBackground: 'Poll external systems in the background with no screen open',
    cantSendBody: 'Send out a prompt, an agent reply or file paths',
    cantAddBot: 'Add the bot to your Telegram chat for you',

    refusalsTitle: 'Refusals and what they mean',
    refusalsCaption: 'Exactly what the panel shows, and what to do about it.',
    refusalsColumn: 'What is shown',
    refusalsMeaningColumn: 'Reason and way out',
    refusalNotConnected: '“… is not connected: enable it and save a token”',
    refusalNotConnectedText:
      'A 404, not a 502: this is not a connectivity failure but a card that is off or ' +
      'unfilled. The agent gets the same sentence through the MCP proxy.',
    refusalNoToken: '“The token is not saved”',
    refusalNoTokenText:
      'The check refuses BEFORE any outbound request — the panel does not go online ' +
      'without a key. The webhook is the exception: its signing secret is optional.',
    refusalNoBaseUrl: '“Without this field the connector cannot be enabled”',
    refusalNoBaseUrlText:
      'The site address is the only mandatory field on the Atlassian card. Without it ' +
      'there is nothing to build a request from.',
    refusalWrongDialect: 'A 404 with a perfectly good token',
    refusalWrongDialectText:
      'Usually the deployment kind is wrong: cloud and Server/DC have different paths to ' +
      'Confluence. Press “Check connection” — the dialect is probed and remembered.',
    refusalForge401: 'A 401 from the forge',
    refusalForge401Text:
      'The token belongs to another installation or lacks the right scope. GitHub wants ' +
      'access to issues, GitLab the api scope.',
    refusalTelegramChat: 'Telegram refuses the test message',
    refusalTelegramChatText:
      'Most often the bot was never added to the chat, or the id has a typo. The panel ' +
      'shows Telegram’s answer as it came instead of hiding it behind a generic failure.',
  },

  shots: {
    atlassian: {
      '01-cards': 'The whole “Integrations” tab: six cards, none enabled, nothing going outside',
      '02-filled':
        'The filled Atlassian card: the address is required, email is cloud-only, deployment not chosen yet',
      '03-checked':
        'After the check: “connected”, the detected “cloud”, the account name and the key stub atl…42a0',
      '04-mcp':
        'The MCP section after the button: agentdeck-atlassian added like any other server, with a probe',
      '05-forge':
        'A forge by token: a self-hosted GitLab, “Signed in as qa-release-bot” and the check time',
      '06-forgotten':
        'After “Forget the key”: address and repository kept, no key, toggle off, state back to “not checked”',
    },
    notify: {
      '01-webhook':
        'The webhook card: the receiver address, five events and a signing secret — not an access token',
      '02-webhook-checked':
        'Checking the webhook is a real send: “The receiver answered the test event (body signed)”',
      '03-events':
        'Picking events: a permission request added to the failures — each card ticks its own list',
      '04-telegram':
        'The Telegram card: chat by @name, a token from @BotFather, a reminder to add the bot to the chat',
    },
  },

  diagrams: {
    'who-calls-whom':
      'The tab’s three directions: the panel fetches context, hands results over on a button, and pushes events outward',
  },
};
