import type { limitCardRu } from './ru.ts';

/** Limit card (stage 12, P169, P171): a route window holds the task, switching only by click. Typed against the Russian module. */
export const limitCardEn: typeof limitCardRu = {
  title: 'Limit',
  waiting: 'The task waits for the window of route {{route}}.',
  verdict: {
    open: 'window open',
    warn: 'window nearly used up',
    refused: 'route refused on a limit',
    held: 'window busy',
    exhausted: 'limit exhausted',
    offline: 'route unavailable',
  },
  resetAt: 'The window opens at {{time}}. The task continues by itself on the same route.',
  resetUnknown:
    'Reset time unknown: the core rechecks the window itself and continues on the same route.',
  offersHint: 'The task never changes its route by itself. You can move it with a click:',
  noOffers: 'The task has no other route in its set — waiting for the reset is the only way.',
  askHolds: 'The switch options are in the question above.',
  option: {
    cli: 'Move to {{cli}}',
    model: 'Other model: {{model}}',
  },
  sending: 'Sending…',
  applied: 'Switch accepted: the next turn takes the new route.',
  refused: 'The core refused: {{reason}}',
  failed: 'The command did not get through: {{reason}}',
  chat: {
    title: 'Subscription limit',
    resetAt: 'The window opens at {{time}}.',
    resetUnknown: 'Reset time unknown — the core re-checks the window by itself.',
    resend:
      'After the reset the last message goes again, once, by itself — no need to press «Retry».',
    wait: 'Wait for reset',
    waiting: 'Waiting for the reset: the message goes by itself, on the same route.',
    switchHint: 'Not waiting — move the conversation with a click:',
    carrying: 'Switching the CLI and carrying the conversation…',
    carried:
      'Conversation carried to {{cli}}: the continuation is open there, and the message is not sent again here after the reset.',
    notCandidate: 'This conversation is not in the carry list for {{cli}}.',
    carryFailed: 'Carry failed: {{reason}}',
  },
};
