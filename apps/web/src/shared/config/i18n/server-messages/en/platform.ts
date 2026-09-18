import type { PlatformMessageCode } from '@agentdeck/contracts/server-messages';

export const platformEn: Record<PlatformMessageCode, string> = {
  'capability-models-key-scoped': 'list narrowed by the key permissions',
  'capability-models-gateway-listed': 'list returned by the gateway',
  'capability-kind-undeclared': 'model kinds are not declared',
  'capability-chat-listed': 'chat models in the key list',
  'capability-chat-none': 'no chat models granted to the key',
  'capability-embeddings-listed': 'embedding models in the key list',
  'capability-embeddings-none': 'no embedding models granted to the key',
  'capability-agents-call-only': 'verifiable only by calling an agent — the panel does not do that',
  'capability-guardrails-in-band': 'run in the request band: a refusal arrives as status 451',
  'capability-knowledge-via-owner': 'through the key owner, no separate route',
  'capability-client-tools-rejected': 'the public API does not accept tool descriptions',
  'capability-undeclared-by-gateway': 'a compatible gateway does not report this about itself',
  'capability-image-flag-undeclared': 'no model declares the drawing flag',
  'capability-image-no-models': 'no models granted to the key',
  'capability-image-listed': 'models with the drawing flag in the key list',
  'capability-image-none': 'no drawing models granted to the key',
  'platform-not-found': 'Contour “{{id}}” does not exist.',
  'platform-not-connected': 'Contour “{{title}}” is not connected: enable it and save the key.',
  'platform-agents-not-declared':
    'Contour “{{title}}” has no published agents: its type does not declare them.',
  'gateway-not-started': 'The gateway did not start',
  'request-target-unknown':
    'Request rejected: the panel does not know target “{{targetId}}” ({{field}}).',
  'request-ca-unreadable':
    'Request rejected: the root certificate could not be read: {{reason}} ({{field}}).',
  'request-ca-not-certificate':
    'Request rejected: the file was read but it is not a certificate: the company root certificate is required (PEM or DER) ({{field}}).',
  'request-key-too-long': 'Request rejected: the key is longer than allowed ({{field}}).',
  'request-key-too-short':
    'Request rejected: the key is shorter than {{MIN_KEY_LENGTH}} characters — this is not a contour key ({{field}}).',
  'request-key-non-latin':
    'Request rejected: the key contains non-Latin characters — such a key cannot be sent in a request header ({{field}}).',
  'request-id-mismatch':
    'Request rejected: the id in the address (“{{id}}”) and in the body (“{{bodyId}}”) do not match ({{field}}).',
  'request-key-not-string': 'Request rejected: the key must be a string ({{field}}).',
  'request-model-not-string': 'Request rejected: the model must be a string ({{field}}).',
  'request-agent-missing': 'Request rejected: no agent named ({{field}}).',
  'request-embedding-model-missing': 'Request rejected: no embedding model named ({{field}}).',
  'request-target-list-expected': 'Request rejected: a list of target ids is expected ({{field}}).',
  'request-string-expected': 'Request rejected: a string is expected ({{field}}).',
  'request-question-empty': 'Request rejected: the question is empty ({{field}}).',
  'request-question-or-messages':
    'Request rejected: a question (message) or a conversation (messages) is required ({{field}}).',
  'request-role-invalid': 'Request rejected: the role is user, assistant or system ({{field}}).',
  'request-message-empty': 'Request rejected: the message is empty ({{field}}).',
  'embeddings-empty': 'Nothing to compute: the text list is empty.',
  'embeddings-model-missing': 'The embeddings model is not named.',
  'embeddings-no-vectors': 'The contour answer has no vectors.',
  'mcp-url-missing': 'Address not set',
  'mcp-url-unparsed': 'The address does not parse as a URL: {{url}}',
  'mcp-command-missing': 'Launch command not set',
  'oauth-network-only': 'OAuth is available only for network servers (http/sse)',
  'oauth-session-missing': 'The authorization session was not found or expired',
  'assistant-timeout': 'The assistant did not answer in the allotted time',
  'assistant-empty-reply': 'The model returned an empty answer.',
  'manifest-invalid-object': 'Request rejected: overrides must be an object of fields ({{field}}).',
  'manifest-invalid-client-tools':
    'Request rejected: tools must be «native» or «shim» ({{field}}).',
  'manifest-invalid-effort': 'Request rejected: effort must be yes or no ({{field}}).',
  'manifest-invalid-path':
    'Request rejected: the handle path relative to the version: lowercase latin, digits, «/», «_», «-» ({{field}}).',
  'manifest-invalid-seconds':
    'Request rejected: a whole number of seconds from 0 to 3600 ({{field}}).',
  'manifest-invalid-thinking-field':
    'Request rejected: the wire field: dot-separated names, no more than five, without reserved object names ({{field}}).',
  'manifest-invalid-vendor-prefix':
    'Request rejected: the field prefix: lowercase latin and digits, the first one a letter, up to 32 characters ({{field}}).',
  'transport-header-token':
    'Request rejected: «{{subject}}» is not an HTTP header name ({{field}}).',
  'transport-header-line':
    'Request rejected: «{{subject}}» is not of the form «Name: value» (a line or parameter number) ({{field}}).',
  'transport-header-secret':
    'Request rejected: «{{subject}}» — the key travels under this name, and the key is stored encrypted and travels in its own field ({{field}}).',
  'transport-header-reserved':
    'Request rejected: «{{subject}}» — the panel sets this header itself ({{field}}).',
};
