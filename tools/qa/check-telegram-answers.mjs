/**
 * Ответы из Telegram на одноразовой панели — весь путь: запрос прав агента →
 * сводка «Вопросы» → опрос бота → сообщение владельцу с кнопками → нажатие →
 * тот же маршрут решения, что у кнопки в панели → ответ дошёл до процесса CLI.
 *
 * Подменены только внешние края: модель (фальшивый `claude` на PATH сам зовёт
 * брокер прав панели по адресу из её `--mcp-config`, как это делает
 * `permission-prompt-server.mjs`) и сервер Telegram (заглушка по
 * `AGENTDECK_TELEGRAM_API`, с очередью `getUpdates`). Опрос, подпись кнопок,
 * проверка владельца, применение ответа — настоящие.
 *
 * Ожидается:
 *   - два висящих запроса прав одного хода уходят ОДНИМ сообщением владельцу
 *     (`afterMinutes: 0`), у каждого «✅ Разрешить» / «⛔ Запретить»;
 *   - нажатие не владельца (чужой чат или чужой отправитель) молча отброшено:
 *     ни всплывающей строки, ни решения;
 *   - нажатие владельца решает запрос: CLI получил allow, сообщение
 *     переписано «✅ Разрешено»; повтор той же кнопки — «Уже отвечено», второго
 *     решения нет; «⛔ Запретить» второго — CLI получил deny, кнопки сняты;
 *   - вебхук у бота — статус `webhook`, `deleteWebhook` не звался ни разу;
 *   - 409 на опросе — статус `conflict`, опрос стоит (без повторов вплотную);
 *   - бот тот же, что у канала Telegram агента, — статус `same-bot` с
 *     «для ответов из Telegram нужен отдельный бот», опроса нет;
 *   - маршрута, принимающего ответ локально, нет;
 *   - токен бота не встречается ни в журнале панели, ни в ответах API, ни в
 *     файлах её дома (хранилище ключей шифрует).
 *
 * Запуск: node tools/qa/check-telegram-answers.mjs
 */
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freePort, runOnStand, wait } from './throwaway-stand.mjs';

const OWNER = 424242;
const STRANGER = 999001;
const TOKEN = '7000001:QA_answers_token_secret_ABCDEFGH';
const CHAT = 'qa-tg-chat';
const SESSION = '5e551000-0000-4000-8000-0000000000a7';
const COMMANDS = ['rm -rf build', 'rm -rf dist'];

/**
 * Фальшивый `claude`: ход с меткой QA_TG_ASK делает два вызова Bash разом и
 * спрашивает права у панели тем же запросом, что брокер; итог каждого решения —
 * строкой в `decisions.jsonl` рядом со скриптом.
 */
const FAKE_CLAUDE = String.raw`
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const self = fileURLToPath(import.meta.url);
const LOG = self.replace(/[^\\/]+$/, 'decisions.jsonl');
const ALIVE = self.replace(/[^\\/]+$/, '.stand-alive');
setInterval(() => { if (!existsSync(ALIVE)) process.exit(0); }, 250).unref();
if (argv[0] === '--version' || argv[0] === '-v') {
  process.stdout.write('2.1.0 (Claude Code)\n');
  process.exit(0);
}
const after = (flag) => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] : undefined; };
const session = after('--resume') ?? after('--session-id') ?? ${JSON.stringify(SESSION)};
const out = (event) => process.stdout.write(JSON.stringify({ ...event, session_id: session }) + '\n');

function broker() {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--mcp-config') continue;
    const raw = argv[i + 1] ?? '';
    let config;
    try { config = JSON.parse(raw.trim().startsWith('{') ? raw : readFileSync(raw, 'utf8')); } catch { continue; }
    for (const server of Object.values(config.mcpServers ?? {})) {
      if (server?.env?.PERM_BASE_URL) return server.env;
    }
  }
  return undefined;
}

async function ask(env, toolUseId, input) {
  let runId = env.PERM_RUN_ID ?? '';
  if (env.PERM_RUN_ID_FILE) { try { runId = readFileSync(env.PERM_RUN_ID_FILE, 'utf8').trim() || runId; } catch {} }
  let token = '';
  if (env.PERM_TOKEN_FILE) { try { token = readFileSync(env.PERM_TOKEN_FILE, 'utf8').trim(); } catch {} }
  const response = await fetch(env.PERM_BASE_URL + '/api/chat/permission-request', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ runId, toolName: 'Bash', input, toolUseId }),
  });
  const decision = await response.json().catch(() => ({}));
  appendFileSync(LOG, JSON.stringify({ toolUseId, command: input.command, status: response.status, behavior: decision.behavior ?? 'none', message: String(decision.message ?? '').slice(0, 300), at: Date.now() }) + '\n');
  return decision;
}

async function turn(text) {
  out({ type: 'system', subtype: 'init', cwd: process.cwd(), model: 'claude-opus-5', tools: [] });
  if (text.includes('QA_TG_ASK')) {
    const env = broker();
    const calls = ${JSON.stringify(COMMANDS)}.map((command, i) => ({ id: 'toolu_qa_tg_' + (i + 1), input: { command } }));
    out({ type: 'assistant', message: { id: 'msg_qa_tg_1', role: 'assistant', model: 'claude-opus-5', content: calls.map((c) => ({ type: 'tool_use', id: c.id, name: 'Bash', input: c.input })) } });
    if (!env) appendFileSync(LOG, JSON.stringify({ error: 'no broker in --mcp-config', argv }) + '\n');
    const decisions = env ? await Promise.all(calls.map((c) => ask(env, c.id, c.input))) : [];
    out({ type: 'user', message: { role: 'user', content: calls.map((c, i) => ({ type: 'tool_result', tool_use_id: c.id, content: decisions[i]?.behavior === 'allow' ? 'ok' : 'denied', ...(decisions[i]?.behavior === 'allow' ? {} : { is_error: true }) })) } });
  }
  const reply = 'Done.';
  out({ type: 'assistant', message: { id: 'msg_qa_tg_text', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: reply }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: reply, num_turns: 1 });
}

function textOf(line) {
  try {
    const event = JSON.parse(line);
    if (event?.type !== 'user') return undefined;
    const content = event.message?.content;
    if (typeof content === 'string') return content;
    return (Array.isArray(content) ? content : []).filter((p) => p.type === 'text').map((p) => p.text).join('');
  } catch {
    return undefined;
  }
}

if (after('--input-format') === 'stream-json') {
  let buffered = '';
  for await (const chunk of process.stdin) {
    buffered += chunk.toString('utf8');
    let at;
    while ((at = buffered.indexOf('\n')) >= 0) {
      const text = textOf(buffered.slice(0, at));
      buffered = buffered.slice(at + 1);
      if (text !== undefined) await turn(text);
    }
  }
} else {
  await turn(after('-p') ?? after('--print') ?? argv.at(-1) ?? '');
}
`;

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
    bot.calls.push({ method, body, tokenOk: tokenSeen === TOKEN, at: Date.now() });
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
        const offset = Number(body.offset ?? 0);
        for (let i = 0; i < 8; i += 1) {
          const ready = bot.updates.filter((update) => update.update_id >= offset);
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
        return ok(true);
      default:
        return send(404, { ok: false, error_code: 404, description: 'Not Found' });
    }
  });
});
await new Promise((done) => tg.listen(tgPort, '127.0.0.1', done));

const callsOf = (method) => bot.calls.filter((call) => call.method === method);
const press = (data, messageId, { from = OWNER, chat = OWNER } = {}) => {
  const id = `cb-${bot.nextUpdateId}`;
  bot.updates.push({
    update_id: bot.nextUpdateId++,
    callback_query: {
      id,
      from: { id: from, is_bot: false, first_name: 'Q' },
      message: { message_id: messageId, chat: { id: chat, type: 'private' } },
      data,
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
      web: false,
      fakeCli: { claude: FAKE_CLAUDE },
      env: { AGENTDECK_TELEGRAM_API: `http://127.0.0.1:${tgPort}` },
      seed: ({ root }) => mkdirSync(join(root, 'qa-tg-app'), { recursive: true }),
    },
    async (stand, check) => {
      const project = join(stand.root, 'qa-tg-app');
      const responses = [];
      const api = async (path, init) => {
        const reply = await stand.api(path, init);
        responses.push(reply.text);
        return reply;
      };
      const view = async () => (await api('/integrations/telegram/answers')).body;
      /**
       * Запуск хода без чтения его потока: ход с отложенными запросами держит
       * поток открытым дольше пятиминутного предела undici, и полное чтение
       * обрывало фальшивый CLI раньше, чем приходили нажатия. Нужен только статус.
       */
      const startTurn = async (path, body) => {
        const response = await fetch(`${stand.apiUrl}/api${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: response.status, text: response.ok ? '' : await response.text() };
      };
      const decisions = () => {
        try {
          return readFileSync(join(stand.bin, 'decisions.jsonl'), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line));
        } catch {
          return [];
        }
      };
      /**
       * Решение по команде. Запрос прав одиночного чата панель может отложить
       * сразу (D-n, `deferred-asks`): агенту уходит отказ-метка, а решение
       * человека ложится на запись. Иначе запрос висит, и решение получает сам CLI.
       */
      const outcome = async (command) => {
        const live = decisions().find(
          (one) => one.command === command && !one.message?.startsWith('agentdeck(deferred '),
        );
        if (live) return { via: 'cli', behavior: live.behavior };
        const list = (await api('/chat/deferred')).body?.items ?? [];
        const item = list.find((one) => one.summary?.includes(command));
        if (!item || item.state === 'waiting') return undefined;
        const behavior =
          item.state === 'denied'
            ? 'deny'
            : ['allowed', 'consumed'].includes(item.state)
              ? 'allow'
              : item.state;
        return { via: `D-n ${item.id}`, behavior, item };
      };

      // ── настройка ────────────────────────────────────────────────────
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

      // ── вопрос → сообщение ───────────────────────────────────────────
      const sent = await startTurn('/chat/send', {
        chatId: CHAT,
        prompt: 'QA_TG_ASK почисти сборку',
        projectPath: project,
      });
      check('ход запущен', sent.status < 300, sent.text.slice(0, 300));
      const message = await until(() => callsOf('sendMessage')[0], 30_000);
      check(
        'сообщение ушло владельцу',
        message?.body?.chat_id === String(OWNER),
        JSON.stringify(message?.body ?? decisions()).slice(0, 600),
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
        JSON.stringify({ allowed, decisions: decisions() }),
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
      const afterReplay = await outcome(first);
      check(
        'повтор той же кнопки — «Уже отвечено», второго решения нет',
        replayToast?.text === 'Уже отвечено' &&
          (allowed?.via === 'cli'
            ? decisions().filter((one) => one.command === first).length === 1
            : afterReplay?.item?.decidedAt === allowed?.item?.decidedAt),
        JSON.stringify({ replayToast, allowed, afterReplay }),
      );

      press(deny2.callback_data, messageId);
      const denied = await until(() => outcome(second));
      check(
        `«2 · Запретить» владельца решило запрос: ${second} → deny (${denied?.via ?? 'нет решения'})`,
        denied?.behavior === 'deny',
        JSON.stringify({ denied, decisions: decisions() }),
      );
      const closed = await until(() =>
        callsOf('editMessageText').find(
          (call) =>
            call.body.text?.includes('⛔ Запрещено') &&
            (call.body.reply_markup?.inline_keyboard ?? []).length === 0,
        ),
      );
      check(
        'закрытое сообщение — оба итога, кнопок нет',
        Boolean(closed) && closed.body.text.includes('✅ Разрешено'),
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

      // ── токен нигде ──────────────────────────────────────────────────
      const secret = TOKEN.split(':')[1];
      const leakedFiles = filesUnder(stand.root, [stand.bin]).filter((file) => {
        try {
          return readFileSync(file, 'utf8').includes(secret);
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
  tg.close();
}
