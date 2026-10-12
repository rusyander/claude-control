/**
 * Жизнь прогона чата Claude на телефоне — стор `shared/lib/runs` на устройстве,
 * а не в юнит-тестах: настоящий сервер одноразовой панели, фальшивый `claude`
 * (ход STREAMHOLD держится `FAKE_HOLD_MS`, по умолчанию 60 с, текст идёт потоком).
 *
 * Три части, у каждой свой разговор — счёт строк ответа не путается чужими:
 * - очередь и переподхват после перезапуска приложения: слово на ходу не дошло
 *   (запрос «на ходу» оборван сетью — так же, как сервер без живой сессии),
 *   встало в очередь; приложение убито и поднято — ход подхвачен, очередь
 *   восстановлена и дослана ОДИН раз, когда агент освободился;
 * - тишина 30 с: прокси замораживает поток хода посреди ответа — телефон
 *   говорит «связь потеряна», переподключается с последнего номера и доводит
 *   ход, не набирая текст второй раз;
 * - холодный старт после конца прогона: приложение убито посреди хода и
 *   поднято, когда ход кончился, — ответ на экране один раз, «Стоп» нет.
 *
 * Подменена только сеть (обрыв одного запроса, замёрзший поток) — сервер,
 * его реестр прогонов и стор телефона настоящие.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { wait } from './throwaway-stand.mjs';
import { PACKAGE } from './android-device.mjs';
import { transcriptDir } from './mobile-device-fixtures.mjs';

const CHATS = {
  queue: { sid: '5e551011-0000-4000-8000-0000000011f1', title: 'LIFE queue chat' },
  silence: { sid: '5e551011-0000-4000-8000-0000000011f2', title: 'LIFE silence chat' },
  cold: { sid: '5e551011-0000-4000-8000-0000000011f3', title: 'LIFE cold chat' },
};
const REPLY = /^STREAMING the turn$/;
const STOP = /^(Stop|Стоп)$/;
const RECONNECTING = /^(Connection lost, reconnecting…|Связь прервалась, переподключаемся…)$/;
const QUEUED_TEXT = 'LIFE queued two';
const QUEUED_ROW = /^(Queued|В очереди): LIFE queued two/;
/** Ход фальшивого CLI держится 60 с; запас — на подъём процесса и опросы. */
const TURN_END_MS = 100_000;

export function setupChatLife({ stand, project }) {
  const dir = transcriptDir(stand.cfg, project);
  mkdirSync(dir, { recursive: true });
  const at = (offsetMs) => new Date(Date.now() - offsetMs).toISOString();
  for (const { sid, title } of Object.values(CHATS)) {
    const base = { sessionId: sid, cwd: project };
    const lines = [
      {
        type: 'user',
        uuid: `${sid}-1`,
        timestamp: at(100_000),
        message: { role: 'user', content: title },
      },
      {
        type: 'assistant',
        uuid: `${sid}-2`,
        timestamp: at(90_000),
        // Закрытый ход: без `stop_reason` сводка видит работу вне панели.
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `${title} ready.` }],
          stop_reason: 'end_turn',
        },
      },
    ];
    writeFileSync(
      join(dir, `${sid}.jsonl`),
      lines.map((line) => JSON.stringify({ ...base, ...line })).join('\n') + '\n',
      'utf8',
    );
  }
}

/**
 * `POST /api/chat/send` через прокси со своими правилами: запрос «на ходу» с
 * `dropSteer` в тексте рвётся (сеть), поток с `freeze` в тексте замерзает после
 * первого куска с `STREAMING`. Остальное идёт наверх как есть.
 */
export function sendRoute(upstream, state) {
  const target = new URL(upstream);
  return {
    name: 'chat-send-life',
    match: (method, path) => method === 'POST' && path === '/api/chat/send',
    handle: async (req, res, _url, entry) => {
      const raw = await new Promise((done) => {
        let text = '';
        req.on('data', (chunk) => (text += chunk));
        req.on('end', () => done(text));
      });
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        // не JSON — уходит наверх как есть
      }
      entry.body = body;
      const prompt = String(body.prompt ?? '');
      if (body.steer && state.dropSteer && prompt.includes(state.dropSteer)) {
        state.droppedSteers += 1;
        req.socket.destroy();
        return;
      }
      const freeze = Boolean(state.freeze && prompt.includes(state.freeze));
      const headers = { ...req.headers, host: target.host };
      delete headers['content-length'];
      const upstreamReq = httpRequest(
        { host: target.hostname, port: target.port, method: 'POST', path: req.url, headers },
        (upstreamRes) => {
          entry.status = upstreamRes.statusCode;
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.on('data', (chunk) => {
            if (res.writableEnded || res.destroyed) return;
            if (freeze && state.frozenAt) return; // наверх читаем дальше, телефону — ни байта
            res.write(chunk);
            if (freeze && String(chunk).includes('STREAMING')) state.frozenAt = Date.now();
          });
          upstreamRes.on('end', () => {
            if (!(freeze && state.frozenAt)) res.end();
          });
        },
      );
      upstreamReq.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      res.on('close', () => upstreamReq.destroy());
      upstreamReq.end(raw);
    },
  };
}

async function openChat(phone, title) {
  phone.shell(`am start -a android.intent.action.VIEW -d agentdeck://chats ${PACKAGE}`);
  // В полном прогоне разговор заведён за полчаса до этой части, и новые
  // разговоры других сценариев уносят его строку за край списка.
  const row = new RegExp(`^${title}$`);
  await phone.waitFor(/^(Search by title|Поиск по названию)$/, 20_000);
  if (!(await phone.scrollTo(row))) throw new Error(`в списке разговоров нет «${title}»`);
  await phone.tap(row, 5000);
  await phone.waitFor(new RegExp(`^${title} ready\\.$`), 20_000);
}

async function coldLaunch(phone) {
  phone.stopApp();
  await wait(1500);
  phone.launch();
  await phone.waitFor(/^(Home|Главная)$/, 30_000);
}

async function say(phone, text) {
  const [field] = (await phone.screen()).filter((node) => node.cls.endsWith('EditText'));
  phone.tapAt(field.x, field.y);
  await wait(400);
  phone.type(text);
  phone.hideKeyboard();
  await wait(400);
  await phone.tap(/^(Send|Отправить)$/);
}

const callsOf = (ctx, sid) => ctx.calls().filter((call) => call.sid === sid);
const said = (ctx, sid, text) => callsOf(ctx, sid).filter((call) => call.text === text);
const done = (ctx, sid, text) => callsOf(ctx, sid).some((call) => call.done === text.slice(0, 40));

async function until(predicate, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    await wait(500);
  }
  return predicate();
}

const count = async (phone, pattern) => (await phone.find(pattern)).length;

async function queueAndReattach(ctx, state) {
  const { phone, check, shot } = ctx;
  const { sid, title } = CHATS.queue;
  const first = 'STREAMHOLD life one';
  await coldLaunch(phone);
  await openChat(phone, title);
  await say(phone, first);
  check('очередь: ход начался («Стоп» на экране)', Boolean(await phone.waitFor(STOP, 20_000)));
  state.dropSteer = QUEUED_TEXT;
  await say(phone, QUEUED_TEXT);
  check(
    'очередь: слово на ходу не дошло — встало в очередь',
    Boolean(await phone.waitFor(QUEUED_ROW, 15_000)) && state.droppedSteers > 0,
    `оборвано запросов «на ходу»: ${state.droppedSteers}`,
  );
  shot('life-1-queued');

  // Перезапуск приложения посреди хода: память пуста, хранилище — нет.
  await coldLaunch(phone);
  await openChat(phone, title);
  const running = await phone.waitFor(STOP, 20_000);
  const queued = await phone.waitFor(QUEUED_ROW, 10_000);
  shot('life-2-after-restart');
  check('переподхват: после перезапуска ход снова идёт на экране («Стоп»)', Boolean(running));
  check('очередь восстановлена после перезапуска', Boolean(queued));
  check(
    'очередь не дослана, пока агент занят',
    said(ctx, sid, QUEUED_TEXT).length === 0 || done(ctx, sid, first),
    JSON.stringify(callsOf(ctx, sid)),
  );

  const ended = await until(() => done(ctx, sid, first), TURN_END_MS);
  check('ход на сервере дожил до конца без телефона', ended);
  const sent = await until(() => said(ctx, sid, QUEUED_TEXT).length > 0, 30_000);
  const ack = await phone.waitFor(new RegExp(`^ACK: ${QUEUED_TEXT}$`), 30_000);
  await wait(6000);
  shot('life-3-queue-sent');
  check(
    'очередь дослана после конца хода — той же сессией, один раз',
    sent && said(ctx, sid, QUEUED_TEXT).length === 1,
    JSON.stringify(said(ctx, sid, QUEUED_TEXT)),
  );
  check('ответ на досланное — на экране', Boolean(ack));
  check('строки очереди больше нет', await phone.waitGone(QUEUED_ROW, 10_000));
}

async function silence(ctx, state) {
  const { phone, check, shot, proxy } = ctx;
  const { sid, title } = CHATS.silence;
  const prompt = 'STREAMHOLD life silent';
  state.freeze = prompt;
  await coldLaunch(phone);
  await openChat(phone, title);
  const from = proxy.log.length;
  await say(phone, prompt);
  check('тишина: ход начался', Boolean(await phone.waitFor(REPLY, 20_000)));
  check(
    'тишина: поток заморожен прокси после первого ответа',
    await until(() => Boolean(state.frozenAt), 10_000),
  );
  const stalled = await phone.waitFor(RECONNECTING, 50_000);
  const stalledAfter = state.frozenAt ? Math.round((Date.now() - state.frozenAt) / 1000) : -1;
  shot('life-4-stalled');
  check(
    'тишина дольше 30 с — телефон говорит «связь потеряна»',
    Boolean(stalled),
    `через ${stalledAfter} с`,
  );
  const attaches = () =>
    proxy.log
      .slice(from)
      .filter((item) => item.method === 'GET' && /^\/api\/chat\/[^/]+\/stream$/.test(item.path));
  const reattached = await until(
    () => attaches().some((item) => /from=[1-9]/.test(item.query)),
    20_000,
  );
  check(
    'телефон переподключился с последнего номера кадра',
    reattached,
    JSON.stringify(attaches().map((item) => item.query)),
  );
  const ended = await until(() => done(ctx, sid, prompt), TURN_END_MS);
  const calm = await phone.waitGone(STOP, 30_000);
  await wait(4000);
  shot('life-5-silence-done');
  check('ход доведён до конца на экране', ended && calm);
  check('метки «связь потеряна» больше нет', (await count(phone, RECONNECTING)) === 0);
  check(
    'ответ после переподключения не набран второй раз',
    (await count(phone, REPLY)) === 1,
    `строк ответа: ${await count(phone, REPLY)}`,
  );
  check(
    'ход не запускался заново',
    said(ctx, sid, prompt).length === 1,
    JSON.stringify(callsOf(ctx, sid)),
  );
}

async function coldStart(ctx) {
  const { phone, check, shot } = ctx;
  const { sid, title } = CHATS.cold;
  const prompt = 'STREAMHOLD life cold';
  await coldLaunch(phone);
  await openChat(phone, title);
  await say(phone, prompt);
  check('холодный старт: ход начался', Boolean(await phone.waitFor(REPLY, 20_000)));
  phone.stopApp();
  const ended = await until(() => done(ctx, sid, prompt), TURN_END_MS);
  check('ход кончился, пока приложение было убито', ended, JSON.stringify(callsOf(ctx, sid)));
  // Сразу после конца: сервер ещё держит законченный прогон в списке для догона —
  // именно тогда телефон мог бы завести его «идущим» и набрать ответ заново.
  phone.launch();
  await phone.waitFor(/^(Home|Главная)$/, 30_000);
  await openChat(phone, title);
  await phone.waitFor(REPLY, 15_000);
  await wait(7000);
  shot('life-6-cold-start');
  check(
    'холодный старт: «Стопа» нет — прогон заведён законченным',
    (await count(phone, STOP)) === 0,
  );
  check(
    'холодный старт: ответ на экране ровно один раз',
    (await count(phone, REPLY)) === 1,
    `строк ответа: ${await count(phone, REPLY)}`,
  );
  check(
    'холодный старт: ход не запускался заново',
    said(ctx, sid, prompt).length === 1,
    JSON.stringify(callsOf(ctx, sid)),
  );
}

export async function runChatLife(ctx) {
  const state = { droppedSteers: 0 };
  const route = sendRoute(ctx.stand.apiUrl, state);
  ctx.proxy.routes.unshift(route);
  try {
    await queueAndReattach(ctx, state);
    await silence(ctx, state);
    await coldStart(ctx);
  } finally {
    ctx.proxy.routes.splice(ctx.proxy.routes.indexOf(route), 1);
  }
}
