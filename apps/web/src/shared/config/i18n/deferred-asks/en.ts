import type { deferredAsksRu } from './ru.ts';

/** English texts of the deferred D-n asks; typed against the Russian module. */
export const deferredAsksEn: typeof deferredAsksRu = {
  badge: 'Awaiting decision ({{count}})',
  hint: 'Calls from the former path that only a human decides. No new records appear; a decision is only recorded — the conversation does not continue, ask for the work in the chat in words.',
  show: 'Show',
  hide: 'Hide',
  filterAll: 'All ({{count}})',
  filterOwner: '{{owner}} ({{count}})',
  group: 'Group {{number}}',
  groupTitled: 'Group {{number}} — {{title}}',
  chat: 'Chat',
  asked: 'asked {{time}}',
  detail: 'What gets written',
  expiredState: 'expired — can be allowed again',
  retries_one: 'the agent repeated the call {{count}} time',
  retries_few: 'the agent repeated the call {{count}} times',
  retries_many: 'the agent repeated the call {{count}} times',
  retries_other: 'the agent repeated the call {{count}} times',
  allow: 'Allow',
  allowAgain: 'Allow again',
  deny: 'Deny',
  openChat: 'Open chat',
  decided: '{{id}}: decision recorded — the conversation does not continue',
  failed: 'The decision was not saved: {{message}}',
  reasons: {
    'group-rows': "The group's permission rows send this call to a human.",
    'not-auto-approved': 'The call is not covered by the auto-approve rules.',
    'main-copy': 'An edit in the main copy of the project: you decide where it writes.',
    'backend-guard': 'Backend guard: {{rule}} — “{{match}}”.',
  },
};
