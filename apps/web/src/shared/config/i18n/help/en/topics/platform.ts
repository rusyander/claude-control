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
      'First three diagrams for the whole path. Then the path in real screenshots: the ' +
      'contour admin, the connection wizard in the panel, and work through the connected ' +
      'contour — the test request and switching, the model, the rules on the way, an agent ' +
      'that edits files, images. Only after that the design of the section, its states, its ' +
      'limits, its refusals and our asks of the platform. If the contour is already connected ' +
      'and you need one fact, scroll straight to “What the section shows”; which part sits on which tab is in “Section tabs” just before it.',

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

    tabsTitle: 'Section tabs',
    tabsCaption:
      'The section is split into tabs, one per question you ask. The tab lives in the address ' +
      '(/platform?tab=rules), so you can link to a part and a reload keeps it. While no contour ' +
      'is connected there are no tabs: an explanation and the “Connect a contour” button stand ' +
      'in their place.',
    tabsColumn: 'Tab',
    tabsMeaningColumn: 'What is on it',
    tabContours: 'Contours',
    tabContoursText:
      'Cards of every connected contour, the active one first: connection, what the probe ' +
      'found, where it is applied, journal, budget and spend. “Make active”, “Check”, ' +
      '“Configure” and delete live here too, and under the cards — the decisions taken and the ' +
      'list of signed compromises.',
    tabModel: 'Model',
    tabModelText:
      'Default model, per-consumer model, name map and reasoning depth — of the selected contour.',
    tabRules: 'Rules',
    tabRulesText:
      'Two columns. On the left, “Platform rules”: the request fields the panel passes to the ' +
      'contour and what the contour does itself. On the right, “Our layers”: the tool shim, the ' +
      'data mask and the ~/.claude layers in a run. Under the columns, the conflict matrix ' +
      'between the sides.',
    tabAccess: 'Section access',
    tabAccessText:
      'Which panel sections go through the selected contour and what gets written for that — ' +
      'see “Section access” below.',
    tabTools: 'Tools and checks',
    tabToolsText:
      'The tool shim summary, the contour’s content checks and the cases where the contour ' +
      'compressed history. Shown once a contour is active, the panel gateway is up and a request ' +
      'went through it; until then the tab says what is missing.',
    tabAgents: 'Agents',
    tabAgentsText:
      'Platform agents of the active contour and the MCP bridge — one for all contours.',
    tabsPickerTitle: 'The contour is picked above the tab',
    tabsPickerText:
      'Model, rules and access belong to one contour. With more than one contour a “Contour” ' +
      'picker stands above these tabs, the active one by default; the choice lives in the ' +
      'address (?id=) and survives switching tabs.',

    accessTitle: 'Section access',
    accessCaption:
      'The same choice as step 4 of the wizard, without walking the wizard again: ticked ' +
      'sections go through the selected contour. Under the ticks — the price of the choice, ' +
      'before you click.',
    accessColumn: 'On the tab',
    accessMeaningColumn: 'What it means',
    accessConsumers: 'Sections',
    accessConsumersText:
      'Chat, split groups, the tests agent, the panel assistant, foreign CLI chats and ' +
      '“Terminal” — the same rows as in the wizard, with the same dashes and reasons. Chat, ' +
      'groups, tests and foreign CLIs are decided at every start: the gateway address goes into ' +
      'the run’s environment and nothing is written.',
    accessWrites: 'What gets written',
    accessWritesText:
      'The panel assistant writes the gateway address into its profile, “Terminal” into the ' +
      'files of the ticked CLIs. Every row names the file, what lands in it and whether the ' +
      'place is taken; a taken place is left alone without the “overwrite” tick. A file applied ' +
      'earlier beats an unticked “Chat” — the line under the section says so.',
    accessButtons: '“Save the choice” and “Save and apply”',
    accessButtonsText:
      'The first only remembers the ticks — enough for chat, groups, tests and foreign CLIs. ' +
      'The second then writes the assistant and the files; whatever was not written is named ' +
      'under the buttons with its reason.',
    accessInactiveTitle: 'On an inactive contour the choice waits for activation',
    accessInactiveText:
      'No section goes through an inactive contour, and the tab says so before the ticks. The ' +
      'choice is kept, and writing to the assistant and CLI files is skipped with a reason. ' +
      'Activation does not repeat the writes: once the contour is active, press “Save and ' +
      'apply” again.',

    screenTitle: 'What the section shows',
    screenCaption:
      'The blocks of the card on the “Contours” tab, top to bottom. None of them is drawn from a guess: everything ' +
      'written there comes from the panel’s answer about your contour.',
    screenColumn: 'Block',
    screenPurposeColumn: 'What is in it',
    screenCard: 'Contour card',
    screenCardText:
      'Name, address, connection state and the date of the last probe. “Not answering” and ' +
      '“never answered” are different lines: the first carries the date of the last successful ' +
      'probe next to it, the second has no date at all. The date is not always yours: the ' +
      'panel re-probes the ACTIVE contour itself, in the background, on an interval from the ' +
      'settings (zero means do not go at all), and the card calls such a probe a background ' +
      'one — otherwise “checked a minute ago” would read as “I pressed that”. The second ' +
      'reason to go is a contour refusal that smells of rights (401 or 403): that is exactly ' +
      'what a revoked key and a model taken off it look like, and until the next interval the ' +
      'card would keep saying “checked, all good”.',
    screenMatrix: 'What is available',
    screenMatrixText:
      'The contour’s capabilities. The contour type declares the set of rows: for the company platform it is ' +
      'models, chat models, embeddings, platform agents, content checks, company knowledge, own ' +
      'tools and image generation; a compatible gateway knows less about itself — models and ' +
      'images. The state is “yes”, “indirect”, “no” or ' +
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
      'For a CLI that means its tools go to the contour as a field, as on a compatible ' +
      'gateway. Triangle: tools go through the shim, with its caveat, or not at all and the ' +
      'CLI works as a chat — the mark beside it says which. Circle: can be applied. Dash: ' +
      'unavailable, and ' +
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
      'a fraction with a dot or a comma. The panel also says a crossing outside this screen: ' +
      '85% and “the estimate reached the budget” go to Telegram and the webhook — once per ' +
      'crossing, not on every request. The mark is cleared by changing the day the period is ' +
      'counted from, or by the refusal reset button. Phone push is deliberately left out: its ' +
      'body opens a conversation, and a budget has none — every run spends it at once.',
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
      'worth reconciling with the admin panel as an order of magnitude, not to the cent. A ' +
      'gateway that publishes prices in the model list itself (OpenRouter does) is counted by ' +
      'them: the panel takes a model’s price from the last connection check, by exact name. ' +
      'Your own prices in settings still win over it.',
    screenExhausted: 'Refused on a spend limit',
    screenExhaustedText:
      'A 402 is a fact from the platform itself, and the panel reads what ran out from its ' +
      'body. On the routes the panel uses, the platform issues 402 for one reason — your key’s ' +
      'budget is exhausted — and the line says exactly that. Another platform may name a ' +
      'different limit: the line then quotes its name, and with no name it just says “spend ' +
      'limit”. A 402 does not always get to tell you: the platform remembers a key check for ' +
      'half a minute and after that answers 401 — the same code as an unknown or revoked key, ' +
      'an expired one, a key whose owner was deleted and a failed owner check, with nothing ' +
      'outside to tell those five apart. That is why on a 401 the panel names all ' +
      'five causes instead of advising ' +
      'you to reissue the key. The 402 line survives a panel ' +
      'restart and clears only through your button: dropping a fact on a guess would hand back ' +
      'a cheerful “there is room” where the platform already refuses.',

    driftTitle: 'Values edited after the apply are left alone by the rollback',
    driftText:
      'At the moment of writing the panel remembers a fingerprint of what it wrote itself: its ' +
      'variables, or the contour’s own entry in the file. If exactly those were edited ' +
      'afterwards — by your own hand or by another tool — the journal row says so, and the ' +
      'rollback leaves that file as it is. Writing the “previous” value over someone else’s ' +
      'edit would erase it. Edits to the rest of the file — permissions, hooks, other ' +
      'variables — do not stand in the rollback’s way and survive it.',

    wizardRequired: 'The “required” mode shows its price before it is switched on',
    wizardRequiredText:
      'Choosing “do not work if the contour is unavailable”, you see right there that with the ' +
      'panel switched off a CLI pointed at the gateway gets a connection refusal instead of ' +
      'quietly falling back to the vendor cloud. That is the whole point of the mode — but it ' +
      'is better learned before, not after. The same holds with the panel alive: if the gateway ' +
      'is down or the key is not saved, a chat, group or test agent whose box is ticked does not ' +
      'start at all — the chat header warns before sending, and the feed keeps the reason together ' +
      'with what to press: “Start the gateway” on the contour card, or the “Key” step. ' +
      '“Best effort” lets such a run bypass the contour instead — and the chat header (own and ' +
      'foreign CLI) says so before sending, with a “Bypassing the contour” line and the same ' +
      'reason: in neither mode does data leave for the vendor cloud quietly.',

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
      'gateway, the very path and the very model a CLI in the terminal takes: its model, otherwise ' +
      'the contour’s model, otherwise the first chat model of the catalog. The model’s answer is ' +
      'shown on the card — without the reasoning draft some models write straight into the ' +
      'answer text — and a model that spent the answer ceiling on reasoning is named ' +
      'separately. A red test ' +
      'request does NOT undo the activation: the reason is spelled out, and it is cured in ' +
      'different places — a gateway that is down, a key that ran out and a model that stays ' +
      'silent are three different troubles. With the tool shim off, ONE more question follows ' +
      'the answer — will the model call a tool through the field. If it did not, wrote the ' +
      'call as text, or the contour type drops the field, the panel turns the shim on ITSELF ' +
      'and says so in a line on the card, with a “Turn the shim off” button: without it an ' +
      'agent over the contour says it edits files and does not. The panel makes that call ' +
      'once per contour — turn it off and the next activation will not bring it back. A ' +
      'refused request with a tool is said about the REQUEST, not about the model, and leaves ' +
      'the switch alone: there the “Turn the shim on” button stays. A call written as text is ' +
      'never executed by the panel.',
    activeReturnRow: '“Back to the default provider”',
    activeReturnRowText:
      'Undoes the applies, clears the mark and leaves the panel and the CLIs on their usual ' +
      'provider. The button sits in two places and does exactly the same thing: on the contour ' +
      'card and in Settings → Models, in the Custom endpoint card, next to the profile the ' +
      'contour created itself.',
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
    statesCaption: 'Six words on the card and what stands behind each.',
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
    stateNoKey: 'no key entered',
    stateNoKeyText:
      'The probe went without a key and the contour refused. This is not “key rejected”: there ' +
      'was nothing to reject, and the refusal itself confirms the address is a model API rather ' +
      'than a login page. Fixed by saving the key — “Configure” → the “Key” step.',
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
      'and restarting the panel clears it entirely. The card says from when it counts. Two ' +
      'checks firing in one request do not share outcomes: each shows the one its own contour ' +
      'frame brought, and only an outcome the contour did not attribute stays with all of them.',
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
      'a contour that is switched on and whose type declares agents: the company platform has them, a ' +
      'compatible gateway has no such surface and gets no card. The MCP bridge stays either ' +
      'way — a model is asked through it on a contour of any type.',
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

    modelsTitle: 'Model and reasoning effort',
    modelsCaption:
      'The panel has its own model names — “sonnet”, “opus” — and the contour does not know ' +
      'them. While a chat runs through a contour, the model and effort picks in the header are ' +
      'locked and show what is actually sent — the contour model; the chat’s saved pick comes ' +
      'back once the contour is turned off. The waiting caption names the same model ' +
      '(“Qwen/Qwen3.8-27B-FP8 is thinking”), and the contour prompt tells the model who it is ' +
      'and which contour the request goes through: without that line the model assembles ' +
      'itself from the Claude Code environment and calls itself Claude.',
    modelsColumn: 'On the card',
    modelsMeaningColumn: 'What it means',
    modelsDefault: 'The contour’s model',
    modelsDefaultText:
      'Everything not overridden goes with it. Until you pick one, the panel takes the first ' +
      'catalog model a conversation can be held with and says plainly that this is its own ' +
      'substitution. A drawing model never becomes the substitution, even when declared a chat ' +
      'model: the company platform runs such a model without a tool loop and an agent cannot work behind it — it can ' +
      'only be picked by hand. The substitution cannot be skipped: a profile with no model would send the CLI into the contour with a vendor ' +
      'name, which is a 403 on the first message. Your pick always beats the catalog — even if ' +
      'the contour does not currently list that model: a model gone from the list more often ' +
      'means narrowed key rights than a decision by the platform. Such a model stays in the ' +
      'list as a row of its own — “chosen by you, the contour does not serve it right now”: a ' +
      'setting that is in force cannot be invisible.',
    modelsConsumer: 'A model per consumer',
    modelsConsumerText:
      'One row for everyone who goes through the contour in their own process: chat, split ' +
      'groups, the tests agent, a foreign CLI. Empty — the contour’s model is used. That is how ' +
      '“a bigger model for chat, a cheaper one for tests” works without a second contour. The ' +
      'assistant and the terminal are not in the list: they have exactly one model — the one ' +
      'written into the profile.',
    modelsMap: 'The name map',
    modelsMapText:
      'On the left the name the panel calls a model by (“sonnet”), on the right the contour’s ' +
      'model. A run that names a model itself goes with the model flag, and that flag beats the ' +
      'address variable: without the map the vendor name reaches the contour. Case does not ' +
      'matter. A name the contour lists in its own catalog needs no translation — it travels ' +
      'as is.',
    modelsUnknownTitle: 'An unknown name is replaced, and the replacement is named',
    modelsUnknownText:
      'If the named model is in neither the map nor the contour’s catalog, the conversation ' +
      'goes with the contour’s model and a line appears under the pick: “no such name there, ' +
      'the request goes with this one”. Letting an unknown name through quietly would hand you ' +
      'a 403 “model” on every message. And when the contour itself has no model — an empty ' +
      'catalog, or a probe that never ran — there is nothing to replace it with: the caption ' +
      'says exactly that, and the request goes as it is.',
    modelsEffortTitle: 'The contour takes no reasoning effort',
    modelsEffortText:
      'The contour’s public interface has no effort field, so the panel does not send it at all ' +
      'and says so in a caption beside the pick. The answer stays complete — only the depth of ' +
      'reasoning is lost. An effort the foreign CLI sends itself travels upstream as it is — ' +
      'the contour strips unknown keys on the way — and the request trace names it as a loss: ' +
      'a setting that quietly fails to reach the model would look applied. Once the contour has ' +
      'the field, the signature comes off and the picked value starts travelling.',

    rulesTitle: 'Contour rules and conflicts',
    rulesCaption:
      'A contour does more with a request than hand it to a model: it checks the content, ' +
      'substitutes data, mixes in company knowledge, compacts a long conversation. Part of that ' +
      'the panel sets through request fields — they are on the “Rules” tab, in the “Platform ' +
      'rules” column; the rest is ' +
      'turned on by the contour’s owner, and the panel only names it so the behaviour does not ' +
      'look random. Whatever the contour did not declare will not appear there: the list comes ' +
      'from the platform’s description, it is not guessed.',
    rulesColumn: 'On the card',
    rulesMeaningColumn: 'What it means',
    rulesTools: 'Platform tools',
    rulesToolsText:
      'Tool names from the contour’s registry — you copy them from its admin console: the key ' +
      'has no “list the tools” route, same as for agents. Empty — the panel sends ' +
      '“tool_choice: none” upstream, asking the contour not to use its own tools at all: staying ' +
      'silent would leave that to its default. While the tool shim is on, the field is locked: two ' +
      'sets on one turn argue with each other — and the shim itself is switched off right here, ' +
      'in the neighbouring “Our layers” column.',
    rulesMode: 'Platform call loop',
    rulesModeText:
      '“loop” — the contour runs the call/result cycle itself and returns a finished answer; ' +
      '“single_turn” — it returns the call to you: the panel translates it into your CLI’s ' +
      'dialect, so the call reaches an Anthropic client too, not only an OpenAI one. The contour ' +
      'accepts no stream in this mode, so the turn goes to it whole: your CLI still receives a ' +
      'stream, but the answer arrives at once and breaks off if the contour thinks longer than ' +
      '120 seconds. With no tool ' +
      'names the mode is not sent anywhere: asking for a cycle of calls that do not exist is ' +
      'pointless.',
    rulesPreset: 'Generation preset',
    rulesPresetText:
      'A named parameter set on the contour’s side. Empty — the field is not sent and the ' +
      'contour takes its own default; an empty string instead would be a refusal for nothing.',
    rulesThinking: 'Model reasoning',
    rulesThinkingText:
      'Three states, not a switch. “Default” sends no field and leaves it to the model’s ' +
      'template — a reasoning model such as Qwen3 then thinks. “Turn on” and “Turn off” go as an ' +
      'explicit value, but the contour carries it only to models on self-hosted vLLM: other ' +
      'providers never receive the field. Reasoning never reaches the outside — the chat shows an ' +
      'ordinary answer.',
    rulesObserved: 'What the contour does itself',
    rulesObservedText:
      'Content checks, data substitution, company knowledge, history compaction. None of it can ' +
      'be switched from here — those are the owner’s knobs; the line “turned on by the contour’s ' +
      'owner” stands beside each so a missing checkbox does not read as a broken panel.',
    rulesExclusiveTitle: 'There is exactly one mutual exclusion',
    rulesExclusiveText:
      'Platform tools versus our tool shim: our set travels as text and is reassembled from the ' +
      'answer, the contour’s set is executed by the contour, and one turn can only have one of ' +
      'them. The panel will not let both be on — the save that CREATES the contradiction is ' +
      'refused in the same words the matrix row is written in. Nor will it silently turn one side ' +
      'off for you: you would learn of such a decision from an agent that went quiet. And if the ' +
      'contradiction did arrive — someone restored a foreign archive — the contour is not locked: ' +
      'the card carries two exit buttons, one per side, and the restore plan names such a contour ' +
      'in advance.',
    rulesLayersTitle: 'The other three rows are not a choice of two',
    rulesLayersText:
      'The contour’s data substitution and the panel’s data mask stack in order, but only ours ' +
      'is worth relying on. Substitution by the contour is not guaranteed: a probe of a live ' +
      'contour showed that on the API-key path the model sees email, phone and IP as they are. ' +
      'So for a contour that declares substitution our mask turns on by itself — the “The ' +
      'panel’s data mask” row under “Our side”; the global switch of the “Data protection” ' +
      'section is neither needed nor touched. Your enabled rules mask, or, with none, the ' +
      'built-in set of twenty patterns; an unreadable rules file refuses the request with the ' +
      'reason instead of sending it in the clear. Our labels are reversible and of another shape, ' +
      'the contour leaves them alone. The mask can be turned off in the same row, but the global ' +
      'switch beats the toggle. A mask that is off changes the matrix row itself: it says the ' +
      'request goes to the contour AS IT IS right now, and names the switch. Promising the mask ' +
      'under a mask that is off would be the worst possible text — about personal data leaving ' +
      'for a corporate contour. The contour’s history compaction versus our checkpoints is a ' +
      'warning: after a compaction the continuation may not know the start of the task. Content ' +
      'checks versus the prompt gate is simply a fact: both refuse, by different lists, and the ' +
      'second refusal does not mean the first one failed. In those two rows the panel marks only ' +
      'ITS own half as on: whether the contour’s owner enabled substitution and checks it does ' +
      'not know — that shows only when a frame fires.',

    layersTitle: 'Our layers: what travels from `~/.claude` into a run',
    layersCaption:
      'The “Our layers in the run” block — the “Rules” tab, “Our layers” column. Through a corporate contour a ' +
      'request goes without prompt caching, and everything the panel adds of its own is paid for ' +
      'again on every turn — which is why layers can be dropped. The price is stated honestly: ' +
      'the agent works without your rules and the answer will not show it, so what was dropped is ' +
      'named both on the card and in the chat header.',
    layersColumn: 'Switch',
    layersMeaningColumn: 'What it drops, and with what',
    layersAll: 'Our rules travel into the run',
    layersAllText:
      'The master switch. Off — not one of our layers travels through this contour, whatever the ' +
      'switches below say: they turn grey rather than argue with it. This is the case where you ' +
      'need not think about four settings at all.',
    layerSettings: 'Personal rules, hooks and permissions',
    layerSettingsText:
      'Everything from `~/.claude` at once: the rules (CLAUDE.md or AGENTS.md), hooks, permissions, personal skills ' +
      'and personal MCP servers — with `--setting-sources project,local`. They cannot be dropped ' +
      'separately: for the CLI this is one `user` settings source, and promising separate ' +
      'dropping would mean drawing three switches where one is executed. Along with the ' +
      'permissions your `deny` rules stop applying — the fence you put around the agent. The ' +
      'project CLAUDE.md and repository settings THIS flag does not touch: those are the rules of ' +
      'the task, not ours (measured, not assumed). One file needs more than the flag: when the ' +
      'project lives under your home folder, the CLI walks up, finds the personal instructions ' +
      'file and reads it as a project file. The panel then excludes exactly those files for the ' +
      'run (`claudeMdExcludes` through `--settings`) — BOTH names, CLAUDE.md and AGENTS.md, ' +
      'because the naming mode is not ours to know — so your personal rules do not come back in ' +
      'by the side door.',
    layerSkills: 'Skills',
    layerSkillsText:
      'Skills and the `Skill` tool itself — with `--disable-slash-commands`. A separate switch not ' +
      'for symmetry: built-in skills go away only this way, the settings source does not touch ' +
      'them. ALL skills go, the repository’s own (`.claude/skills`) included: the CLI has no flag ' +
      'for just the personal ones, and that is worth knowing in a project that lives by its skills.',
    layerMcp: 'MCP servers',
    layerMcpText:
      'MCP servers — with `--strict-mcp-config`, and ALL of them: personal, the project’s own from ' +
      'the repository’s `.mcp.json`, and the panel’s bridge to the contour’s own tools. Only the ' +
      'panel’s permission broker stays: it arrives with its own `--mcp-config`, and without it ' +
      'every permission request would become a silent refusal in the middle of the agent’s work. ' +
      'So the switch also removes the task’s tools — gitlab, atlassian, the browser — not just ' +
      'your personal servers.',
    layerPrompt: 'The panel’s addition to the system prompt',
    layerPromptText:
      'What the panel adds of its own: initiatives, task splitting, session continuation. The CLI ' +
      'has no flag for it — the panel drops it itself, which is why it is absent from the flag ' +
      'list.',
    layersFlagsTitle: 'The flags shown are the real ones',
    layersFlagsText:
      'Under the switches stands the line of flags the run will carry — exactly the ones that ' +
      'reach the CLI launch. “Personal rules dropped” without saying by what would be a request ' +
      'to take it on trust. The server computes them, the screen only shows them; the chat header ' +
      'says the same BEFORE a message is sent — otherwise “the agent does not read my rules” ' +
      'looks like a broken agent rather than your own switch. In a conversation created by a ' +
      'split the header asks with the same consumer the run itself will use (“Split groups”), not ' +
      '“Chat”: otherwise it would describe a foreign route. And when the contour’s route has no ' +
      'Claude launch ticked at all — no chat, no groups, no tests agent — the line under the ' +
      'flags says exactly that: there is nobody to receive them yet.',
    layersMissingTitle: 'Three neighbouring settings are absent here',
    layersMissingText:
      'The prompt gate is physically our hook in `~/.claude/settings.json`: it leaves together ' +
      'with the personal settings and has no switch of its own. Data protection is not a layer at ' +
      'all — it is not traded for prompt budget. The model cascade is switched on per project, ' +
      'not per contour. And last: layers are dropped by Claude Code flags, so a foreign CLI going ' +
      'through the same contour is untouched by these switches — it has its own files and its own ' +
      'rules.',

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

    asksTitle: 'What we asked the platform for',
    asksCaption:
      'The signatures above are what the panel works around on its own. Here is what would ' +
      'lift them from the platform side: the six asks that change work through a contour the ' +
      'most.',
    asksColumn: 'Ask',
    asksMeaningColumn: 'What changes',
    askTools: 'Accept the client’s tools',
    askToolsText:
      'Tool schemas in single-turn mode, and that mode’s ban on streaming lifted. An agent ' +
      'through the contour gets real calls, and the shim — with its price and its caveats — is ' +
      'no longer needed, and a turn in that mode will stop arriving at once, with no first ' +
      'words. A stream does not lift the 120-second cap — that is a separate ask below. The ' +
      'platform would not have to run the tools: the CLI calls them locally.',
    askCache: 'Stop dropping the prompt cache mark',
    askCacheText:
      'Today the tool schemas travel afresh on every turn — tens of kilobytes per agent step. ' +
      'A cache mark passed through to the provider would remove that price. We do not ask the ' +
      'platform to build a cache of its own.',
    askTimeout: 'Raise the 120-second ceiling on an answer',
    askTimeoutText:
      'The contour’s server cuts any answer off in its second minute, streams included. A ' +
      'long answer from a reasoning model ends as “the stream broke off”, and people go and ' +
      'fix their network.',
    askBudget: 'The budget left, the prices, and why a key was refused',
    askBudgetText:
      'A “what this key has” route: the budget and how much is spent — instead of a figure ' +
      'typed in by hand. Model prices in the model list — so money is counted at the company’s ' +
      'prices rather than the panel’s reference. And the five causes of a 401 told apart — ' +
      'instead of one “key rejected”, after which a healthy key gets reissued for nothing.',
    askMask: 'Leave the content between tool markers untouched',
    askMaskText:
      'The contour’s data substitution runs over the whole history, the tool descriptions and ' +
      'the call in the model’s answer included, and does not give a key client the “label → ' +
      'value” map. A label nothing can restore is never let into a file — the call stops. A ' +
      'per-request switch would make that stop impossible.',
    askEffort: 'Accept the reasoning effort',
    askEffortText:
      'The field is not in the public schema, so the panel does not send it: the effort chosen ' +
      'in the chat header stays a “not sent” caption through the contour.',
    asksDocTitle: 'The full list — a letter to the platform team',
    asksDocText:
      'All seventeen asks, plus the questions the code does not answer, are collected in a letter ' +
      'to the platform team (in Russian). It is not in the panel repository and never will be: the ' +
      'letter dissects someone else’s stand and the repository is public — it sits next to the ' +
      'panel, under .agent/private/, and never reaches a fresh clone. Each row names the signature an ' +
      'answer would lift, the place in the platform code it rests on, and what it costs the ' +
      'platform. None of the asks blocks work: ' +
      'everything already runs through workarounds, and each workaround is signed in the list ' +
      'above.',

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
      'make it is named in the request trace, by name. For a platform whose driver declares a ' +
      'native Anthropic-dialect endpoint, such a CLI’s request goes out untranslated: thinking ' +
      'and cache marks arrive intact, while key, rules and spend stay the same. A model that ' +
      'writes its thinking straight into the answer text and closes it with a bare “</think>” ' +
      'is remembered on the first such answer (usually the check at connection) and from then ' +
      'on the client gets only the answer itself: the thinking goes to the trace as the ' +
      '“reasoning” stage, and a tool call sketched inside it is never executed. A refusal can ' +
      'arrive at any of three ' +
      'places: content checks — 451, the key budget — 402, request frequency — 429.',

    d2Title: 'The path of one request: six steps and three places it can end in a refusal',
    d2Dialect: 'Translation into the contour dialect',
    d2Dlp: 'Blind-spot rules',
    d2Key: 'Key substitution',
    d2Contour: 'Contour',
    d2Inside: 'inside: checks · tools · knowledge',
    d2Translate: 'Answer translated back',
    d2Spend: 'Spend recorded',
    d2Blocked: '451 — the request was refused',
    d2Budget: '402 — key budget',
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
    moduleImages: 'Image generation',
    moduleImagesText:
      'Indirectly: a key has no route of its own, but a drawing model answers with a picture as ' +
      'part of an ordinary answer — which the panel shows in the «Image» mode.',
    moduleOther: 'Entities, document parsing, sentiment',
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
      '“Tools through the contour” card. A compatible gateway needs no shim: it accepts the ' +
      'tools field, and the calls are real.',
    workImages: 'Images from a description in chat',
    workImagesWhy:
      'Drawing works on the contour whose driver declares it, with the model the key catalog ' +
      'declares as capable of image generation: on the company platform the picture arrives as part of an ' +
      'ordinary answer — it has no separate images endpoint. A compatible gateway says nothing ' +
      'about images, and the panel does NOT invent an endpoint for it: a guessed address would ' +
      'return 404 after the person had already described the picture. The endpoint is declared ' +
      'by a preset checked against the gateway docs, or by you — in the wizard’s “What the ' +
      'gateway can do” block, when your gateway’s docs name it. The second road is your own ' +
      'endpoint profile with a generation address field. ' +
      'A contour request travels through the panel gateway, so it is in the gateway journal. It ' +
      'reaches the key’s spend only if the contour sent a bill: the company platform sends an image as part ' +
      'of an answer without one, so such an image is not in the key’s spend. The gateway has ' +
      'to be up for this — and when its switch is on while no listener is there, the panel ' +
      'raises it itself, once: the lock with a reason appears only after that failed, and it ' +
      'names the reason in the gateway’s own words. A switch left off the panel does not turn ' +
      'on for you — the lock says exactly that: the gateway is off.',
    workDecks: 'Presentations on a topic from chat',
    workDecksWhy:
      'The deck itself asks the contour for no capability: the panel sends an ordinary chat ' +
      'request and asks for the structure — title, slides with a layout and a mood, bullets, ' +
      'speaker notes, diagrams as code. HTML, PPTX and PDF it assembles itself on your machine, ' +
      'so not one file travels upward, and a PDF is promised only where a browser for printing ' +
      'was found. Exactly one place needs a capability — the photographic slide pictures: the ' +
      'panel draws those through the same raster route as the «Image» mode, with a low ceiling ' +
      'per deck, and the first failure stops the rest. With no raster route the deck is still ' +
      'assembled with its diagrams, and the reason is named on the card. It is «partial» here ' +
      'for the same reason as the agent: whether the model answers with a structure is its own ' +
      'affair — a sentence around the structure or reasoning before it the panel drops by ' +
      'itself, and an answer with no structure at all it names in the model’s own words rather ' +
      'than as «a panel error». And the mode does not depend on a contour: in a conversation ' +
      'the agent dictates the presentation itself — a revision too, and the pictures already ' +
      'drawn for the previous deck carry over into the new one — while a contour or an own ' +
      'endpoint dictates it only outside a conversation.',
    worksHonestTitle: 'How the shim differs from real tools',
    worksHonestText:
      'It is a protocol on top of a foreign one, and it is weaker than the vendor’s: a call ' +
      'carries no identifier, parallel calls do not arrive in one turn, and an unparsable ' +
      'block does not become a call at all — it stays in the answer as text, and the request ' +
      'trace says why. What runs is a call written with the protocol tags, plus an answer that ' +
      'is ENTIRELY one call — that is how models trained on the vendor function format reply. A ' +
      'call shown as an EXAMPLE inside a code block never runs, even a correct one: a quote of ' +
      'the protocol and a documentation file the agent has just read out to you look exactly ' +
      'the same. A code block is what Markdown calls one: a line of its own made of three or ' +
      'more backticks or tildes; backticks in the middle of a sentence open no block and do not ' +
      'silence a real call below them. The request trace names such a block as the reason, so ' +
      'that “no calls” is not ' +
      'read as a broken panel. ' +
      'The panel runs nothing whose name and arguments it could not parse: a ' +
      'wrong parse must not hand the agent the right to do something the model never asked ' +
      'for. If you do not need the shim, switch it off on the contour: the CLI keeps working ' +
      'as an agent through its own usual key, and the contour does not stand in the way. Runs ' +
      'that go THROUGH a contour which does not accept a tools field are left without hands ' +
      'after that: the list is dropped at the entrance, the model never sees it and has ' +
      'nothing to call. The “Tools through the contour” card counts such requests on a line of ' +
      'their own and names the switch — from the outside this is indistinguishable from a lazy ' +
      'model, and without that line people go fixing the panel.',

    shimTitle: 'Tools through the contour: how it works and what it costs',
    shimCaption:
      'On the company platform the shim is on by default. On a compatible gateway it is off: that gateway ' +
      'accepts tools as a request field, and the panel passes them through as real calls, ' +
      'with no protocol text. The contour type sets the default when you connect — and so ' +
      'does the tool probe at activation, when the model does not call through the field; ' +
      'after that the switch is yours, and neither changing the type of a saved contour nor a ' +
      'new probe rewrites it. The wizard has a third answer too — “as a request field the ' +
      'model ignores”: the gateway takes the field, no calls come back through it, and such a ' +
      'contour gets the shim on from the start. ' +
      'Here is what goes up with the shim on, what comes back and the price you pay on every ' +
      'turn.',
    shimColumn: 'What',
    shimMeaningColumn: 'How',
    shimUp: 'What goes up',
    shimUpText:
      'The protocol rules and your tool schemas — as text, inside the system message. There is ' +
      'no tools field in the request at all, and no client tool choice either. The company platform gets ' +
      'tool choice switched off: the platform picks its own set, and left on it would ' +
      'override the protocol we just taught the model. A compatible gateway gets nothing ' +
      'beyond the text.',
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
      'characters and 154 KB. The figure grows with the tool set: a run with 30 tools gave ' +
      '77 thousand characters. Same order either way: tens of kilobytes for every step the ' +
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
      'errs both ways, and the panel will not block a turn on such a guess. Under the last ' +
      'agent turn through the contour the chat (Claude and a foreign CLI alike) says so when ' +
      'the turn had no tool calls at all, and — with the shim off — when the whole answer is a ' +
      'call written as text: it was not executed. The model card recalls the threshold: an ' +
      'agent that edits files is verified on models from 27B; a model whose name carries a ' +
      'smaller size gets a yellow caption.',

    summarizedTitle: 'The contour compressed history',
    summarizedCaption:
      'A conversation longer than the model limit is shortened by the contour itself: its start ' +
      'is replaced with a summary, and the model answers without seeing the original text. The ' +
      'panel cannot switch this off — it is the signed compromise “context-managed”. The panel ' +
      'learns about a compression from a service frame in the answer stream and says so where ' +
      'you read the answer.',
    summarizedColumn: 'Where it shows',
    summarizedMeaningColumn: 'What it says and how the answer is found',
    summarizedClaude: 'Claude chat',
    summarizedClaudeText:
      'A caption under THE answer the contour compressed history before. The answer is found by ' +
      'message id: the gateway issues it to the client itself, Claude Code writes it to the ' +
      'transcript, and the feed matches it against the compression log. Neighbouring answers get ' +
      'no caption.',
    summarizedForeign: 'Foreign CLI chat',
    summarizedForeignText:
      'A caption “while this answer was prepared, the contour compressed history”. Every message ' +
      'goes to the gateway with its own run tag in the address, so a compression in another chat ' +
      '— even at the same time through the same contour — never lands here. It cannot be tied ' +
      'closer than the run: one foreign CLI answer can take several requests.',
    summarizedPhone: 'Phone',
    summarizedPhoneText: 'The same caption under a Claude answer as in the web chat.',
    summarizedCard: '“Tools and checks” tab',
    summarizedCardText:
      'The “The contour compressed history” card: how many cases the log holds, the last ten, and ' +
      'for each whether an answer was marked. A request that came from outside the panel chats (a ' +
      'terminal, a CLI configured through the section) has nowhere to be marked — it shows up ' +
      'only here.',
    summarizedLimitsTitle: 'What the caption does not know',
    summarizedLimitsText:
      'What exactly went into the summary the panel cannot see — the contour compresses, and only ' +
      'the fact comes out. The compression log keeps the last 500 cases on disk and survives a ' +
      'panel restart; older ones lose their caption. Conversations that went through the contour ' +
      'before the log existed get no captions.',

    errorsTitle: 'Refusals and what to do',
    errorsCaption:
      'The codes come from the contour, and the panel turns them into a reason in the ' +
      'interface language — the same text the refusal carries to your CLI. Here ' +
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
    err402Badge: 'key budget',
    err402:
      'Your key’s budget is exhausted — on the routes the panel uses, the platform issues 402 ' +
      'for this reason only. A platform administrator raises the budget, or it resets with the ' +
      'key’s new period if one is set. Within half a minute the platform starts rejecting the ' +
      'same key with a 401.',
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
      'The narrowest action of all: “Configure” → “Where the contour works” → clear the tick. It ' +
      'takes effect from the NEXT start — runs already going are left alone, the panel will ' +
      'not stop someone’s work over a setting. The other consumers stay on the contour, and ' +
      'no CLI file changes at all. Two caveats, both stated on screen: clearing “Panel ' +
      'assistant” moves the assistant back to its previous profile at once — that is a panel ' +
      'setting, not a run variable, and it has no next launch to wait for; and if the same ' +
      'CLI has its files applied, its runs read the contour address from its own config, so ' +
      'clearing the box will not bring them back — “Undo the apply” will.',
    disableStep1: '“Undo the apply”',
    disableStep1Text:
      'The CLI files go back to their previous values and the managed profile disappears. The ' +
      'contour itself stays connected: the panel’s assistant and the bridge keep working. A ' +
      'file you edited after the apply is left alone and named.',
    disableStep2: '“Back to the default provider”',
    disableStep2Text:
      'The contour stops being active and the gateway stops serving it: the connection is still ' +
      'accepted, but the answer is a 502 saying “the contour is switched off in the panel” — the ' +
      'contour is down, not the panel. The settings, the key and the spend history stay in place: ' +
      '“Make it active” brings the work back to it. The same button sits in Settings → Models, ' +
      'in the Custom endpoint card — the same action, not a second one.',
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

      adminTitle: 'First half: the contour admin',
      adminCaption:
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
        'Four wizard steps and what happens after them. While the wizard is open nothing is ' +
        'applied and nothing goes anywhere; “Done” saves the contour, makes it active and ' +
        'asks the model a test question right away.',
      pEmpty: 'Open the “Contour” section',
      pEmptyText:
        'Before connecting there is one button and an explanation of what will happen. The ' +
        'section sits next to “Data protection” for a reason: they share one question — where ' +
        'does the request go.',
      pAddress: 'Step 1: contour type, title and address',
      pAddressText:
        'The type is “Company platform”; the title is arbitrary. ' +
        'The identifier is built from the title in Latin letters — a title in another script ' +
        'leaves it empty and “Check the connection” stays disabled, so check it and type it ' +
        'in yourself if needed, company-stand ' +
        'on the screenshot: the local gateway address is built from it. The address is the public API ' +
        'root, http://127.0.0.1:5300 on the screenshot (a stand behind a port-forward); ' +
        'yours will be your instance’s address. The panel appends /v1 itself when the path has ' +
        'no version. For the company platform leave both collapsed blocks under the address alone. ' +
        '“Non-standard gateway” is for gateways that expect the key somewhere other than ' +
        'Authorization: Bearer, or an address without /v1, and it also shows the final address ' +
        'the check will use. “What the gateway can do” holds the native Anthropic endpoint, the ' +
        'image endpoint, the thinking field, tools, effort, the whole-answer limit and the ceiling ' +
        'for any answer (a gateway or proxy that cuts even a stream on a clock — the panel names a ' +
        'declared ceiling when the cut happens) on top of what the type declares. Types other than the company platform are gateway presets (LiteLLM, vLLM, ' +
        'Ollama, OpenRouter, Azure OpenAI, DashScope, Together AI): each carries what was checked ' +
        'against the gateway docs, with the link in that same block. Azure OpenAI, for example, ' +
        'puts the key into the api-key header itself.',
      pProbe: 'At this step the probe still has no key',
      pProbeText:
        'Pressed before the second step, “Check connection” answers “the address is right, a key ' +
        'is needed”: the contour refused without a key, and that refusal is exactly what confirms ' +
        'the address is a model API and not an admin console. “Key rejected” does not appear here ' +
        '— there is nothing to reject; the panel keeps that word for a key the contour really ' +
        'refused. The real connection check happens at the third step.',
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
        'environment. Unticking the box hides the list, remembers the CLIs ticked in it and ' +
        'leaves the files already written ' +
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
        'http://127.0.0.1:5179/company-stand/v1. The dashes next to the consumers stay to the very ' +
        'end: the contour is switched on only by “Done”, and until then the row honestly says ' +
        'there is nothing to apply yet. A forgotten button does not break the connection: ' +
        'activation raises a stopped gateway itself, and one that fails to start names the reason ' +
        'in the smoke-request line. If the gateway goes down later, the active contour’s card says ' +
        '“The panel gateway is down” and keeps the same button right there — no trip to the wizard.',
      pCard: 'Done: the contour is active and has already answered',
      pCardText:
        'On “Done” the new contour becomes active at once, and the panel immediately asks the ' +
        'model through its own gateway — the same way the CLIs will go. On the screenshot that ' +
        'is the “active” badge, the “online” state and the line “Test request went through”, ' +
        'with the model’s answer, the delay and qwen2.5:0.5b. EVERY new contour becomes active, ' +
        'even when another one was working before it: the previous one goes dark but stays ' +
        'configured. “Configure” on a connected contour opens the same wizard, and there ' +
        '“Done” only saves the edit. On an inactive contour “Done” closes the wizard and a toast ' +
        'names whatever was not written; the wizard stays open only for a taken place that needs ' +
        'the overwrite tick.',
      pSpend: 'Make one short request',
      pSpendText:
        'Any CLI pointed at the gateway, or the panel assistant; two characters such as “2+2=” ' +
        'are enough. The gateway collects spend and writes it in batches every few seconds, ' +
        'so it does not appear on the card instantly. For a model our price book has no price ' +
        'for, the sum stays at “≈ 0.00 $”, and a line below names whose tokens were left out of ' +
        'the money — you enter the price of such a model by hand in the settings. This step has ' +
        'no screenshot yet, and that is not a gap in the shoot: with the live stand no spend ' +
        'appeared on the card — the gateway does not recognise the frame in which the company platform sends ' +
        'the usage in a stream. Until that is fixed, compare spend in the admin analytics, at ' +
        'step eight.',

      useActiveTitle: 'Next: the contour is active',
      useActiveCaption:
        'Which contour the work goes through always has one answer. Four screens around that ' +
        'answer: a test request that went through, a red one, switching to another contour and ' +
        'going back to the usual provider.',
      aSmoke: 'The test request went through',
      aSmokeText:
        'The line under the address is the result of a question the panel asked the model ' +
        'itself: the answer in quotes, the delay, the model name and when it was asked. It goes ' +
        'through the panel’s gateway, so a green line proves the whole CLI path, not just that ' +
        'the contour is alive. Further down, in “Applied to”, the panel assistant has a tick, ' +
        'the CLIs that can be applied have circles, and the rest have dashes with a flag ' +
        'carrying the reason.',
      aSmokeRed: 'The test request did not go through',
      aSmokeRedText:
        'This frame is from the scripted contour, stopped before activation. The activation ' +
        'still happened — the “active” badge is in place — and the cause is written twice: at ' +
        'the connection state as “no connection to the contour: fetch failed”, and at the test ' +
        'request as “The test request through the gateway did not go through” with the ' +
        'gateway’s 502. Under the address is the last successful check, at the bottom of the ' +
        'screen a notification. A red line does not undo the activation on purpose: a gateway ' +
        'that is down, a key that ran out and a silent model are fixed in different places, ' +
        'and there is nothing to roll back on your behalf.',
      aSwitch: 'Another contour: “Make it active”',
      aSwitchText:
        'Connect one more and it becomes the active one, while the previous one goes dark: its ' +
        'card says “not active” and carries a “Make it active” button. Its key, budget and ' +
        'settings are all in place; only its applies are gone — the CLI files returned to their ' +
        'previous values, and every entry in “Applied to” is a dash. The button does the same ' +
        'in reverse, as one action, and asks the model a test question again. On the ' +
        'screenshot the previous contour is the stand, the new one the scripted contour.',
      aReturn: 'Back to the default provider',
      aReturnText:
        'The button sits on the contour card, and the same button sits in Settings → Models, ' +
        'in the profile the contour created itself: that profile’s address is the local ' +
        'gateway with the contour identifier, its model the contour model. The action is the ' +
        'same in both places: the applies are removed, the badge goes dark, the panel and the ' +
        'CLIs stay on the usual provider. The profile fields can be edited by hand, but an edit ' +
        'sends the CLI past the contour — it says so above the button.',

      useRouteTitle: 'Which model the request leaves with',
      useRouteCaption:
        'The panel and the contour name models differently. Two screens: where that is set ' +
        'up, and where it is visible before anything is sent.',
      rModel: 'Contour model: default, per consumer, name map',
      rModelText:
        'The default model goes into the CLI configs and the assistant profile; if you did not ' +
        'choose one, the first suitable model of the catalogue is taken, and the field says so. ' +
        'Below is a model of its own for a consumer, for when one key serves both the ' +
        'conversation and the tests (on the screenshot chat is the only run consumer switched ' +
        'on). The name map answers what “sonnet” means for you: a run given a vendor model in ' +
        'the chat header leaves with that name, and without a row in the map it is replaced ' +
        'with the contour model. The last line of the card says the contour takes no reasoning ' +
        'effort.',
      rHeader: 'The chat header says it before sending',
      rHeaderText:
        'Under the model picker there are two lines: “Through the "<your title>" contour: ' +
        'qwen2.5:0.5b.” and “takes no reasoning effort — it is not sent.” That is what really ' +
        'leaves: the header’s model list holds vendor names, and through a contour the name map ' +
        'translates them. A name that is neither in the map nor in the key catalogue is ' +
        'replaced with the contour model, and the caption then says “no "…" there, the request ' +
        'goes with …”. The same function the server uses computes it, so the caption and the ' +
        'real request cannot drift apart.',

      useRulesTitle: 'What is done to the request on the way',
      useRulesCaption:
        'The “Rules” tab in three parts: on the left what the panel manages on the contour side, ' +
        'on the right what we do ourselves, under them where the two sides collide. The ' +
        'screenshots predate the split into columns; the content is the same.',
      ruPanel: 'Managed by the panel',
      ruPanelText:
        'What the panel sends the contour with every request: the platform tool set, the loop ' +
        'of their calls, the generation preset, the model’s thinking. The notes under the ' +
        'fields say why a field has no effect right now: the tool set is locked while our shim ' +
        'is on, and the loop mode is not sent while no tool names are set. The preset on the ' +
        'screenshot is balanced; an empty field means “the contour uses its own”.',
      ruOurs: 'Our side: the shim and the layers',
      ruOursText:
        'The first switch is the tool shim; the next section is about it. Under it, “Our ' +
        'layers in the run”: what of your ~/.claude travels into a run through this contour — ' +
        'personal rules with hooks and permissions, skills, MCP servers and the panel’s ' +
        'addition to the system prompt. Each switch names the real Claude Code flag that ' +
        'removes the layer and says what goes with it: personal settings, for instance, take ' +
        'your deny rules along. What you remove saves prompt, but the agent loses your rules, ' +
        'and nothing in the answer shows it.',
      ruConflicts: 'Conflict matrix',
      ruConflictsText:
        'Four pairs of “their mechanism ↔ ours”. There is exactly one mutual exclusion: the ' +
        'platform tools and our shim — two tool sets on one turn, so pick one. The warning is ' +
        'the contour compressing history next to our checkpoints: after compression a ' +
        'continuation may not know how the task began, and the row says both sides are on ' +
        'right now. The two “for information” rows exist precisely so that nothing gets ' +
        'switched off: data masking and content checks stack in order rather than compete.',

      useAgentTitle: 'An agent that edits files',
      useAgentCaption:
        'The company platform does not accept the client’s tools, so the panel’s shim carries them (a ' +
        'compatible gateway gets them as a field, without it). The ' +
        'diagram shows how one turn works; the frames show two outcomes on the scripted contour ' +
        'and one honest failure on the live stand.',
      agCall: 'The call ran: the file is on disk',
      agCallText:
        'The scripted contour answered with a Write call in protocol tags. The shim rebuilt a ' +
        'real call out of it, and Claude Code itself ran it — with its own permissions, as with ' +
        'the vendor: the conversation shows a Write chip followed by the answer. The shoot ' +
        'checks the file on disk, not the text on screen: no file, no frame. The header reads ' +
        '“Through the "Scripted contour" contour: stub-tool-shim.”',
      agQuote: 'An example in a code block does not run',
      agQuoteText:
        'The same call, shown as an example in a code block, stays text: there is no Write ' +
        'chip, and the shoot checks that the file is absent. A quoted protocol and a ' +
        'documentation file the agent has just read look exactly like this — running them would ' +
        'be more dangerous than missing a real call. Every such block is named as a reason in ' +
        'the request trace.',
      agCard: 'The shim card counts both outcomes',
      agCardText:
        'On the “Tools through the contour” card: “turns with tools: 1”, “1 calls across 3 ' +
        'requests with tools”, and a separate row saying a call inside a code block is not run, ' +
        '1 time. The count comes from the gateway trace: the trace is capped in length, and a ' +
        'panel restart clears it entirely — it says so under the count.',
      agLive: 'The live stand: the model made no call',
      agLiveText:
        'The same “create hello.txt” request through the real stand with qwen2.5:0.5b. The ' +
        'protocol is declared to the model, but half a billion parameters cannot hold on to it: ' +
        'the answer is a numbered list repeated two hundred times, and not a single call. No ' +
        'file. This is neither a panel fault nor a rarity: a weak model talks about or ' +
        'describes the action but does not do it, and whether a model answers with a call is ' +
        'up to the model.',
      agLiveCard: 'The card after such a run',
      agLiveCardText:
        '“Requests with tools did go through, but the model made no call and claimed no action ' +
        'in words.” The “described in words” mark is a guess from the answer text, not a ' +
        'verdict: it did not fire on an incoherent list, and it errs both ways. The panel does ' +
        'not block a turn without a call.',
      agPriceTitle: 'The price of every turn',
      agPriceText:
        'The contour has no prompt cache, so the tool schemas travel afresh on every turn: 24 ' +
        'Claude Code tools are about 58 thousand characters of system text and 86 KB of request ' +
        'per agent step. That is why a run through a contour uses the panel’s short prompt by ' +
        'default, and why the shim is worth switching off on a contour you only use for text. ' +
        'Details in the “Tools through the contour” section below.',

      useMediaTitle: 'Images',
      useMediaCaption:
        'An image is drawn by the panel, not by the CLI, and only where the key catalogue ' +
        'declares a drawing model. Two frames from the stand, which has no such model, and two ' +
        'from the scripted contour, which does.',
      mRow: 'The “Image generation” row',
      mRowText:
        'On the contour card, under “What is available”. For the stand key it says no — no ' +
        'drawing models were granted to the key — confirmed by the probe. While it says no, ' +
        'there will be no raster image through this contour, and the panel does not guess a ' +
        'generation address: a guessed address would answer 404 only after you had described ' +
        'the picture.',
      mMenu: 'The mode menu without a drawing model',
      mMenuText:
        'The “Message” button under the input opens the modes. “Image” is named honestly here: ' +
        '“The conversation agent draws it: vector code, not a photo · no raster: the key ' +
        'catalog holds no image model”. So you get a diagram or an illustration in code, not a ' +
        'photograph. “Presentation” says “The conversation agent dictates the slides”.',
      mStubMenu: 'The mode menu when there is a model',
      mStubMenuText:
        'The scripted contour’s key catalogue has a drawing model, and “Image” names it ' +
        'outright: “Scripted contour · stub-image”. The same caption appears under the input, ' +
        'and the input asks: “Describe the image — the panel draws it itself, without the ' +
        'agent”.',
      mCard: 'An image is a card, not a message',
      mCardText:
        'The description “A lighthouse on a cliff at dusk, watercolour” went through the ' +
        'panel’s gateway — so the request is in the gateway journal (in the key’s spend if the ' +
        'contour sent a bill). The image ' +
        'lands as a card in the right-hand column: size, weight, “Drawn by stub-image · ' +
        'contour, part of the answer” and your description under it. It does not enter the ' +
        'conversation: the transcript is Claude Code’s file, and the panel writes not one line ' +
        'into it. The image itself is a file in the panel’s data; there is no gallery. The ' +
        'lighthouse on the screenshot came from a stub: there is no model behind the scripted ' +
        'contour.',
      mDecksTitle: 'Presentations — no frame of their own',
      mDecksText:
        'A deck asks the contour for no capability: the panel asks the model for the slide ' +
        'structure with an ordinary chat request and builds HTML, PPTX and PDF on your machine. ' +
        'Only the photographic slide images depend on the contour — they are drawn the same way ' +
        'as in the frames above. A sentence around the structure the panel drops by itself; an ' +
        'answer with no structure at all it names in the model’s own words.',

      useEndTitle: 'When the contour is no longer needed',
      useEndCaption:
        'Four actions of different strength are covered below, in “How to switch it off”. ' +
        'Here is the harshest one.',
      pDelete: 'Deletion',
      pDeleteText:
        'Deletion asks for the contour title in full, while the apply is removed before it by ' +
        'itself, returning the CLI files to their original state. The settings, the key and ' +
        'the check trace go; the “before” copies in “History” and the spend already counted ' +
        'stay.',

      shotsTitle: 'Where these screenshots come from and why they can be trusted',
      shotsText:
        'The frames are taken by a run of their own. The admin and most of the panel come ' +
        'from a live company platform stand with the local qwen2.5:0.5b model; the panel there is a ' +
        'throwaway copy with its own config directory, so that nobody’s working stand is ' +
        'touched. What the stand cannot show — a successful tool call, a drawing model, a ' +
        'contour gone dark — was shot on the scripted contour: a stub from the panel’s own ' +
        'checks that answers with pre-recorded turns, and the steps call it exactly that. ' +
        'Everything else in those frames is real: the panel, its gateway, Claude Code and the ' +
        'file on disk. Keys, tokens and emails are masked in the markup BEFORE the shot, and the ' +
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
      '11-wizard-probe': 'A probe with no key answers “the address is right, a key is needed”',
      '12-wizard-key': 'Step 2: the key. A stored one is never shown again, anywhere',
      '13-wizard-capabilities': 'Step 3: what the probe confirmed, and what stayed “not declared”',
      '14-wizard-targets':
        'Step 4: consumers, mode, budget. The dashes stay until “Done” — the contour is still off',
      '15-wizard-gateway': 'The gateway is up on 127.0.0.1:5179 — now CLIs have somewhere to point',
      '16-panel-card': 'Right after “Done”: the contour is active, the test request went through',
      '18-panel-delete': 'Deleting asks for the title; the apply is removed before it by itself',
    },
    activate: {
      '01-smoke-ok': 'The active contour card: the model’s answer to the test request, delay, name',
      '02-return-settings':
        'Settings → Models: the profile the contour created, and the same way back to the provider',
    },
    route: {
      '01-model-card': 'Contour model: the default, per consumer, and the name map',
      '02-chat-header':
        'The chat header before sending: which contour and model the run leaves with, no effort',
    },
    rules: {
      '01-rules-panel': 'Managed by the panel: platform tools, the loop, the preset, thinking',
      '02-rules-ours': 'Our side: the tool shim and the ~/.claude layers with their real flags',
      '03-rules-conflicts':
        'Conflict matrix: one mutual exclusion, one warning, two rows for information',
    },
    agent: {
      '01-chat-run': 'The live stand, a 0.5B model: a numbered list instead of a call — no file',
      '02-shim-card': 'The shim card after such a run: requests went through, no calls were made',
    },
    media: {
      '01-capability-row': 'The capability row for the stand key: no drawing models were granted',
      '02-mode-menu': 'The mode menu on the stand: the agent draws in code, no raster — and why',
    },
    scripted: {
      '01-shim-call':
        'Scripted contour: a call in protocol tags run by the real Claude Code — the file is on disk',
      '02-shim-quote': 'Scripted contour: the same call as an example in a code block did not run',
      '03-shim-card': 'The shim card: one real call and a code block named as the reason',
      '04-image-menu': 'Scripted contour: the key has a drawing model, and “Image” leads to it',
      '05-image-card':
        'A drawn image is a card in the right-hand column, not a conversation message',
      '06-switch-button': 'The previous contour after a new one: “not active”, “Make it active”',
      '07-smoke-red':
        'Scripted contour stopped: activation went through, the test request is red, cause named',
    },
  },
  diagrams: {
    'request-path':
      'The path of one request: CLI → the panel’s local gateway → the contour → the model. The key appears at exactly one point on it.',
    'who-creates-what':
      'What gets created in the contour admin, what in the panel, and which two lines cross the border.',
    'two-systems':
      'The two systems side by side: the panel’s parts against the company platform instance services, and the three arrows that cross the border between them.',
    'tool-shim':
      'One agent turn through the shim: tool schemas travel as text, the call is rebuilt from the answer, and a code block never runs.',
  },
};
