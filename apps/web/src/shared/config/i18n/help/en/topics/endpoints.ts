import type { endpointsRu } from '../../ru/topics/endpoints';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const endpointsEn: typeof endpointsRu = {
  topic: {
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

    filesTitle: 'Exact paths on both sides',
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

    guideTitle: 'What this document holds',
    guideText:
      'A diagram of where the address ends up; a path of seven frames from a real panel ' +
      '— from the empty block to an applied profile; what this block is NOT; what it ' +
      'writes on disk and when a CLI sees it; the “who accepts it” table and a table of ' +
      'refusals quoted verbatim.',

    writeMapTitle: 'Where the address ends up',
    writeMapCaption:
      'The profile lives with the panel, but it only works once its value has landed in ' +
      'a particular CLI’s environment file. The diagram shows both stores and the line ' +
      'between them.',
    pathTextTitle: 'The same path in words',
    pathTextText:
      'The profile (name, API kind, address, model) lives in the panel’s state.json; the ' +
      'token separately and encrypted. Until you press “Apply”, no CLI knows the address. ' +
      'Pressing it writes one or two variables into the chosen CLI’s environment file ' +
      '(for Claude Code that is the env key in settings.json), taking a backup of the ' +
      'file first. The token does not go there — only with the explicit checkbox. A CLI ' +
      'session already running does not re-read variables: restart it.',

    guide: {
      localTitle: 'Path: set up your own model address and hand it to the CLIs',
      localCaption:
        'Settings → the “Models” tab → the “Own endpoint” block. Seven frames: the empty ' +
        'block, the form, the connection check, the token, an API-kind change, the applied ' +
        'profile and the panel assistant.',
      localEmpty: '1. The empty block explains what it is for',
      localEmptyText:
        'Before the first profile the block states what it solves: the address a CLI uses ' +
        'to reach a model instead of the vendor cloud — a local model, a corporate ' +
        'gateway or a proxy. The point is to set it once and hand it out with a button, ' +
        'rather than typing ANTHROPIC_BASE_URL into every environment section by hand.',
      localForm: '2. Four fields, and the first one is not the address',
      localFormText:
        'The key field is “API kind”: it decides both what the address means and which ' +
        'CLIs will accept the profile. The hint under the address changes with it: for ' +
        'Anthropic “the host root, without /v1”, for OpenAI-compatible “the address ' +
        'including the version”. The model may stay empty: then the model variable is ' +
        'left alone.',
      localProbe: '3. The connection check pulls the model list',
      localProbeText:
        '“Check connection” asks the address for its model list and answers with a fact: ' +
        '“connected, models: 3”. After that the “Model” field stops being free text — it ' +
        'offers the names from the address itself (qa-mini, qa-standard, qa-long). The ' +
        'check writes nothing into any CLI.',
      localToken: '4. The token stays in the panel — unless you ask otherwise',
      localTokenText:
        'A saved token is shown masked only and is used for the connection check and by ' +
        'the panel assistant. The “Write the token into the CLI config” checkbox exists, ' +
        'but warns in plain words: with it the token lands in the config file in the ' +
        'clear. By default only the address and the model go into a foreign config.',
      localKind: '5. Change the API kind and the accepting list changes',
      localKindText:
        'The same address as “OpenAI-compatible” is no longer accepted by Claude Code: ' +
        '“this CLI works with a different API kind”. Each refusal names its own reason ' +
        'rather than a blanket “no”: some have no documented address variable, others no ' +
        'environment file of their own.',
      localApplied: '6. What exactly will be written is visible beforehand',
      localAppliedText:
        'For an accepting CLI the whole line is shown: the variable, the value and the ' +
        'path of the file it will land in. The block lives inside the “Models” tab, under ' +
        'the model catalog — it has no page of its own.',
      localAssistant: '7. The panel assistant switches separately',
      localAssistantText:
        'The “Panel assistant” switch chooses between the vendor cloud “as before” and ' +
        'the profile. With the profile picked, the hints in forms go to that address, ' +
        'bypassing both the cloud and the provider’s CLI. It does not follow what was ' +
        'applied to a CLI: these are different jobs.',
    },

    notTitle: 'What this block is not',
    notCaption: 'Five things it gets mistaken for, and what actually does them.',
    notColumn: 'Not here',
    notMeaningColumn: 'Where it actually is',
    notProxy: 'Not a proxy',
    notProxyText:
      'The panel does not sit on the request path: it only writes the address into the ' +
      'CLI’s environment, and the CLI goes there itself. Intercepting and inspecting ' +
      'requests is “Data protection”.',
    notMask: 'Not data protection',
    notMaskText:
      'The profile decides where a request goes, not what is in it. Masking secrets and ' +
      'personal data is a separate section of the panel.',
    notRunner: 'Not a model launcher',
    notRunnerText:
      'You bring up the server behind the address yourself. The panel will check the ' +
      'connection and name the models, but it can neither install nor start them.',
    notEnvSection: 'Not the “Environment” section',
    notEnvSectionText:
      'Applying writes exactly one or two variables — the address and the model. The rest ' +
      'of the CLI’s environment is edited in its own section and untouched by a profile.',
    notContour: 'Not the contour',
    notContourText:
      'The corporate contour is its own section with a gateway inside the panel’s ' +
      'process, its own models and spend accounting. This is just an address in a foreign ' +
      'config.',

    storageProfiles: 'Profiles',
    storageProfilesValue: 'agentdeck/state.json → endpointProfiles (address, API kind, model)',
    storageToken: 'Profile token',
    storageTokenValue: 'agentdeck/provider-keys.enc, key endpoint:<id> (AES-256-GCM)',
    storageApplied: 'Applying to a CLI',
    storageAppliedValue:
      'The chosen CLI’s environment file plus a backup of that file taken before the write',
    storageSeen: 'When the CLI sees it',
    storageSeenValue: 'At its next start: a running session does not re-read environment variables',

    canProfile: 'Set up a profile with an address, an API kind and a model',
    canProbe: 'Check the connection and pull the model list from the address itself',
    canPreview: 'Show, before writing, which variable goes into which file',
    canApply: 'Apply the profile to an accepting CLI with one button, taking a backup',
    canToken: 'Keep the token encrypted and never hand it out',
    canAssistant: 'Point the panel assistant at that address with a separate switch',
    cantForce: 'Make a CLI accept an address when no variable for it exists',
    cantSecret: 'Write the token into a foreign config without the explicit checkbox',
    cantRestart: 'Restart the CLI for you so it re-reads its variables',
    cantHide: 'Hide the content of the request travelling to that address',
    cantVerifyModel: 'Vouch that the address is answering with that exact model',

    refusalsTitle: 'Refusals and what they mean',
    refusalsCaption: 'Exactly what the panel shows, and what to do about it.',
    refusalsColumn: 'What is shown',
    refusalsMeaningColumn: 'Reason and way out',
    refusalUrl: '“The endpoint address must be a valid http(s) address”',
    refusalUrlText:
      'The address did not parse as http or https. Nothing is written — fix the address ' +
      'and apply again.',
    refusalHttps: '“Gemini CLI only accepts https in its address variable”',
    refusalHttpsText:
      'A requirement of the CLI itself, with an exception only for localhost. Plain http ' +
      'must not be written there: the CLI would silently reject the setting.',
    refusalNoVar: '“no documented environment variable for this API kind”',
    refusalNoVarText:
      'For that CLI the address is set only in its configuration file, by hand. The panel ' +
      'will not guess a variable name.',
    refusalNoEnv: '“no environment section — nowhere to write”',
    refusalNoEnvText:
      'That CLI has no environment file of its own. The profile does not apply to it — ' +
      'apply it to the ones that accept it.',
    refusalKindMismatch: '“This CLI works with a different API kind”',
    refusalKindMismatchText:
      'The profile’s API kind is not the one the CLI understands. Create a second profile ' +
      'with the right kind — pointing at the same address, if it answers both schemes.',
    refusalNotJson: '“The response is not JSON — that address is not a model API”',
    refusalNotJsonText:
      'There is a connection, but the wrong thing answers: usually a web server page or a ' +
      'login portal. Check the address and the port.',
    refusalStatus: '“The address answered 401” (or another code)',
    refusalStatusText:
      'The code and the response text are shown as they came. 401 and 403 usually mean a ' +
      'profile token is needed, or the one stored is no longer valid.',
  },

  shots: {
    local: {
      '01-empty':
        'The “Own endpoint” block before the first profile: why it exists and that “there are no profiles yet”',
      '02-profile':
        'The profile form: the API kind comes first, and the hint under the address changes with it',
      '03-probe':
        'After the connection check: “connected, models: 3”, the model field became a list from the address',
      '04-token':
        'The token saved as a mask; the checkbox writing it into the CLI config warns about plain text',
      '05-targets':
        'The same address as “OpenAI-compatible”: Claude Code now “does not accept”, Qwen and Aider do',
      '06-applied':
        'The whole “Models” tab: the endpoint lives under the model catalog, the accepting CLI shows its variable and file path',
      '07-assistant':
        'The “Panel assistant” switch: form hints go through the profile, bypassing the cloud and the CLI',
    },
  },

  diagrams: {
    'where-the-address-is-written':
      'The profile at the panel, the variable at the CLI: what each side holds and what the “Apply” button does',
  },
};
