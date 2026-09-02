/**
 * Прогон родительского чата как пульта над своими детьми.
 *
 * Проверяется ровно то, из-за чего разделением было невозможно пользоваться на
 * живом прогоне 2 сентября:
 *
 * 1. ВЫБОР ДОСТУПЕН, ПОКА АГЕНТ РАБОТАЕТ. `AskUserQuestion` в пакетном режиме
 *    возвращается ошибкой сразу и никого не ждёт: агент спрашивает посреди хода
 *    и пишет код дальше. Пока карточка гасилась на время прогона, человек видел
 *    «нужен ваш выбор», по которому нельзя щёлкнуть.
 * 2. Ответ занятому агенту уходит В ОЧЕРЕДЬ его прогона, а не теряется и не
 *    прерывает ход.
 * 3. Вопрос ДОЧЕРНЕГО чата виден и отвечается в родителе, с подписью, чей он, и
 *    ответ уходит в чат ребёнка — не в родительский.
 *
 * Данные подменяются целиком: ни настоящих копий, ни запущенных агентов прогон
 * не создаёт. Поток отдаётся готовым телом SSE — этого хватает, чтобы прогон
 * числился идущим и держал вопрос.
 *
 * Запуск: `node tools/qa/check-parent-hub.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PROJECT = { name: 'QA родитель', path: 'C:/qa-hub-project' };

const PARENT = 'qa-hub-parent';
const CHILD = 'qa-hub-child';
const PARENT_TOOL = 'toolu_parent_1';
const CHILD_TOOL = 'toolu_child_1';

const parentQuestion = {
  questions: [
    {
      question: 'Чем закрывать модалку?',
      header: 'Модалка',
      multiSelect: false,
      options: [
        { label: 'Escape и клик вне', description: 'Как везде в панели.' },
        { label: 'Только кнопкой', description: 'Ничего не закроется случайно.' },
      ],
    },
  ],
};

const childQuestion = {
  questions: [
    {
      question: 'Какой формат даты в списке?',
      header: 'Дата',
      multiSelect: false,
      options: [
        { label: 'ISO 8601', description: '2026-09-02' },
        { label: 'Как в системе', description: '02.09.2026' },
      ],
    },
  ],
};

const chat = (id, extra) => ({
  id,
  title: extra.title,
  project: PROJECT.name,
  projectPath: extra.projectPath ?? PROJECT.path,
  isSandbox: false,
  messageCount: 1,
  createdAt: '2026-09-02T10:00:00.000Z',
  updatedAt: '2026-09-02T10:05:00.000Z',
  preview: 'Нужен ваш выбор',
  ...(extra.parentId ? { parentId: extra.parentId } : {}),
});

const CHATS = [
  chat(PARENT, { title: 'Разбор задач' }),
  chat(CHILD, {
    title: 'Форма входа',
    parentId: PARENT,
    // Ребёнок работает в КОПИИ репозитория — другой каталог, тот же проект.
    projectPath: `${PROJECT.path}-worktrees/feature-login`,
  }),
];

/** Лента родителя: вопрос в ней есть и вызовом инструмента — дубля быть не должно. */
const MESSAGES = {
  messages: [
    {
      id: 'm-1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Разобрал задачи, уточняю детали.' }],
      timestamp: '2026-09-02T10:01:00.000Z',
    },
  ],
  total: 1,
  hasMore: false,
};

/** Кадр SSE: событие потока, как его отдаёт сервер. */
const frame = (event, seq) => `data: ${JSON.stringify({ ...event, seq })}\n\n`;

/**
 * Поток прогона: вопрос — обычный вызов инструмента.
 *
 * Родителю терминального события не даём намеренно: он остаётся идущим, и
 * проверять «выбор доступен во время хода» есть на чём. Ребёнок, наоборот, ход
 * закрывает — так живут оба состояния сразу: занятому ответ уходит в очередь,
 * замолчавшему — сразу сообщением в его чат.
 */
const streamBody = (toolUseId, payload, finished) =>
  frame({ kind: 'tool', name: 'AskUserQuestion', input: payload, id: toolUseId }, 1) +
  (finished ? frame({ kind: 'done' }, 2) : '');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await bypassOnboarding(page);

const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text().slice(0, 200));
});

/** Отправки, ушедшие на сервер: по ним и судим, а не по виду кнопок. */
const sent = [];

await page.route('**/api/project-git*', (route) =>
  route.fulfill({
    json: { isRepo: false, detached: false, unborn: false, branches: [], changes: [] },
  }),
);

await page.route('**/api/chats/projects*', (route) =>
  route.fulfill({
    json: [
      {
        path: PROJECT.path,
        name: PROJECT.name,
        exists: true,
        lastActivity: '2026-09-02T10:00:00.000Z',
        chats: [],
      },
    ],
  }),
);

await page.route('**/api/chats', (route) => route.fulfill({ json: CHATS }));
await page.route(`**/api/chats/${PARENT}/messages*`, (route) => route.fulfill({ json: MESSAGES }));
await page.route(`**/api/chats/${CHILD}/messages*`, (route) =>
  route.fulfill({ json: { messages: [], total: 0, hasMore: false } }),
);
await page.route('**/api/chat/*/progress*', (route) =>
  route.fulfill({ json: { steps: [], isComplete: false } }),
);
await page.route('**/api/chat/*/artifacts*', (route) => route.fulfill({ json: [] }));

// Оба прогона идут на сервере — страница подхватывает их и подключается потоком.
await page.route('**/api/chat/active', (route) =>
  route.fulfill({
    json: [
      { chatId: PARENT, seq: 0 },
      { chatId: CHILD, seq: 0 },
    ],
  }),
);

// Родитель: вопрос приходит первым же подключением, а дальше соединение просто
// висит — так прогон честно остаётся идущим весь прогон проверки. Тело фиксирной
// длины закончилось бы сразу, страница переподключилась бы несколько раз и
// сдалась, а с ней уехала бы и очередь — то есть проверка мерила бы таймеры, а
// не поведение.
let parentStreamHits = 0;
await page.route(`**/api/chat/${PARENT}/stream*`, (route) => {
  parentStreamHits += 1;
  if (parentStreamHits > 1) return;
  return route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: streamBody(PARENT_TOOL, parentQuestion),
  });
});
await page.route(`**/api/chat/${CHILD}/stream*`, (route) =>
  route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: streamBody(CHILD_TOOL, childQuestion, true),
  }),
);

// Ответ на вопрос уходит обычным сообщением: другого канала у него нет — вызов
// `AskUserQuestion` в пакетном режиме возвращается ошибкой сразу и никого не ждёт.
await page.route('**/api/chat/send', (route) => {
  sent.push(route.request().postDataJSON());
  return route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: 'data: {"kind":"done","seq":1}\n\n',
  });
});

await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1200);

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

await page.getByRole('tab', { name: 'Проекты' }).click();
await page.waitForTimeout(800);
await page
  .getByRole('button', { name: new RegExp(PROJECT.name) })
  .first()
  .click();
await page.waitForTimeout(1500);

// Дети живут ДЕРЕВОМ в этой же вкладке, а не отдельными проектами.
check(
  (await page.getByRole('button', { name: /Форма входа/ }).count()) === 1,
  'дочерний чат виден в списке родительской вкладки',
);

await page
  .getByRole('button', { name: /Разбор задач/ })
  .first()
  .click();
await page.waitForTimeout(2000);

const cards = page.locator('[class*="_question_"]').filter({ hasText: 'Нужен ваш выбор' });
check((await cards.count()) === 2, `карточек в ленте две — своя и детская: ${await cards.count()}`);
check(
  (await page.getByText('Чем закрывать модалку?').count()) === 1,
  'свой вопрос показан ОДИН раз, а не дважды (поток + запрос прав)',
);
check(
  (await page.getByText(/Спрашивает .*Форма входа/).count()) === 1,
  'вопрос ребёнка подписан, чей он',
);

// Снимки для отчёта: `SHOTS=<каталог> node tools/qa/check-parent-hub.mjs`.
// Снимаются из того же прогона, что и проверяет, — иначе картинка и вердикт
// расходятся при первой же правке.
const shot = async (name) => {
  if (!process.env.SHOTS) return;
  await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: false });
};

await shot('01_вопросы-родителя-и-ребёнка_AFTER');

// Главное: прогон ИДЁТ, и выбор при этом доступен.
const own = page.getByRole('button', { name: /Escape и клик вне/ });
check((await own.count()) === 1, 'вариант своего вопроса на месте');
check(await own.first().isEnabled(), 'выбор доступен, пока агент работает');

await own.first().click();
await page.waitForTimeout(800);
await shot('02_свой-вопрос-отвечен_AFTER');

// Агент занят, значит ответ уходит В ОЧЕРЕДЬ его прогона — тем же путём, что и
// дописанное в занятый чат. Ход не прерывается, ответ не теряется.
const queue = page.locator('[data-chat-queue]');
check(await queue.isVisible(), 'ответ занятому агенту встал в очередь, а не пропал');
check(
  (await queue.getByText('Escape и клик вне').count()) === 1,
  'в очереди лежит именно выбранный вариант',
);
check(sent.length === 0, `пока агент занят, отправки нет: ${JSON.stringify(sent)}`);
// Подпись карточки обязана говорить правду о судьбе ответа: «агент думает» про
// ответ, который ещё лежит в очереди, — ровно та ложь, из-за которой человек
// ждёт реакции, которой не будет до конца хода.
check(
  (await page.getByText(/Ответ в очереди/).count()) === 1,
  'карточка честно говорит, что ответ ждёт конца хода',
);

// Вопрос ребёнка — из родителя, ответ уходит ЕМУ.
const kid = page.getByRole('button', { name: /ISO 8601/ });
check((await kid.count()) === 1, 'вариант детского вопроса доступен из родителя');
await kid.first().click();
await page.waitForTimeout(1000);

check(sent.length === 1, `ответ ребёнку ушёл одной отправкой: ${sent.length}`);
check(sent[0]?.chatId === CHILD, `отправка адресована РЕБЁНКУ: ${sent[0]?.chatId}`);
check(sent[0]?.prompt === 'ISO 8601', `ушёл выбранный вариант: ${JSON.stringify(sent[0]?.prompt)}`);
check(
  sent[0]?.projectPath === `${PROJECT.path}-worktrees/feature-login`,
  `ребёнок отвечает в СВОЕЙ копии репозитория: ${sent[0]?.projectPath}`,
);
check(
  (await queue.getByText('ISO 8601').count()) === 0,
  'родительский разговор за детский ответ ходом не заплатил',
);
// Отвеченный вопрос ребёнка из родителя УХОДИТ: ответ поехал, ребёнок начал
// новый ход — держать карточку значило бы предлагать ответить второй раз.
check(
  (await page.getByText('Какой формат даты в списке?').count()) === 0,
  'отвеченный вопрос ребёнка убран из родительской ленты',
);

// Тост «сходите в другой проект» про ребёнка ОТКРЫТОГО чата — лишний: вопрос
// показан здесь же, а переход по нему открыл бы отдельную вкладку, ровно ту,
// от которой ушли. Звук при этом остаётся: он про «от вас ждут», а не про путь.
await page.waitForTimeout(1500);
check(
  (await page.getByText(/агент ждёт ответа|агент просит разрешение/).count()) === 0,
  'вопрос ребёнка не зовёт тостом в другой проект',
);
// А о том, что ребёнок закончил, сказать надо — но разговором, а не проектом:
// «Проект „feature-login“» назвал бы копию репозитория, которой в списке нет.
const finished = page.getByText(/Чат «Форма входа»: агент завершил работу/);
check((await finished.count()) === 1, 'о конце хода ребёнка сказано его именем в чате');
await finished.first().click();
await page.waitForTimeout(800);
check(
  (await page
    .getByRole('tab')
    .filter({ hasText: /feature-login/ })
    .count()) === 0,
  'переход к ребёнку не заводит вкладку его копии',
);
const header = await page.locator('[class*="_headerText_"]').first().innerText();
check(
  header.includes('Форма входа') && header.includes('feature-login'),
  `ребёнок открылся в этой же вкладке и в своей копии: ${JSON.stringify(header)}`,
);
await shot('04_ребёнок-открыт-в-той-же-вкладке_AFTER');
await shot('03_вопрос-ребёнка-отвечен-из-родителя_AFTER');

check(errors.length === 0, errors.length === 0 ? 'ошибок консоли нет' : errors.join(' | '));

await browser.close();
console.log(bad === 0 ? 'Родительский чат управляет детьми' : `Проблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
