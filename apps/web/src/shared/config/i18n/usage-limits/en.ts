import type { usageLimitsRu } from './ru.ts';

/** English texts of the subscription usage limits in the sidebar; typed against the Russian module. */
export const usageLimitsEn: typeof usageLimitsRu = {
  title: 'Plan usage limits',
  session: 'Session (5 h)',
  weekly: 'Week',
  weeklyModel: 'Week · {{model}}',
  reset: 'resets {{time}}',
  resetUnknown: 'reset not given',
  aria: '{{label}}: {{percent}} used, {{reset}}',
  tooltipUsed: '{{label}}: {{percent}} used',
  tooltipReset: 'Resets: {{time}} (in {{until}})',
  tooltipObserved: 'Data as of {{time}} — {{source}}',
  source: {
    oauth: 'Anthropic server response, refreshed once a minute',
    'chat-run': 'last sample from a chat run',
  },
  stale: 'stale',
  status: {
    ok: '',
    'no-credentials': 'No Claude Code login on this machine',
    'api-key': 'Claude Code runs on an API key — there are no plan limits',
    'token-expired': 'The Claude Code login expired — it renews on the next claude run',
    unauthorized: 'The Anthropic server refused the Claude Code token',
    'rate-limited': 'The Anthropic server asked to wait — retrying later',
    unavailable: 'No response from the Anthropic server',
  },
  until: {
    days: '{{d}} d {{h}} h',
    hours: '{{h}} h {{m}} min',
    minutes: '{{m}} min',
    soon: 'less than a minute',
  },
};
