import type { deferredAsksRu } from './ru.ts';

/** English texts of the deferred D-n asks; typed against the Russian module. */
export const deferredAsksEn: typeof deferredAsksRu = {
  badge: 'Awaiting decision ({{count}})',
  hint: 'Calls only a human decides. The agents queued them and keep working; an answer resumes the work with exactly this call.',
  show: 'Show',
  hide: 'Hide',
  hubTitle: 'Awaiting decision in groups ({{count}})',
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
  branchGate: 'Edit in the main copy',
  allow: 'Allow',
  allowAgain: 'Allow again',
  deny: 'Deny',
  openChat: 'Open chat',
  decided: {
    sent: '{{id}}: decided — the conversation resumed',
    queued: '{{id}}: decided — the conversation resumes after the pause',
    parked: '{{id}}: decided — the conversation resumes when the current turn ends',
    none: '{{id}}: decided — nothing to resume, the agent sees the answer on its next call',
  },
  failed: 'The decision was not saved: {{message}}',
  reasons: {
    'group-rows': "The group's permission rows send this call to a human.",
    'not-auto-approved': 'The call is not covered by the auto-approve rules.',
    'main-copy': 'An edit in the main copy of the project: you decide where it writes.',
    'backend-guard': 'Backend guard: {{rule}} — “{{match}}”.',
  },
  card: {
    title: 'Deferred as {{id}} — the agent keeps working',
    note: 'An answer here decides {{id}} in the «Awaiting decision» list.',
  },
};
