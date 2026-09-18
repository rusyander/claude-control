import type { ContourMessageCode } from '@agentdeck/contracts/server-messages';

export const contourEn: Record<ContourMessageCode, string> = {
  'contour-gateway-not-raised': 'The gateway did not start: {{reason}}',
  'contour-smoke-no-models': 'The contour named no models: there is nothing to ask with.',
  'contour-smoke-gateway-down':
    'The gateway is down: the probe request goes through it, just as the CLI does.',
  'contour-smoke-thinking-cap':
    'The model spent the probe ceiling ({{tokens}} tokens) without saying a word — it looks like everything went into reasoning. The path works; real requests have a higher ceiling.',
  'contour-smoke-silent': 'The model said nothing: the path works, there is no answer.',
  'contour-smoke-timeout': 'No answer for {{seconds}} s — the CLI would wait exactly as long.',
  'contour-smoke-gateway-error': 'The gateway did not answer: {{reason}}.',
  'contour-smoke-refused': 'The gateway answered {{status}}: {{message}}',
  'contour-smoke-status': 'The gateway answered {{status}}.',
  'contour-agent-not-json':
    "The contour answered with something other than JSON — there is nothing to parse the agent's answer with.",
  'contour-agent-unknown-shape':
    'The contour answered in a shape the panel did not recognise: there is nothing to parse.',
  'contour-agent-answered': 'The agent answered.',
  'contour-agent-empty': 'The agent answered with an empty message.',
  'contour-agent-session-rejected': 'The contour did not accept the session id (422).',
  'contour-agent-said': '{{message}} The contour said: {{detail}}',
  'contour-agent-no-license':
    "Agents are not part of this contour's licence — the company enables them, not the panel.",
  'contour-agent-license-inactive':
    "The contour's licence is inactive: agents do not work until it is renewed.",
  'contour-agent-license-unchecked':
    'The contour could not verify its own licence — that is its side, try again later.',
  'contour-agent-key-rejected':
    'The key was rejected by the contour (401): it is revoked or its budget is spent.',
  'contour-agent-key-forbidden': 'The key is not allowed to call agents (403).',
  'contour-agent-key-budget': "The key's budget is spent (402).",
  'contour-agent-not-found':
    'The contour did not find such an agent (404). Check the id in the platform admin.',
  'contour-agent-failed': 'The agent ended with an error.',
  'contour-agent-rate-limited': 'The contour rate-limited the requests (429).',
  'contour-agent-status': 'The contour answered with error {{status}}.',
  'contour-agent-rejected': 'The contour did not accept the request ({{status}}).',
  'contour-agent-nothing-to-ask': 'Nothing to ask: there are no messages.',
  'contour-agent-last-must-be-question': "The last message must be the human's question.",
  'contour-agent-no-system-with-session':
    'With a session the system message is not sent — the contour does not keep it.',
  'contour-probe-not-api':
    'The address answered {{status}}, but this is not a model list: {{hint}}.',
  'contour-probe-not-api-address':
    'The address answered {{status}}, but this is not a model list: {{hint}}. {{address}}',
  'contour-probe-bad-url': 'The contour address must be a valid http(s) URL.',
  'contour-probe-no-key':
    'The address answers like the contour API and refused without a key ({{status}}) — as it should: the key has not been entered yet. Enter it at the next step.',
  'contour-probe-unauthorized': '{{message}} (401).',
  'contour-probe-forbidden':
    "The key is not allowed to do what the panel asked (403). Check the key's permissions.",
  'contour-probe-not-ready': '{{message}} ({{status}}). Run the check again.',
  'contour-probe-server-error':
    'The contour answered with error {{status}}. That is its side — try again later.',
  'contour-probe-no-catalog-path': 'no model list was found at this path',
  'contour-probe-html': 'an HTML page came back, not JSON',
  'contour-probe-not-json': 'the answer does not parse as JSON',
  'contour-probe-no-models-field':
    'the answer holds no model list (neither a data field nor an array)',
  'contour-probe-ok': 'The contour answered: {{count}} models.',
  'contour-probe-timeout': 'The contour did not answer within {{seconds}} s.',
  'contour-address-admin':
    'This looks like the admin address: the public API lives on a separate host (usually api.<domain>).',
  'contour-thinking-default': 'by default',
  'contour-thinking-on': 'on',
  'contour-thinking-off': 'off',
  'contour-where-outside': 'outside the panel',
  'contour-conflict-tools-title': 'Platform tools ⟷ our tool shim',
  'contour-conflict-tools-detail':
    "Two tool sets for one turn: ours travels as text and is reassembled from the answer, the contour's set is executed by the contour itself. Both cannot be on — pick one.",
  'contour-conflict-anonymization-title': "The contour's data substitution ⟷ our data mask",
  'contour-conflict-anonymization-detail':
    "Not a choice between two: the layers stack in order. Over an API key the contour's substitution is not guaranteed — the stand probe showed a request without it, and the contour does not hand the substitution map to an API client. So our mask turns itself on for such a contour: it goes first, it is reversible, and the contour does not touch its markers. Nothing needs to be switched off.",
  'contour-conflict-compaction-title': 'History compaction by the contour ⟷ our checkpoints',
  'contour-conflict-anonymization-detail-off':
    'Not a choice between two: the layers stack in order. Over an API key the contour’s substitution is not guaranteed — the stand probe showed a request without it, and the contour does not hand the substitution map to an API client. Our mask turns itself on for such a contour, but RIGHT NOW it is off on this card: the request goes to the contour as it is. The “The panel’s data mask” switch above turns it on.',
  'contour-conflict-compaction-detail':
    "The contour compacts a long conversation itself, while the panel's checkpoint describes the whole history. After compaction the continuation may not know the start of the task — keep the checkpoint fresh.",
  'contour-conflict-guardrails-title': "The contour's content checks ⟷ our prompt gate",
  'contour-conflict-guardrails-detail':
    "Both check, and by different lists: the panel's gate refuses before sending and names the rule, the contour refuses on its side with status 451. The second refusal does not mean the first one did not fire.",
  'contour-control-tools-title': 'Platform tools',
  'contour-control-tools-detail':
    "names of the contour's tools; empty — «tool_choice: none» goes upstream",
  'contour-control-toolmode-title': 'Platform call loop',
  'contour-control-toolmode-detail':
    '«loop» — the contour goes round the loop itself, «single_turn» — it returns the call to the client; such a turn goes to the contour without streaming',
  'contour-control-preset-title': 'Generation preset',
  'contour-control-preset-detail':
    "a named parameter set on the contour's side; empty — the contour takes its own",
  'contour-control-thinking-title': 'Model reasoning',
  'contour-control-thinking-detail':
    'switching it on or off reaches only models on self-hosted vLLM — to other providers the contour does not pass the field; by default it is not sent and the model template decides. The reasoning itself never leaves the contour',
  'contour-control-thinking-manifest-detail':
    'switch it on or off with the field «{{path}}»; by default it is not sent and the model template decides',
  'contour-control-guardrails-title': 'Content checks',
  'contour-control-guardrails-detail':
    "the contour's owner switches it on; the refusal arrives as status 451",
  'contour-control-owner-enables': "the contour's owner enables it",
  'contour-control-anonymization-title': 'Data substitution',
  'contour-control-anonymization-detail':
    'present in the contour’s own chat; over an API key the stand probe saw the request go WITHOUT substitution, and the contour hands the map to no API client',
  'contour-control-knowledge-title': 'Company knowledge',
  'contour-control-knowledge-where': "the key's owner mixes it in",
  'contour-control-knowledge-detail': "mixed in by the key's owner, there is no separate route",
  'contour-control-context-title': 'History compaction',
  'contour-control-context-where': 'the contour decides',
  'contour-control-context-detail':
    'the contour compacts a long conversation itself — our checkpoints know nothing about it',
  'contour-notes-no-capabilities':
    'A compatible gateway declares no capabilities beyond the model list.',
  'contour-tools-dropped':
    'This contour type drops the tools field — without the shim the agent will not be able to edit files.',
  'contour-tools-refused': 'The request with a tool was refused ({{status}}).',
  'contour-tools-call-as-text':
    'The model wrote the call as text: the tools field did not reach it, or it does not understand the field.',
  'contour-tools-no-call': 'The model answered without calling a tool.',
  'contour-tools-failed': 'The tools probe did not pass: {{reason}}.',
  'contour-required-gateway-down':
    "The contour «{{title}}» is required, and the panel's gateway is down — the run was not started, so that it would not slip into the vendor cloud. Press «Start the gateway» on the contour card (the «Contour» section) or switch the provider back to the default one.",
  'contour-required-no-token':
    'The contour «{{title}}» is required, and its key is not saved — the run was not started, so that it would not slip into the vendor cloud. Save the key («Configure» on the contour card → the «Key» step) or switch the provider back to the default one.',
  'contour-target-assistant': 'Panel assistant',
  'contour-bridge-script-missing':
    'The bridge script tools/mcp/platform.mjs was not found — the panel was started outside its own repository.',
};
