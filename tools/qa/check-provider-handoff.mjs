/**
 * Перезапуск сессии у чужого CLI (Т7 партии «автономия у чужих CLI»).
 *
 * У этих CLI понятия сессии нет вовсе: продолжить «с того же места» нечем.
 * Панель заводит НОВЫЙ разговор с контрольной точкой и исходной задачей — и
 * прогон проверяет ровно то, что человек при этом видит и чего не видит.
 *
 * Настоящий CLI не запускается и настройки панели НЕ переключаются: активный
 * провайдер, список разговоров и ответ маршрута подменяются на лету — иначе
 * прогон зависел бы от того, какой CLI установлен, и правил бы конфигурацию
 * человека.
 *
 * Проверяется: кнопка есть только там, где есть рабочий каталог; отказ сервера
 * («ответ ещё идёт») сказан словами, а не проглочен; неготовая опора превращается
 * в ОБЫЧНУЮ реплику в тот же разговор, а не в тихое ничего; заведённое
 * продолжение открывается само, и в старом разговоре остаётся заметка, куда ушла
 * работа.
 *
 * Запуск: `node tools/qa/check-provider-handoff.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';

const at = '2026-09-09T10:00:00.000Z';
const CWD = 'C:/work/repo';

/** Просьба записать опору — тот же текст, что собирает контракт. */
const REQUEST = 'Запиши состояние в .agent/PROGRESS.md';
const NOTICE =
  'Работа продолжена в новом разговоре «Переименование · работа · продолжение» (продолжение 1 из 8): сессии у CLI нет, поэтому продолжение — новый разговор с контрольной точкой и исходным заданием.';

const chats = [
  {
    id: 'qa1',
    providerId: 'codex',
    title: 'Переименование · работа',
    workdir: CWD,
    createdAt: at,
    updatedAt: at,
    messages: [
      { id: 'qa1-m1', role: 'user', content: 'Переименуй foo в bar', at },
      {
        id: 'qa1-m2',
        role: 'assistant',
        content: 'Первый проход сделан. Перезапустите сессию и продолжайте по .agent/PROGRESS.md.',
        at,
        transport: 'stream',
      },
    ],
  },
  {
    id: 'qa2',
    providerId: 'codex',
    title: 'Разговор без каталога',
    createdAt: at,
    updatedAt: at,
    messages: [{ id: 'qa2-m1', role: 'assistant', content: 'Каталога у меня нет.', at }],
  },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await bypassOnboarding(page);

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

await page.route('**/api/settings', async (route) => {
  if (route.request().method() !== 'GET') return route.continue();
  const response = await route.fetch();
  // Тело бывает пустым: стенд перезапускается (`node --watch`) или отвечает 304
  // на условный запрос. Падать здесь стеком нельзя — прогон соврал бы про
  // причину: он не сломался, он не дождался стенда.
  const text = await response.text();
  if (!text) {
    console.log('✗ стенд не ответил настройками — поднимите `pnpm dev` и повторите');
    process.exit(1);
  }
  await route.fulfill({ response, json: { ...JSON.parse(text), provider: 'codex' } });
});

await page.route('**/api/provider-runner', (route) =>
  json(route, { providerId: 'codex', providerName: 'Codex', mode: 'cli' }),
);

await page.route('**/api/provider-chat/chats', (route) =>
  json(
    route,
    chats.map(({ messages, ...summary }) => ({ ...summary, messageCount: messages.length })),
  ),
);
await page.route('**/api/provider-chat/chats/*', (route) => {
  const id = new URL(route.request().url()).pathname.split('/').pop();
  const chat = chats.find((item) => item.id === id);
  return chat ? json(route, chat) : json(route, { error: 'нет разговора' }, 404);
});
await page.route('**/api/provider-chat/chats/*/status', (route) => {
  const id = new URL(route.request().url()).pathname.split('/').at(-2);
  return json(route, { chatId: id, isRunning: false, partial: '' });
});
// Дерево связей к перезапуску отношения не имеет: хаба здесь нет и быть не должно.
await page.route('**/api/chat/*/tree', (route) => json(route, { root: 'codex:qa1', nodes: [] }));

/** Что маршрут перезапуска ответит на очередной клик — по сценарию. */
const answers = [
  { status: 409, body: { message: 'Ответ ещё идёт: дождитесь конца хода или остановите его' } },
  { status: 200, body: { mode: 'requested', prompt: REQUEST } },
  { status: 200, body: { mode: 'started', chatId: 'cont1' } },
];
const restarts = [];
await page.route('**/api/provider-chat/chats/*/restart', (route) => {
  const id = new URL(route.request().url()).pathname.split('/').at(-2);
  restarts.push(id);
  const answer = answers.shift();
  if (answer?.body.mode === 'started') {
    // Так же, как сервер: продолжение уже заведено хранилищем, а в старом
    // разговоре появилась заметка.
    chats.push({
      id: 'cont1',
      providerId: 'codex',
      title: 'Переименование · работа · продолжение',
      workdir: CWD,
      createdAt: at,
      updatedAt: at,
      messages: [
        { id: 'cont1-m1', role: 'user', content: 'Продолжай по .agent/PROGRESS.md', at },
        {
          id: 'cont1-m2',
          role: 'assistant',
          content: 'Продолжаю со второго шага.',
          at,
          transport: 'stream',
        },
      ],
    });
    chats[0].messages.push({ id: 'qa1-m3', role: 'notice', content: NOTICE, at });
  }
  return json(route, answer?.body ?? { mode: 'requested' }, answer?.status ?? 200);
});

/** Реплики человека: просьба записать опору обязана уйти именно сюда. */
const sent = [];
await page.route('**/api/provider-chat/chats/*/send', (route) => {
  const id = new URL(route.request().url()).pathname.split('/').at(-2);
  const body = route.request().postDataJSON();
  sent.push({ id, ...body });
  const message = { id: `${id}-h${sent.length}`, role: 'user', content: body.text, at };
  chats.find((item) => item.id === id)?.messages.push(message);
  return json(route, { message });
});

// Поток ответа: просьба записать опору уходит настоящим путём человека, и за
// репликой сразу открывается поток. Настоящего CLI здесь нет — отвечаем пустым
// ходом, иначе стенд отказал бы на несуществующем прогоне и прогон соврал бы
// про ошибку в консоли.
await page.route('**/api/provider-chat/chats/*/stream', (route) =>
  route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    body: `data: ${JSON.stringify({ type: 'done' })}

`,
  }),
);

const errors = [];
page.on('console', (message) => {
  // Отказ 409 — часть сценария: браузер пишет о нём в консоль сам, и считать
  // его поломкой нельзя. Всё остальное считается.
  if (message.type() === 'error' && !message.text().includes('409')) errors.push(message.text());
});

await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1500);

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? '✓' : '✗'} ${text}`);
  if (!ok) bad += 1;
};

const body = await page.textContent('body');
check(body.includes('Разговоры'), 'открылся чат чужого провайдера, а не чат Claude');
check(body.includes('Перезапустите сессию'), 'открыт разговор, который сам попросил перезапуск');

const button = page.getByRole('button', { name: 'Перезапустить', exact: true });
check((await button.count()) === 1, 'в шапке разговора с каталогом есть «Перезапустить»');
check(
  (await button.getAttribute('title')) === 'Перезапустить разговор в чистом виде',
  'кнопка называет, что именно случится',
);

// Отказ сервера: прогон ещё идёт. Проглотить его нельзя — человек нажал и ждёт.
await button.click();
await page.waitForTimeout(1200);
check(restarts.length === 1 && restarts[0] === 'qa1', `клик ушёл своим маршрутом: ${restarts}`);
const refused = await page.textContent('body');
check(
  refused.includes('Не удалось перезапустить разговор'),
  'отказ сервера сказан словами, а не проглочен',
);
check(refused.includes('Ответ ещё идёт'), 'названа причина отказа, а не «что-то пошло не так»');
check(sent.length === 0, 'на отказе ничего не отправлено в разговор');

// Опора не готова: панель просит агента записать состояние ОБЫЧНОЙ репликой —
// тем же путём, что и человек, с той же моделью и теми же правами.
await button.click();
await page.waitForTimeout(1500);
check(
  sent.length === 1 && sent[0].id === 'qa1' && sent[0].text === REQUEST,
  `просьба записать опору ушла обычной репликой: ${JSON.stringify(sent)}`,
);
const asked = await page.textContent('body');
check(asked.includes('Файл-опора ещё не готов'), 'человеку сказано, что панель попросила и ждёт');

// Продолжение заведено: вкладка уходит на него сама — смотреть надо туда.
await button.click();
await page.waitForTimeout(2000);
const started = await page.textContent('body');
check(started.includes('Продолжаю со второго шага'), 'открылась переписка продолжения');
check(
  started.includes('Работа продолжена в новом разговоре'),
  'сказано, что это новый разговор, а не «продолжили с того же места»',
);
check(
  (await page.locator('[data-provider-notice]').count()) === 0,
  'в самом продолжении заметки нет: она осталась там, откуда ушла работа',
);

// Старый разговор: человек вернётся в него и должен увидеть, куда ушла работа.
// Имя пункта списка — заголовок ПЛЮС счётчик реплик, поэтому цифра в шаблоне:
// без неё сюда попадало бы и продолжение, у которого заголовок начинается так же.
await page
  .getByRole('button', { name: /^Переименование · работа \d/ })
  .first()
  .click();
await page.waitForTimeout(1500);
const back = page.locator('[data-provider-notice]');
check((await back.count()) === 1, 'в старом разговоре осталась заметка о продолжении');
check(
  (await back.first().textContent()).includes('сессии у CLI нет'),
  'заметка называет вещи своими именами: сессии у CLI нет',
);

// Разговор без каталога заводить продолжение негде — и кнопки там нет.
await page
  .getByRole('button', { name: /^Разговор без каталога/ })
  .first()
  .click();
await page.waitForTimeout(1500);
check(
  (await page.getByRole('button', { name: 'Перезапустить', exact: true }).count()) === 0,
  'без рабочего каталога кнопки нет: заводить продолжение негде',
);

check(errors.length === 0, `ошибок в консоли нет${errors.length ? `: ${errors[0]}` : ''}`);

await browser.close();
console.log(bad === 0 ? '\nВсе проверки прошли.' : `\nПровалено проверок: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
