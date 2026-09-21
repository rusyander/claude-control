import type { GatewayMessageCode } from '@agentdeck/contracts/server-messages';

export const gatewayEn: Record<GatewayMessageCode, string> = {
  'gateway-prefixed': 'AgentDeck: {{message}}',
  'gateway-joined': '{{message}}: {{detail}}',
  'gateway-upstream-400': 'The contour did not accept the request',
  'gateway-upstream-401': 'The contour rejected the key. Check the key itself and its permissions',
  'gateway-upstream-402': 'The contour refused on the spending limit — before calling the model',
  'gateway-upstream-403': 'This model is not allowed for the key on the contour',
  'gateway-upstream-404': 'The contour does not know this route',
  'gateway-upstream-413': 'The request is larger than the contour accepts',
  'gateway-upstream-422': 'The contour did not accept the shape of the request',
  'gateway-upstream-429':
    'The key limit on the contour is exceeded (requests or tokens per minute)',
  'gateway-upstream-451': 'The request was stopped by content checks on the contour side',
  'gateway-upstream-500': 'The contour answered with an error on its side',
  'gateway-upstream-502': 'The contour could not reach the model',
  'gateway-upstream-503': 'The contour is unavailable right now',
  'gateway-upstream-status': 'The contour answered with code {{status}}',
  'gateway-retry-after': '{{message}}. The contour asks to retry in {{seconds}} s',
  'gateway-model-forbidden':
    "Model “{{model}}” is not allowed for the key on the contour — the key's allowed list is in the platform admin, and the Contour section shows the same as its model list",
  'gateway-model-not-found':
    'The contour answered “not found” for model “{{model}}”. This reads two ways: the model was removed from the contour between runs (the Contour section marks vanished models and keeps the date they were last seen) — or the contour address points not at the public API but, for example, at the admin, and then the route was not found, not the model',
  'gateway-key-rejected':
    'The contour rejected the key without naming the reason. There are five: the key is unknown or revoked, expired, spent its budget, its owner was deleted — or the owner check on the contour side failed (then the key is fine and a retry is worth it). Check the key, its expiry, budget and owner in the platform admin',
  'gateway-key-budget':
    "The key budget is spent — the contour refused before calling the model. Raise the budget or wait for the key's next period in the platform admin; in half a minute the contour will start rejecting this key with code 401",
  'gateway-content-checks-request': "The contour's content checks stopped the request",
  'gateway-registry-not-ready': 'The contour is still starting: the model registry is not ready',
  'gateway-route-unknown': 'The panel gateway accepts only {{routes}} at /<contour>/v1/...',
  'gateway-contour-unknown': 'Contour “{{id}}” is not set up in the panel',
  'gateway-contour-disabled': 'Contour “{{title}}” is turned off in the panel',
  'gateway-contour-no-key': 'Contour “{{title}}” has no saved key',
  'gateway-body-too-large': 'The request body is over 32 MB — the gateway does not accept it',
  'gateway-body-not-json': 'The request body does not parse as JSON',
  'gateway-answer-not-model':
    'The contour did not answer with a stream, and its body does not parse as a model answer',
  'gateway-client-gone': 'The client disconnected before the answer ended',
  'gateway-answer-broken': "The contour's answer broke off: {{reason}}",
  'gateway-answer-truncated':
    "The contour's answer broke off: the stream ended without a final frame — the answer is incomplete",
  'gateway-upstream-aborted': 'The contour aborted the answer: {{message}}',
  'gateway-upstream-unnamed-error':
    'the other side ended the answer with an error and did not name it',
  'gateway-checks-stopped': "The contour's content checks stopped the answer",
  'gateway-checks-stopped-named': "The contour's content checks stopped the answer: {{names}}",
  'gateway-tool-blocked': 'The “{{name}}” call was stopped by the PreToolUse hook',
  'gateway-tool-blocked-why': 'The “{{name}}” call was stopped by the PreToolUse hook: {{reason}}',
  'gateway-answer-too-large':
    "The contour's answer is over 8 MB — the gateway does not assemble it whole. The same request as a stream comes without this ceiling",
  'gateway-not-anthropic': 'The platform did not answer with an Anthropic dialect message',
  'gateway-mask-rules-broken': 'Data protection is on, but its rules cannot be read ({{error}})',
  'gateway-mask-unparsed': 'Data protection could not parse the request body',
  'gateway-mask-blocked':
    'The request was stopped by rule “{{rule}}” — it contains data that must not go to the model',
  'gateway-mask-unrestorable':
    'The tool call was stopped: data protection label {{names}} cannot be restored — it would go into the file instead of the value',
  'gateway-images-not-declared':
    'Contour “{{title}}” has no images endpoint declared in its manifest',
  'gateway-images-too-large':
    'The images endpoint answer is over 16 MB — the gateway does not assemble it',
  'gateway-failed': 'AgentDeck: the gateway could not handle the request',
  'gateway-ports-busy': 'ports {{from}}–{{to}} are busy: {{reason}}',
  'gateway-ports-busy-unknown': 'reason unknown',
  'gateway-ceiling-cut':
    "The contour's answer broke off at second {{seconds}} — that is the platform's own ceiling for any answer, streams included. The network is not to blame: shorten the turn (less thinking, a shorter answer) or ask the contour owner to raise the ceiling",
  'gateway-url-not-http': 'The contour address is not http(s): {{url}}',
  'gateway-redirect':
    'The contour answered with a redirect ({{status}}) — the panel did not follow it: the request would have gone to another address. Put the address it redirects to into the contour settings',
  'gateway-redirect-to':
    'The contour answered with a redirect to {{where}} ({{status}}) — the panel did not follow it: the request would have gone to another address. Put the address it redirects to into the contour settings',
  'gateway-headers-timeout': 'The contour did not start answering within {{seconds}} s',
  'gateway-cert-failed':
    'The contour certificate did not verify: {{reason}}. Set the company root certificate in the contour settings',
  'gateway-no-connection': 'No connection to the contour: {{reason}}',
  'gateway-key-not-header-safe':
    'The contour key cannot go into a header: it has characters outside Latin. Save the key again without the extra characters',
  'gateway-proxy-unsupported':
    'The panel cannot use the proxy from {{source}} ({{value}}): a plain http proxy is needed. The panel will not go direct around the named proxy',
  'gateway-proxy-unreachable': 'proxy {{host}} is unreachable: {{reason}}',
  'gateway-proxy-connect-timeout': 'proxy {{host}} did not answer CONNECT within {{seconds}} s',
  'gateway-proxy-connect-refused':
    'proxy {{host}} did not pass CONNECT to {{authority}}: {{status}}',
  'gateway-proxy-connect-login':
    'proxy {{host}} did not pass CONNECT to {{authority}}: {{status}} (proxy login required)',
  'gateway-request-cancelled': 'request cancelled',
  'gateway-flaw-fenced': 'a call inside a code block is not executed',
  'gateway-flaw-loose-whole': 'a call without tags is accepted only as a whole JSON object',
  'gateway-flaw-undeclared': 'the tool is not declared by the client',
  'gateway-flaw-args': 'arguments do not parse as an object',
  'gateway-flaw-empty': 'empty call block',
  'gateway-flaw-several': 'several calls in one block',
  'gateway-flaw-not-json': 'does not parse as JSON',
  'gateway-flaw-no-object': 'no object inside the block',
  'gateway-flaw-no-name': 'no tool name in the block',
  'gateway-flaw-unclosed': 'block without a closing tag',
  'gateway-flaw-fence-midanswer': 'a fenced call in the middle of an answer is not executed',
  'gateway-flaw-contour-unnamed': 'contour call without a name',
  'gateway-flaw-contour-args': 'contour call arguments do not parse',
  'gateway-flaw-stop-without-call': 'stop reason “call” without a single call',
  'gateway-request-aborted': 'Request cancelled',
  'proxy-failed': 'the proxy could not handle the request',
  'proxy-not-configured': 'the proxy is not configured',
  'proxy-body-too-large': 'the request body is too large',
  'proxy-shape-unknown': 'the request shape does not parse',
  'proxy-body-not-json': 'the request body is not JSON',
  'proxy-stopped-unparsed':
    'AgentDeck: {{reason}}, the request was stopped (the «let unparsed through» setting is off)',
  'proxy-upstream-unreachable': 'AgentDeck: the model address does not answer ({{reason}})',
};
