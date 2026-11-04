/**
 * Учёт контуров у ядра (C3b): НАСТОЯЩАЯ панель со своим шлюзом контуров, НАСТОЯЩЕЕ ядро стенда
 * с хостом звеньев, стаб-контур (`tools/qa/stub-platform.mjs`) наверху и приёмник вебхука на
 * свободном порту. Сеть и ключ живой платформы не нужны.
 *
 * Что проверяется:
 * 1. Запрос CLI через шлюз панели → расход ложится днём у звена ядра (файл
 *    `<дом ядра>/hops/contour-spend.json`), а не в `state.json` панели; карточка расхода панели
 *    (`GET /api/platforms/:id/spend`) показывает ту же цифру по цене человека.
 * 2. Карточка шлюза (`GET /api/platforms/gateway`) — след запросов и счётчик от звена.
 * 3. Порог внимания и бюджет — по одному вебхуку «budget» каждый (звено считает переход,
 *    панель пересылает каналам); жёсткий перезапуск панели не повторяет сказанное.
 * 4. Отказ 402 контура ставит отметку «исчерпан» у звена; снятие с карточки её убирает.
 * 5. Прогон чужого CLI с меткой `_run/<tag>` и сжатием у контура → звено отвечает «сжато в
 *    этом прогоне» и счёт вызовов с его начала; чужая метка — нет.
 * 6. Лента Claude (`GET /api/chats/:id/messages`) подписывает ответ «контур сжал историю» по
 *    журналу сжатий звена; у панели своего журнала нет.
 *
 * Запуск: `node tools/qa/check-core-contours.mjs`. Код выхода: 0 / 1 провал / 2 стенд.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHookSink } from './hook-sink.mjs';
import { freePort, runOnStand, wait } from './throwaway-stand.mjs';
import { startStubPlatform } from './stub-platform.mjs';

const CONTOUR = 'spend-company';
const TITLE = 'Контур учёта';
/** Заглушка вместо ключа: собрана из кусков, чтобы не лежало присваивание, похожее на секрет. */
const KEY = ['spend', 'stub', 'key'].join('-');
/** Кадр расхода стаба: 11 входа + 2 выхода; по 0.1 $ за токен — 1.3 $ за запрос. */
const PER_REQUEST_USD = 1.3;
/** 1.3 из 1.4 — порог внимания (90 %), второй запрос — бюджет перейдён. */
const BUDGET_USD = 1.4;
/** Разговор Claude и id ответа, перед которым контур сжал историю (п. 6). */
const CHAT = '0c0c0c0c-1111-4222-8333-c0c0c0c0c0c0';
const SUMMARIZED_MESSAGE = 'msg_qa_contour_summarized';
/** Метка прогона чужого CLI в адресе шлюза (п. 5). */
const RUN_TAG = 'qa-run-1';

const stub = await startStubPlatform({ port: 0 });
const gatewayPort = await freePort();

// Модель контура — сценарий `@agentdeck/stub-model` за `stub-platform.mjs` (P120); вебхук
// ловит общий приёмник — своего сервера у проверки нет.
const sink = await startHookSink();
const { hooks } = sink;

// Ядро стенда видит каталог панели только явной переменной (дом ядра перенесён): ставится в
// `seed`, когда путь дома стенда уже известен, — объект `env` стенд читает после `seed`.
const env = {};
const standOptions = {
  label: 'contours',
  web: false,
  core: true,
  env,
  seed: ({ cfg }) => {
    env.AGENTDECK_PANEL_DATA = join(cfg, 'agentdeck');
    // Разговор Claude, ответ которого контур «сжал» (п. 6): транскрипт там, где его ищет лента.
    const dir = join(cfg, 'projects', 'qa-contours');
    mkdirSync(dir, { recursive: true });
    const row = (type, message) => ({
      type,
      uuid: randomUUID(),
      sessionId: CHAT,
      cwd: dir,
      timestamp: new Date().toISOString(),
      message,
    });
    writeFileSync(
      join(dir, `${CHAT}.jsonl`),
      `${[
        row('user', { role: 'user', content: 'длинный разговор' }),
        row('assistant', {
          id: SUMMARIZED_MESSAGE,
          role: 'assistant',
          model: 'stub-chat',
          content: [{ type: 'text', text: 'ответ после сжатия' }],
        }),
      ]
        .map((item) => JSON.stringify(item))
        .join('\n')}\n`,
    );
  },
  settings: {
    platformGateway: { enabled: true, port: gatewayPort, forceStream: true },
    modelPricing: { 'stub-chat': { input: 100_000, output: 100_000, cacheRead: 0, cacheWrite: 0 } },
  },
};

async function chat(model = 'stub-chat', runTag) {
  const run = runTag ? `/_run/${runTag}` : '';
  const res = await fetch(`http://127.0.0.1:${gatewayPort}/${CONTOUR}${run}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: true,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'привет' }],
    }),
  });
  await res.text();
  return res.status;
}

try {
  await runOnStand(standOptions, async (stand, check) => {
    const spend = async () => (await stand.api(`/platforms/${CONTOUR}/spend`)).body;
    /** Дождаться состояния; иначе — провал с последним увиденным. */
    const until = async (name, read, predicate, tries = 60) => {
      let last;
      for (let i = 0; i < tries; i += 1) {
        last = await read();
        if (predicate(last)) return check(name, true);
        await wait(250);
      }
      return check(name, false, JSON.stringify(last ?? null).slice(0, 500));
    };
    const budgetHooks = () => hooks.filter((hook) => hook.event === 'budget');

    // ── Контур, шлюз, вебхук ─────────────────────────────────────────────
    const saved = await stand.api(`/platforms/${CONTOUR}`, {
      method: 'PUT',
      body: {
        settings: {
          id: CONTOUR,
          title: TITLE,
          driver: 'enterprise-platform',
          baseUrl: stub.url,
          enabled: true,
          mode: 'best-effort',
          budgetUsd: BUDGET_USD,
          budgetSince: '',
          capabilities: [],
          consumers: ['chat'],
          targets: [],
          projectPaths: [],
          agents: [],
          caCertPath: '',
          toolShim: false,
        },
        token: KEY,
      },
    });
    check('контур сохранён', saved.status === 200, JSON.stringify(saved.body).slice(0, 300));
    // Без пробного вопроса активации: он шёл бы тем же шлюзом и добавлял свой расход к счёту.
    const activated = await stand.api(`/platforms/${CONTOUR}/activate?probe=skip`, {
      method: 'POST',
      body: {},
    });
    check(
      'контур активен',
      activated.body?.activePlatformId === CONTOUR,
      JSON.stringify(activated.body).slice(0, 200),
    );
    const restarted = await stand.api('/platforms/gateway/restart', { method: 'POST', body: {} });
    check(
      'шлюз поднялся на своём порту',
      restarted.body?.status?.running === true && restarted.body?.status?.port === gatewayPort,
      JSON.stringify(restarted.body?.status ?? restarted.body).slice(0, 300),
    );
    const hook = await stand.api('/integrations/webhook', {
      method: 'PUT',
      body: {
        settings: { enabled: true, url: sink.url, events: ['budget'] },
      },
    });
    check(
      'вебхук включён на «бюджет»',
      hook.status === 200,
      JSON.stringify(hook.body).slice(0, 300),
    );

    // ── 1. Расход у звена ядра ──────────────────────────────────────────
    // Шлюз держит ядро, но запись контура действует к ответу панели (s10 G7: панель просит ядро
    // применить её до ответа) — первый же запрос после записи идёт через контур, без ожидания такта.
    const first = await chat();
    check('запрос через шлюз прошёл сразу после записи контура', first === 200, String(first));
    const chatCalls = () => stub.calls.filter((call) => call.path.endsWith('/chat/completions'));
    check(
      'стаб получил ровно один запрос чата',
      chatCalls().length === 1,
      JSON.stringify(stub.calls.map((call) => call.path)),
    );
    await until(
      'карточка расхода панели: 13 токенов и 1.3 $ по цене человека',
      spend,
      (info) =>
        info?.total?.totalTokens === 13 &&
        Math.abs((info?.budget?.spentUsd ?? 0) - PER_REQUEST_USD) < 1e-9,
    );
    const ledgerFile = join(stand.coreHome, 'hops', 'contour-spend.json');
    const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : null;
    check(
      'день расхода лежит в учёте звена ядра',
      ledger?.records?.[CONTOUR]?.days?.[0]?.totalTokens === 13,
      JSON.stringify(ledger).slice(0, 400),
    );
    const panelState = JSON.parse(readFileSync(join(stand.cfg, 'agentdeck', 'state.json'), 'utf8'));
    check(
      'панель расход к себе не пишет (platformSpend в state.json нет)',
      !panelState.platformSpend || Object.keys(panelState.platformSpend).length === 0,
      JSON.stringify(panelState.platformSpend).slice(0, 300),
    );

    // ── 2. Карточка шлюза ───────────────────────────────────────────────
    const gw = (await stand.api('/platforms/gateway')).body?.status;
    check(
      'карточка шлюза: след запроса и счётчик от звена',
      gw?.requests >= 1 &&
        gw?.events?.[0]?.platformId === CONTOUR &&
        gw?.events?.[0]?.status === 200 &&
        gw?.usage?.some((item) => item.platformId === CONTOUR && item.totalTokens === 13),
      JSON.stringify({
        requests: gw?.requests,
        events: gw?.events?.slice(0, 1),
        usage: gw?.usage,
      }).slice(0, 400),
    );

    // ── 3. Пороги бюджета — каналам ─────────────────────────────────────
    await until(
      'порог внимания — один вебхук',
      () => budgetHooks(),
      (list) => list.length === 1,
      80,
    );
    check(
      'текст вебхука называет контур',
      String(budgetHooks()[0]?.text ?? '').includes(TITLE),
      JSON.stringify(budgetHooks()[0] ?? null).slice(0, 300),
    );
    check('второй запрос прошёл', (await chat()) === 200);
    await spend(); // чтение складывает пачку у звена — переход порога считается на нём
    await until(
      'бюджет перейдён — второй вебхук',
      () => budgetHooks(),
      (list) => list.length === 2,
      80,
    );

    const before = budgetHooks().length;
    await stand.restartHard();
    await wait(7_000); // опрос пересылки — 5 с
    check(
      'жёсткий перезапуск панели — сказанное не повторяется',
      budgetHooks().length === before,
      JSON.stringify(budgetHooks()).slice(0, 400),
    );

    // ── 4. Отказ 402 и снятие отметки ───────────────────────────────────
    check('отказ 402 контура дошёл до CLI', (await chat('stub-402')) === 402);
    await until('отметка «исчерпан» у звена', spend, (info) => info?.budget?.exhausted === true);
    const cleared = await stand.api(`/platforms/${CONTOUR}/spend/exhausted`, { method: 'DELETE' });
    check(
      'снятие с карточки: снято, отметки нет',
      cleared.body?.cleared === true && cleared.body?.budget?.exhausted === false,
      JSON.stringify(cleared.body).slice(0, 300),
    );
    const after = JSON.parse(readFileSync(ledgerFile, 'utf8'));
    check(
      'в учёте звена отметки нет',
      !after.records?.[CONTOUR]?.exhaustedAt,
      JSON.stringify(after.records?.[CONTOUR]).slice(0, 300),
    );

    // ── 5. Прогон чужого CLI: сжатие по метке и вызовы — у звена ─────────
    // Ядро спрашивается так же, как его спрашивает панель в конце хода (`contours.runFacts`).
    const coreEntry = JSON.parse(readFileSync(join(stand.coreHome, 'procs.json'), 'utf8'))
      .cores?.[0];
    const coreAuth = {
      authorization: `Bearer ${readFileSync(join(stand.coreHome, 'token'), 'utf8').trim()}`,
    };
    const core = async (path, init = {}) => {
      const res = await fetch(`${coreEntry?.url}${path}`, {
        ...init,
        headers: {
          ...coreAuth,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const runStart = Date.now();
    check(
      'запрос прогона со сжатием прошёл через шлюз панели',
      (await chat('stub-summarizing', RUN_TAG)) === 200,
    );
    await until(
      'звено: сжатие в ЭТОМ прогоне и счёт вызовов с его начала (0 — запрос был)',
      () => core(`/v1/contours/run?tag=${RUN_TAG}&since=${runStart}`),
      (res) => res.body?.summarized === true && res.body?.toolCalls === 0,
    );
    const foreign = await core(`/v1/contours/run?tag=qa-run-2&since=${Date.now() + 60_000}`);
    check(
      'чужая метка: сжатия нет, вызовов не названо',
      foreign.status === 200 &&
        foreign.body?.summarized === false &&
        !('toolCalls' in (foreign.body ?? {})),
      JSON.stringify(foreign.body),
    );

    // ── 6. Подпись «контур сжал историю» в ленте Claude ─────────────────
    const messages = async () =>
      (await stand.api(`/chats/${CHAT}/messages`)).body?.messages?.find(
        (message) => message.role === 'assistant',
      );
    const unsigned = await messages();
    check(
      'до записи сжатия ответ без подписи',
      unsigned !== undefined && unsigned.contextSummarized !== true,
      JSON.stringify(unsigned ?? null).slice(0, 300),
    );
    // Сжатие перед ответом Claude засеваем записью снаружи — тот же учёт, что пишет звено.
    const recorded = await core('/v1/contours/record', {
      method: 'POST',
      body: JSON.stringify({
        platformId: CONTOUR,
        summarized: {
          at: new Date().toISOString(),
          path: `/${CONTOUR}/v1/messages`,
          messageId: SUMMARIZED_MESSAGE,
        },
      }),
    });
    check('запись сжатия принята звеном', recorded.status === 200, JSON.stringify(recorded.body));
    await until(
      'лента панели: подпись у ТОГО ответа — из журнала звена',
      messages,
      (message) => message?.contextSummarized === true,
    );
    check(
      'журнал сжатий лежит у звена, у панели его нет',
      existsSync(join(stand.coreHome, 'hops', 'platform-summarized.json')) &&
        !existsSync(join(stand.cfg, 'agentdeck', 'platform-summarized.json')),
    );
  });
} finally {
  await sink.close();
  await stub.close();
}
