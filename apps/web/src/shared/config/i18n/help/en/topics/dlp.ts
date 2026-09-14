import type { dlpRu } from '../../ru/topics/dlp';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const dlpEn: typeof dlpRu = {
  topic: {
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
      'A surname becomes [NAME_1] in the request; [NAME_1] becomes the surname again in the ' +
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
      'The ready-made set — twenty built-in patterns: email, phones, INN, SNILS, OGRN, ' +
      'passports, cards, IBAN, crypto wallets, IP and MAC addresses, UUID, URL, a login with a ' +
      'password in an address, JWT and secret keys. For a set built earlier the section names ' +
      'the missing patterns and adds them with one button. INN, SNILS, OGRN, card numbers and ' +
      'IBAN are checksum-verified: without that, the rule would catch any number of the ' +
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
      'address the proxy will not start — it will not guess the vendor cloud for you. Port and ' +
      'address are saved on Enter or when the field loses focus; any settings change restarts ' +
      'a running proxy, and placeholder numbering starts over.',
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
      'Email, phones, INN, SNILS, OGRN, Russian and Uzbek passports, cards, IBAN, crypto ' +
      'wallets, IPv4 and IPv6, MAC, UUID, URL, a login with a password in an address, JWT, ' +
      'secret keys. Wherever the format has a checksum, it is verified. A pattern that catches ' +
      'too much becomes your own expression with the same text via “Turn into my own ' +
      'expression” — but the expression no longer carries the checksum.',
    kindTerms: 'Own dictionary',
    kindTermsText:
      'A list of values: surnames, names, addresses. Case-insensitive, whole words; Russian ' +
      'inflections are covered — "Петрова" matches "Петров", while "Петровский" does not ' +
      'match "Петров".',
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
    actionMaskBadge: '[NAME_1]',
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
      'system, message texts, tool-result contents and string arguments of tool calls — both ' +
      'in a whole body and in a stream. Thinking blocks are left alone: they carry a ' +
      'signature, and editing would break the reply.',
    shapeOpenai:
      'Message contents and function-call arguments — also both in a whole body and in a ' +
      'stream. The same parsing serves any OpenAI-compatible gateway.',
    shapeArgsTitle: 'Call arguments are a special case',
    shapeArgsText:
      'Arguments arrive as JSON PACKED into a string, and the reverse substitution knows it: ' +
      'the value is escaped by JSON rules as it returns in place of the placeholder. Otherwise ' +
      'a path like `C:\\Users\\…` or a quote inside the value would make the call unparsable ' +
      'and the agent would lose it entirely — and with no substitution in arguments at all it ' +
      'would write `[EMAIL_1]` into the file instead of the address.',
    shapeOther: 'Everything else',
    shapeOtherText:
      'An unfamiliar path or a non-JSON body — this includes Gemini, whose shape the panel ' +
      'does not parse. Such a request is refused by default; passing it through can be ' +
      'enabled separately, and every pass-through lands in the journal.',
    shapeRefused: 'refused',

    filesTitle: 'Exact paths',
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
      'Restoration works on exact text. If the reply says "name 1" instead of [NAME_1], or ' +
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
      'there; the panel keeps no hidden mechanism. Changing the action rewrites the panel’s ' +
      'script; a hand-edited file is left alone — “Restore the panel’s script” brings it back. A ' +
      'script built by an earlier panel version is not treated as a hand edit: the card says the ' +
      'new patterns are missing from it, and “Rebuild the script” writes the current one.',

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

    guideTitle: 'What this document holds',
    guideText:
      'A diagram of what the proxy sees and what the gate sees; two paths — bringing the ' +
      'proxy up and installing the gate; what the section is NOT; what it writes on disk ' +
      'and what it never writes; limits and refusals quoted with their status codes.',

    seenMapTitle: 'What the proxy sees and what the gate sees',
    seenMapCaption:
      'The two tools watch DIFFERENT places, and that is the thing to understand before ' +
      'configuring either: one stands on the wire, the other on the human’s keyboard.',
    pathTextTitle: 'The same path in words',
    pathTextText:
      'The proxy is a local listener on 127.0.0.1 that the CLI treats as its model. It ' +
      'sees the whole BODY of every request: the typed text, the files the agent read, ' +
      'command output, subagent prompts — edits it by the rules and forwards it on. The ' +
      'gate is a UserPromptSubmit hook; it fires earlier and sees ONLY what the human ' +
      'typed, and it cannot replace the text, so it has two actions: reject or warn. ' +
      'Whatever the agent reads by itself is the proxy’s business alone.',

    guide: {
      firstTitle: 'Path: bring the proxy up and watch what it does',
      firstCaption:
        'The “Data protection” section. Seven frames: the empty section, the rules, the ' +
        'sample-text check, the running proxy, the journal and the counters.',
      firstEmpty: '1. The section before the first rule',
      firstEmptyText:
        'The proxy is stopped and there are no rules. Two fields already decide ' +
        'everything: the listener port (127.0.0.1 only — it is never published outward) ' +
        'and where to forward. An empty address is taken from the selected endpoint ' +
        'profile: the proxy and your own address stack.',
      firstStarter: '2. The built-in sample is a quick start, not a guarantee',
      firstStarterText:
        'The “Built-in sample” button adds ready rules: phone numbers, cards, emails, ' +
        'secret keys. Each states plainly what it catches and what it does not — a set of ' +
        'regular expressions understands no meaning and catches shape.',
      firstTerms: '3. Your own dictionary catches what no expression will',
      firstTermsText:
        'Surnames, project names, internal system names — that is a list of words, not a ' +
        'pattern. The same value always gets the same placeholder, so the model sees ' +
        'coherent text rather than a soup of different numbers.',
      firstPreview: '4. The sample-text check — before saving and without the network',
      firstPreviewText:
        'The field shows exactly what the model would see: “Check order [ДАННЫЕ_1], phone ' +
        '[ТЕЛЕФОН_1], card [КАРТА_1]”, with “3 replacements” broken down by rule beside ' +
        'it. It is computed from the current, still unsaved edits and goes nowhere.',
      firstRunning: '5. The proxy is up — the address for the CLI is on screen',
      firstRunningText:
        'The panel names the address (http://127.0.0.1:5397 in this frame) and says it can ' +
        'be handed to a CLI as an endpoint profile. The counters are still zero. “Pass ' +
        'unparsed” is off: a request whose body the panel did not parse is refused — a ' +
        'proxy that silently passes what it does not understand is worse than none.',
      firstJournal: '6. The journal: rule, placeholder and count — no values',
      firstJournalText:
        'Two lines from one run: “blocked” by the “Secret keys” rule and “masked” with the ' +
        '[ДАННЫЕ_1] and [ТЕЛЕФОН_1] placeholders. The values themselves are not there and ' +
        'never will be — otherwise the journal would hoard what is being protected.',
      firstCounters: '7. The counters answer “is it actually working”',
      firstCountersText:
        '“requests: 2 · masked: 1 · blocked: 1” — one number per outcome. They are how you ' +
        'confirm the CLI really goes through the proxy: zero requests means the address in ' +
        'the CLI is not this one.',

      gateTitle: 'Path: install the gate on the prompt',
      gateCaption:
        'The second tool, lower in the same section. Four frames: the card before ' +
        'installing, after, the generated hook and the refusal on a foreign CLI.',
      gateOff: '1. The card lists its blind spots outright',
      gateOffText:
        'Before installing it already says what the gate cannot see by design: files the ' +
        'agent read, command output, subagent prompts. And that it cannot replace the ' +
        'prompt text — the event does not allow it. Next to that, the count of rules ' +
        'shared with the proxy: “7 enabled, 1 of them blocking”.',
      gateOn: '2. Installed — and the script path is visible',
      gateOnText:
        'The panel generates the hook script and shows its path: the file can be opened ' +
        'and read. The default action is picked right there — reject the prompt, or warn ' +
        'and send.',
      gateHook: '3. The same hook in the “Hooks” section',
      gateHookText:
        'The gate is an ordinary UserPromptSubmit hook, not hidden machinery: it appears ' +
        'in the general list with its description and a “generated by AgentDeck” ' +
        'note. The file can be edited by hand — the panel will notice the divergence.',
      gateClaudeOnly: '4. On a foreign CLI the button is disabled — with the reason',
      gateClaudeOnlyText:
        '“The gate is installed into Claude Code’s configuration: other CLIs document no ' +
        '‘prompt submitted’ event that can refuse. Switch the provider to Claude to enable ' +
        'it.” The proxy meanwhile works for everyone: it is on the wire, not inside a CLI.',
    },

    notTitle: 'What this section is not',
    notCaption:
      'A protection tool whose limits went unmentioned is worse than none: here they are named.',
    notColumn: 'Not here',
    notMeaningColumn: 'How it actually works',
    notDlpSuite: 'Not an enterprise DLP',
    notDlpSuiteText:
      'No org-wide policies, no reporting, no enforcement: the rules live on this machine, ' +
      'and whoever switched the proxy on can switch it off.',
    notSmart: 'Not an understanding of meaning',
    notSmartText:
      'Matching is by shape — a word list and regular expressions. A secret retold in your ' +
      'own words goes out intact, and no set of rules will close that.',
    notTls: 'Not decryption of other traffic',
    notTlsText:
      'The proxy does not break TLS and does not sit between unrelated applications and ' +
      'the network. It only handles the CLI that was pointed at it.',
    notAudit: 'Not an audit trail',
    notAuditText:
      'The journal keeps the rule, the placeholder and a count — and only the last 500 ' +
      'lines. Reconstructing what actually left is impossible by design.',
    notGateProxy: 'The gate is not a substitute for the proxy',
    notGateProxyText:
      'The hook sees only text typed by the human. Everything the agent read itself passes ' +
      'by it, and only the proxy covers that.',

    storageRules: 'Rules',
    storageRulesValue: 'agentdeck/dlp-rules.json (one file for the proxy and the gate)',
    storageJournalFile: 'Journal',
    storageJournalValue: 'agentdeck/dlp-journal.jsonl, the last 500 lines',
    storageSettingsRow: 'Port, address and toggles',
    storageSettingsValue: 'agentdeck/state.json → dlp',
    storageHook: 'The gate script',
    storageHookValue:
      '<config directory>/hooks/agentdeck-prompt-gate.mjs plus an entry in settings.json',
    storageNever: 'What never reaches disk',
    storageNeverValue: 'The values themselves, request bodies, and the placeholder → value mapping',

    canProxy: 'Bring a local proxy up on 127.0.0.1 and forward requests onward',
    canMask: 'Replace a match with a placeholder, the same one for the same value',
    canRestore: 'Put the real values back into the model’s reply',
    canBlockReq: 'Stop a request entirely — a 403 in the API’s own error shape',
    canPreviewText: 'Show on sample text what the model will see, before saving and offline',
    canGate: 'Install a hook on the human’s prompt in Claude Code — reject or warn',
    cantUnderstand: 'Recognise a secret retold in different words',
    cantForeignTraffic: 'See traffic from applications that were never pointed at the proxy',
    cantGateForeign: 'Install the gate on a CLI that documents no prompt-submit event',
    cantGateReplace: 'Replace the prompt text in the gate — the event does not allow it',
    cantRestoreLog: 'Reconstruct from the journal which data left',

    refusalsTitle: 'Refusals and what they mean',
    refusalsCaption: 'Exactly what the CLI receives or the panel shows, and what to do about it.',
    refusalsColumn: 'What is shown',
    refusalsMeaningColumn: 'Reason and way out',
    refusalBlocked: '“the request was stopped by rule ‘…’” (403)',
    refusalBlockedText:
      'A rule with the “block” action matched. The refusal arrives in the API’s own error ' +
      'shape, so the CLI prints it as text rather than “unexpected response”. The journal ' +
      'carries a “blocked” line with the rule name.',
    refusalUnknown: '“…, request stopped (the ‘pass unparsed’ setting is off)”',
    refusalUnknownText:
      'The body was not parsed: a foreign path, not JSON, or an unfamiliar schema. Turn ' +
      'the toggle on if you trust that channel — but then the unparsed goes through as is.',
    refusalTooBig: '“the request body is too large” (413)',
    refusalTooBigText:
      'Over 32 MB. The proxy will not parse a body that size in memory — it could neither ' +
      'pass nor check it honestly.',
    refusalUpstream: '“the model address is not responding”',
    refusalUpstreamText:
      'The proxy got as far as forwarding and the destination is silent. Check the ' +
      '“Forward to” field, or the endpoint profile it is taken from.',
    refusalGateProvider: '“Switch the provider to Claude to enable it”',
    refusalGateProviderText:
      'The gate is installed into Claude Code’s configuration; other CLIs document no ' +
      '“prompt submitted” event that can refuse. The proxy works for all of them.',
    refusalGateUnsure: '“The prompt was NOT checked”',
    refusalGateUnsureText:
      'The rules file cannot be read, or the hook input shape is unfamiliar. The prompt ' +
      'goes through: a script that blocks every prompt after a format change gets switched ' +
      'off along with the protection.',
  },

  shots: {
    first: {
      '01-empty':
        'The section before the first rule: the proxy stopped, the port on 127.0.0.1 only, no forward address',
      '02-starter':
        'The built-in sample added: ready rules with an honest “what it catches and what it does not”',
      '03-terms':
        'Your own dictionary: a word list instead of a pattern — surnames, projects, internal names',
      '04-preview':
        'The sample-text check: “3 replacements” and the line the model will see — before saving, offline',
      '05-running':
        'The proxy is up: http://127.0.0.1:5397 for the CLI, counters at zero, “pass unparsed” off',
      '06-journal':
        'The journal: “blocked” by the “Secret keys” rule and “masked” with placeholders — no values',
      '07-counters': 'The counters after the run: “requests: 2 · masked: 1 · blocked: 1”',
    },
    gate: {
      '01-gate-off':
        'The gate card before installing: blind spots listed and the shared rule count (7 enabled, 1 blocking)',
      '02-gate-on':
        'The gate installed: the generated script path and the choice of action on a match',
      '03-hook':
        'The same hook in “Hooks”: an ordinary UserPromptSubmit marked “generated by AgentDeck”',
      '04-claude-only':
        'On a foreign CLI the button is disabled with the reason: no documented prompt-submit event',
    },
  },

  diagrams: {
    'what-the-proxy-sees-and-what-the-gate-sees':
      'Two tools on one path: what passes through the proxy, what the gate can still catch, and what neither sees',
  },
};
