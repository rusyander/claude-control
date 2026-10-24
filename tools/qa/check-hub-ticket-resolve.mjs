/**
 * Хаб родителя: «Разобрать…» в заголовке «Предложить тикет» (владелец 24.10.2026).
 *
 * 1. Открытые предложения есть — кнопка в заголовке раздела, видна и свёрнутой.
 * 2. Окно: сколько открыто, сколько явных повторов, сколько выйдет задач, список
 *    связками (два дефекта одного файла — одна задача); «куда» читается,
 *    пока окно открыто (в пути — «Опубликовать» заперта), проект привязки выбран.
 * 3. «Опубликовать в Jira» — один запрос (второй клик в пути не шлёт второго),
 *    тело: проект, тип, язык; итог — ключ ссылкой, сведённый повтор назван,
 *    упавшая строка с причиной.
 * 4. «Повторить упавшие» — тот же адрес с `retryFailed`; итог без упавших, уже
 *    открытая задача — «добавлено комментарием» с обоими дефектами;
 *    выбранный проект запомнен; всё заведено — кнопки «Разобрать…» больше нет.
 * 5. Jira не подключена — «Опубликовать» заперта с причиной, есть «Подключить
 *    Jira»; «Решить здесь»: отказ сервера виден в окне, второй раз — новый чат,
 *    вид уходит на его ленту.
 *
 * Данные подменяются целиком (`page.route`): ни Jira, ни модели, ни прогонов
 * прогон не трогает.
 *
 * Запуск: `node tools/qa/check-hub-ticket-resolve.mjs` при поднятом `pnpm dev`
 * (`APP_URL` — другой стенд); `SHOTS=<папка>` — снимки из того же прогона.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PROJECT = { name: 'QA разбор тикетов', path: 'C:/qa-ticket-resolve-project' };
const CEILING = { chatModel: 'claude-opus-5', chatEffort: 'high' };
const PARENT = 'qa-resolve-parent';
const TAKE_CHAT = 'new-1761300000000-resolve';
const SITE = 'https://tracker.example.com';
const LAST_KEY = 'agentdeck.split-tickets.last-jira-project';

const at = '2026-10-24T10:00:00.000Z';
const EXPORT = {
  title: 'Падает экспорт отчёта',
  where: 'apps/web/src/export.ts:42',
  why: 'пустой файл',
  at,
};
const SAVE = {
  title: 'Кнопка «Сохранить» не жмётся',
  where: 'apps/web/src/save.tsx:7',
  why: 'disabled',
  at,
};
// Вторая группа: тот же экспорт (тот же ключ) и он же другими словами по тому же месту.
const SAME_PLACE = { title: 'Экспорт отдаёт пустой файл', where: EXPORT.where, why: 'то же', at };
// Другой дефект в файле кнопки: не повтор, но та же задача (связка по файлу).
const DRAFT_LOST = {
  title: 'Черновик теряется при уходе со страницы',
  where: 'apps/web/src/save.tsx:30',
  why: 'нет автосохранения',
  at,
};

const GROUPS = [
  { index: 0, title: 'Отчёты', branch: 'feature/reports', chatId: 'qa-resolve-reports' },
  { index: 1, title: 'Экспорт', branch: 'feature/export', chatId: 'qa-resolve-export' },
];

const chat = (id, extra) => ({
  id,
  title: extra.title,
  project: PROJECT.name,
  projectPath: PROJECT.path,
  isSandbox: false,
  messageCount: 1,
  createdAt: '2026-10-24T09:00:00.000Z',
  updatedAt: '2026-10-24T09:05:00.000Z',
  preview: '',
  ...(extra.parentId ? { parentId: extra.parentId } : {}),
  ...(extra.groupTitle ? { groupTitle: extra.groupTitle, groupIndex: extra.groupIndex } : {}),
  ...(extra.parentId ? { stage: 'work' } : {}),
});
const chats = [
  chat(PARENT, { title: 'Пачка задач' }),
  ...GROUPS.map((group) =>
    chat(group.chatId, {
      title: `Работа группы «${group.title}»`,
      parentId: PARENT,
      groupTitle: group.title,
      groupIndex: group.index,
    }),
  ),
];

/** Запись разделения; `marks` — отметки «заведено»/«взято» по названию находки. */
let marks = {};
const ticketsOf = (list) => list.map((ticket) => ({ ...ticket, ...(marks[ticket.title] ?? {}) }));
const split = () => ({
  parentChatId: PARENT,
  order: [0, 1],
  // Проект трекера привязан — у строк есть «Завести» (шаг 4б).
  ticketTracker: 'PROJ',
  groups: [
    { ...GROUPS[0], after: [], status: 'done', tickets: ticketsOf([EXPORT, SAVE]) },
    {
      ...GROUPS[1],
      after: [],
      status: 'done',
      tickets: ticketsOf([{ ...EXPORT, why: 'тот же дефект' }, SAME_PLACE, DRAFT_LOST]),
    },
  ],
});

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: {
    width: Number(process.env.QA_WIDTH ?? 1500),
    height: process.env.SHOTS ? 1400 : 1000,
  },
  ...(process.env.QA_THEME ? { colorScheme: process.env.QA_THEME } : {}),
});
await bypassOnboarding(page, CEILING);
const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text().slice(0, 200));
});
/** Ответы с ошибкой — с адресом: консоль браузера его не называет. */
const failedResponses = [];
page.on('response', (response) => {
  if (response.status() >= 400) {
    failedResponses.push(`${response.status()} ${new URL(response.url()).pathname}`);
  }
});

await page.route('**/api/project-git*', (route) =>
  route.fulfill({
    json: { isRepo: false, detached: false, unborn: false, branches: [], changes: [] },
  }),
);
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
    json: [{ path: PROJECT.path, name: PROJECT.name, exists: true, lastActivity: at, chats: [] }],
  }),
);
await page.route('**/api/chats', (route) => route.fulfill({ json: chats }));
await page.route('**/api/chat/*/tree', (route) =>
  route.fulfill({
    json: {
      root: PARENT,
      running: 0,
      split: split(),
      nodes: chats
        .filter((item) => item.parentId)
        .map((item) => ({
          chatId: item.id,
          aliases: [],
          parentChatId: PARENT,
          title: item.title,
          running: false,
        })),
    },
  }),
);
await page.route('**/api/chats/*/messages*', (route) =>
  route.fulfill({
    json: {
      messages: [
        {
          id: 'm-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Разделил задачи на две группы.' }],
          timestamp: at,
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
// После «Решить здесь» сервер ведёт прогон нового чата — вид находит его здесь.
let takeStarted = false;
await page.route('**/api/chat/active', (route) =>
  route.fulfill({
    json: takeStarted
      ? [
          {
            chatId: TAKE_CHAT,
            projectPath: PROJECT.path,
            seq: 0,
            startedAt: Date.now(),
            status: 'running',
            model: 'opus',
            effort: 'high',
          },
        ]
      : [],
  }),
);
const streamed = [];
await page.route('**/api/chat/*/stream*', (route) => {
  streamed.push(route.request().url());
  return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: '' });
});

/** «Куда заводить»: подключённая Jira с привязкой — или не подключена. */
let jiraConnected = true;
const targets = [];
await page.route('**/api/chat/split/*/tickets/target*', async (route) => {
  targets.push(new URL(route.request().url()));
  await new Promise((done) => setTimeout(done, 900));
  await route.fulfill({
    json: jiraConnected
      ? {
          connected: true,
          site: SITE,
          projects: [
            { key: 'OPS', name: 'Операции' },
            { key: 'PROJ', name: 'Проект' },
          ],
          projectKey: 'PROJ',
          projectFrom: 'bound',
          issueTypes: ['Task', 'Bug'],
          issueType: 'Bug',
        }
      : { connected: false, projects: [], issueTypes: [] },
  });
});
const published = [];
await page.route('**/api/chat/split/*/tickets/publish', async (route) => {
  const body = route.request().postDataJSON();
  published.push({ url: route.request().url(), body });
  await new Promise((done) => setTimeout(done, 1200));
  const issue = (key, title, proposals, defects, extra = {}) => ({
    key,
    url: `${SITE}/browse/${key}`,
    title,
    proposals,
    created: true,
    defects,
    ...extra,
  });
  if (!body.retryFailed) {
    marks[EXPORT.title] = { filed: { key: 'PROJ-7', at } };
    marks[SAME_PLACE.title] = { filed: { key: 'PROJ-7', at } };
    return route.fulfill({
      json: {
        mode: 'model',
        issues: [
          issue(
            'PROJ-7',
            'Экспорт отчёта отдаёт пустой файл',
            ['a', 'b'],
            [{ title: EXPORT.title, duplicates: [SAME_PLACE.title] }],
          ),
        ],
        failed: [
          {
            title: 'Не жмётся «Сохранить»',
            proposals: ['c'],
            message: 'Jira: 500 Internal Server Error',
          },
        ],
      },
    });
  }
  // Повтор: в трекере уже открыта задача про сохранение — оба дефекта ушли в неё комментарием.
  marks[SAVE.title] = { filed: { key: 'PROJ-8', at, commented: true } };
  marks[DRAFT_LOST.title] = { filed: { key: 'PROJ-8', at, commented: true } };
  return route.fulfill({
    json: {
      mode: 'model',
      issues: [
        issue(
          'PROJ-8',
          'Сохранение формы ненадёжно',
          ['c', 'd'],
          [
            { title: SAVE.title, duplicates: [] },
            { title: DRAFT_LOST.title, duplicates: [] },
          ],
          { created: false, commented: true },
        ),
      ],
      failed: [],
    },
  });
});
// «Завести» одной строки (R3.6): сервер нашёл открытую задачу про то же — комментарий.
const filedOne = [];
await page.route('**/api/chat/split/*/tickets/file', async (route) => {
  filedOne.push({ url: route.request().url(), body: route.request().postDataJSON() });
  await new Promise((done) => setTimeout(done, 400));
  marks[SAVE.title] = { filed: { key: 'PROJ-8', at, commented: true } };
  return route.fulfill({ json: { key: 'PROJ-8', created: false, commented: true } });
});
const taken = [];
await page.route('**/api/chat/split/*/tickets/take', async (route) => {
  taken.push(route.request().postDataJSON());
  if (taken.length === 1) {
    return route.fulfill({
      status: 409,
      json: {
        message: 'Чат не запустился: прогон с этим ключом уже идёт',
        messageCode: 'split-ticket-take-not-started',
      },
    });
  }
  for (const ticket of [EXPORT, SAVE, SAME_PLACE])
    marks[ticket.title] = { taken: { chatId: TAKE_CHAT, at } };
  takeStarted = true;
  return route.fulfill({ json: { chatId: TAKE_CHAT, count: 3 } });
});

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};
const shot = async (name, target) => {
  if (!process.env.SHOTS) return;
  const path = `${process.env.SHOTS}/${name}.png`;
  await (target ?? page.locator('[data-child-hub]'))
    .screenshot({ path })
    .catch(() => page.screenshot({ path }));
};
const openParent = async () => {
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
};

await openParent();
const hub = page.locator('[data-child-hub]');
check((await hub.count()) === 1, 'сводка групп у родителя показана');

// 1. Кнопка в заголовке свёрнутого раздела.
const resolveButton = hub.locator('[data-split-tickets] [data-resolve-tickets]');
check((await resolveButton.count()) === 1, 'в заголовке «Предложить тикет» есть «Разобрать…»');
check(
  (await hub.locator('[data-split-tickets] [data-hub-fold="closed"]').count()) === 1,
  'раздел свёрнут, а кнопка видна',
);
await shot('01-hub-resolve-button', hub.locator('[data-split-tickets]'));

// 2. Окно: число, повторы, список; «куда» в пути — «Опубликовать» заперта.
await resolveButton.click();
const dialog = page.getByRole('dialog');
await dialog
  .locator('[data-resolve-dialog]')
  .waitFor({ timeout: 5000 })
  .catch(() => {});
const publish = dialog.locator('[data-resolve-publish]');
await page.waitForTimeout(200);
check(await publish.isDisabled(), '«куда» ещё читается — «Опубликовать» заперта');
const info = await dialog
  .locator('[data-resolve-open]')
  .innerText()
  .catch(() => '');
check(/4/.test(info) && /1 из них/.test(info), `открыто 4, один явный повтор: «${info}»`);
check(
  (await dialog.locator('[data-resolve-list] > li').count()) === 2 &&
    (await dialog.locator('[data-resolve-duplicate]').count()) === 1,
  'список: две будущие задачи, повтор подписан «то же»',
);
check(
  (await dialog.locator('[data-resolve-planned="2"]').count()) === 1 &&
    (await dialog.locator('[data-resolve-bundle="2"]').count()) === 1 &&
    (await dialog.getByText('одна задача — общий файл apps/web/src/save.tsx').count()) === 1,
  'два дефекта файла кнопки — одной задачей с подписью общего файла; выйдет 2 задачи',
);
await dialog
  .locator('[data-resolve-target]')
  .waitFor({ timeout: 5000 })
  .catch(() => {});
const project = await dialog
  .locator('select')
  .first()
  .inputValue()
  .catch(() => '');
check(project === 'PROJ', `проект по умолчанию — привязка: ${project}`);
check(
  (await dialog.getByText(SITE).count()) > 0 &&
    (await dialog.getByText('привязан к проекту панели').count()) > 0,
  'сайт Jira и причина выбора проекта названы',
);
check(
  targets.length >= 1 && targets.at(-1)?.pathname === `/api/chat/split/${PARENT}/tickets/target`,
  `«куда» читается у родителя: ${targets.map((url) => url.pathname + url.search).join(', ')}`,
);
check(!(await publish.isDisabled()), 'прочитано — «Опубликовать» доступна');
await shot('02-dialog-ready', dialog);

// 3. Публикация: второй клик в пути второго запроса не шлёт; итог с упавшей строкой.
await publish.click();
await page.waitForTimeout(300);
await publish.click({ force: true }).catch(() => {});
await dialog
  .locator('[data-resolve-result]')
  .waitFor({ timeout: 8000 })
  .catch(() => {});
check(published.length === 1, `публикаций ушло: ${published.length} (ждали одну)`);
const first = published[0];
check(
  first?.url.endsWith(`/api/chat/split/${PARENT}/tickets/publish`) &&
    first?.body?.projectKey === 'PROJ' &&
    first?.body?.issueType === 'Bug' &&
    first?.body?.lang === 'ru' &&
    first?.body?.retryFailed === false,
  `тело публикации: ${JSON.stringify(first?.body)}`,
);
const link = dialog.locator('[data-resolve-issue="PROJ-7"] a, a[href$="/browse/PROJ-7"]').first();
check(
  (await link.getAttribute('href').catch(() => '')) === `${SITE}/browse/PROJ-7`,
  'заведённая задача — ссылкой на трекер',
);
check(
  (await dialog.locator('[data-resolve-failed]').count()) === 1 &&
    (await dialog.getByText(/500 Internal Server Error/).count()) === 1,
  'упавшая задача — строкой с причиной',
);
check(
  (await dialog.getByText(`сведено: ${SAME_PLACE.title}`).count()) === 1,
  'в итоге видно, какой повтор сведён в задачу',
);
await shot('03-dialog-partial', dialog);

// 4. «Повторить упавшие» — только они; выбор проекта запомнен.
await dialog.locator('[data-resolve-retry]').click();
await page.waitForTimeout(1800);
check(
  published.length === 2 && published[1]?.body?.retryFailed === true,
  `повтор ушёл с retryFailed: ${JSON.stringify(published[1]?.body)}`,
);
check(
  (await dialog.locator('[data-resolve-failed]').count()) === 0 &&
    (await dialog.locator('a[href$="/browse/PROJ-8"]').count()) === 1,
  'после повтора упавших нет, задача ссылкой',
);
check(
  (await dialog.locator('[data-resolve-commented]').count()) === 1 &&
    (await dialog.getByText('уже была открыта — добавлено комментарием').count()) === 1 &&
    (await dialog.locator('[data-resolve-defects]').getByText(DRAFT_LOST.title).count()) === 1,
  'открытая задача — «добавлено комментарием», оба её дефекта перечислены',
);
const remembered = await page.evaluate((key) => window.localStorage.getItem(key), LAST_KEY);
check(remembered === 'PROJ', `проект запомнен для следующего раза: ${remembered}`);
await shot('04-dialog-retried', dialog);
await dialog.getByRole('button', { name: 'Закрыть' }).last().click();
await page.waitForTimeout(1500);
check(
  (await hub.locator('[data-resolve-tickets]').count()) === 0,
  'всё заведено — «Разобрать…» больше нет',
);
await hub.locator('[data-split-tickets] [data-hub-fold]').click();
await page.waitForTimeout(300);
check(
  // PROJ-7 собрала две строки (экспорт и он же другими словами), PROJ-8 — два дефекта файла кнопки.
  (await hub.locator('[data-ticket-filed="PROJ-7"]').count()) === 2 &&
    (await hub.locator('[data-ticket-filed="PROJ-8"]').count()) === 2,
  `строки раздела показывают заведённые ключи: ${(
    await hub
      .locator('[data-ticket-filed]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-ticket-filed')))
  ).join(', ')}`,
);
check(
  (await hub.locator('[data-ticket-filed="PROJ-8"][data-ticket-commented]').count()) === 2 &&
    (await hub.locator('[data-ticket-filed="PROJ-7"][data-ticket-commented]').count()) === 0 &&
    (await hub.getByText('PROJ-8: уже была открыта — добавлено комментарием').count()) === 2,
  'строки, ушедшие комментарием, так и подписаны; заведённые — «Заведено»',
);

// 4б. «Завести» одной строки: открытая задача про то же — строка подписана «добавлено комментарием».
marks = {};
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-child-hub]', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);
await hub.locator('[data-split-tickets] [data-hub-fold]').click();
await page.waitForTimeout(300);
const saveRow = hub.locator('[data-split-ticket]').filter({ hasText: SAVE.title });
await saveRow.locator('[data-file-ticket]').click();
await saveRow.getByRole('button', { name: 'Завести', exact: true }).click();
await saveRow
  .locator('[data-ticket-commented]')
  .waitFor({ timeout: 8000 })
  .catch(() => {});
check(
  filedOne.length === 1 &&
    filedOne[0]?.url.endsWith(`/api/chat/split/${PARENT}/tickets/file`) &&
    filedOne[0]?.body?.lang === 'ru' &&
    typeof filedOne[0]?.body?.key === 'string',
  `«Завести» строки ушло с языком: ${JSON.stringify(filedOne[0]?.body ?? null).slice(0, 160)}`,
);
check(
  (await saveRow.locator('[data-ticket-filed="PROJ-8"][data-ticket-commented]').count()) === 1 &&
    (await saveRow.getByText('PROJ-8: уже была открыта — добавлено комментарием').count()) === 1,
  'строка «Завести» — «уже была открыта — добавлено комментарием»',
);
check(
  (await page.getByText('PROJ-8: уже была открыта — добавлено комментарием').count()) >= 1,
  'тост «Завести» говорит о комментарии, а не «Заведено»',
);
await shot('04b-row-commented', hub.locator('[data-split-tickets]'));

// 5. Jira не подключена; «Решить здесь» — отказ виден, повтор открывает новый чат.
marks = {};
jiraConnected = false;
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-child-hub]', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.locator('[data-resolve-tickets]').click();
await dialog
  .locator('[data-resolve-offline]')
  .waitFor({ timeout: 5000 })
  .catch(() => {});
check(
  (await dialog.locator('[data-resolve-offline]').count()) === 1,
  'окно говорит, что Jira не подключена',
);
check(await publish.isDisabled(), '«Опубликовать» заперта');
check(
  (await publish.getAttribute('title')) === 'Jira не подключена' &&
    (await dialog.getByText('Jira не подключена', { exact: true }).count()) === 1,
  'причина запрета написана рядом и в подсказке',
);
check((await dialog.locator('[data-resolve-connect]').count()) === 1, 'есть «Подключить Jira»');
const take = dialog.locator('[data-resolve-take]');
check(!(await take.isDisabled()), '«Решить здесь» работает без Jira');
await shot('05-dialog-offline', dialog);
await take.click();
await page.waitForTimeout(800);
check(
  (await dialog.locator('[data-resolve-error]').count()) === 1 &&
    /Чат не запустился/.test(
      await dialog
        .locator('[data-resolve-error]')
        .innerText()
        .catch(() => ''),
    ),
  'отказ сервера виден в окне, окно осталось',
);
check(taken[0]?.lang === 'ru', `тело «Решить здесь»: ${JSON.stringify(taken[0])}`);
await take.click();
await page.waitForTimeout(3000);
check(taken.length === 2, `запросов «Решить здесь»: ${taken.length}`);
check(
  streamed.some((url) => url.includes(`/api/chat/${encodeURIComponent(TAKE_CHAT)}/stream`)),
  `вид открыл ленту нового чата: ${streamed.map((url) => new URL(url).pathname).join(', ') || 'нет'}`,
);
check(
  (await page.locator('[data-child-hub]').count()) === 0,
  'вид ушёл на новый чат — хаба на экране нет',
);

// Отказ «Решить здесь» (409) подстроен проверкой — остальные ответы с ошибкой считаются.
const unexpected = failedResponses.filter((line) => !/^409 .*\/tickets\/take$/.test(line));
check(unexpected.length === 0, `ответов с ошибкой нет: ${[...new Set(unexpected)].join(', ')}`);
const realErrors = errors.filter((text) => !/status of 409/.test(text));
check(
  realErrors.length === 0,
  realErrors.length === 0 ? 'ошибок консоли нет' : [...new Set(realErrors)].join(' | '),
);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
