/**
 * Хаб родителя: «Продолжить» у недоделанной группы и «Перепроверить MR» у
 * доставленной (владелец, 05.10.2026).
 *
 * 1. Группа, сдавшаяся на сбое (доступ CLI кончился, повторы исчерпаны), —
 *    кнопка «Продолжить» в её строке; щелчок уходит родителю с номером группы.
 *    Копия убрана — продолжать негде, кнопки нет.
 * 2. Доставленная группа с MR — «Перепроверить MR» обычного цвета; щелчок
 *    уходит родителю, строка говорит «перепроверяется»; когда проверка
 *    кончилась доставкой — кнопка зелёная и с временем последней проверки.
 * 3. Отказ сервера (MR уже влит) — тост с причиной, кнопка остаётся обычной.
 *
 * Данные подменяются целиком: ни копий, ни прогонов прогон не создаёт.
 *
 * Запуск: `node tools/qa/check-hub-continue-recheck.mjs` при поднятом `pnpm dev`;
 * `SHOTS=<папка>` — снимки из того же прогона.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PROJECT = { name: 'QA продолжение', path: 'C:/qa-continue-project' };
const CEILING = { chatModel: 'claude-opus-5', chatEffort: 'high' };

const PARENT = 'qa-continue-parent';
const KID_AUTH = 'qa-continue-auth';
const KID_MR = 'qa-continue-mr';
const KID_MERGED = 'qa-continue-merged';
const KID_CLEANED = 'qa-continue-cleaned';
const MR = 'https://gitlab.example.com/proj/app/-/merge_requests/41';
const MERGED_MR = 'https://gitlab.example.com/proj/app/-/merge_requests/42';
const CHECKED_AT = '2026-10-05T11:32:00.000Z';

const GROUPS = [
  { index: 0, title: 'Авторизация', branch: 'feature/auth', chatId: KID_AUTH },
  { index: 1, title: 'Отчёты', branch: 'feature/reports', chatId: KID_MR },
  { index: 2, title: 'Экспорт', branch: 'feature/export', chatId: KID_MERGED },
  {
    index: 3,
    title: 'Импорт',
    branch:
      'fix-PROJ-1459-PROJ-1444-PROJ-1402-PROJ-1399-PROJ-1362-PROJ-1361-PROJ-1337-PROJ-1335-PROJ-1487-PROJ-1488-PROJ-1490-PROJ-1491/import-fixes',
    chatId: KID_CLEANED,
  },
];

const copyOf = (group) => `${PROJECT.path}-worktrees/${group.branch.replace(/\//g, '-')}`;

const chat = (id, extra) => ({
  id,
  title: extra.title,
  project: PROJECT.name,
  projectPath: extra.projectPath ?? PROJECT.path,
  isSandbox: false,
  messageCount: 1,
  createdAt: '2026-10-05T10:00:00.000Z',
  updatedAt: '2026-10-05T10:05:00.000Z',
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
    chat(group.chatId, {
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

const base = (group) => ({
  index: group.index,
  title: group.title,
  branch: group.branch,
  after: [],
  chatId: group.chatId,
  path: copyOf(group),
  deliver: true,
  seated: true,
});

const split = {
  parentChatId: PARENT,
  order: [0, 1, 2, 3],
  groups: [
    {
      ...base(GROUPS[0]),
      status: 'failed',
      error: 'Not logged in · Please run /login',
      retries: 3,
    },
    { ...base(GROUPS[1]), status: 'done', mr: MR, result: { kind: 'pushed', commits: 2 } },
    { ...base(GROUPS[2]), status: 'done', mr: MERGED_MR, result: { kind: 'pushed', commits: 1 } },
    {
      ...base(GROUPS[3]),
      status: 'failed',
      error: 'Not logged in · Please run /login',
      cleaned: { branch: 'kept' },
    },
  ],
};

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: {
    width: Number(process.env.QA_WIDTH ?? 1500),
    height: process.env.SHOTS ? 1600 : 1000,
  },
  ...(process.env.QA_THEME ? { colorScheme: process.env.QA_THEME } : {}),
});
await bypassOnboarding(page, CEILING);

const errors = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  const text = message.text();
  // Отказ 409 — часть сценария (п. 3): браузер пишет его в консоль сам.
  if (/409 \(Conflict\)/.test(text)) return;
  errors.push(text.slice(0, 200));
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
    json: [
      {
        path: PROJECT.path,
        name: PROJECT.name,
        exists: true,
        lastActivity: '2026-10-05T10:00:00.000Z',
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
      running: 0,
      split,
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
          blocks: [{ type: 'text', text: 'Разделил задачи на четыре группы.' }],
          timestamp: '2026-10-05T10:02:00.000Z',
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
await page.route('**/api/chat/active', (route) => route.fulfill({ json: [] }));

// Запросы кнопок: ведут себя как сервер — запись группы меняется.
const continueCalls = [];
await page.route('**/api/chat/split/*/continue-group', (route) => {
  const url = new URL(route.request().url());
  const body = route.request().postDataJSON();
  continueCalls.push({ parent: url.pathname.split('/').at(-2), ...body });
  const group = split.groups[body.index];
  group.status = 'started';
  delete group.error;
  delete group.retries;
  return route.fulfill({ json: { index: body.index, outcome: 'sent' } });
});
const recheckCalls = [];
await page.route('**/api/chat/split/*/recheck', (route) => {
  const url = new URL(route.request().url());
  const body = route.request().postDataJSON();
  recheckCalls.push({ parent: url.pathname.split('/').at(-2), ...body });
  const group = split.groups[body.index];
  if (group.mr === MERGED_MR) {
    // Как сервер (ревью R4): состояние MR ложится в запись группы.
    group.mrClosed = 'merged';
    return route.fulfill({
      status: 409,
      json: { message: 'MR уже влит — перепроверять нечего', messageCode: 'split-recheck-merged' },
    });
  }
  const requestedAt = '2026-10-05T11:20:00.000Z';
  group.status = 'started';
  group.recheckRequestedAt = requestedAt;
  return route.fulfill({ json: { index: body.index, outcome: 'sent', requestedAt } });
});

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};
const shot = async (name) => {
  if (!process.env.SHOTS) return;
  await page
    .locator('[data-child-hub]')
    .screenshot({ path: `${process.env.SHOTS}/${name}.png` })
    .catch(() => page.screenshot({ path: `${process.env.SHOTS}/${name}.png` }));
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
  await page.waitForTimeout(2000);
};

await openParent();
const hub = page.locator('[data-child-hub]');
check((await hub.count()) === 1, 'сводка групп у родителя показана');
await shot('01-hub-initial');

// 1. «Продолжить» у сдавшейся группы.
const continueOf = (index) =>
  hub.locator(`[data-group-index="${index}"] [data-group-control="continue"]`);
check((await continueOf(0).count()) === 1, 'у сдавшейся группы есть «Продолжить»');
check(
  (await continueOf(3).count()) === 0,
  'у сдавшейся группы с убранной копией «Продолжить» нет — продолжать негде',
);
check(
  (await hub.locator('[data-group-index="1"] [data-group-control="continue"]').count()) === 0,
  'у доставленной группы «Продолжить» нет',
);
if ((await continueOf(0).count()) === 1) {
  await continueOf(0).click();
  await page.waitForTimeout(1200);
}
check(
  continueCalls.length === 1 && continueCalls[0].parent === PARENT && continueCalls[0].index === 0,
  `«Продолжить» ушло родителю с номером группы: ${JSON.stringify(continueCalls)}`,
);
check((await continueOf(0).count()) === 0, 'после продолжения кнопка ушла — группа работает');

// 2. «Перепроверить MR» у доставленной группы.
const recheckOf = (index) => hub.locator(`[data-recheck-group][data-group-index="${index}"]`);
const recheckState = async (index) =>
  (await recheckOf(index).count()) === 1 ? recheckOf(index).getAttribute('data-recheck-group') : '';
check((await recheckState(1)) === 'open', 'у доставленной группы — «Перепроверить MR», обычная');
check((await recheckOf(0).count()) === 0, 'у недоставленной группы перепроверки MR нет');
await shot('02-hub-before-recheck');
if ((await recheckOf(1).count()) === 1) {
  await recheckOf(1).getByRole('button').click();
  await page.waitForTimeout(1200);
}
check(
  recheckCalls.length === 1 && recheckCalls[0].parent === PARENT && recheckCalls[0].index === 1,
  `«Перепроверить MR» ушло родителю с номером группы: ${JSON.stringify(recheckCalls)}`,
);
check((await recheckState(1)) === 'pending', 'идущая перепроверка подписана «перепроверяется»');
await shot('03-hub-recheck-pending');

// 3. Отказ сервера — тост с причиной, кнопка обычная.
if ((await recheckOf(2).count()) === 1) {
  await recheckOf(2).getByRole('button').click();
  await page.waitForTimeout(1000);
}
const toastText = await page
  .locator('[data-sonner-toast], [role="status"], [role="alert"]')
  .allInnerTexts();
check(
  toastText.some((text) => /MR уже влит/.test(text)),
  `отказ виден тостом с причиной: ${JSON.stringify(toastText).slice(0, 200)}`,
);
await page.waitForTimeout(1500);
check(
  (await recheckOf(2).count()) === 0,
  'после отказа «влит» кнопки перепроверки нет — жать её бесполезно',
);
check(
  (await hub.locator('[data-hub-mr-closed="merged"]').count()) === 1,
  'строка говорит «MR влит»',
);

// Сервер кончил перепроверку доставкой: группа снова «готово», с отметкой.
Object.assign(split.groups[1], { status: 'done', recheckedAt: CHECKED_AT });
delete split.groups[1].recheckRequestedAt;
// Перезагрузка оставляет открытым тот же разговор: дерево читается заново.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-child-hub]', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);
check((await recheckState(1)) === 'checked', 'после проверки кнопка зелёная');
const caption = (await recheckOf(1).count()) === 1 ? await recheckOf(1).innerText() : '';
check(/\d{1,2}:\d{2}/.test(caption), `рядом время последней проверки: «${caption}»`);
await shot('04-hub-recheck-checked');

// 4. Карточка группы (владелец 05.10): кнопки — внутри своей карточки, ветка —
// одной строкой, MR открывает только своя кнопка, остальная карточка — чат.
const cards = hub.locator('[data-hub-row="chat"]');
const cardOf = (index) => cards.filter({ has: page.locator(`[data-group-index="${index}"]`) });
check(
  (await cardOf(1).locator('[data-recheck-group]').count()) === 1 &&
    (await cardOf(1).locator('[data-accept-group]').count()) === 1 &&
    (await cardOf(1).locator('[data-hub-mr]').count()) === 1,
  'кнопки доставленной группы — внутри её карточки',
);
const geometry = await cardOf(1).evaluate((card) => {
  const box = card.getBoundingClientRect();
  // Правый край ряда кнопок — самая правая кнопка карточки, кроме растянутой.
  const rights = [...card.querySelectorAll('button:not([data-hub-open])')].map((el) =>
    el.getBoundingClientRect(),
  );
  const button = rights.sort((a, b) => b.right - a.right)[0];
  const title = card.querySelector('[data-hub-open]')?.getBoundingClientRect();
  return { box, button, title };
});
check(
  Boolean(geometry.button) &&
    geometry.button.right <= geometry.box.right &&
    geometry.button.right > geometry.box.right - 40 &&
    // Узкая карточка (телефон) уводит кнопки под текст — прижатыми вправо.
    (geometry.box.width < 560 || geometry.button.top - geometry.box.top < 40),
  `кнопки прижаты к правому верху карточки: ${JSON.stringify({ card: geometry.box, button: geometry.button })}`,
);
const gap = await cards.evaluateAll((list) =>
  list.length > 1
    ? list[1].getBoundingClientRect().top - list[0].getBoundingClientRect().bottom
    : -1,
);
check(gap >= 8, `между карточками отступ: ${gap}px`);
const longBranch = await hub.evaluate((root) => {
  const node = [...root.querySelectorAll('span')].find((el) =>
    el.textContent?.startsWith('fix-PROJ-1459'),
  );
  if (!node) return undefined;
  const style = getComputedStyle(node);
  return {
    height: node.getBoundingClientRect().height,
    line: parseFloat(style.lineHeight) || 18,
    clipped: node.scrollWidth > node.clientWidth,
    title: node.getAttribute('title') ?? '',
  };
});
check(
  Boolean(longBranch) && longBranch.height < longBranch.line * 1.5,
  `длинная ветка — одной строкой: ${JSON.stringify(longBranch)}`,
);
check(
  !longBranch?.clipped || longBranch.title.startsWith('fix-PROJ-1459'),
  'обрезанная ветка читается целиком по наведению',
);

const mrButton = cardOf(1).locator('[data-hub-mr]');
check((await mrButton.evaluate((el) => el.tagName)) === 'BUTTON', 'MR — отдельная кнопка');
check(
  (await cardOf(1).locator('[data-hub-open] a, [data-hub-open] button').count()) === 0,
  'внутри открывающей кнопки нет других ссылок и кнопок',
);
await page
  .context()
  .route(/gitlab\.example\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<title>MR</title>' }),
  );
const popup = page.waitForEvent('popup', { timeout: 5000 }).catch(() => undefined);
await mrButton.click();
const opened = await popup;
check(opened?.url() === MR, `кнопка MR открыла сам MR: ${opened?.url() ?? 'нет окна'}`);
await opened?.close();
await page.waitForTimeout(500);
check((await hub.count()) === 1, 'клик по MR не увёл из родителя в чат группы');
await shot('05-hub-cards');

// Клик по тексту карточки (не по кнопке) — чат группы.
await cardOf(1).locator('[data-hub-meta]').click();
await page.waitForTimeout(1500);
check((await page.locator('[data-child-hub]').count()) === 0, 'клик по карточке открыл чат группы');

check(errors.length === 0, errors.length === 0 ? 'ошибок консоли нет' : errors.join(' | '));
await browser.close();
process.exit(bad === 0 ? 0 : 1);
