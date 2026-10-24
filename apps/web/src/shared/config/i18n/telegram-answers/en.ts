import type { telegramAnswersRu } from './ru.ts';

/** English texts of the Telegram answers block; typed against the Russian module. */
export const telegramAnswersEn: typeof telegramAnswersRu = {
  title: 'Answers from Telegram',
  hint: 'An agent question you have not answered in the panel arrives in Telegram with Allow / Deny buttons or the answer options. A press is applied exactly as in the panel, and the message is edited with the outcome. Group questions and deferred D-n asks go at once.',
  enabled: 'Send questions to Telegram and accept answers',
  afterMinutes: 'Minutes without an answer before sending',
  afterMinutesHint: '0 means at once',
  ownerId: 'Your Telegram id',
  ownerIdHint:
    'Answers are accepted only from this person and only in the private chat with the bot. Find your id with @userinfobot.',
  useSuggested: 'Take it from the card ({{id}})',
  token: 'Dedicated bot token',
  tokenHint:
    'Needed when the Telegram card bot is already listened to by the agent (an MCP server or the Telegram channel): one bot can have only one listener.',
  tokenSaved: 'Saved: {{mask}}',
  tokenPlaceholder: '123456789:AA…',
  tokenClear: 'Erase the token',
  usesNotifyBot: 'No dedicated token — the Telegram card bot is listened to.',
  save: 'Save',
  restart: 'Restart',
  saved: 'Telegram answers settings saved',
  open_one: 'Waiting for an answer in Telegram: {{count}}',
  open_few: 'Waiting for an answer in Telegram: {{count}}',
  open_many: 'Waiting for an answer in Telegram: {{count}}',
  open_other: 'Waiting for an answer in Telegram: {{count}}',
  bot: 'Bot: {{bot}}',
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
