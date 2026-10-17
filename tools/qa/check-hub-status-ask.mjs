/**
 * Хаб родителя: вопрос о ходе групп уходит в лёгкий чат, а не в родителя (5.1
 * плана экономии).
 *
 * Родитель разделения — разговор на 170–230 тыс. контекста. После часа тишины
 * его кеш остыл, и один вопрос «как там группы?» стоил перезаписи 160 тыс. и
 * ~30 вызовов. Сводку групп панель и так строит; теперь в хабе есть поле
 * «Спросить о ходе групп»: вопрос открывает новый лёгкий чат со сводкой, а
 * писать самому родителю — по-прежнему его полем ввода.
 *
 * Что проверяется:
 * 1. Поле есть в хабе; пустой вопрос не отправляется (кнопка выключена).
 * 2. Отказ сервера — тост с его текстом, вопрос в поле остаётся, адрес прежний.
 * 3. Запрос в пути (ответ задержан) — кнопка крутится, второй клик второго
 *    запроса не шлёт.
 * 4. Успех — тело запроса несёт вопрос, адрес называет новый чат, вид уходит
 *    на его живой прогон (хаба родителя на экране больше нет).
 *
 * Данные подменяются целиком: ни прогонов, ни чатов проверка не заводит.
 *
 * Запуск: `node tools/qa/check-hub-status-ask.mjs` при поднятом фронте
 * (`APP_URL`, по умолчанию http://localhost:8888); `SHOTS=<папка>` и
 * `PHASE=before|after` — снимки, `QA_THEME=dark` — тёмная тема.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PROJECT = { name: 'QA вопрос о ходе', path: 'C:/qa-hub-status-project' };
const CEILING = { chatModel: 'claude-opus-5', chatEffort: 'high' };
const PARENT = 'qa-status-parent';
const STATUS_CHAT = 'new-1760650000000-status';
const QUESTION = 'Что у группы «Отчёты» с тестами?';
const REFUSAL = 'План разделения не найден';

const GROUPS = [
  { index: 0, title: 'Вход', branch: 'feature/login', status: 'started' },
  { index: 1, title: 'Отчёты', branch: 'feature/reports', status: 'started' },
  { index: 2, title: 'Схема', branch: 'feature/schema', status: 'done' },
];

const chatIdOf = (group) => `qa-status-${group.index}`;
const copyOf = (group) => `${PROJECT.path}-worktrees/${group.branch.replace(/\//g, '-')}`;

const chat = (id, extra) => ({
  id,
  title: extra.title,
  project: PROJECT.name,
  projectPath: extra.projectPath ?? PROJECT.path,
  isSandbox: false,
  messageCount: 1,
  createdAt: '2026-10-17T10:00:00.000Z',
  updatedAt: '2026-10-17T10:05:00.000Z',
  preview: '',
  ...(extra.parentId ? { parentId: extra.parentId } : {}),
  ...(extra.stage ? { stage: extra.stage } : {}),
  ...(extra.groupTitle ? { groupTitle: extra.groupTitle } : {}),
  ...(extra.groupIndex !== undefined ? { groupIndex: extra.groupIndex } : {}),
  ...(extra.branch ? { branch: extra.branch } : {}),
});

const chats = [
  chat(PARENT, { title: 'Пачка задач' }),
  ...GROUPS.map((group) =>
    chat(chatIdOf(group), {
      title: `Работа группы «${group.title}»`,
      parentId: PARENT,
      stage: 'work',
      groupTitle: group.title,
      groupIndex: group.index,
      branch: group.branch,
      projectPath: copyOf(group),
    }),
  ),
];

const split = () => ({
  parentChatId: PARENT,
  order: GROUPS.map((group) => group.index),
  groups: GROUPS.map((group) => ({
    index: group.index,
    title: group.title,
    branch: group.branch,
    after: [],
    chatId: chatIdOf(group),
    path: copyOf(group),
    seated: true,
    deliver: true,
    status: group.status,
    ...(group.status === 'done' ? { result: { kind: 'pushed', commits: 1 } } : {}),
  })),
});

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: Number(process.env.QA_WIDTH ?? 1400), height: 1300 },
  ...(process.env.QA_THEME ? { colorScheme: process.env.QA_THEME } : {}),
});
await bypassOnboarding(page, CEILING);

const errors = [];
// Источник любой ошибки ответа — в отчёт: консоль браузера адреса не называет.
const failed = [];
page.on('response', (response) => {
  if (response.status() >= 400 && response.status() !== 409)
    failed.push(`${response.status()} ${response.url()}`);
});
page.on('console', (message) => {
  // Отказ 409 подменён нарочно — браузер пишет его в консоль сам.
  if (message.type() === 'error' && !message.text().includes('409'))
    errors.push(message.text().slice(0, 200));
});

await page.route('**/api/project-git*', (route) =>
  route.fulfill({
    json: { isRepo: false, detached: false, unborn: false, branches: [], changes: [] },
  }),
);
// Настройки разделения у проекта-заглушки: настоящий сервер такого пути не знает.
await page.route('**/api/project-git/split-settings*', (route) =>
  route.fulfill({
    json: {
      deliver: true,
      parallel: 2,
      parallelAuto: false,
      profile: {
        enabled: true,
        repo: true,
        remote: true,
        bootstrapConfigured: false,
        heavy: false,
      },
      permissions: {},
      permissionsOwn: [],
    },
  }),
);
await page.route('**/api/chats/projects*', (route) =>
  route.fulfill({
    json: [
      {
        path: PROJECT.path,
        name: PROJECT.name,
        exists: true,
        lastActivity: '2026-10-17T10:00:00.000Z',
        chats: [],
      },
    ],
  }),
);
await page.route('**/api/chats', (route) => route.fulfill({ json: chats }));
await page.route('**/api/chat/*/tree', (route) =>
  route.fulfill({
    json: {
      root: PARENT,
      running: 2,
      split: split(),
      nodes: chats
        .filter((item) => item.parentId)
        .map((item) => ({
          chatId: item.id,
          aliases: [],
          parentChatId: PARENT,
          title: item.title,
          running: GROUPS[item.groupIndex]?.status === 'started',
        })),
    },
  }),
);

/** Вопросы, дошедшие до «сервера»: первый получает отказ, второй — новый чат. */
const asked = [];
let started = false;
await page.route('**/api/chat/split/*/status-ask', async (route) => {
  asked.push({ url: route.request().url(), body: route.request().postDataJSON() });
  if (asked.length === 1) {
    await route.fulfill({
      status: 409,
      json: { message: REFUSAL, messageCode: 'split-plan-not-found' },
    });
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  started = true;
  await route.fulfill({ json: { chatId: STATUS_CHAT } });
});
await page.route('**/api/chat/active', (route) =>
  route.fulfill({
    json: started
      ? [
          {
            chatId: STATUS_CHAT,
            projectPath: PROJECT.path,
            seq: 0,
            startedAt: Date.now(),
            status: 'running',
            model: 'sonnet',
            effort: 'medium',
          },
        ]
      : [],
  }),
);
/** Живые ленты, которые открыл вид: переход на лёгкий чат виден по его ленте. */
const streamed = [];
await page.route(
  '**/api/chat/*/stream*',
  (route) =>
    streamed.push(route.request().url()) &&
    route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: '' }),
);
await page.route('**/api/chats/*/messages*', (route) =>
  route.fulfill({
    json: {
      messages: [
        {
          id: 'm-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Разделил задачи на три группы.' }],
          timestamp: '2026-10-17T10:02:00.000Z',
        },
      ],
      total: 1,
      hasMore: false,
    },
  }),
);
await page.route('**/api/chat/*/progress*', (route) =>
  route.fulfill({ json: { steps: [], isComplete: false } }),
);
await page.route('**/api/chat/*/artifacts*', (route) => route.fulfill({ json: [] }));

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};
const suffix = process.env.PHASE ? `_${process.env.PHASE.toUpperCase()}` : '';
const shot = async (name) => {
  if (!process.env.SHOTS) return;
  const path = `${process.env.SHOTS}/${name}${suffix}.png`;
  await page
    .locator('[data-child-hub]')
    .screenshot({ path })
    .catch(() => page.screenshot({ path }));
};

await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1200);
await page.getByRole('tab', { name: 'Проекты' }).click();
await page.waitForTimeout(800);
await page
  .getByRole('button', { name: new RegExp(PROJECT.name) })
  .first()
  .click();
await page.waitForTimeout(1500);
await page
  .getByRole('button', { name: /Пачка задач/ })
  .first()
  .click();
await page.waitForSelector('[data-child-hub]', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);

const hub = page.locator('[data-child-hub]');
check((await hub.count()) === 1, 'сводка групп у родителя показана');
await shot('01-hub');

const form = hub.locator('[data-status-ask]');
const field = form.locator('textarea, input');
const send = form.locator('button[type="submit"]');
check((await form.count()) === 1, 'в хабе есть поле «Спросить о ходе групп»');
if ((await form.count()) === 0) {
  check(errors.length === 0, errors.length === 0 ? 'ошибок консоли нет' : errors.join(' | '));
  await browser.close();
  process.exit(1);
}

// 1. Пустой вопрос не уходит.
check(await send.isDisabled(), 'пустое поле — кнопка выключена');
await field.fill('   ');
check(await send.isDisabled(), 'одни пробелы — кнопка выключена');

// 2. Отказ сервера: текст отказа виден, вопрос не потерян, адрес прежний.
await field.fill(QUESTION);
check(!(await send.isDisabled()), 'с вопросом кнопка включена');
const urlBefore = page.url();
await send.click();
await page.waitForTimeout(800);
const toastText = (await page.locator('[role="alert"], [role="status"]').allTextContents())
  .join(' ')
  .trim();
check(toastText.includes(REFUSAL), `отказ показан тостом: «${toastText.slice(0, 120)}»`);
check((await field.inputValue()) === QUESTION, 'после отказа вопрос остался в поле');
check(page.url() === urlBefore, 'после отказа адрес прежний');

// 3. Запрос в пути: кнопка крутится, второй клик второго запроса не шлёт.
await send.click();
await page.waitForTimeout(300);
await shot('02-hub-asking');
const busy =
  (await send.getAttribute('aria-busy')) === 'true' ||
  (await send.isDisabled()) ||
  (await send.locator('[data-loading], svg').count()) > 0;
check(busy, 'запрос в пути — кнопка занята');
await send.click({ force: true }).catch(() => {});
await field.press('Enter').catch(() => {});
await page.waitForTimeout(2500);
check(asked.length === 2, `запросов к серверу: ${asked.length} (ждали 2 — отказ и один вопрос)`);

// 4. Успех: вопрос в теле, адрес назвал новый чат, вид ушёл с хаба родителя.
const last = asked.at(-1);
check(
  last?.url.includes(`/api/chat/split/${PARENT}/status-ask`),
  `запрос адресован родителю: ${last?.url ?? 'нет'}`,
);
check(last?.body?.question === QUESTION, `тело несёт вопрос: ${JSON.stringify(last?.body)}`);
await page.waitForTimeout(3000);
// Адрес получает ключ разговора только по концу первого хода — до того вид
// показывает живой прогон как черновик. Переход доказывает лента нового чата.
check(
  streamed.some((url) => url.includes(`/api/chat/${encodeURIComponent(STATUS_CHAT)}/stream`)),
  `вид открыл живую ленту лёгкого чата: ${streamed.map((u) => new URL(u).pathname).join(', ') || 'нет'}`,
);
check(
  (await page.locator('[data-child-hub]').count()) === 0,
  'вид ушёл на лёгкий чат — хаба родителя на экране нет',
);
// Шапка и подпись ожидания называют модель прогона, а не модель из настроек:
// чата ещё нет в списке, назначенная сервером модель приходит с прогоном.
const pendingLabel = (
  await page.getByText(/думает над ответом|работает с файлами/).allTextContents()
).join(' ');
check(/sonnet/i.test(pendingLabel), `подпись ожидания называет модель прогона: «${pendingLabel}»`);
// Выбор модели и глубины — выпадающие списки: читаем выбранное, не весь список.
const picked = await page
  .locator('select')
  .evaluateAll((selects) =>
    selects.map((select) => select.selectedOptions[0]?.textContent?.trim() ?? ''),
  );
check(
  picked.some((text) => /sonnet/i.test(text)) && !picked.some((text) => /opus/i.test(text)),
  `в шапке модель прогона, не из настроек: ${picked.join(' / ')}`,
);
check(picked.includes('Средняя'), `в шапке глубина прогона: ${picked.join(' / ')}`);
if (process.env.SHOTS) {
  await page.screenshot({ path: `${process.env.SHOTS}/03-status-chat${suffix}.png` });
}

check(errors.length === 0, errors.length === 0 ? 'ошибок консоли нет' : errors.join(' | '));
check(failed.length === 0, failed.length === 0 ? 'ошибок ответов нет' : failed.join(' | '));
await browser.close();
process.exit(bad === 0 ? 0 : 1);
