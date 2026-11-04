/**
 * Прокси защиты данных человека держит ядро (C3c): НАСТОЯЩАЯ панель и НАСТОЯЩЕЕ ядро стенда с
 * хостом звеньев над временным домом, модель наверху — заглушка `packages/stub-model`. Сеть,
 * ключ и настоящий CLI не нужны; рабочий стенд человека не затрагивается.
 *
 * Что проверяется — путём человека, через API панели (как страница /dlp):
 * 1. Правила сохраняются панелью; `POST /api/dlp/start` → ядро открывает порт из настроек, ответ
 *    панели «работает» и адрес `127.0.0.1:<порт>`; тумблер в настройках включён.
 * 2. Запрос «CLI» на этот адрес: модель получает метку вместо почты, ключ CLI — как есть; ответ
 *    до CLI приходит с настоящей почтой.
 * 3. Правило «блок» — отказ 400 без похода к модели.
 * 4. `GET /api/dlp` — счётчики ядра (запросы, маски, блоки); журнал панели без самих значений.
 * 5. `POST /api/dlp/stop` → порт закрыт, тумблер выключен.
 * 6. Отказ ядра доходит до человека: без включённых правил ядро не открывает порт — 400 до записи
 *    тумблера, тумблер остаётся выключенным.
 *
 * Запуск: `node tools/qa/check-core-dlp.mjs`. Код выхода: 0 / 1 провал / 2 стенд.
 */
import { connect } from 'node:net';
import { join } from 'node:path';
import { runOnStand, wait } from './throwaway-stand.mjs';

const EMAIL = 'ivan.petrov@example.com';
const STOP_WORD = 'КОДОВОЕ-СЛОВО';
const CLI_KEY = ['cli', 'stub', 'key'].join('-');

const RULES = [
  {
    id: 'mail',
    name: 'Почта',
    enabled: true,
    kind: 'builtin',
    builtin: 'email',
    terms: [],
    pattern: '',
    action: 'mask',
    label: 'ПОЧТА',
  },
  {
    id: 'stop',
    name: 'Стоп-слово',
    enabled: true,
    kind: 'terms',
    terms: [STOP_WORD],
    pattern: '',
    action: 'block',
    label: 'СТОП',
  },
];

const { startStubModel } = await import('../../packages/stub-model/src/index.mjs');
const seen = [];
const placeholderIn = (raw) => raw.match(/\[ПОЧТА_\d+\]/)?.[0] ?? 'ничего';
const stub = await startStubModel({
  route: (request) => {
    if (request.path.endsWith('/models')) return undefined;
    seen.push(request);
    return {
      body: {
        id: 'm1',
        type: 'message',
        role: 'assistant',
        model: 'stub-model',
        content: [{ type: 'text', text: `ответ про ${placeholderIn(request.raw)}` }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 3 },
      },
    };
  },
});

const portOpen = (port) =>
  new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

try {
  // Ядро с явным домом (`AGENTDECK_CORE_HOME`) панель само не ищет — каталог данных панели стенда
  // называется ему явно, как у `check-core-contours`; ядро человека находит его по дому.
  const env = {};
  const options = {
    label: 'core-dlp',
    web: false,
    core: true,
    env,
    seed: ({ cfg }) => {
      env.AGENTDECK_PANEL_DATA = join(cfg, 'agentdeck');
    },
  };
  await runOnStand(options, async (stand, check) => {
    // Ядро стенда отвечает — иначе любой отказ ниже был бы «ядра нет», а не поведение прокси.
    for (let i = 0; i < 60 && !(await stand.api('/dlp')).body?.status; i += 1) await wait(500);

    const settings = (await stand.api('/settings')).body;
    const port = settings?.dlp?.port;
    check('у стенда свой порт защиты данных', Number.isInteger(port) && port > 0, String(port));
    const patched = await stand.api('/settings', {
      method: 'PATCH',
      body: { dlp: { ...settings.dlp, upstreamUrl: stub.baseUrl, journal: true } },
    });
    check('адрес наверх сохранён', patched.status === 200, patched.text.slice(0, 200));

    // 6 — сначала отказ: правил нет.
    const refused = await stand.api('/dlp/start', { method: 'POST', body: {} });
    check(
      'без правил запуск — 400 dlp_misconfigured',
      refused.status === 400 && refused.body?.error === 'dlp_misconfigured',
      `${refused.status} ${refused.text.slice(0, 200)}`,
    );
    check(
      'после отказа тумблер выключен',
      (await stand.api('/settings')).body?.dlp?.enabled === false,
    );

    // 1
    const saved = await stand.api('/dlp/rules', { method: 'PUT', body: { rules: RULES } });
    check('правила сохранены панелью', saved.status === 200, saved.text.slice(0, 200));
    const started = await stand.api('/dlp/start', { method: 'POST', body: {} });
    check(
      'запуск: панель отвечает «работает» по ответу ядра',
      started.status === 200 && started.body?.status?.running === true,
      `${started.status} ${started.text.slice(0, 300)}`,
    );
    check(
      'адрес — 127.0.0.1 и порт из настроек',
      started.body?.status?.address === `http://127.0.0.1:${port}`,
      started.body?.status?.address,
    );
    check('тумблер включён', (await stand.api('/settings')).body?.dlp?.enabled === true);
    check('порт открыт', await portOpen(port));

    // 2
    const cli = (body) =>
      fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': CLI_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'stub-model',
          max_tokens: 32,
          messages: [{ role: 'user', content: body }],
        }),
      });
    const answered = await cli(`напиши на ${EMAIL}`);
    const answerText = await answered.text();
    const upstream = seen.at(-1);
    check(
      'запрос дошёл до модели',
      answered.status === 200 && Boolean(upstream),
      answerText.slice(0, 200),
    );
    check(
      'модель получила метку, а не почту',
      Boolean(upstream) && !upstream.raw.includes(EMAIL) && /\[ПОЧТА_1\]/.test(upstream.raw),
      upstream?.raw.slice(0, 300),
    );
    check(
      'ключ CLI ушёл модели как есть',
      upstream?.headers?.['x-api-key'] === CLI_KEY,
      String(upstream?.headers?.['x-api-key']),
    );
    check(
      'ответ до CLI — с настоящей почтой',
      answerText.includes(EMAIL),
      answerText.slice(0, 300),
    );

    // 3
    const before = seen.length;
    const blocked = await cli(`план ${STOP_WORD}`);
    const blockedText = await blocked.text();
    check(
      'стоп-слово — 400 invalid_request_error без похода к модели',
      blocked.status === 400 &&
        blockedText.includes('invalid_request_error') &&
        seen.length === before,
      `${blocked.status} ${blockedText.slice(0, 200)}`,
    );

    // 4
    const info = (await stand.api('/dlp')).body;
    check(
      'счётчики ядра на странице: 2 запроса, 1 маска, 1 блок',
      info?.status?.requests === 2 && info?.status?.masked === 1 && info?.status?.blocked === 1,
      JSON.stringify(info?.status),
    );
    const journal = await stand.api('/dlp/journal');
    const entries = journal.body?.entries ?? [];
    check(
      'журнал панели: маска и блок, без самих значений',
      entries.some((entry) => entry.decision === 'blocked') &&
        entries.some((entry) => entry.hits?.length > 0) &&
        !journal.text.includes(EMAIL) &&
        !journal.text.includes(STOP_WORD),
      journal.text.slice(0, 400),
    );

    // 5
    const stopped = await stand.api('/dlp/stop', { method: 'POST', body: {} });
    check(
      'остановка: «не работает», тумблер выключен',
      stopped.status === 200 &&
        stopped.body?.status?.running === false &&
        (await stand.api('/settings')).body?.dlp?.enabled === false,
      stopped.text.slice(0, 200),
    );
    check('порт закрыт', !(await portOpen(port)));
  });
} finally {
  await stub.close();
}
