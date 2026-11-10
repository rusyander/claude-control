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
  core: {
    toggle: 'Answer the core from Telegram',
    hint: 'Core task questions arrive in the answers bot with buttons. From Telegram you can answer a question, allow the one asked call, cancel or rework a task, switch its model or CLI, add an Inbox entry. Granting more than the question asks, changing a route or a setting, taking over, publishing stay in the panel or on the phone: your Telegram account is reachable from this same machine, the phone key is not.',
    bound: 'The core recognises this chat: task questions come with buttons.',
    unbound: 'Off: task questions come as text with a link to the panel.',
    needBot: 'Connect the answers bot and set your id first.',
    unreachable: 'The core is not running or did not answer — the binding cannot be checked.',
    saved: 'Core binding saved',
    failed: 'The core refused the binding: {{reason}}',
    reposSaved: 'Repositories for Telegram tasks saved',
    repos: {
      label: 'Repositories for Telegram tasks',
      hint: 'One repository per line: a path, optionally " @ branch". A /task entry carries them and starts from Telegram with «Start work». Empty — the entry waits for a repository on the board, Telegram shows no button.',
      placeholder: 'C:/work/app @ main',
      save: 'Save repositories',
      tooMany: 'At most {{max}} repositories.',
      tooLong: 'A path is over 1000 characters or a branch over 300.',
      failed: 'The core refused the repositories: {{reason}}',
      reload: 'Reload the config',
    },
  },
};
