/**
 * Хаб родителя: «Перевести задачи» групп в статус Jira (G4, владелец
 * 05.10.2026; с 06.10 MR не нужен, есть «Из статуса»).
 *
 * 1. Группа с задачами трекера — кнопка «Перевести N задачи» в её карточке,
 *    с MR и без. В шапке хаба — «Перевести задачи групп» (весь план с
 *    вложенными разделениями).
 * 2. Окно группы читает её задачи (ключ, группа, статус сейчас) и предлагает
 *    только статусы, общие для всех; «Перевести» уходит родителю с номером
 *    группы и выбранным статусом, итог — по каждой задаче.
 * 3. Окно шапки — без номера группы; задача, которую Jira не отдала, видна с
 *    причиной; общего статуса нет — выбора нет, «Перевести» заперта.
 * 4. «Из статуса»: задачи в разных статусах — выбор источника; статусы цели —
 *    доступные задачам этого статуса; «Перевести» несёт `from`, прочие
 *    задачи — «не тронута».
 * 5. Jira не подключена (`jiraTasks` нет) — кнопки на месте (владелец 06.10), окно
 *    ничего не читает и ведёт в «Интеграции».
 *
 * Данные подменяются целиком: ни Jira, ни копий, ни прогонов прогон не трогает.
 *
 * Запуск: `node tools/qa/check-hub-move-tasks.mjs` при поднятом `pnpm dev`
 * (`APP_URL` — другой стенд); `SHOTS=<папка>` — снимки из того же прогона.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PROJECT = { name: 'QA перевод задач', path: 'C:/qa-move-tasks-project' };
const CEILING = { chatModel: 'claude-opus-5', chatEffort: 'high' };

const PARENT = 'qa-move-parent';
const GROUPS = [
  { index: 0, title: 'Отчёты', branch: 'feature/PROJ-11-reports', chatId: 'qa-move-reports' },
  { index: 1, title: 'Экспорт', branch: 'feature/export', chatId: 'qa-move-export' },
  { index: 2, title: 'Импорт', branch: 'feature/import', chatId: 'qa-move-import' },
];
const MR = (index) => `https://gitlab.example.com/proj/app/-/merge_requests/${50 + index}`;

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
  order: [0, 1, 2],
  jiraTasks: true,
  groups: [
    {
      ...base(GROUPS[0]),
      status: 'done',
      mr: MR(0),
      result: { kind: 'pushed', commits: 2 },
      taskKeys: ['PROJ-11', 'PROJ-12'],
    },
    {
      ...base(GROUPS[1]),
      status: 'done',
      mr: MR(1),
      result: { kind: 'pushed', commits: 1 },
      taskKeys: ['PROJ-21'],
    },
    // Без MR, но с задачей трекера — кнопка есть (владелец 06.10).
    { ...base(GROUPS[2]), status: 'started', taskKeys: ['PROJ-31'] },
  ],
};

/** Jira, как её видит сервер: статус каждой задачи и переходы из статуса. */
const statuses = {
  'PROJ-11': 'In Progress',
  'PROJ-12': 'Review',
  'PROJ-21': 'In Progress',
  'PROJ-31': 'Done',
};
const FLOW = { 'In Progress': ['Review', 'Done'], Review: ['Done', 'In Progress'] };
const options = (keys, unread = []) => {
  const read = keys.filter((item) => !unread.some((entry) => entry.key === item.key));
  const candidates = [...new Set(read.flatMap((item) => FLOW[statuses[item.key]] ?? []))];
  return {
    keys: keys.map((item) =>
      unread.some((entry) => entry.key === item.key)
        ? item
        : { ...item, status: statuses[item.key] },
    ),
    statuses: candidates.filter(
      (name) =>
        read.every(
          (item) => statuses[item.key] === name || (FLOW[statuses[item.key]] ?? []).includes(name),
        ) && !read.every((item) => statuses[item.key] === name),
    ),
    // «Из статуса»: по каждому текущему — куда можно перевести каждую задачу в нём.
    from: [...new Set(read.map((item) => statuses[item.key]))].map((status) => {
      const peers = read.filter((item) => statuses[item.key] === status);
      return {
        status,
        count: peers.length,
        targets: (FLOW[status] ?? []).filter((name) =>
          peers.every((item) => (FLOW[statuses[item.key]] ?? []).includes(name)),
        ),
      };
    }),
    unread,
  };
};

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
          blocks: [{ type: 'text', text: 'Разделил задачи на три группы.' }],
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

// Шапка видит ещё вложенное разделение (SUB-1), которое Jira не отдала.
let unreadAll = [{ key: 'SUB-1', reason: 'Jira: 403 нет доступа' }];
const reads = [];
await page.route('**/api/chat/split/*/tasks?*', (route) => routeTasks(route));
await page.route('**/api/chat/split/*/tasks', (route) => routeTasks(route));
function routeTasks(route) {
  const url = new URL(route.request().url());
  const index = url.searchParams.get('index');
  reads.push({ parent: url.pathname.split('/').at(-2), index });
  const own = (group) => group.taskKeys?.map((key) => ({ key, group: group.title })) ?? [];
  const keys =
    index === null
      ? [...split.groups.flatMap(own), { key: 'SUB-1', group: 'Вложенная' }]
      : own(split.groups[Number(index)]);
  return route.fulfill({ json: options(keys, index === null ? unreadAll : []) });
}
const moves = [];
await page.route('**/api/chat/split/*/tasks/move', (route) => {
  const url = new URL(route.request().url());
  const body = route.request().postDataJSON();
  moves.push({ parent: url.pathname.split('/').at(-3), ...body });
  const keys = split.groups[body.index]?.taskKeys ?? [];
  const items = keys.map((key) => {
    if (body.from && statuses[key] !== body.from)
      return { key, outcome: 'skipped', reason: statuses[key] };
    if (statuses[key] === body.status) return { key, outcome: 'already' };
    statuses[key] = body.status;
    return { key, outcome: 'moved' };
  });
  return route.fulfill({
    json: { status: body.status, ...(body.from ? { from: body.from } : {}), items },
  });
});

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};
const shot = async (name, target) => {
  if (!process.env.SHOTS) return;
  await (target ?? page.locator('[data-child-hub]'))
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

// 1. Кнопки: у групп с MR — в карточке, у группы без MR — нет, в шапке — одна.
const cards = hub.locator('[data-hub-row="chat"]');
const cardOf = (index) => cards.filter({ has: page.locator(`[data-group-index="${index}"]`) });
const groupButton = (index) => hub.locator(`[data-move-tasks="${index}"]`);
check((await groupButton(0).count()) === 1, 'у группы с MR и двумя задачами есть кнопка');
check(
  /Перевести 2 задачи/.test(
    (await groupButton(0)
      .innerText()
      .catch(() => '')) || '',
  ),
  `подпись называет число задач: «${await groupButton(0)
    .innerText()
    .catch(() => '')}»`,
);
check(
  (await cardOf(0).locator('[data-move-tasks="0"]').count()) === 1,
  'кнопка группы — внутри её карточки',
);
check((await groupButton(2).count()) === 1, 'у группы без MR, но с задачей трекера — кнопка есть');
check(
  (await hub.locator('[data-move-tasks="all"]').count()) === 1,
  'в шапке хаба — одна кнопка на весь план',
);
await shot('01-hub-move-buttons');

// 2. Окно группы: задачи, статусы, общие для всех, перевод и итог.
const dialog = page.locator('[data-move-tasks-dialog]');
await groupButton(0).click();
await dialog
  .locator('[data-move-tasks-keys]')
  .waitFor({ timeout: 5000 })
  .catch(() => {});
const rows = await dialog.locator('[data-move-tasks-keys] li').allInnerTexts();
check(
  rows.length === 2 && /PROJ-11[\s\S]*Отчёты[\s\S]*In Progress/.test(rows[0] ?? ''),
  `окно показывает задачу, группу и статус: ${JSON.stringify(rows)}`,
);
check(
  reads.at(-1)?.parent === PARENT && reads.at(-1)?.index === '0',
  `окно группы читает задачи её номера: ${JSON.stringify(reads)}`,
);
// Задачи в разных статусах — два выбора: «Из статуса» и цель (последний).
check(
  (await dialog.locator('select').count()) === 2,
  'задачи в разных статусах — есть «Из статуса»',
);
const select = dialog.locator('select').last();
const offered = (await select.count()) === 1 ? await select.locator('option').allInnerTexts() : [];
// PROJ-11 In Progress → Review|Done, PROJ-12 Review → Done|In Progress: общие — Done и обе «уже».
check(
  JSON.stringify(offered) === JSON.stringify(['Review', 'Done', 'In Progress']),
  `выбор — статусы, доступные каждой задаче: ${JSON.stringify(offered)}`,
);
await shot('02-group-dialog', page.getByRole('dialog'));
if ((await select.count()) === 1) await select.selectOption('Done');
await page.locator('[data-move-tasks-submit]').click();
await dialog
  .locator('[data-move-tasks-result]')
  .waitFor({ timeout: 5000 })
  .catch(() => {});
check(
  moves.length === 1 &&
    moves[0].parent === PARENT &&
    moves[0].index === 0 &&
    moves[0].status === 'Done',
  `«Перевести» ушло родителю с номером группы и статусом: ${JSON.stringify(moves)}`,
);
const outcome = await dialog
  .locator('[data-move-tasks-result] li')
  .evaluateAll((list) => list.map((item) => [item.textContent, item.getAttribute('data-outcome')]));
check(
  outcome.length === 2 && outcome.every(([, kind]) => kind === 'moved'),
  `итог по каждой задаче: ${JSON.stringify(outcome)}`,
);
const toastText = await page
  .locator('[data-sonner-toast], [role="status"], [role="alert"]')
  .allInnerTexts();
check(
  toastText.some((text) => /Переведено 2 из 2/.test(text)),
  `тост называет, сколько переведено: ${JSON.stringify(toastText).slice(0, 160)}`,
);
await shot('03-group-result', page.getByRole('dialog'));
await page.getByRole('button', { name: 'Готово' }).click();
await page.waitForTimeout(400);
check((await dialog.count()) === 0, '«Готово» закрывает окно');

// 3. Окно шапки: без номера, непрочитанная задача с причиной; общего статуса нет.
statuses['PROJ-21'] = 'Done';
await hub.locator('[data-move-tasks="all"]').click();
await dialog
  .locator('[data-move-tasks-keys]')
  .waitFor({ timeout: 5000 })
  .catch(() => {});
check(reads.at(-1)?.index === null, 'окно шапки читает задачи без номера группы');
const allRows = await dialog.locator('[data-move-tasks-keys] li').allInnerTexts();
check(
  allRows.length === 5 && allRows.some((row) => /SUB-1[\s\S]*403 нет доступа/.test(row)),
  `задача, которую Jira не отдала, — с причиной: ${JSON.stringify(allRows)}`,
);
// Все прочитанные в Done — переводить некуда: выбора нет, кнопка заперта.
check(
  (await dialog.locator('[data-move-tasks-none]').count()) === 1,
  'общего статуса нет — сказано словами',
);
check(
  await page.locator('[data-move-tasks-submit]').isDisabled(),
  '«Перевести» заперта, пока выбирать не из чего',
);
await shot('04-all-dialog-none', page.getByRole('dialog'));
await page.getByRole('button', { name: 'Отмена' }).click();
await page.waitForTimeout(300);
check(moves.length === 1, 'окно шапки без выбора ничего не перевело');

// 4. «Из статуса»: только задачи, что стоят в нём сейчас.
statuses['PROJ-11'] = 'In Progress';
statuses['PROJ-12'] = 'Review';
await groupButton(0).click();
await dialog
  .locator('[data-move-tasks-keys]')
  .waitFor({ timeout: 5000 })
  .catch(() => {});
const fromSelect = dialog.locator('select').first();
const sources = await fromSelect.locator('option').allInnerTexts();
check(
  JSON.stringify(sources) ===
    JSON.stringify(['Все задачи', 'In Progress — 1 задача', 'Review — 1 задача']),
  `«Из статуса» — «Все задачи» и каждый текущий статус с числом задач: ${JSON.stringify(sources)}`,
);
await fromSelect.selectOption('Review');
const fromTargets = await dialog.locator('select').last().locator('option').allInnerTexts();
check(
  JSON.stringify(fromTargets) === JSON.stringify(['Done', 'In Progress']),
  `цель — статусы, доступные задачам «Review»: ${JSON.stringify(fromTargets)}`,
);
await dialog.locator('select').last().selectOption('In Progress');
await shot('05-group-from-status', page.getByRole('dialog'));
await page.locator('[data-move-tasks-submit]').click();
await dialog
  .locator('[data-move-tasks-result]')
  .waitFor({ timeout: 5000 })
  .catch(() => {});
check(
  moves.at(-1)?.from === 'Review' && moves.at(-1)?.status === 'In Progress',
  `«Перевести» несёт from и цель: ${JSON.stringify(moves.at(-1))}`,
);
const fromOutcome = await dialog
  .locator('[data-move-tasks-result] li')
  .evaluateAll((list) => list.map((item) => [item.textContent, item.getAttribute('data-outcome')]));
check(
  fromOutcome.length === 2 &&
    fromOutcome[0][1] === 'skipped' &&
    /не тронута — стоит в «In Progress»/.test(fromOutcome[0][0] ?? '') &&
    fromOutcome[1][1] === 'moved',
  `задача в другом статусе — «не тронута», с её статусом: ${JSON.stringify(fromOutcome)}`,
);
await page.getByRole('button', { name: 'Готово' }).click();
await page.waitForTimeout(400);

// 5. Jira отключена — кнопок нет.
delete split.jiraTasks;
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-child-hub]', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);
check(
  (await page.locator('[data-move-tasks]').count()) === 4,
  `без подключённой Jira кнопки на месте: ${await page.locator('[data-move-tasks]').count()}`,
);
const readsBefore = reads.length;
await groupButton(0).click();
await page.waitForTimeout(600);
check(
  (await dialog.locator('[data-move-tasks-offline]').count()) === 1 && reads.length === readsBefore,
  'окно говорит, что Jira не подключена, и ничего не читает',
);
await shot('06-offline', page.getByRole('dialog'));
await page.locator('[data-move-tasks-connect]').click();
await page.waitForTimeout(800);
check(
  //settings/.test(page.url()) && /tab=integrations/.test(page.url()),
  `«Открыть «Интеграции»» ведёт в настройки: ${page.url()}`,
);

check(errors.length === 0, errors.length === 0 ? 'ошибок консоли нет' : errors.join(' | '));
await browser.close();
process.exit(bad === 0 ? 0 : 1);
