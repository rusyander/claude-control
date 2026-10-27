import type { telegramAnswersRu } from './ru.ts';

/** English texts of the Telegram answers block; typed against the Russian module. */
export const telegramAnswersEn: typeof telegramAnswersRu = {
  token: 'Dedicated bot token',
  tokenHint:
    'Needed when the Telegram card bot is already listened to by the agent (an MCP server or the Telegram channel): one bot can have only one listener.',
  tokenSaved: 'Saved: {{mask}}',
  tokenPlaceholder: '123456789:AA…',
  saved: 'Telegram answers settings saved',
  connect: {
    open: 'Connect',
    reopen: 'Open again',
    needToken: 'Save the bot token and press Check first.',
    waiting: 'Waiting for /start until {{time}}: open {{link}} and press Start.',
    candidate: '{{name}}, id {{id}} — is this you?',
    confirm: 'Yes, it is me',
    cancel: 'No, cancel',
    confirmed: 'Connected: {{name}}, id {{id}}. The bot has written to you in Telegram.',
    expired: 'Five minutes passed without /start. Press Open again.',
    reason: {
      'no-token': 'The card has no bot token.',
      'same-bot':
        'The agent already listens to this bot (an MCP server or the Telegram channel) — enter the id by hand or take another bot.',
      unauthorized: 'Telegram did not accept the bot token.',
      webhook: 'The bot has a webhook — /start will not arrive by polling.',
      conflict: 'Someone else already listens to the bot (409).',
      network: 'Telegram did not answer — try again.',
    },
  },
  lastSend: {
    ok: 'Last send: {{time}} — delivered',
    failed: 'Last send: {{time}} — error: {{error}}',
  },
  state: {
    off: 'Off',
    polling: 'Listening to the bot — answers are accepted',
    'no-token': 'No token: neither a dedicated bot nor the Telegram card has one',
    'owner-missing': 'Your id is not set — there is nobody to accept answers from',
    'same-bot': 'Telegram answers need a separate bot: the agent already listens to this one',
    webhook:
      'The bot has a webhook — polling gets no answers. Remove the webhook yourself or use another bot',
    conflict:
      'Someone else already listens to the bot (409). Polling stopped — remove the other listener and press Restart',
    unauthorized: 'Telegram did not accept the bot token',
    error: 'Telegram does not answer — retrying with a pause',
  },
};
