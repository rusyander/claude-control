/**
 * Заглушка Bot API Telegram для живых проверок (одна на все скрипты: ответы из Telegram, пересылка
 * вопросов ядра, уведомления о задачах ядра — этап 12). Свободный порт на 127.0.0.1, сеть не нужна;
 * панель смотрит сюда через `AGENTDECK_TELEGRAM_API=<url>`.
 *
 * Что умеет: getMe, getWebhookInfo, getUpdates (очередь своя у каждого токена; `offset`
 * подтверждает, как у Telegram, `-1` оставляет только последнее; 409 по `bot.conflict`),
 * sendMessage, editMessageText, editMessageReplyMarkup, answerCallbackQuery, setMyCommands,
 * deleteWebhook, deleteMessage(s). Каждый вызов — в `bot.calls` (`tokenOk` — токен из списка
 * известных; у sendMessage ещё `messageId` выданного сообщения).
 */
import { createServer } from 'node:http';
import { freePort, wait } from './throwaway-stand.mjs';

/**
 * @param {{ botId: number, username: string, tokens: string[], owner?: number, firstMessageId?: number }} options
 */
export async function startBotStub({ botId, username, tokens, owner, firstMessageId = 500 }) {
  const bot = {
    calls: [],
    /** `{ token, update }` — у каждого бота своя очередь. */
    updates: [],
    webhookUrl: '',
    conflict: false,
    nextMessageId: firstMessageId,
    nextUpdateId: 1,
  };
  const port = await freePort();
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        // пустое тело — тоже вызов
      }
      const match = /^\/bot([^/]+)\/(\w+)/.exec(req.url ?? '');
      const method = match?.[2] ?? '';
      const tokenSeen = match?.[1] ?? '';
      const call = { method, body, tokenOk: tokens.includes(tokenSeen), at: Date.now() };
      bot.calls.push(call);
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const ok = (result) => send(200, { ok: true, result });
      switch (method) {
        case 'getMe':
          return ok({ id: botId, is_bot: true, username, first_name: 'QA' });
        case 'getWebhookInfo':
          return ok({ url: bot.webhookUrl, pending_update_count: 0 });
        case 'getUpdates': {
          if (bot.conflict) {
            return send(409, {
              ok: false,
              error_code: 409,
              description: 'Conflict: terminated by other getUpdates request',
            });
          }
          const offset = Number(body.offset ?? 0);
          const own = (entry) => entry.token === tokenSeen;
          if (offset === -1) {
            const last = bot.updates.filter(own).at(-1);
            bot.updates = bot.updates.filter((entry) => !own(entry) || entry === last);
            return ok(last ? [last.update] : []);
          }
          if (offset > 0) {
            bot.updates = bot.updates.filter((e) => !own(e) || e.update.update_id >= offset);
          }
          for (let i = 0; i < 8; i += 1) {
            const ready = bot.updates.filter(own).map((entry) => entry.update);
            if (ready.length > 0) return ok(ready);
            await wait(100);
          }
          return ok([]);
        }
        case 'sendMessage': {
          call.messageId = bot.nextMessageId++;
          return ok({
            message_id: call.messageId,
            chat: { id: Number(body.chat_id) },
            date: Math.floor(Date.now() / 1000),
          });
        }
        case 'editMessageText':
        case 'editMessageReplyMarkup':
        case 'answerCallbackQuery':
        case 'deleteWebhook':
        case 'setMyCommands':
        case 'deleteMessage':
        case 'deleteMessages':
          return ok(true);
        default:
          return send(404, { ok: false, error_code: 404, description: 'Not Found' });
      }
    });
  });
  await new Promise((done) => server.listen(port, '127.0.0.1', done));

  /** Положить обновление в очередь бота `token` (по умолчанию первого). */
  const push = (update, token = tokens[0]) => bot.updates.push({ token, update });
  return {
    bot,
    port,
    url: `http://127.0.0.1:${port}`,
    callsOf: (method) => bot.calls.filter((call) => call.method === method),
    push,
    /** Сообщение в чат бота: `/start`, `/status`, reply (`replyTo`)… */
    say(text, { from = owner, chat = from, type = 'private', token = tokens[0], replyTo } = {}) {
      push(
        {
          update_id: bot.nextUpdateId++,
          message: {
            message_id: bot.nextUpdateId,
            date: Math.floor(Date.now() / 1000),
            text,
            chat: { id: chat, type },
            from: { id: from, is_bot: false, first_name: 'Анна', username: 'anna_qa' },
            ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo } }),
          },
        },
        token,
      );
    },
    /** Нажатие инлайн-кнопки; возвращает id callback-запроса. */
    press(data, messageId, { from = owner, chat = owner, token = tokens[0] } = {}) {
      const id = `cb-${bot.nextUpdateId}`;
      push(
        {
          update_id: bot.nextUpdateId++,
          callback_query: {
            id,
            from: { id: from, is_bot: false, first_name: 'Q' },
            message: { message_id: messageId, chat: { id: chat, type: 'private' } },
            data,
          },
        },
        token,
      );
      return id;
    },
    close: () => new Promise((done) => server.close(() => done())),
  };
}
