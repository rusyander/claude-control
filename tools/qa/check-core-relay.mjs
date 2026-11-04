/**
 * Пересылка вопроса ядра в Telegram (этап 10, зона D): НАСТОЯЩЕЕ ядро стенда с открытым вопросом,
 * НАСТОЯЩИЙ сервер панели, заглушка Bot API на свободном порту (`AGENTDECK_TELEGRAM_API`).
 *
 * Что проверяется:
 * 0. Канал выключен — вопрос ждёт в `pending` файла пересылки и сообщённым не числится; Telegram
 *    включён через панель (`PUT /integrations/telegram`) — вопрос уходит.
 * 1. Вопрос ядра → ровно одно сообщение Telegram: заголовок задачи, суть вопроса, «ответить в панели
 *    или с телефона» и ссылка панели именно на эту задачу и этот вопрос (`/core?id=…&ask=…`).
 * 2. Курсор и отправленный вопрос записаны в `<дом панели>/core-relay.json`, ожидание пусто.
 * 3. Жёсткий перезапуск панели посреди открытого вопроса — второго сообщения нет.
 * 4. Reply владельца на это сообщение ответом НЕ становится: бот отвечает отказом, где названы
 *    панель и телефон, вопрос в виде задачи остаётся открытым.
 *
 * Вопрос в журнале — кодом ядра до его старта (`core-ask-seed.mjs`); токен бота и выключенная
 * подписка Telegram — до старта панели. Сеть не нужна.
 * Запуск: `node tools/qa/check-core-relay.mjs`. Код выхода: 0 / 1 провал / 2 стенд.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { freePort, REPO, runOnStand, wait } from './throwaway-stand.mjs';

const { writeToken } = await import('../../apps/server/src/domains/integrations/store/store.ts');

const OWNER = 424243;
const TOKEN = '7000003:QA_relay_token_secret_ABCDEFGH';
const TITLE = 'Пересылка вопроса ядра';

// ---- заглушка Bot API ---------------------------------------------------------------------------
const bot = { calls: [], updates: [], nextMessageId: 900, nextUpdateId: 1 };
const tgPort = await freePort();
const tg = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      // пустое тело — тоже вызов
    }
    const method = /^\/bot[^/]+\/(\w+)/.exec(req.url ?? '')?.[1] ?? '';
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const ok = (result) => send(200, { ok: true, result });
    switch (method) {
      case 'getMe':
        return ok({ id: 7000003, is_bot: true, username: 'qa_relay_bot', first_name: 'QA' });
      case 'getWebhookInfo':
        return ok({ url: '', pending_update_count: 0 });
      case 'getUpdates': {
        const offset = Number(body.offset ?? 0);
        if (offset > 0) bot.updates = bot.updates.filter((u) => u.update_id >= offset);
        for (let i = 0; i < 8; i += 1) {
          if (bot.updates.length > 0) return ok(bot.updates);
          await wait(100);
        }
        return ok([]);
      }
      case 'sendMessage': {
        const messageId = bot.nextMessageId++;
        bot.calls.push({ method, body, messageId });
        return ok({
          message_id: messageId,
          chat: { id: Number(body.chat_id) },
          date: Math.floor(Date.now() / 1000),
        });
      }
      case 'editMessageText':
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
await new Promise((done) => tg.listen(tgPort, '127.0.0.1', done));

const sent = () => bot.calls.filter((call) => call.method === 'sendMessage');
const asksSent = () => sent().filter((call) => String(call.body.text).includes('Ядро ждёт ответа'));
async function until(probe, ms = 30_000, step = 250) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value || Date.now() > deadline) return value;
    await wait(step);
  }
}

let seeded;
try {
  await runOnStand(
    {
      label: 'core-relay',
      core: true,
      web: false,
      env: {
        // Ядро стенда — своё (`core: true`): надзор панели второго не поднимает.
        AGENTDECK_CORE_SUPERVISE: '0',
        AGENTDECK_TELEGRAM_API: `http://127.0.0.1:${tgPort}`,
        AGENTDECK_TELEGRAM_SEND_GRACE_MS: '0',
      },
      settings: {
        integrations: {
          // Канал сначала ВЫКЛЮЧЕН: вопрос должен ждать, а не числиться сообщённым.
          telegram: { enabled: false, chatId: String(OWNER), events: ['question'] },
        },
      },
      seed: ({ cfg, coreHome }) => {
        const out = spawnSync(
          process.execPath,
          [
            '--experimental-strip-types',
            '--no-warnings',
            join(REPO, 'tools/qa/core-ask-seed.mjs'),
            coreHome,
            TITLE,
          ],
          { encoding: 'utf8' },
        );
        if (out.status !== 0) throw new Error(`seed failed: ${out.stderr}`);
        seeded = JSON.parse(out.stdout.trim().split('\n').at(-1));
        writeToken(join(cfg, 'agentdeck'), 'telegram', TOKEN);
      },
    },
    async (stand, check) => {
      const { taskId, askId } = seeded;
      const statePath = join(stand.home, '.agentdeck', 'core-relay.json');
      const readState = () =>
        existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;

      // Каналов нет: пересылка прочла вопрос, но сообщить некуда — он ждёт, а не «сообщён».
      const waiting = await until(() =>
        readState()?.pending?.some((item) => item.askId === askId) ? readState() : null,
      );
      check(
        'канал выключен — вопрос ждёт в pending, не записан сообщённым',
        Boolean(waiting) && !waiting.delivered?.includes(askId) && asksSent().length === 0,
        JSON.stringify(readState()),
      );
      const enabled = await stand.api('/integrations/telegram', {
        method: 'PUT',
        body: { settings: { enabled: true, chatId: String(OWNER), events: ['question'] } },
      });
      check('Telegram включён через панель', enabled.status === 200, enabled.text.slice(0, 300));

      const first = await until(() => asksSent()[0]);
      check('вопрос ядра пришёл в Telegram', Boolean(first), JSON.stringify(sent().slice(-3)));
      const text = String(first?.body.text ?? '');
      check(
        'в сообщении заголовок задачи и «ответить в панели или с телефона»',
        text.includes(TITLE) && text.includes('в панели или с телефона'),
        text,
      );
      check(
        'ссылка — на эту задачу и этот вопрос',
        text.includes(`/core?id=${taskId}&amp;ask=${askId}`),
        text,
      );
      check('сообщение без кнопок (ответить в Telegram нельзя)', !first?.body.reply_markup);

      const state = await until(() =>
        readState()?.delivered?.includes(askId) ? readState() : null,
      );
      check(
        'курсор и отправленный вопрос записаны в core-relay.json, ожидание пусто',
        state?.delivered?.includes(askId) &&
          typeof state?.cursors?.[taskId] === 'string' &&
          state?.pending?.length === 0,
        JSON.stringify(readState()),
      );

      await stand.restartHard();
      // Три круга пересылки после перезапуска: поток задачи перечитан с курсора.
      await wait(10_000);
      check(
        'после жёсткого перезапуска панели — по-прежнему одно сообщение',
        asksSent().length === 1,
        `сообщений о вопросе: ${asksSent().length}`,
      );

      const answers = await stand.api('/integrations/telegram/answers', {
        method: 'PUT',
        body: { enabled: true, afterMinutes: 0, ownerId: String(OWNER), token: TOKEN },
      });
      check('ответы из Telegram включены', answers.status === 200, answers.text.slice(0, 300));
      const before = sent().length;
      bot.updates.push({
        update_id: bot.nextUpdateId++,
        message: {
          message_id: 7001,
          date: Math.floor(Date.now() / 1000),
          text: 'approve-split',
          chat: { id: OWNER, type: 'private' },
          from: { id: OWNER, is_bot: false, first_name: 'Анна' },
          reply_to_message: { message_id: first?.messageId ?? 0 },
        },
      });
      const refusal = await until(() =>
        sent()
          .slice(before)
          .find((call) => String(call.body.text).includes('ядру не передан')),
      );
      const refusalText = String(refusal?.body.text ?? '');
      check(
        'reply на вопрос ядра — отказ, названы панель и телефон, ссылка на задачу',
        refusalText.includes('в панели') &&
          refusalText.includes('с телефона') &&
          refusalText.includes(`/core?id=${taskId}`),
        refusalText || JSON.stringify(sent().slice(before)),
      );
      const view = await stand.api(`/core/tasks/${taskId}`);
      const ask = view.body?.view?.asks?.find((one) => one.askId === askId);
      check(
        'вопрос в виде задачи остался открытым',
        ask?.state === 'open',
        JSON.stringify(ask ?? view.body),
      );
    },
  );
} finally {
  tg.close();
}
