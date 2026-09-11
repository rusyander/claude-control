import type { platformRu } from '../../ru/topics/platform';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const platformEn: typeof platformRu = {
  topic: {
    title: 'Contour',
    summary:
      'A corporate platform behind one key: the whole path in screenshots and an honest ' +
      'list of what it does differently',
    lead:
      'A contour is the company’s platform the panel talks to with a corporate key: its ' +
      'models, embeddings and agents. The key stays in the panel and CLIs are pointed at its ' +
      'local gateway — otherwise a corporate key would have to be spread across nine CLI ' +
      'configs, from where it can never be recalled. The platform is somebody else’s, and ' +
      'some of its properties cannot be worked around: every such place is named here as a ' +
      'signed compromise, with a condition for revisiting it.',

    guideTitle: 'How this page is laid out',
    guideText:
      'First three diagrams for the whole path. Then eighteen steps with real screenshots: ' +
      'the contour admin first, the panel second — from “nothing here yet” to the first ' +
      'answer from a model. And only after that the design of the section, its states, its ' +
      'limits and its refusals. If the contour is already connected and you need one fact, ' +
      'scroll straight to “What the section shows”.',

    whyKey: 'The key never leaves the panel',
    whyKeyText:
      'Not in an API response, not in a prompt, not in a log, not in any CLI config, not in ' +
      'the environment of a running agent — only a mask goes out, and the key variable gets a ' +
      'placeholder the gateway substitutes for the real one. The price of that decision is ' +
      'signed too: with the panel off, CLIs pointed at the gateway are left without a model.',
    whySigned: 'A workaround without a signature fails the build',
    whySignedText:
      'Every workaround carries a comment in the code, a row in the registry, texts in both ' +
      'languages and a mark next to the thing it explains. The check compares those sets: ' +
      'none of them can appear or vanish quietly.',
    whyProbe: 'Nothing is promised beyond what was verified',
    whyProbeText:
      'A capability the panel has not confirmed by a probe or a live call is shown as “not ' +
      'declared”, never as a tick. A capability guessed from a host name is a promise with ' +
      'nothing behind it.',

    screenTitle: 'What the section shows',
    screenCaption:
      'The blocks of the card, top to bottom. None of them is drawn from a guess: everything ' +
      'written there comes from the panel’s answer about your contour.',
    screenColumn: 'Block',
    screenPurposeColumn: 'What is in it',
    screenCard: 'Contour card',
    screenCardText:
      'Name, address, connection state and the date of the last probe. “Not answering” and ' +
      '“never answered” are different lines: the first carries the date of the last successful ' +
      'probe next to it, the second has no date at all.',
    screenMatrix: 'What is available',
    screenMatrixText:
      'Seven capabilities of the contour: models, chat models, embeddings, platform agents, ' +
      'content checks, company knowledge, own tools. The state is “yes”, “indirect”, “no” or ' +
      '“not declared”, and next to it stands where it came from: confirmed by a probe or ' +
      'declared as a property of the platform.',
    screenSmoke: 'Test request',
    screenSmokeText:
      'The result of the last activation: the model’s answer in quotes, the latency and the ' +
      'model name. It goes through the panel’s OWN gateway — the very path a CLI takes — and ' +
      'so it disagrees with the probe more often than one would think: a live contour with the ' +
      'gateway down gives a green probe and a red test request. This is the line that explains ' +
      'why a CLI “sees no models”.',
    screenApplied: 'Applied to',
    screenAppliedText:
      'One row per consumer — the panel’s assistant and nine CLIs. Check mark: works fully. ' +
      'Triangle: works as a chat without tools. Circle: can be applied. Dash: unavailable, and ' +
      'the reason is spelled out — no environment file, no documented address variable, a ' +
      'foreign dialect, a gateway that is down.',
    screenJournal: 'Apply journal',
    screenJournalText:
      'One entry is one target, with its date and its own rollback button. A rollback removes ' +
      'that row and returns the previous values to the file; the other targets stay on the ' +
      'contour. The file edits themselves, with the before copies, live in the History section.',
    screenBudget: 'Budget',
    screenBudgetText:
      'The figure from the contour’s admin panel, typed by hand: the platform exposes no route ' +
      'for the remaining balance. Zero means “do not track” — then the card carries no bar, ' +
      'while the spend is still shown. The period is counted from the day you name next to it: ' +
      'when the contour resets its own counter is not visible from outside. At 85% the card ' +
      'warns in words and figures, not by the bar’s colour alone, and the same warning ' +
      'reaches the overview — before the refusal, not after. The budget is a number: write ' +
      'a fraction with a dot or a comma.',
    screenSpend: 'Spend',
    screenSpendText:
      'One figure, and it is an ESTIMATE — money by our own price book, carrying the “≈” sign. ' +
      'A second one used to stand here, the contour’s “own internal unit” (total tokens × ' +
      '$0.00001); that formula no longer exists on the platform — it charges by its own model ' +
      'registry, input and output tokens priced apart — and showing it would pass our number ' +
      'off as theirs. The rule is now shared: tokens of a model whose price we do not know are ' +
      'not converted into money at all (the platform does not charge for them either), and the ' +
      'model is named — you type its price by hand in settings. What differs is not the rule ' +
      'but the price book: their registry against ours. So our figure estimates theirs, and is ' +
      'worth reconciling with the admin panel as an order of magnitude, not to the cent.',
    screenExhausted: 'Refused on a spend limit',
    screenExhaustedText:
      'A 402 is a fact, but NOT about your key’s budget. The platform issues it from three ' +
      'other levels: a user’s daily limit, a team’s monthly one and the instance’s monthly ' +
      'one; which one is named in the line itself. The key’s own budget is checked while the ' +
      'key is parsed, and an exhausted one comes back as 401 — the same code as an unknown or ' +
      'revoked key, an expired one, a key whose owner was deleted and a failed owner check, ' +
      'with nothing outside to tell those five apart. That is why on a 401 the panel names all ' +
      'five causes instead of advising ' +
      'you to reissue the key. The 402 line survives a panel ' +
      'restart and clears only through your button: dropping a fact on a guess would hand back ' +
      'a cheerful “there is room” where the platform already refuses.',

    driftTitle: 'A file edited after the apply is left alone by the rollback',
    driftText:
      'At the moment of writing the panel remembers the file’s fingerprint. If the file was ' +
      'edited afterwards — by your own hand or by another tool — the journal row says so, and ' +
      'the rollback leaves that file as it is. Writing the “previous” value over someone ' +
      'else’s edit would erase it.',

    wizardRequired: 'The “required” mode shows its price before it is switched on',
    wizardRequiredText:
      'Choosing “do not work if the contour is unavailable”, you see right there that with the ' +
      'panel switched off a CLI pointed at the gateway gets a connection refusal instead of ' +
      'quietly falling back to the vendor cloud. That is the whole point of the mode — but it ' +
      'is better learned before, not after.',

    activeTitle: 'The active contour: exactly one',
    activeCaption:
      'Which contour the work goes through is one answer now, not three. Two contours are never ' +
      'on at once, and switching between them is one action instead of four.',
    activeColumn: 'What to press',
    activeMeaningColumn: 'What happens',
    activeMake: '“Make it active”',
    activeMakeText:
      'The PREVIOUS contour’s applies are undone (CLI files go back to their earlier values, its ' +
      'managed profile disappears), its mark goes out, and the new one becomes active. It is one ' +
      'action: if something fails midway, the panel’s own records go back to what they were. ' +
      'CLI files that had already been restored by that second stay restored — they are ' +
      'someone else’s files, and the panel may not rewrite them a second time; each of them is ' +
      'named in the answer. The button is disabled until a key is saved: there is nothing to ' +
      'ask the contour with.',
    activeBadgeRow: 'The “active” mark',
    activeBadgeRowText:
      'It sits on the single contour both the panel and the CLIs go through. The others say “not ' +
      'active” in their state line: they stay configured, their keys and budgets in place — the ' +
      'work simply does not go through them.',
    activeSmokeRow: 'Test request',
    activeSmokeRowText:
      'Right after activation the panel asks the model a short question itself — through its own ' +
      'gateway, the very path a CLI takes. The model’s answer is shown on the card. A red test ' +
      'request does NOT undo the activation: the reason is spelled out, and it is cured in ' +
      'different places — a gateway that is down, a key that ran out and a model that stays ' +
      'silent are three different troubles.',
    activeReturnRow: '“Back to the default provider”',
    activeReturnRowText:
      'Undoes the applies, clears the mark and leaves the panel and the CLIs on their usual ' +
      'provider. The button sits in two places and does exactly the same thing: on the contour ' +
      'card and in Settings → Custom endpoint, next to the profile the contour created itself.',
    activeWhyTitle: 'Why this is not a toggle',
    activeWhyText:
      'Several contours used to be on at once, and “which one does the work go through” had three ' +
      'answers: the address in the CLI config, the contour toggle and the assistant profile. They ' +
      'drifted apart silently — and the bill for that came to the corporate key. Now there is one ' +
      'answer, and switching brings all three to it in a single action.',
    activeMigratedTitle: 'If you had several contours switched on',
    activeMigratedText:
      'On the first start after the update the FIRST one that was on becomes active — you set the ' +
      'order of the list yourself, and the panel will not pick for you by some other measure. The ' +
      'rest stay configured, with their keys and budgets; only their marks go out. The section ' +
      'says so in a separate message and names every one of them — once, until you close it. The ' +
      'panel reconciles the same way after EVERY foreign write of the settings — a settings ' +
      'snapshot and an environment transfer archive: they arrive from another machine where a ' +
      'different contour was the active one. The one named active on your machine stays active; ' +
      'the other marks go out. Without that the panel would call a contour inactive while the ' +
      'gateway kept serving it — a divergence you would only notice through your CLI.',

    statesTitle: 'Connection states',
    statesCaption: 'Five words on the card and what stands behind each.',
    stateColumn: 'State',
    stateMeaningColumn: 'What stands behind it',
    stateUnchecked: 'not probed',
    stateUncheckedText:
      'The panel has not gone to the contour yet and therefore claims nothing about it — ' +
      'neither models nor capabilities.',
    stateOk: 'connected',
    stateOkText:
      'The last probe returned the list of the key’s models; the card says when that was. The ' +
      'answer usually arrives in seconds — longer means the network or the contour itself.',
    stateUnauthorized: 'key rejected',
    stateUnauthorizedText:
      'The contour answered but did not accept the key, and named no cause: there are five — ' +
      'from an expired term and an exhausted budget to an owner check that simply blinked. The ' +
      'panel names all five and does not send you straight to reissuing the key: the last cause ' +
      'is transient, and the first sensible move is to probe again. A failed probe does not ' +
      'erase capabilities confirmed earlier. The other side of that same cache is signed on the ' +
      '“connected” state: a successful probe does not mean the key is still alive.',
    stateUnreachable: 'not answering',
    stateUnreachableText:
      'The request never reached the contour — usually the address or the network, not the ' +
      'key. The date of the last successful probe stays in place: it shows whether this ever ' +
      'worked at all.',
    stateDisabled: 'not active',
    stateDisabledText:
      'The settings and the key are in place, but the work does not go through it: the gateway ' +
      'does not serve it and there is nothing to apply to the CLIs. A contour has no switch of ' +
      'its own — the one that is on is the one made active.',

    checksTitle: 'Contour checks: shown, not governed',
    checksCaption:
      'Content checks belong to the company and are configured in its admin panel — the panel ' +
      'does not call them, does not configure them and cannot switch them off. All it does ' +
      'here is not lie about what they did. The card appears only with the contour enabled and ' +
      'the gateway up.',
    checksColumn: 'What happened',
    checksMeaningColumn: 'What it looks like to you',
    checksBlocked: 'the request was refused',
    checksBlockedText:
      'The contour refused before the model: there is no answer at all and the model never saw ' +
      'the request. You noticed this yourself — the chat showed an error.',
    checksInterrupted: 'the answer was cut off',
    checksInterruptedText:
      'A check fired in the middle of an answer already streaming: you read part of the text, ' +
      'and there will be no continuation. A cut answer is easy to mistake for a short one — ' +
      'which is why it is named separately.',
    checksMasked: 'data was masked',
    checksMaskedText:
      'The answer arrived whole and looks normal, but the model answered something other than ' +
      'what you sent: the contour replaced part of the data on the way. The quietest outcome, ' +
      'and therefore highlighted louder than the rest.',
    checksUnknown: 'the outcome was not named',
    checksUnknownText:
      'The contour named a check but did not say what happened to the request. The panel says ' +
      'exactly that: passing it off as “fired and let it through” is impossible, because the ' +
      'same silence can hide a refusal it never learned about.',
    checksSilenceTitle: 'Three different silences never merge into “no violations”',
    checksSilenceText:
      'Not a single request went through the gateway — the panel knows nothing about the ' +
      'checks. Requests went through and the checks stayed silent — that is already a claim. ' +
      'Masking happened but the contour gave no names — “no violations” would be a lie there, ' +
      'and such an answer gets a line of its own. The count runs over the last requests the ' +
      'gateway still remembers: the trace is length-capped, the oldest firings drop out of it, ' +
      'and restarting the panel clears it entirely. The card says from when it counts.',
    checksTextTitle: 'The checked text is not in the panel',
    checksTextText:
      'Only the check names exactly as the contour named them, a counter and a date reach the ' +
      'card. Neither the request, nor the answer, nor the masked fragment gets here or is ' +
      'stored anywhere. The local Blind spot rules are a different thing and your own: those ' +
      'the panel governs, these checks it does not.',

    agentsTitle: 'Agents, knowledge and the bridge',
    agentsCaption:
      'An agent is built by the company: its own knowledge, its own tools, its own behaviour. ' +
      'The panel can do exactly one thing — call it and show the answer. The card appears for ' +
      'a contour that is switched on.',
    agentsColumn: 'What is on the card',
    agentsMeaningColumn: 'What to do with it',
    agentsRoster: 'The agent list',
    agentsRosterText:
      'You keep it: the key has no “list the agents” route, and the panel did not invent one. ' +
      'The id is the UUID from the agent’s card in the platform’s admin console; the name is ' +
      'yours and lives only here. The list is stored with the contour, the key is not in it.',
    agentsSession: 'The session',
    agentsSessionText:
      'The conversation is remembered by the CONTOUR — the panel keeps no copy of its own, ' +
      'which is why the line under the answer says how many messages it remembers, not how ' +
      'many you were shown. “Reset the session” erases it on the contour’s side. If an answer ' +
      'arrived but the turn did not make it into the session, the panel says so on its own ' +
      'line: otherwise you would learn about the hole from a “forgetful” agent.',
    agentsOutcomes: 'The outcome',
    agentsOutcomesText:
      '“Agents are not in the licence” is not a breakage: the company’s agent module simply is ' +
      'not granted, and it is not painted red. “The agent ended with an error” is not a panel ' +
      'failure either: that is how its author built it. They are fixed in different places, ' +
      'which is why they are named differently.',
    agentsBridge: 'The MCP bridge',
    agentsBridgeText:
      'Switches on a local MCP server through which the contour’s agents, knowledge and models ' +
      'are available to your CLI as tools. Only the panel’s address goes into the CLI config: ' +
      'the contour key stays in the panel, as everywhere else. One record covers every contour — ' +
      'the call itself picks which one — so the section shows a single button.',
    agentsLimitTitle: 'One call — up to two minutes',
    agentsLimitText:
      'The agent answers all at once, the contour does not stream it, and on a long task the ' +
      'answer may not fit into the time the contour allows. The outcome is then “the contour ' +
      'did not answer”, not an empty answer — the panel will not pass a cut-off turn off as one.',

    marksTitle: 'The compromise mark',
    marksCaption:
      'The flag stands right next to what it explains: a row of the capability matrix, the ' +
      'budget field, a refusal state. It opens on hover and on focus, and closes on Escape.',
    marksNote:
      'The level is spelled out — “Limitation”, “Workaround”, “With risk” — rather than being ' +
      'carried by colour alone: in this panel colour is never the only carrier of meaning.',

    listTitle: 'Signed compromises',
    listCaption:
      'The same list as in the “Contour” section, from the same source: there is nowhere for ' +
      'them to drift apart. The “not in the code yet” badge means the signature was filed ' +
      'ahead of time — the workaround itself arrives with its own task of the batch.',

    neighboursTitle: 'How a contour differs from its neighbours',
    neighboursCaption:
      'Three different things the panel can do that are easy to confuse. The difference is not ' +
      'convenience — it is where the key lives and who provides the models.',
    neighboursColumn: 'Way',
    neighboursMeaningColumn: 'What it does and where the key ends up',
    neighboursEndpoint: 'Your own endpoint',
    neighboursEndpointText:
      'The panel writes the model address and its key into the environment variables of the ' +
      'CLIs you pick. After that the key sits in their configuration, is readable by any ' +
      'process on the machine, and can only be revoked in the provider’s admin panel. It fits ' +
      'a local model, where there is no key at all.',
    neighboursDlp: 'A proxy with the blind spot',
    neighboursDlpText:
      'It edits traffic by your rules — masking secrets and personal data — but provides no ' +
      'models: the request still goes wherever the endpoint points, with the endpoint’s key.',
    neighboursContour: 'A contour',
    neighboursContourText:
      'It provides the company’s models, embeddings and agents behind one key, and keeps that ' +
      'key to itself. CLIs are pointed at the panel’s local gateway; the key is substituted ' +
      'there and never reaches a foreign configuration. The price: the panel has to be ' +
      'running — a dead panel means a dead gateway.',

    getKeyTitle: 'What else lives in the contour admin',
    getKeyCaption:
      'The eight steps above walked the path to a key screen by screen. This list is about ' +
      'which admin page owns what, and what that turns into for you: part of the contour’s ' +
      'settings reach you not through the panel but as a refusal code.',
    getKeyProvider: 'A provider and its key — “Providers”',
    getKeyProviderText:
      'Who actually does the computing: a vendor cloud or the company’s own installation. The ' +
      'provider’s key stays inside the platform and never reaches you.',
    getKeyModel: 'A model — “Models”',
    getKeyModelText:
      'A model is created with a public name, and that is the name you later pick in the ' +
      'panel. The vendor’s documented name and the contour’s name do not always match.',
    getKeyOwner: 'An owner and a team — “Users”, “Teams”',
    getKeyOwnerText:
      'A key has an owner, and the owner drives both access to the knowledge bases and the set ' +
      'of tools the platform picks for your request. A key with no owner still answers, but ' +
      'sees none of the company’s knowledge.',
    getKeyKey: 'The key — “Keys”',
    getKeyKeyText:
      'Allowed models, request and token limits per minute, a budget and an expiry are all set ' +
      'here. All of it answers you later as refusal codes rather than as a route: there is no ' +
      'way to ask the contour “how much is left”.',
    getKeyChecks: 'Content checks — “Guardrails”',
    getKeyChecksText:
      'Optional, at the company’s discretion. They run on its side and are switched on and off ' +
      'there; the panel only shows what they did.',
    getKeyTools: 'Tools, skills, MCP',
    getKeyToolsText:
      'Also on the platform’s side. It picks the tool set itself — by model, skill and key ' +
      'owner; a client cannot declare its own tools to it.',
    getKeyProbe: 'Checking the key',
    getKeyProbeText:
      'The panel’s first probe shows what this key can see: the model list arrives already ' +
      'narrowed by its rights. Until the probe succeeds the panel claims nothing about the ' +
      'contour.',
    getKeyOnceTitle: 'The key is shown once',
    getKeyOnceText:
      'The platform’s admin panel shows the key’s value at the moment it is created and never ' +
      'again. A lost key is not recovered — it is reissued, and the old one stops working.',

    keyLifeTitle: 'What happens to the key',
    keyLifeCaption:
      'The key is entered once in the wizard and after that lives only on this machine, in one ' +
      'place.',
    keyLifeColumn: 'Question',
    keyLifeMeaningColumn: 'Answer',
    keyLifeWhere: 'Where it lives',
    keyLifeWhereText:
      'In a separate key-store file inside the panel’s working directory. It is not in ' +
      'state.json, not in the settings backups and not in the environment transfer.',
    keyLifeCrypto: 'How it is encrypted',
    keyLifeCryptoText:
      'AES-256-GCM; the passphrase is a machine-local secret in a neighbouring file readable ' +
      'by its owner only. Copied to another machine the key file is useless: without the ' +
      'secret file it does not decrypt.',
    keyLifeConfigs: 'Why it is not in a CLI configuration',
    keyLifeConfigsText:
      'What goes into the configuration is the local gateway address and a placeholder instead ' +
      'of the key (panel-contour-no-key-needed). The real key is substituted by the gateway at ' +
      'request time. So it reaches neither a file the human shows a colleague nor the ' +
      'environment transfer.',
    keyLifeOutside: 'What leaves the panel',
    keyLifeOutsideText:
      'In the panel’s own answers the key is always a mask of the form “first characters… last ' +
      'four”. The value never reaches a prompt, a log or the page markup — separate checks ' +
      'watch exactly that.',

    pathTitle: 'The path of one request',
    pathCaption:
      'The same road in detail: the three places where a request can end in a refusal, and ' +
      'which code each of them answers with.',
    pathTextTitle: 'The same in words',
    pathTextText:
      'CLIs and the built-in assistant do not talk to the contour: they talk to the panel’s ' +
      'local gateway on 127.0.0.1; the default port is 5179, and if it is busy the gateway ' +
      'takes a neighbouring one and names what it got — that is the port the panel writes into ' +
      'a CLI’s configuration. The gateway translates the request into the contour’s ' +
      'dialect, applies your blind-spot rules, substitutes the key and sends the request out — ' +
      'the single moment anything leaves the machine. On the contour’s side the request passes ' +
      'the content checks, receives the company’s tools and knowledge, and reaches the model. ' +
      'The gateway translates the answer back into the dialect the client expects and records ' +
      'the spend. Translation can be incomplete both ways: a request field the contour does not ' +
      'take, and a part of the answer the client’s dialect cannot carry (a contour picture is ' +
      'exactly that), never reach the other side. It never happens silently — whatever did not ' +
      'make it is named in the request trace, by name. A refusal can arrive at any of three ' +
      'places: content checks — 451, a spend limit — 402, request frequency — 429.',

    d2Title: 'The path of one request: six steps and three places it can end in a refusal',
    d2Dialect: 'Translation into the contour dialect',
    d2Dlp: 'Blind-spot rules',
    d2Key: 'Key substitution',
    d2Contour: 'Contour',
    d2Inside: 'inside: checks · tools · knowledge',
    d2Translate: 'Answer translated back',
    d2Spend: 'Spend recorded',
    d2Blocked: '451 — the request was refused',
    d2Budget: '402 — spend limit',
    d2Limit: '429 — too often',

    d3Title: 'Where the key lives: in the panel, and it never reaches the CLI files',
    d3Panel: 'Panel',
    d3Vault: 'Encrypted store',
    d3Key: 'Contour key',
    d3Files: 'CLI files',
    d3Address: 'Local gateway address',
    d3Stub: 'Placeholder instead of the key',
    d3Never: 'the key never gets here',

    d4Title: 'What works through a contour and what does not',

    modulesTitle: 'The contour’s modules: what a key can see',
    modulesCaption:
      'The platform is built of modules, but a key has seven public routes. The rest arrives ' +
      'not as a separate call but through what the platform does by itself while serving an ' +
      'ordinary request to a model.',
    modulesColumn: 'Module',
    modulesMeaningColumn: 'Visible to a key?',
    moduleLlm: 'Models and inference',
    moduleLlmText:
      'Directly: this IS the contour’s public API — chat, completions, embeddings, the model ' +
      'list.',
    moduleGuard: 'Content checks',
    moduleGuardText:
      'Indirectly: they fire on their own and answer with a 451. They are configured in the ' +
      'company’s admin panel; the panel does not drive them.',
    moduleTools: 'Tool registry',
    moduleToolsText:
      'Indirectly: the platform picks the tools for a request and runs them itself. A client ' +
      'cannot declare its own — that is the main limitation, and it has its own section below.',
    moduleKb: 'Company knowledge bases',
    moduleKbText:
      'Indirectly: the platform searches them itself when the key has an owner. There is no ' +
      '“search the knowledge” route for a key.',
    moduleMcp: 'The platform’s external MCP servers',
    moduleMcpText: 'Indirectly: those are its tools, not yours; they never reach your CLI.',
    moduleAgents: 'Platform agents',
    moduleAgentsText:
      'Directly: a separate route calls an agent. The panel calls it and shows the answer; the ' +
      'conversation is remembered by the contour.',
    moduleOther: 'Images, entities, document parsing, sentiment',
    moduleOtherText: 'A key has no public route to them — so the panel does not show them.',
    moduleSpeech: 'Speech and quality scoring',
    moduleSpeechText: 'Present in the platform, with no public surface for a key.',
    modulesIndirectTitle: 'The key word here is “indirectly”',
    modulesIndirectText:
      'The platform’s richness arrives not as separate buttons but through an ordinary request ' +
      'to its model already carrying the company’s checks, knowledge and tools. They cannot be ' +
      'driven one by one from the panel, and that is how the platform is built rather than ' +
      'something the panel left undone.',

    worksTitle: 'What works through a contour and what does not',
    worksCaption:
      'The list is complete and unsoftened. One line in it is the reason a contour does not ' +
      'replace everything else in the panel.',
    worksColumn: 'What we send through the contour',
    worksWhyColumn: 'Why',
    worksBadgeYes: 'works',
    worksBadgePartial: 'formally yes',
    worksBadgeNo: 'does not work',
    workAssistant: 'The panel’s built-in assistant',
    workAssistantWhy: 'Text in, text out — it needs no tools.',
    workCases: 'Generating test cases, reading runs, translations',
    workCasesWhy: 'The same: text work inside the panel.',
    workAnalytics: 'Analytics and explanations in the panel',
    workAnalyticsWhy: 'The same.',
    workEmbeddings: 'Embeddings for search',
    workEmbeddingsWhy: 'They have their own route in the contour’s public API.',
    workAgent: 'Calling a contour agent',
    workAgentWhy: 'That is the company’s agent with its own tools — it runs them on its side.',
    workBridge: 'The MCP bridge: your CLI calls a contour model',
    workBridgeWhy:
      'The direction is reversed: the panel calls the contour, not the other way round. The ' +
      'tools stay yours, the model work is the contour’s.',
    workCliChat: 'A CLI as a plain chat partner without tools',
    workCliChatWhy:
      'It will answer, but there is little use in it: an agent that cannot open a file is a ' +
      'chat in an awkward window.',
    workCliAgent: 'Claude Code or another CLI as an agent editing files',
    workCliAgentWhy:
      'Works through the shim, with one caveat. The platform’s public schema does not accept ' +
      'the client’s tools field — it is dropped — so the panel declares your tools to the ' +
      'model as protocol text and assembles the call back out of its answer. The agent ' +
      'receives a real call block and edits files. The caveat: whether the model obeys is up ' +
      'to the model. A weaker one describes the action in words instead of calling anything, ' +
      'and the turn ends successfully with no file written. The panel marks such a turn on the ' +
      '“Tools through the contour” card.',
    worksHonestTitle: 'How the shim differs from real tools',
    worksHonestText:
      'It is a protocol on top of a foreign one, and it is weaker than the vendor’s: a call ' +
      'carries no identifier, parallel calls do not arrive in one turn, and an unparsable ' +
      'block does not become a call at all — it stays in the answer as text, and the request ' +
      'trace says why. What runs is a call written with the protocol tags, plus an answer that ' +
      'is ENTIRELY one call — that is how models trained on the vendor function format reply. A ' +
      'call shown as an EXAMPLE inside a code block never runs, even a correct one: a quote of ' +
      'the protocol and a documentation file the agent has just read out to you look exactly ' +
      'the same. The request trace names such a block as the reason, so that “no calls” is not ' +
      'read as a broken panel. ' +
      'The panel runs nothing whose name and arguments it could not parse: a ' +
      'wrong parse must not hand the agent the right to do something the model never asked ' +
      'for. If you do not need the shim, switch it off on the contour: the CLI keeps working ' +
      'as an agent through its own usual key, and the contour does not stand in the way.',

    shimTitle: 'Tools through the contour: how it works and what it costs',
    shimCaption:
      'The shim is on by default. Here is what goes up, what comes back and the price you pay ' +
      'on every turn.',
    shimColumn: 'What',
    shimMeaningColumn: 'How',
    shimUp: 'What goes up',
    shimUpText:
      'The protocol rules and your tool schemas — as text, inside the system message. There is ' +
      'no tools field in the request at all, and tool choice is sent switched off: the ' +
      'platform picks its own set, and left on it would override the protocol we just taught ' +
      'the model.',
    shimDown: 'What comes back',
    shimDownText:
      'The panel parses the call block out of the model’s answer and hands your CLI a real ' +
      'call — the same one a vendor API would have sent. The tool’s result travels back up as ' +
      'protocol text: without it the model sees neither its own call nor its answer and does ' +
      'the same thing twice.',
    shimPrice: 'What it costs',
    shimPriceText:
      'The contour has no prompt cache, so the schemas travel AGAIN on every turn. Measured on ' +
      'a real Claude Code run: 24 tools — about 58 thousand characters of system text and 86 ' +
      'KB per request on every turn; an interactive run with the full CLI prompt gave 108,546 ' +
      'characters and 154 KB. Same order either way: tens of kilobytes for every step the ' +
      'agent takes.',
    shimPrompt: 'The contour’s short prompt',
    shimPromptText:
      'That is why a run through the contour goes with the panel’s short prompt from the ' +
      'prompt library instead of the CLI’s own. Measured on a local 14B model: with the full ' +
      'prompt it announced the file as created without calling anything; with the short one it ' +
      'made a real call and created the file. The switch next to the shim is there for a model ' +
      'the large prompt does not bother.',
    shimOff: 'When to switch it off',
    shimOffText:
      'When you use the contour for text only: the shim costs room in every request, and there ' +
      'is nothing to pay for there. Switched off, it restores the previous behaviour — an ' +
      'agent through the contour talks but edits no files.',
    shimWarnTitle: 'The turn succeeds and nothing was done',
    shimWarnText:
      'This is the section’s main trouble, and the panel cannot fix it: the model is free to ' +
      'ignore the protocol. The “Tools through the contour” card shows two numbers side by ' +
      'side — how many turns ended in a real call, and in how many the model described the ' +
      'action in words. The second is a mark based on the answer’s wording, not a verdict: it ' +
      'errs both ways, and the panel will not block a turn on such a guess.',

    errorsTitle: 'Refusals and what to do',
    errorsCaption:
      'The codes come from the contour, and the panel turns them into a reason in words. Here ' +
      'is what stands behind each and where to go.',
    errorsColumn: 'Code',
    errorsActionColumn: 'What happened and what to do',
    err401Badge: 'key',
    err401:
      'The contour did not accept the key, and there are five possible reasons: the key is ' +
      'unknown or revoked, expired, has exhausted its budget, its owner was deleted — or the ' +
      'owner check failed. Nothing from the outside tells them apart — the platform answers ' +
      'with one code and one text — so the panel names all five instead of advising you to ' +
      'reissue the key. The fifth is the only transient one: the key itself is fine, and the ' +
      'first sensible move is to retry. If that does not help, check the expiry, the budget ' +
      'and the owner in the admin panel before issuing a new one.',
    err402Badge: 'spend limit',
    err402:
      'A refusal on a spend limit, and NOT on your key’s budget: the platform issues it from a ' +
      'user’s daily limit, a team’s monthly one or the instance’s monthly one. Which one is ' +
      'named in the line itself. It is lifted by a platform administrator or by waiting for a ' +
      'new period.',
    err403Badge: 'model',
    err403:
      'This key is not allowed the requested model — its name is in the refusal. The list of ' +
      'allowed models is edited in the admin panel; the “Contour” section shows the same list.',
    err404Badge: 'model gone',
    err404:
      'The contour does not know that model: it may have been removed between runs. In the ' +
      '“Contour” section missing models are flagged and keep the date they were last seen — ' +
      'pick another one.',
    err429Badge: 'frequency',
    err429:
      'The key’s per-minute request or token limit was exceeded. The panel retries such a ' +
      'request exactly once; if the refusal repeats, waiting or asking for a higher limit is ' +
      'the way out. When the contour names a retry delay, it stands right in the refusal — ' +
      '“retry in so many seconds”; without it, “too often” is indistinguishable from “broken”.',
    err451Badge: 'checks',
    err451:
      'The company’s content checks stopped the request. The panel names the checks that fired ' +
      'exactly as the contour named them; the checked text itself is neither on the screen nor ' +
      'in a log. The refusal is terminal: repeating the same request makes no sense.',
    err503Badge: 'contour',
    err503:
      'The contour is still starting — its model registry is not ready. A retry a minute later ' +
      'usually goes through, and the card’s state does not erase capabilities confirmed ' +
      'earlier.',

    disableTitle: 'How to switch it off',
    disableCaption:
      'Four different actions, and they remove different things. Top to bottom, gentlest first.',
    disableStep0: 'Untick a consumer',
    disableStep0Text:
      'The narrowest action of all: “Set up” → “Where the contour works” → clear the tick. It ' +
      'takes effect from the NEXT start — runs already going are left alone, the panel will ' +
      'not stop someone’s work over a setting. The other consumers stay on the contour, and ' +
      'no CLI file changes at all. Two caveats, both stated on screen: clearing “Panel ' +
      'assistant” moves the assistant back to its previous profile at once — that is a panel ' +
      'setting, not a run variable, and it has no next launch to wait for; and if the same ' +
      'CLI has its files applied, its runs read the contour address from its own config, so ' +
      'clearing the box will not bring them back — “Undo apply” will.',
    disableStep1: '“Remove the apply”',
    disableStep1Text:
      'The CLI files go back to their previous values and the managed profile disappears. The ' +
      'contour itself stays connected: the panel’s assistant and the bridge keep working. A ' +
      'file you edited after the apply is left alone and named.',
    disableStep2: '“Back to the default provider”',
    disableStep2Text:
      'The contour stops being active and the gateway stops serving it: the connection is still ' +
      'accepted, but the answer is a 502 saying “the contour is switched off in the panel” — the ' +
      'contour is down, not the panel. The settings, the key and the spend history stay in place: ' +
      '“Make it active” brings the work back to it. The same button sits in Settings → Custom ' +
      'endpoint — the same action, not a second one.',
    disableStep3: '“Delete the contour”',
    disableStep3Text:
      'The settings, the key and the probe trace are gone. The apply is removed first, ' +
      'automatically. The action cannot be undone: the key has to be entered again.',
    disableKeepsTitle: 'What stays either way',
    disableKeepsText:
      'The “before” copies of every configuration edit live in the “History” section and ' +
      'outlive the contour. The spend counted over past days stays too: that is your history, ' +
      'not a connection state.',

    guide: {
      needTitle: 'What you need first',
      needCaption:
        'Three things. Without any one of them the path breaks halfway, and better to find out now.',
      needAccess: 'Access to the contour admin',
      needAccessText:
        'Only an instance administrator can issue a key. With no admin access the key has to ' +
        'be asked from whoever has it; everything else in the panel works without it.',
      needModel: 'At least one chat model',
      needModelText:
        'A key gets the instance model list narrowed by its own rights. An empty instance ' +
        'connects and reports “0 models” — a formal success with nothing to work with.',
      needAddress: 'The public API address, not the admin one',
      needAddressText:
        'The admin address and the API address differ. The panel appends /v1 itself, and the ' +
        'probe names an address mistake in a message of its own — yet half an hour is lost ' +
        'on it regularly.',

      mapTitle: 'First, the whole thing',
      mapCaption:
        'Three diagrams for the whole path: which road a request takes, who creates what, and ' +
        'how the two systems sit next to each other. Then the same thing step by step, with screens.',

      enterprise-platformTitle: 'First half: the contour admin',
      enterprise-platformCaption:
        'This is where a model is created and a key is issued. Eight steps, after which ' +
        'exactly two lines move into the panel: the address and the key.',
      gLogin: 'Sign in to the instance admin',
      gLoginText:
        'Email with a password or SSO — depends on how your contour is set up. The admin ' +
        'address comes from whoever deployed the instance; on the screenshot it is a ' +
        'different address from the API one, and mixing the two is the most common way to ' +
        'lose half an hour on this path.',
      gDashboard: 'Take a look at the dashboard',
      gDashboardText:
        'It answers the main question right away: does the instance have active models? A ' +
        'zero here makes the next step mandatory rather than “just in case”. The other ' +
        'numbers — requests, errors and spend for today — matter at the very end, when you ' +
        'compare the panel’s estimate against them.',
      gModels: 'Open the model catalog',
      gModelsText:
        'This is what the key will later get its list from. The panel does not invent models ' +
        'from a host name — it asks the contour and shows the answer. Every row here has a ' +
        'kind (chat or image) and a state: a chat model is mandatory, otherwise the panel has ' +
        'nothing to answer with.',
      gModelCreate: 'Create a model if there is none',
      gModelCreateText:
        'The title is human and arbitrary: “Qwen 2.5 0.5B (локальная)” on the screenshot. The ' +
        'provider is not a brand but a call protocol: for a model living on your own machine ' +
        'it is Ollama. The model id is written exactly as the provider knows it — qwen2.5:0.5b ' +
        'on the screenshot, gpt-4o-mini for a cloud one — and that very string is what reaches ' +
        'the panel later. “API Base URL” is the address of whoever answers: for a local Ollama ' +
        'it is http://host.docker.internal:11434 and WITHOUT /v1, because its API is native, ' +
        'and the extra tail yields “404 page not found” inside the model’s answer, not at ' +
        'saving time.',
      gKeys: 'Go to the keys',
      gKeysText:
        'The list shows a truncated key — not even an administrator sees it in full. Which is ' +
        'why the next step is done once and carefully.',
      gKeyCreate: 'Issue a key for the panel',
      gKeyCreateText:
        'The key title is there so you recognise it among the others later: “AgentDeck · ' +
        'путеводитель” on the screenshot. Budget and limits are the contour’s restrictions, not ' +
        'the panel’s: the panel reads and shows them but never works around them — $10, RPM 60, ' +
        'TPM 100000 on the screenshot, with an empty expiry, i.e. a key that never expires. Model ' +
        'access narrows what the panel will later see through the probe: leave it empty and ' +
        'the key sees the whole catalog, name models and it sees only those — and that is ' +
        'exactly the list that lands in the capability matrix.',
      gKeyIssued: 'Copy the key — there is no second time',
      gKeyIssuedText:
        'The contour shows the key exactly once, in this dialog. Copy it whole, including the ' +
        'sk- prefix: it goes into the panel as is, nothing to append or trim. Lost means ' +
        'issue a new one; an existing key cannot be recovered either in the admin or in the ' +
        'panel.',
      gUsage: 'Remember where to look at spend',
      gUsageText:
        'Spend is counted by the contour, not by the panel. The panel shows its own estimate ' +
        'by its own price list and honestly calls it an estimate — the figures are compared ' +
        'here, and they agree as an order of magnitude rather than to the cent.',

      panelTitle: 'Second half: the connection wizard',
      panelCaption:
        'Four wizard steps and three screens after it. The contour stays off until the very ' +
        'end: a draft applies nothing and goes nowhere on its own.',
      pEmpty: 'Open the “Contour” section',
      pEmptyText:
        'Before connecting there is one button and an explanation of what will happen. The ' +
        'section sits next to “Data protection” for a reason: they share one question — where ' +
        'does the request go.',
      pAddress: 'Step 1: contour type, title and address',
      pAddressText:
        'The type is “EnterprisePlatform”; the title is arbitrary, “Платформа компании · стенд” on the screenshot. ' +
        'The identifier is built from the title in Latin letters — a Russian title leaves it ' +
        'empty and “Check connection” stays disabled, so type it in yourself, enterprise-platform-stand ' +
        'on the screenshot: the local gateway address is built from it. The address is the public API ' +
        'root, http://127.0.0.1:5300 on the screenshot (a stand behind a port-forward); ' +
        'yours will be your instance’s address. The panel appends /v1 itself.',
      pProbe: 'At this step the probe still has no key',
      pProbeText:
        'Pressed before the second step, “Check connection” returns “key rejected” — and that ' +
        'is not a misconfiguration. The panel lists five causes right there, because the ' +
        'contour itself names none: an unknown key, a revoked one, an expired one, one with a ' +
        'deleted owner and one out of budget all answer with the same 401. The real ' +
        'connection check happens at the third step.',
      pKey: 'Step 2: paste the key',
      pKeyText:
        'The very sk-… copied at step seven, in full. After this it is never shown again: ' +
        'not in an API response, not in a prompt, not in a log, not in a CLI config. An empty ' +
        'field on a repeat setup means “keep the stored one”, not “erase it”.',
      pCapabilities: 'Step 3: what the contour confirmed',
      pCapabilitiesText:
        'The panel went to the contour and shows the answer — “2 models” on the screenshot, ' +
        'one of them a chat model and one for embeddings: how many models the key has, ' +
        'which of them are chat ones, whether embeddings exist. This is also where you see ' +
        'whether the access narrowing from step six worked — the model count must match what ' +
        'you allowed the key. Anything unverified stands as “not declared” rather than as a ' +
        'tick: there is nothing to promise beyond what was checked.',
      pTargets: 'Step 4: where the contour works',
      pTargetsText:
        'The list of consumers: chat, split groups, the test agent, the panel assistant, the ' +
        'chats of foreign CLIs and “Terminal”. Only the assistant is ticked by default — it ' +
        'is the one thing that works through a contour in full; everything else is switched ' +
        'on by hand, and every run row carries the note that a CLI behind the gateway has no ' +
        'tools of its own. Each row says HOW it travels: “per run” — the address goes into ' +
        'that one process’s environment and nowhere else — “through the panel profile”, or ' +
        '“written into the CLI config”. An unavailable consumer is a dash with a reason, not ' +
        'a checkbox: Codex and Continue keep the address in their own file, one per machine, ' +
        'so “for chat only” is physically impossible there; Gemini CLI speaks a dialect the ' +
        'gateway does not understand. Below the list come the mode for a contour refusal ' +
        '(“required” = do not work), the key budget (the figure you set in the admin; 100 on ' +
        'the screenshot) and the day the contour restarts its period from, as 2026-09-01.',
      pTerminal: 'CLI files live under the “Terminal” tick',
      pTerminalText:
        'The former “Where to apply” list has not gone anywhere: it opens under a ticked ' +
        '“Terminal” — Claude Code and eight other CLIs, with the file path and the lines that ' +
        'will land in it. It is unticked by default for a reason, not out of caution: a write ' +
        'into a shared CLI config also reaches the run you start by hand in your own console, ' +
        'past the panel, and a “chat through the contour” tick warns about no such thing. The ' +
        'panel’s own runs do not need that file at all — each gets the address in its own ' +
        'environment. Unticking the box hides the list but leaves the files already written ' +
        'exactly as they are — the step says so in as many words, and only “Unapply” on the ' +
        'contour card brings them back. And while the file is applied it beats the tick boxes: ' +
        'the CLI reads the address from its own config on every launch, the panel’s launches ' +
        'included, so a cleared “Chat” with “Terminal” applied will not return the chat to the ' +
        'vendor cloud. A line under the consumer says so right where the box is.',
      pGateway: 'Raise the gateway',
      pGatewayText:
        'The “Raise the gateway” button sits on the same step. Once up, it names its address ' +
        '— http://127.0.0.1:5179 on the screenshot — and that is what lands in the ' +
        'consumers’ configs, with the contour identifier appended: ' +
        'http://127.0.0.1:5179/enterprise-platform-stand/v1. The dashes next to the consumers stay to the very ' +
        'end: the contour is switched on only by “Done”, and until then the row honestly says ' +
        'there is nothing to apply yet.',
      pCard: 'Done: the contour card',
      pCardText:
        'Right after the wizard not a single request has gone through the gateway, and the ' +
        'panel says so plainly instead of showing a zero as a result.',
      pSpend: 'Make one short request',
      pSpendText:
        'Any CLI pointed at the gateway, or the panel assistant; two characters such as “2+2” ' +
        'are enough. After the very first answer the card shows spend, the budget left and ' +
        'the content-check trace — now a measurement rather than a promise.',
      pDelete: 'How to switch it off',
      pDeleteText:
        'Three actions of different strength are covered below, in “How to switch it off”. ' +
        'The harshest is deletion: it asks for the contour title in full, while the apply is ' +
        'removed before it by itself, returning the CLI files to their original state.',

      shotsTitle: 'Where these screenshots come from and why they can be trusted',
      shotsText:
        'The frames are taken by a run of their own: the admin on a live stand, the panel on ' +
        'a throwaway copy with its own config directory, so that nobody’s working stand is ' +
        'touched. Keys, tokens and emails are masked in the markup BEFORE the shot, and the ' +
        'visible text of the frame goes into an inventory next to the image. A separate check ' +
        'reads that inventory looking for keys, tokens, foreign domains and values from the ' +
        'private store — so a leak is caught by a run rather than by eye. The check has one ' +
        'boundary and it is named outright: it sees what was in the markup, and would not see ' +
        'a secret drawn as a picture.',
    },
  },
  shots: {
    connect: {
      '01-admin-login': 'Signing in to the instance admin: email and password, or SSO',
      '02-admin-dashboard': 'Dashboard: active models, keys and today’s requests',
      '03-admin-models': 'The instance model catalogue — where the key’s own list comes from',
      '04-admin-model-create':
        'Model form: display name, the provider’s model reference, context length',
      '05-admin-keys': 'The key list; the column holds a truncated key, masked here',
      '06-admin-key-create': 'Issuing a key: budget, RPM and TPM limits, model access',
      '07-admin-key-issued':
        'The key is shown once — masked in the frame, as in the curl and Python samples',
      '08-admin-usage': 'Usage analytics: spend by model and by key',
      '09-panel-empty': 'The “Contour” section before connecting: one button and a promise',
      '10-wizard-address': 'Step 1: contour type, title, identifier and API address',
      '11-wizard-probe': 'A probe with no key answers “key rejected” — five causes are named',
      '12-wizard-key': 'Step 2: the key. A stored one is never shown again, anywhere',
      '13-wizard-capabilities': 'Step 3: what the probe confirmed, and what stayed “not declared”',
      '14-wizard-targets':
        'Step 4: consumers, mode, budget. The dashes stay until “Done” — the contour is still off',
      '15-wizard-gateway': 'The gateway is up on 127.0.0.1:5179 — now CLIs have somewhere to point',
      '16-panel-card': 'The contour card right after “Done”: no request has gone through yet',
      '17-panel-spend': 'The same card after a live request: spend, budget and the check trace',
      '18-panel-delete': 'Deleting asks for the title; the apply is removed before it by itself',
    },
  },
  diagrams: {
    'request-path':
      'The path of one request: CLI → the panel’s local gateway → the contour → the model. The key appears at exactly one point on it.',
    'who-creates-what':
      'What gets created in the contour admin, what in the panel, and which two lines cross the border.',
    'two-systems':
      'The two systems side by side: the panel’s parts against the enterprise-platform instance services, and the three arrows that cross the border between them.',
  },
};
