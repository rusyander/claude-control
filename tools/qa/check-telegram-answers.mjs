/**
 * Ответы из Telegram на одноразовой панели — весь путь: запрос прав сессии вне
 * панели (терминал, VS Code) → хук пересылки панели → сводка «Вопросы» → опрос
 * бота → сообщение владельцу с кнопками → нажатие → решение дошло до хука,
 * то есть до CLI.
 *
 * С этапа 10 ход `/chat` — задача ядра, и вопрос права ядра Telegram только
 * сообщает (ответ ядру — в панели или с телефона). Кнопки Telegram остались у
 * запросов, которые решает панель; здесь — запрос сессии вне панели: его держит
 * НАСТОЯЩИЙ хук `outside-relay-hook.mjs` (Claude Code запускает его так же — со
 * строкой JSON во входе), транскрипт сессии лежит в доме стенда, как его пишет CLI.
 * Подменены только внешние края: сам Claude Code (транскрипт + запуск хука) и
 * сервер Telegram (заглушка по `AGENTDECK_TELEGRAM_API`, с очередью
 * `getUpdates`). Пересылка, сводка, опрос, подпись кнопок, проверка владельца,
 * применение ответа — настоящие.
 *
 * Ожидается:
 *   - два висящих запроса прав одной сессии уходят ОДНИМ сообщением владельцу
 *     (`afterMinutes: 0`), у каждого «✅ Разрешить» / «⛔ Запретить»;
 *   - нажатие не владельца (чужой чат или чужой отправитель) молча отброшено:
 *     ни всплывающей строки, ни решения;
 *   - нажатие владельца решает запрос: хук вывел CLI allow, сообщение
 *     переписано «✅ Разрешено»; повтор той же кнопки — «Уже отвечено», второго
 *     решения нет; «⛔ Запретить» второго — хук вывел deny, кнопки сняты;
 *   - вопрос ядра (ядро стенда поднимает задачу с открытым вопросом) приходит
 *     в Telegram только уведомлением: «Ядро ждёт ответа», без кнопок, и
 *     сообщения с кнопками про него нет;
 *   - вебхук у бота — статус `webhook`, `deleteWebhook` не звался ни разу;
 *   - 409 на опросе — статус `conflict`, опрос стоит (без повторов вплотную);
 *   - бот тот же, что у канала Telegram агента, — статус `same-bot` с
 *     «для ответов из Telegram нужен отдельный бот», опроса нет;
 *   - маршрута, принимающего ответ локально, нет;
 *   - подключение по /start (бот карточки): окно ждёт, /start из группы и
 *     /start без кода окна — не кандидат, личный /start с кодом — кандидат, до подтверждения настройки не тронуты,
 *     подтверждение пишет чат уведомлений и владельца ответов, бот здоровается;
 *   - /status нового владельца — сообщение «Работают… Ждут тебя…», чужой
 *     /status — тишина; меню команд бот получает при старте опроса;
 *   - токен бота не встречается ни в журнале панели, ни в ответах API, ни в
 *     файлах её дома (хранилище ключей шифрует).
 *
 * Запуск: node tools/qa/check-telegram-answers.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freePort, REPO, runOnStand, wait } from './throwaway-stand.mjs';

const OWNER = 424242;
const STRANGER = 999001;
const TOKEN = '7000001:QA_answers_token_secret_ABCDEFGH';
/** Бот карточки Telegram — его слушает окно подключения по /start. */
const NOTIFY_TOKEN = '7000002:QA_notify_token_secret_ABCDEFGH';
const CONNECTED = 555777;
const SESSION = '5e551000-0000-4000-8000-0000000000a7';
const COMMANDS = ['rm -rf build', 'rm -rf dist'];
/** Заголовок задачи ядра с открытым вопросом — по нему находится уведомление о ней. */
const CORE_TITLE = 'Вопрос ядра посреди хода';
/** Хук пересылки — тот самый файл, который панель ставит в настройки Claude Code. */
const RELAY_HOOK = join(REPO, 'apps/server/src/domains/chat/outside-relay/outside-relay-hook.mjs');

/** Транскрипт сессии вне панели, как его пишет CLI: два вызова Bash разом, результатов ещё нет. */
function transcript(cwd, at) {
  const base = { sessionId: SESSION, cwd, version: '2.1.295', entrypoint: 'cli' };
  const records = [
    {
      ...base,
      type: 'user',
      uuid: 'u1',
      timestamp: at,
      message: { role: 'user', content: 'почисти сборку' },
    },
    {
      ...base,
      type: 'assistant',
      uuid: 'a1',
      timestamp: at,
      message: {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: COMMANDS.map((command, i) => ({
          type: 'tool_use',
          id: `toolu_qa_tg_${i + 1}`,
          name: 'Bash',
          input: { command },
        })),
      },
    },
  ];
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

/** Запущенные хуки — снимаются в конце, даже если проверка упала посреди ожидания. */
const hooks = [];

/**
 * Запуск хука так, как его запускает Claude Code на `PermissionRequest`: строка JSON во вход,
 * решение — JSON в выходе. Хук сам ждёт решения срезами `/wait`, поэтому живёт до нажатия.
 */
function startHook({ apiUrl, tokenFile, transcriptPath, cwd, command }) {
  const child = spawn(process.execPath, [RELAY_HOOK, '--url', apiUrl, '--token-file', tokenFile], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  child.stdin.end(
    JSON.stringify({
      hook_event_name: 'PermissionRequest',
      session_id: SESSION,
      transcript_path: transcriptPath,
      cwd,
      tool_name: 'Bash',
      tool_input: { command },
    }),
  );
  const hook = {
    command,
    child,
    exited: () => child.exitCode !== null,
    output: () => out,
    /** Что хук отдал CLI: allow / deny; пусто — решения не было. */
    behavior: () => {
      try {
        return JSON.parse(out).hookSpecificOutput?.decision?.behavior;
      } catch {
        return undefined;
      }
    },
  };
  hooks.push(hook);
  return hook;
}

// ---- заглушка Bot API ---------------------------------------------------------------------------
const bot = {
  calls: [],
  updates: [],
  webhookUrl: '',
  conflict: false,
  nextMessageId: 500,
  nextUpdateId: 1,
};
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
    const match = /^\/bot([^/]+)\/(\w+)/.exec(req.url ?? '');
    const method = match?.[2] ?? '';
    const tokenSeen = match?.[1] ?? '';
    bot.calls.push({
      method,
      body,
      tokenOk: tokenSeen === TOKEN || tokenSeen === NOTIFY_TOKEN,
      at: Date.now(),
    });
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const ok = (result) => send(200, { ok: true, result });
    switch (method) {
      case 'getMe':
        return ok({ id: 7000001, is_bot: true, username: 'qa_answers_bot', first_name: 'QA' });
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
        // Очередь у каждого бота своя, и, как у Telegram, `offset` подтверждает:
        // всё раньше него из очереди уходит, `-1` оставляет только последнее.
        const offset = Number(body.offset ?? 0);
        const own = (update) => update.token === tokenSeen;
        if (offset === -1) {
          const last = bot.updates.filter(own).at(-1);
          bot.updates = bot.updates.filter((update) => !own(update) || update === last);
          return ok(last ? [last.update] : []);
        }
        if (offset > 0) {
          bot.updates = bot.updates.filter((u) => !own(u) || u.update.update_id >= offset);
        }
        for (let i = 0; i < 8; i += 1) {
          const ready = bot.updates.filter(own).map((u) => u.update);
          if (ready.length > 0) return ok(ready);
          await wait(100);
        }
        return ok([]);
      }
      case 'sendMessage':
        return ok({
          message_id: bot.nextMessageId++,
          chat: { id: Number(body.chat_id) },
          date: Math.floor(Date.now() / 1000),
        });
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

const callsOf = (method) => bot.calls.filter((call) => call.method === method);
/** Сообщение в личный чат бота: `/start`, `/status`… */
const say = (text, { from = OWNER, chat = from, type = 'private', token = TOKEN } = {}) =>
  bot.updates.push({
    token,
    update: {
      update_id: bot.nextUpdateId++,
      message: {
        message_id: bot.nextUpdateId,
        date: Math.floor(Date.now() / 1000),
        text,
        chat: { id: chat, type },
        from: { id: from, is_bot: false, first_name: 'Анна', username: 'anna_qa' },
      },
    },
  });
const press = (data, messageId, { from = OWNER, chat = OWNER } = {}) => {
  const id = `cb-${bot.nextUpdateId}`;
  bot.updates.push({
    token: TOKEN,
    update: {
      update_id: bot.nextUpdateId++,
      callback_query: {
        id,
        from: { id: from, is_bot: false, first_name: 'Q' },
        message: { message_id: messageId, chat: { id: chat, type: 'private' } },
        data,
      },
    },
  });
  return id;
};
async function until(probe, ms = 20_000, step = 200) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value || Date.now() > deadline) return value;
    await wait(step);
  }
}

/** Все файлы дома стенда, кроме фальшивого CLI: токен в открытом виде не должен лежать нигде. */
function filesUnder(dir, skip) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (skip.includes(path)) continue;
    let info;
    try {
      info = statSync(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) found.push(...filesUnder(path, skip));
    else if (info.size < 5_000_000) found.push(path);
  }
  return found;
}

try {
  await runOnStand(
    {
      label: 'tg-answers',
      // Своё ядро стенда — источник вопроса ядра (задача с открытым вопросом поднимается при старте).
      core: true,
      web: false,
      env: {
        AGENTDECK_CORE_SUPERVISE: '0',
        AGENTDECK_TELEGRAM_API: `http://127.0.0.1:${tgPort}`,
        // Две минуты тишины после старта панели (B7) стенду ждать незачем.
        AGENTDECK_TELEGRAM_SEND_GRACE_MS: '0',
      },
      seed: ({ root, cfg, coreHome }) => {
        const project = join(root, 'qa-tg-app');
        mkdirSync(project, { recursive: true });
        // Транскрипт — там, где его ищет сводка: `<конфиг>/projects/<каталог проекта>/<сессия>.jsonl`.
        const dir = join(cfg, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, `${SESSION}.jsonl`),
          transcript(project, new Date(Date.now() - 30_000).toISOString()),
          'utf8',
        );
        const out = spawnSync(
          process.execPath,
          [
            '--experimental-strip-types',
            '--no-warnings',
            join(REPO, 'tools/qa/core-ask-seed.mjs'),
            coreHome,
            CORE_TITLE,
          ],
          { encoding: 'utf8' },
        );
        if (out.status !== 0) throw new Error(`core-ask-seed: ${out.stderr}`);
      },
    },
    async (stand, check) => {
      const project = join(stand.root, 'qa-tg-app');
      const transcriptPath = join(
        stand.cfg,
        'projects',
        project.replace(/[^a-zA-Z0-9]/g, '-'),
        `${SESSION}.jsonl`,
      );
      const responses = [];
      const api = async (path, init) => {
        const reply = await stand.api(path, init);
        responses.push(reply.text);
        return reply;
      };
      const view = async () => (await api('/integrations/telegram/answers')).body;
      /** Решение по команде — то, что хук отдал CLI; хук ещё ждёт — решения нет. */
      const outcome = (command) => {
        const hook = hooks.find((one) => one.command === command);
        return hook?.exited() ? { via: 'хук', behavior: hook.behavior() ?? 'нет' } : undefined;
      };
      const toolUseOf = (command) => `toolu_qa_tg_${COMMANDS.indexOf(command) + 1}`;

      // ── настройка ────────────────────────────────────────────────────
      // Главный выключатель карточки Telegram: выключена — ответы не слушают.
      const cardOn = await api('/integrations/telegram', {
        method: 'PUT',
        body: { settings: { enabled: true, chatId: String(OWNER), events: ['runError'] } },
      });
      check('карточка Telegram включена', cardOn.status === 200, cardOn.text.slice(0, 300));
      const saved = await api('/integrations/telegram/answers', {
        method: 'PUT',
        body: { enabled: true, afterMinutes: 0, ownerId: String(OWNER), token: TOKEN },
      });
      check('настройка сохранена', saved.status === 200, saved.text.slice(0, 300));
      const started = await until(async () => {
        const current = await view();
        return current?.status?.state === 'polling' ? current : undefined;
      }, 10_000);
      check(
        'опрос пошёл: статус polling, бот @qa_answers_bot, токен только маской',
        started?.status?.bot === '@qa_answers_bot' &&
          started?.hasToken === true &&
          typeof started?.maskedToken === 'string' &&
          !started.maskedToken.includes(TOKEN),
        JSON.stringify(started),
      );
      check(
        'вызовы Bot API идут с сохранённым токеном',
        bot.calls.length > 0 && bot.calls.every((call) => call.tokenOk),
      );
      const relay = await api('/outside/relay', { method: 'PATCH', body: { enabled: true } });
      check(
        'пересылка сессий вне панели включена, хуки стоят в настройках Claude Code стенда',
        relay.status === 200 && relay.body?.enabled === true && relay.body?.installed === true,
        relay.text.slice(0, 300),
      );

      // ── вопрос → сообщение ───────────────────────────────────────────
      const tokenFile = join(stand.home, '.agentdeck', 'api-token');
      for (const command of COMMANDS) {
        startHook({ apiUrl: stand.apiUrl, tokenFile, transcriptPath, cwd: project, command });
      }
      const message = await until(
        () => callsOf('sendMessage').find((call) => call.body.reply_markup),
        30_000,
      );
      check(
        'сообщение с кнопками ушло владельцу',
        message?.body?.chat_id === String(OWNER),
        JSON.stringify({
          sent: callsOf('sendMessage').map((call) => call.body),
          hooks: hooks.map((one) => ({ exited: one.exited(), out: one.output() })),
        }).slice(0, 900),
      );
      if (!message) return;
      const text = message.body.text ?? '';
      const buttons = (message.body.reply_markup?.inline_keyboard ?? []).flat();
      const button = (label) => buttons.find((one) => one.text === label);
      const allow1 = button('1 · ✅ Разрешить');
      const allow2 = button('2 · ✅ Разрешить');
      const deny2 = button('2 · ⛔ Запретить');
      check(
        'оба запроса — в одном сообщении, у каждого «Разрешить» и «Запретить»',
        callsOf('sendMessage').length === 1 && allow1 && allow2 && deny2,
        JSON.stringify(buttons.map((one) => one.text)),
      );
      check(
        'данные кнопок не длиннее 64 байт',
        buttons.length > 0 &&
          buttons.every((one) => Buffer.byteLength(one.callback_data, 'utf8') <= 64),
      );
      // Какой команде принадлежит пункт 1 — по порядку в тексте сообщения.
      const at = COMMANDS.map((command) => text.indexOf(command));
      const first = at[0] >= 0 && at[1] >= 0 && at[1] < at[0] ? COMMANDS[1] : COMMANDS[0];
      const second = first === COMMANDS[0] ? COMMANDS[1] : COMMANDS[0];
      const messageId = message?.body ? bot.nextMessageId - 1 : 0;

      // ── чужие нажатия ────────────────────────────────────────────────
      const strangerA = press(allow2.callback_data, messageId, { from: STRANGER, chat: STRANGER });
      const strangerB = press(allow2.callback_data, messageId, { from: STRANGER, chat: OWNER });
      await wait(3_000);
      const toasts = () => callsOf('answerCallbackQuery').map((call) => call.body);
      const strangerOutcome = await Promise.all(COMMANDS.map(outcome));
      check(
        'нажатие не владельца (чужой чат, чужой отправитель) отброшено молча',
        !toasts().some((one) => [strangerA, strangerB].includes(one.callback_query_id)) &&
          strangerOutcome.every((one) => one === undefined),
        JSON.stringify({ toasts: toasts(), strangerOutcome }),
      );

      // ── нажатие владельца ────────────────────────────────────────────
      const ownerPress = press(allow1.callback_data, messageId);
      const allowed = await until(() => outcome(first));
      check(
        `«1 · Разрешить» владельца решило запрос: ${first} → allow (${allowed?.via ?? 'нет решения'})`,
        allowed?.behavior === 'allow',
        JSON.stringify({ allowed, hooks: hooks.map((one) => one.output()) }),
      );
      const editedAllowed = await until(() =>
        callsOf('editMessageText').find((call) => call.body.text?.includes('✅ Разрешено')),
      );
      check(
        'сообщение переписано «✅ Разрешено», у второго кнопки остались',
        Boolean(editedAllowed) &&
          (editedAllowed.body.reply_markup?.inline_keyboard ?? [])
            .flat()
            .some((one) => one.text.startsWith('2 ·')),
        JSON.stringify(callsOf('editMessageText').map((call) => call.body.text)),
      );
      check(
        'всплывающая строка на нажатие владельца есть',
        Boolean(await until(() => toasts().find((one) => one.callback_query_id === ownerPress))),
      );

      const replay = press(allow1.callback_data, messageId);
      const replayToast = await until(() =>
        toasts().find((one) => one.callback_query_id === replay),
      );
      // Решение пересылка отдаёт хуку один раз и забывает запрос: второму решению некуда лечь.
      const afterReplay = await api(
        `/outside/asks/${encodeURIComponent(toolUseOf(first))}/wait?ms=1000`,
      );
      check(
        'повтор той же кнопки — «Уже отвечено», второго решения нет',
        replayToast?.text === 'Уже отвечено' && afterReplay.body?.state === 'unknown',
        JSON.stringify({ replayToast, allowed, afterReplay: afterReplay.body }),
      );

      press(deny2.callback_data, messageId);
      const denied = await until(() => outcome(second));
      check(
        `«2 · Запретить» владельца решило запрос: ${second} → deny (${denied?.via ?? 'нет решения'})`,
        denied?.behavior === 'deny',
        JSON.stringify({ denied, hooks: hooks.map((one) => one.output()) }),
      );
      const closed = await until(() =>
        callsOf('editMessageText').find(
          (call) =>
            call.body.text?.includes('Запрещено') &&
            (call.body.reply_markup?.inline_keyboard ?? []).length === 0,
        ),
      );
      // Отвечено всё — сообщение свёрнуто: строка итога на ожидание, без разметки и кнопок.
      // Вид строки — `compose.ts`: «✅ Разрешено 15:54 · git push · 📁 shop · Терминал · сессия».
      const lines = closed?.body.text.split('\n') ?? [];
      const collapsed = (mark, command) =>
        new RegExp(`^${mark} \\d\\d:\\d\\d · ${command} · 📁 qa-tg-app · .+$`);
      check(
        'закрытое сообщение свёрнуто: две строки итога, без подробностей и кнопок',
        lines.length === 2 &&
          collapsed('✅ Разрешено', first).test(lines[0]) &&
          collapsed('⛔ Запрещено', second).test(lines[1]) &&
          !closed.body.text.includes('<'),
        JSON.stringify(callsOf('editMessageText').at(-1)?.body ?? {}),
      );

      // ── маршрута «ответить за Telegram» нет ──────────────────────────
      const local = await Promise.all(
        ['/integrations/telegram/answers/answer', '/integrations/telegram/answers/press'].map(
          (path) => api(path, { method: 'POST', body: { data: allow2.callback_data } }),
        ),
      );
      check(
        'локального маршрута, принимающего ответ, нет',
        local.every((reply) => reply.status === 404),
        local.map((reply) => reply.status).join(','),
      );

      // ── вебхук ───────────────────────────────────────────────────────
      bot.webhookUrl = 'https://hooks.example.com/bot';
      await api('/integrations/telegram/answers/restart', { method: 'POST' });
      const hooked = await until(async () => {
        const current = await view();
        return current?.status?.state === 'webhook' ? current : undefined;
      }, 10_000);
      check(
        'у бота вебхук — статус webhook, deleteWebhook не звался',
        Boolean(hooked) && callsOf('deleteWebhook').length === 0,
        JSON.stringify((await view())?.status),
      );
      bot.webhookUrl = '';

      // ── 409 ──────────────────────────────────────────────────────────
      bot.conflict = true;
      await api('/integrations/telegram/answers/restart', { method: 'POST' });
      const conflicted = await until(async () => {
        const current = await view();
        return current?.status?.state === 'conflict' ? current : undefined;
      }, 10_000);
      const polls = callsOf('getUpdates').length;
      await wait(3_000);
      check(
        '409 — статус conflict, опрос стоит без повторов',
        Boolean(conflicted) && callsOf('getUpdates').length === polls,
        JSON.stringify({
          status: (await view())?.status,
          polls,
          after: callsOf('getUpdates').length,
        }),
      );
      bot.conflict = false;

      // ── тот же бот, что у канала агента ──────────────────────────────
      const channel = join(stand.cfg, 'channels', 'telegram');
      mkdirSync(channel, { recursive: true });
      writeFileSync(join(channel, '.env'), `TELEGRAM_BOT_TOKEN=${TOKEN}\n`, 'utf8');
      const before = bot.calls.length;
      await api('/integrations/telegram/answers/restart', { method: 'POST' });
      const same = await until(async () => {
        const current = await view();
        return current?.status?.state === 'same-bot' ? current : undefined;
      }, 10_000);
      await wait(1_000);
      check(
        'бот канала агента — same-bot «для ответов из Telegram нужен отдельный бот», к боту ни одного вызова',
        same?.status?.detail === 'для ответов из Telegram нужен отдельный бот' &&
          bot.calls.length === before,
        JSON.stringify({
          status: same?.status,
          calls: bot.calls.slice(before).map((c) => c.method),
        }),
      );
      rmSync(join(channel, '.env'), { force: true });

      // ── подключение по /start ────────────────────────────────────────
      // Опрос ответов стоит (same-bot выше), окно слушает бота карточки само.
      const card = await api('/integrations/telegram', {
        method: 'PUT',
        body: {
          settings: { enabled: false, chatId: '', events: ['runError', 'question'] },
          token: NOTIFY_TOKEN,
        },
      });
      check('токен бота карточки сохранён', card.status === 200, card.text.slice(0, 300));
      const opened = await api('/integrations/telegram/connect', { method: 'POST', body: {} });
      const code = /^https:\/\/t\.me\/qa_answers_bot\?start=([A-Za-z0-9_-]{16})$/.exec(
        opened.body?.link ?? '',
      )?.[1];
      check(
        'окно подключения: ждём /start, ссылка на бота с кодом окна',
        opened.body?.state === 'waiting' && Boolean(code),
        JSON.stringify(opened.body),
      );
      say(`/start ${code}`, { from: STRANGER, chat: -100500, type: 'group', token: NOTIFY_TOKEN });
      // Посторонний в личном чате без кода окна: окно не занято.
      say('/start', { from: STRANGER, token: NOTIFY_TOKEN });
      say('/start wrongcode', { from: STRANGER, token: NOTIFY_TOKEN });
      await wait(2_000);
      check(
        '/start из группы и /start без кода окна — не кандидат',
        (await api('/integrations/telegram/connect')).body?.state === 'waiting',
      );
      say(`/start ${code}`, { from: CONNECTED, token: NOTIFY_TOKEN });
      const candidate = await until(async () => {
        const current = (await api('/integrations/telegram/connect')).body;
        return current?.state === 'candidate' ? current : undefined;
      }, 15_000);
      const settingsBefore = (await api('/settings')).body?.integrations?.telegram;
      check(
        'личный /start — кандидат с id; настройки до подтверждения не тронуты',
        candidate?.candidate?.id === String(CONNECTED) && settingsBefore?.chatId === '',
        JSON.stringify({ candidate, settingsBefore }),
      );
      const confirmed = await api('/integrations/telegram/connect/confirm', {
        method: 'POST',
        body: {},
      });
      const telegramAfter = (await api('/settings')).body?.integrations?.telegram;
      const answersAfter = await view();
      // Уведомление о вопросе ядра приходит в этот же чат — приветствие ищется по тексту.
      const greeting = await until(() =>
        callsOf('sendMessage').find(
          (call) =>
            call.body.chat_id === String(CONNECTED) &&
            String(call.body.text ?? '').startsWith('✅ Подключено'),
        ),
      );
      // Разобранный окном /start подтверждён: ни один бот не отвечает на него второй раз.
      await wait(2_000);
      const twice = callsOf('sendMessage').filter(
        (call) =>
          call.body.chat_id === String(CONNECTED) &&
          String(call.body.text ?? '').includes('Уже подключено'),
      );
      check(
        'подтверждение: чат уведомлений и владелец ответов записаны, оба включены, бот поздоровался',
        confirmed.status === 200 &&
          telegramAfter?.chatId === String(CONNECTED) &&
          telegramAfter?.enabled === true &&
          answersAfter?.settings?.ownerId === String(CONNECTED) &&
          answersAfter?.settings?.enabled === true &&
          String(greeting?.body?.text ?? '').startsWith('✅ Подключено к AgentDeck') &&
          twice.length === 0,
        JSON.stringify({
          confirmed: confirmed.body,
          telegramAfter,
          answers: answersAfter?.settings,
        }),
      );

      // ── вопрос ядра — только уведомлением ────────────────────────────
      // Задача ядра с открытым вопросом ждала с запуска: до подтверждения у карточки не было ни
      // токена, ни события «вопрос». Ответ ядру Telegram не доказывает (human-strict), поэтому
      // сообщение без кнопок, и опрос ответов своего сообщения с кнопками о нём не шлёт.
      const coreNotice = await until(
        () =>
          callsOf('sendMessage').find((call) =>
            String(call.body.text ?? '').includes('Ядро ждёт ответа'),
          ),
        30_000,
      );
      const coreButtons = callsOf('sendMessage').filter(
        (call) => call.body.reply_markup && String(call.body.text ?? '').includes(CORE_TITLE),
      );
      check(
        'вопрос ядра — уведомление «Ядро ждёт ответа» с заголовком задачи и ссылкой, без кнопок',
        coreNotice?.body?.chat_id === String(CONNECTED) &&
          String(coreNotice?.body?.text ?? '').includes(CORE_TITLE) &&
          String(coreNotice?.body?.text ?? '').includes('/core?id=') &&
          !coreNotice?.body?.reply_markup &&
          coreButtons.length === 0,
        JSON.stringify({
          notice: coreNotice?.body,
          withButtons: coreButtons.map((call) => call.body.text),
        }).slice(0, 900),
      );

      // ── команды владельца ────────────────────────────────────────────
      const polling = await until(async () => {
        const current = await view();
        return current?.status?.state === 'polling' ? current : undefined;
      }, 10_000);
      check('после подтверждения опрос ответов слушает', Boolean(polling), JSON.stringify(polling));
      check(
        'меню команд бот получил: /status, /waiting, /clear, /help',
        callsOf('setMyCommands').some(
          (call) =>
            (call.body.commands ?? []).map((one) => one.command).join(',') ===
            'status,waiting,clear,help',
        ),
      );
      const toStranger = () =>
        callsOf('sendMessage').filter((call) => call.body.chat_id === String(STRANGER));
      say('/status', { from: STRANGER });
      say('/status', { from: CONNECTED });
      const status = await until(() =>
        callsOf('sendMessage').find(
          (call) =>
            call.body.chat_id === String(CONNECTED) &&
            String(call.body.text ?? '').startsWith('⚙️ Работают:'),
        ),
      );
      check(
        '/status владельца — «Работают… Ждут тебя…»; чужой /status — тишина',
        String(status?.body?.text ?? '').includes('⏳ Ждут тебя:') && toStranger().length === 0,
        JSON.stringify({ status: status?.body?.text, stranger: toStranger().length }),
      );

      // ── /clear ───────────────────────────────────────────────────────
      say('/clear', { from: CONNECTED });
      const cleared = await until(() =>
        callsOf('sendMessage').find(
          (call) =>
            call.body.chat_id === String(CONNECTED) &&
            String(call.body.text ?? '').startsWith('🧹 Убрал'),
        ),
      );
      const batch = callsOf('deleteMessages').at(-1);
      check(
        '/clear владельца — сообщения бота и команды удалены пачкой, ответ «🧹 Убрал N»',
        Boolean(cleared) &&
          batch?.body?.chat_id === String(CONNECTED) &&
          (batch?.body?.message_ids ?? []).length > 0,
        JSON.stringify({ reply: cleared?.body?.text, batch: batch?.body }),
      );

      // ── токен нигде ──────────────────────────────────────────────────
      const secret = TOKEN.split(':')[1];
      const notifySecret = NOTIFY_TOKEN.split(':')[1];
      const leakedFiles = filesUnder(stand.root, [stand.bin]).filter((file) => {
        try {
          const text = readFileSync(file, 'utf8');
          return text.includes(secret) || text.includes(notifySecret);
        } catch {
          return false;
        }
      });
      check(
        'токена нет ни в журнале панели, ни в ответах API, ни в файлах дома',
        !stand.log().includes(secret) &&
          responses.every((body) => !body.includes(secret)) &&
          // Файл канала агента стёрт выше; иначе он был бы единственным законным.
          leakedFiles.length === 0,
        JSON.stringify({
          log: stand.log().includes(secret),
          responses: responses.filter((body) => body.includes(secret)).length,
          files: leakedFiles,
        }),
      );
    },
  );
} finally {
  // Хук без решения ждал бы до своего предела (50 мин) — снимаем всех, кто ещё жив.
  for (const hook of hooks) if (!hook.exited()) hook.child.kill();
  tg.close();
}
