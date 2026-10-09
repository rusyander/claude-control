/**
 * Хаб родителя: принятая группа видна и уходит вниз (владелец, 09.10.2026).
 *
 * «Принять» раньше меняло только подпись кнопки: принятая и просто
 * доставленная группы лежали в одной части «законченные», в порядке плана, и
 * выглядели одинаково — по хабу нельзя было понять, что уже принято. Теперь:
 *
 * 1. Порядок: в работе → доставлены и ждут приёмки → приняты → MR влит или
 *    закрыт. Внутри каждой части — порядок плана.
 * 2. У принятой карточки свой фон (`data-hub-accepted`), отличный и от
 *    доставленной, и от влитой.
 * 3. Нажатие «Принять» сразу перекрашивает карточку и опускает её к принятым;
 *    «Снять отметку» возвращает назад.
 *
 * Данные подменяются целиком: ни копий, ни прогонов прогон не создаёт;
 * приёмка — подменённый POST, дерево отдаёт её со следующим опросом.
 *
 * Запуск: `node tools/qa/check-hub-accepted.mjs` при поднятом `pnpm dev`;
 * `SHOTS=<папка>` и `PHASE=before|after` — снимки, `QA_THEME=dark` — тёмная тема.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PROJECT = { name: 'QA приёмка групп', path: 'C:/qa-hub-accepted-project' };
const CEILING = { chatModel: 'claude-opus-5', chatEffort: 'high' };
const PARENT = 'qa-accepted-parent';
const mrOf = (id) => `https://gitlab.example.com/proj/app/-/merge_requests/${id}`;
const ACCEPTED_AT = '2026-10-09T12:00:00.000Z';

const GROUPS = [
  { index: 0, title: 'Вход', branch: 'feature/login', status: 'started' },
  { index: 1, title: 'Отчёты', branch: 'feature/reports', status: 'done', mr: 11 },
  {
    index: 2,
    title: 'Схема',
    branch: 'feature/schema',
    status: 'done',
    mr: 12,
    acceptedAt: ACCEPTED_AT,
  },
  { index: 3, title: 'Доки', branch: 'feature/docs', status: 'done', mr: 13, mrClosed: 'merged' },
  { index: 4, title: 'Импорт', branch: 'feature/import', status: 'done', mr: 14 },
];

const ORDER_START = ['Вход', 'Отчёты', 'Импорт', 'Схема', 'Доки'];
const ORDER_AFTER_ACCEPT = ['Вход', 'Импорт', 'Отчёты', 'Схема', 'Доки'];

const chatIdOf = (group) => `qa-accepted-${group.index}`;
const copyOf = (group) => `${PROJECT.path}-worktrees/${group.branch.replace(/\//g, '-')}`;

const chat = (id, extra) => ({
  id,
  title: extra.title,
  project: PROJECT.name,
  projectPath: extra.projectPath ?? PROJECT.path,
  isSandbox: false,
  messageCount: 1,
  createdAt: '2026-10-09T10:00:00.000Z',
  updatedAt: '2026-10-09T10:05:00.000Z',
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

/** Приёмка живёт «на сервере»: POST меняет её, дерево отдаёт со следующим опросом. */
const accepted = new Map(
  GROUPS.filter((group) => group.acceptedAt).map((group) => [group.index, group.acceptedAt]),
);

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
    ...(group.mr ? { mr: mrOf(group.mr) } : {}),
    ...(group.mrClosed ? { mrClosed: group.mrClosed } : {}),
    ...(group.status === 'done' ? { result: { kind: 'pushed', commits: 1 } } : {}),
    ...(accepted.has(group.index) ? { acceptedAt: accepted.get(group.index) } : {}),
  })),
});

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: Number(process.env.QA_WIDTH ?? 1400), height: 1300 },
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
        lastActivity: '2026-10-09T10:00:00.000Z',
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
await page.route('**/api/chat/split/*/accept', async (route) => {
  const body = route.request().postDataJSON();
  if (body.accepted) accepted.set(body.index, '2026-10-09T13:00:00.000Z');
  else accepted.delete(body.index);
  await route.fulfill({
    json: {
      parentChatId: PARENT,
      index: body.index,
      ...(body.accepted ? { acceptedAt: accepted.get(body.index) } : {}),
    },
  });
});
await page.route('**/api/chats/*/messages*', (route) =>
  route.fulfill({
    json: {
      messages: [
        {
          id: 'm-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Разделил задачи на пять групп.' }],
          timestamp: '2026-10-09T10:02:00.000Z',
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
const cards = hub.locator('[data-hub-row]');
const titles = GROUPS.map((group) => group.title);

/** Имя группы каждой карточки, фон и метка принятой — по порядку на экране. */
const readCards = () =>
  cards.evaluateAll(
    (list, names) =>
      list.map((card) => {
        const text = card.textContent ?? '';
        const name =
          names
            .map((item) => ({ item, at: text.indexOf(item) }))
            .filter((found) => found.at >= 0)
            .sort((a, b) => a.at - b.at)[0]?.item ?? '?';
        return {
          name,
          background: getComputedStyle(card).backgroundColor,
          accepted: card.hasAttribute('data-hub-accepted'),
        };
      }),
    titles,
  );

const expectState = async (label, order, acceptedNames) => {
  const state = await readCards();
  const names = state.map((card) => card.name);
  check(
    JSON.stringify(names) === JSON.stringify(order),
    `${label}: порядок ${names.join(' · ')} (ждали ${order.join(' · ')})`,
  );
  const bg = Object.fromEntries(state.map((card) => [card.name, card.background]));
  const marked = state.filter((card) => card.accepted).map((card) => card.name);
  check(
    JSON.stringify(marked.sort()) === JSON.stringify([...acceptedNames].sort()),
    `${label}: метка принятой у ${marked.join(', ') || 'никого'}`,
  );
  for (const name of acceptedNames) {
    check(
      bg[name] !== bg['Импорт'] && bg[name] !== bg['Доки'] && bg[name] !== bg['Вход'],
      `${label}: фон принятой «${name}» (${bg[name]}) отличен от доставленной (${bg['Импорт']}), влитой (${bg['Доки']}) и идущей (${bg['Вход']})`,
    );
  }
};

await expectState('старт', ORDER_START, ['Схема']);
await shot('01-hub-start');

// Приёмка «Отчётов» — карточка перекрашивается и опускается к принятым.
const reports = cards.filter({ hasText: 'Отчёты' });
await reports.locator('[data-accept-group] button').click();
await page.waitForTimeout(1500);
await expectState('после «Принять»', ORDER_AFTER_ACCEPT, ['Схема', 'Отчёты']);
await shot('02-hub-accepted');

// Снять отметку — карточка возвращается к ждущим приёмки.
await cards.filter({ hasText: 'Отчёты' }).locator('[data-accept-group] button').click();
await page.waitForTimeout(1500);
await expectState('после «Снять отметку»', ORDER_START, ['Схема']);

check(errors.length === 0, errors.length === 0 ? 'ошибок консоли нет' : errors.join(' | '));
await browser.close();
process.exit(bad === 0 ? 0 : 1);
