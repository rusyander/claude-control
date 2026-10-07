/**
 * Хаб родителя: порядок карточек групп и очередь слияния MR (владелец, 05.10.2026).
 *
 * G2. Группы, которые ещё в работе (идут, стоят, ждут человека, в очереди),
 *     всегда сверху; законченные (доставлены, приняты, MR влит или закрыт,
 *     копия убрана) — ниже. Внутри каждой части — прежний порядок плана.
 * G3. У кнопки MR — «мержить N-м из M»: топологический порядок по
 *     предшественникам (`after` и ветка, от которой отведена копия), в
 *     подсказке — чьи MR влить раньше. Без своего MR, с влитым MR или с
 *     предшественником, которому нечего вливать, — номера нет.
 *
 * Данные подменяются целиком: ни копий, ни прогонов прогон не создаёт.
 *
 * Запуск: `node tools/qa/check-hub-order-merge.mjs` при поднятом `pnpm dev`;
 * `SHOTS=<папка>` — снимки из того же прогона, `QA_WIDTH` — ширина окна.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PROJECT = { name: 'QA очередь слияния', path: 'C:/qa-merge-order-project' };
const CEILING = { chatModel: 'claude-opus-5', chatEffort: 'high' };
const PARENT = 'qa-merge-parent';
const mrOf = (id) => `https://gitlab.example.com/proj/app/-/merge_requests/${id}`;

/**
 * План из восьми групп. Порядок плана — по номеру; «Схема БД» ждёт
 * «Настройки», «API» и «Отчёты» отведены от ветки «Схемы БД», «Импорт» ждёт
 * «API». Ожидаемая очередь слияния: Настройки 1-й, Схема БД 2-й (после
 * Настроек), Отчёты 3-й (после обоих); у «Импорта» MR есть, но «API» вливать
 * нечем — номера нет; у «Доков» MR влит — номера нет.
 */
const GROUPS = [
  { index: 0, title: 'Схема БД', branch: 'feature/schema', status: 'done', mr: 10, after: [7] },
  { index: 1, title: 'API', branch: 'feature/api', status: 'started', base: 'feature/schema' },
  {
    index: 2,
    title: 'Отчёты',
    branch: 'feature/reports',
    status: 'done',
    mr: 12,
    base: 'feature/schema',
  },
  { index: 3, title: 'Экспорт', branch: 'feature/export', status: 'failed' },
  { index: 4, title: 'Импорт', branch: 'feature/import', status: 'started', mr: 14, after: [1] },
  { index: 5, title: 'Доки', branch: 'feature/docs', status: 'done', mr: 15, mrClosed: 'merged' },
  { index: 6, title: 'Логи', branch: 'feature/logs', status: 'pending', noChat: true },
  { index: 7, title: 'Настройки', branch: 'feature/settings', status: 'done', mr: 17 },
];

/**
 * В работе — сверху по плану, законченные — ниже по плану, группа с влитым MR
 * («Доки») — в самом низу (владелец 06.10.2026): невлитая ещё ждёт слияния.
 */
const EXPECTED_ORDER = [
  'API',
  'Экспорт',
  'Импорт',
  'Логи',
  'Схема БД',
  'Отчёты',
  'Настройки',
  'Доки',
];
const EXPECTED_MERGE = {
  Настройки: { position: '1', total: '3', before: [] },
  'Схема БД': { position: '2', total: '3', before: ['Настройки'] },
  Отчёты: { position: '3', total: '3', before: ['Настройки', 'Схема БД'] },
};

const chatIdOf = (group) => `qa-merge-${group.index}`;
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
  ...GROUPS.filter((group) => !group.noChat).map((group) =>
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

const split = {
  parentChatId: PARENT,
  order: GROUPS.map((group) => group.index),
  groups: GROUPS.map((group) => ({
    index: group.index,
    title: group.title,
    branch: group.branch,
    after: group.after ?? [],
    ...(group.base ? { base: group.base } : {}),
    ...(group.noChat ? {} : { chatId: chatIdOf(group), path: copyOf(group), seated: true }),
    deliver: true,
    status: group.status,
    ...(group.status === 'failed' ? { error: 'Not logged in · Please run /login' } : {}),
    ...(group.mr ? { mr: mrOf(group.mr) } : {}),
    ...(group.mrClosed ? { mrClosed: group.mrClosed } : {}),
    ...(group.status === 'done' ? { result: { kind: 'pushed', commits: 1 } } : {}),
  })),
};

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: {
    width: Number(process.env.QA_WIDTH ?? 1500),
    height: process.env.SHOTS ? 1800 : 1000,
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
// Настройки разделения проекта, которого нет на диске: сервер ответил бы 400.
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
          blocks: [{ type: 'text', text: 'Разделил задачи на восемь групп.' }],
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

// Каждой карточке — имя её группы: первое из известных имён в её тексте.
const titles = GROUPS.map((group) => group.title);
const cards = hub.locator('[data-hub-row]');
const cardTitles = await cards.evaluateAll(
  (list, names) =>
    list.map((card) => {
      const text = card.textContent ?? '';
      const found = names
        .map((name) => ({ name, at: text.indexOf(name) }))
        .filter((item) => item.at >= 0)
        .sort((a, b) => a.at - b.at)[0];
      return found?.name ?? '?';
    }),
  titles,
);

// G2. Порядок карточек.
check(
  JSON.stringify(cardTitles) === JSON.stringify(EXPECTED_ORDER),
  `в работе сверху, законченные ниже, влитые в самом низу, внутри — порядок плана: ${cardTitles.join(' · ')}`,
);

// G3. Очередь слияния у кнопки MR.
const cardOf = (title) => cards.nth(cardTitles.indexOf(title));
for (const group of GROUPS) {
  if (cardTitles.indexOf(group.title) < 0) continue;
  const card = cardOf(group.title);
  const chip = card.locator('[data-merge-order]');
  const expected = EXPECTED_MERGE[group.title];
  if (!expected) {
    check(
      (await chip.count()) === 0,
      `«${group.title}» — без номера в очереди слияния (${group.mr ? 'MR есть, но вливать его по порядку нельзя или он влит' : 'MR нет'})`,
    );
    continue;
  }
  if ((await chip.count()) !== 1) {
    check(false, `«${group.title}» — у кнопки MR есть номер в очереди слияния`);
    continue;
  }
  const text = (await chip.innerText()).trim();
  const title = (await chip.getAttribute('title')) ?? '';
  check(
    text === `мержить ${expected.position}-м из ${expected.total}` &&
      (await chip.getAttribute('data-merge-order')) === expected.position,
    `«${group.title}» — «${text}»`,
  );
  const named = titles.filter((name) => name !== group.title && title.includes(`«${name}»`));
  check(
    JSON.stringify(named.sort()) === JSON.stringify([...expected.before].sort()),
    `подсказка «${group.title}» называет, кого влить раньше: «${title}»`,
  );
  // Номер — рядом с кнопкой MR этой же карточки и в её границах.
  const geometry = await card.evaluate((root) => {
    const box = root.getBoundingClientRect();
    const mr = root.querySelector('[data-hub-mr]')?.getBoundingClientRect();
    const tag = root.querySelector('[data-merge-order]')?.getBoundingClientRect();
    return { box, mr, tag };
  });
  check(
    Boolean(geometry.mr && geometry.tag) &&
      geometry.tag.left >= geometry.box.left &&
      geometry.tag.right <= geometry.box.right + 0.5 &&
      Math.abs(
        geometry.tag.top + geometry.tag.height / 2 - (geometry.mr.top + geometry.mr.height / 2),
      ) <= 2 &&
      Math.min(
        Math.abs(geometry.tag.right - geometry.mr.left),
        Math.abs(geometry.mr.right - geometry.tag.left),
      ) <= 12,
    `номер «${group.title}» стоит вплотную к кнопке MR, на одной линии: ${JSON.stringify(geometry)}`,
  );
}
await shot('02-hub-merge-order');

check(errors.length === 0, errors.length === 0 ? 'ошибок консоли нет' : errors.join(' | '));
await browser.close();
process.exit(bad === 0 ? 0 : 1);
