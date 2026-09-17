import type { ServerMessageCode } from '@agentdeck/contracts/server-messages';

/** English texts for server message codes; keyed by the same `Record` as `ru.ts`. */
export const serverMessagesEn: Record<ServerMessageCode, string> = {
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
  'run-busy':
    'The previous answer in this conversation is still being generated. Wait for it to finish or press “Stop” — the message was not sent.',
  'run-empty-prompt': 'The message is empty — nothing to send.',
  'run-unsupported-upload':
    'Unsupported attachments: {{names}}. The message was not sent. Allowed extensions: {{supported}}.',
  'run-workspace-missing':
    'This chat’s working folder was not found: {{cwd}}. The conversation started there and can only continue from there.',
  'media-block-too-large': 'The block is too large — the panel does not accept it.',
  'media-image-not-found': 'The panel has no such image.',
  'media-deck-not-found': 'The panel has no such presentation.',
  'media-deck-file-missing': 'The panel could not find the presentation file.',
  'media-deck-format-unknown': 'Presentations have no such file type.',
  'media-deck-revise-unspecified': 'Which presentation to revise was not specified.',
  'media-deck-revise-gone': 'The presentation you asked to revise is no longer in the panel.',
  'media-deck-block-invalid': 'The block is not a deck: no title or no slides.',
  'media-topic-empty': 'Describe what you need.',
  'media-prompt-kind-unknown': 'Unknown request kind.',
};
