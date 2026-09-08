/**
 * Кадры для руководства «Чат панели» (.agent/chat-guide, вне git).
 *
 * Данные подменяются целиком — как в проверках `tools/qa/`: ни агентов, ни копий
 * репозитория съёмка не заводит, в кадр не попадают ни личные проекты, ни пути с
 * машины. Поэтому руководство пересобирается на любой машине и выглядит одинаково.
 *
 * Запуск: `node tools/docs/shots-chat-guide.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bypassOnboarding } from '../qa/bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const OUT = process.env.OUT ?? join(process.cwd(), '.agent', 'chat-guide', 'shots');

/** Потолок разговора: без распознанного потолка лестница ступеней не строится. */
const CEILING = { chatModel: 'claude-opus-5', chatEffort: 'high' };

const project = (name, path) => ({
  path,
  name,
  exists: true,
  lastActivity: '2026-09-07T10:00:00.000Z',
  chats: [],
});

const PROJECTS = [
  project('Панель', 'C:/demo/panel'),
  project('Виджет', 'C:/demo/widget'),
  project('Сервер', 'C:/demo/server'),
];

const DEMO = { name: 'Панель', path: 'C:/demo/panel' };

const chat = (id, title, patch = {}) => ({
  id,
  title,
  project: DEMO.name,
  projectPath: DEMO.path,
  isSandbox: false,
  messageCount: 4,
  createdAt: '2026-09-07T09:00:00.000Z',
  updatedAt: '2026-09-07T10:00:00.000Z',
  branch: 'main',
  ...patch,
});

const PARENT_ID = 'demo-parent';
const REVIEW_ID = 'demo-review';
/** Разговор без детей: только в нём у карточки разделения живые кнопки. */
const SOLO_ID = 'demo-solo';

/** Родитель и три звена одной группы: работа, ревью, правки. */
const CHATS = [
  chat(SOLO_ID, 'Пул правок на утро', { updatedAt: '2026-09-07T10:50:00.000Z' }),
  chat(PARENT_ID, 'Разбор пула правок', { updatedAt: '2026-09-07T10:40:00.000Z' }),
  chat('demo-work', 'Переименования по файлам', {
    parentId: PARENT_ID,
    stage: 'work',
    branch: 'split/rename',
    updatedAt: '2026-09-07T10:10:00.000Z',
  }),
  chat(REVIEW_ID, 'Ревью работы «Переименования»', {
    parentId: PARENT_ID,
    stage: 'review',
    branch: 'split/rename',
    updatedAt: '2026-09-07T10:20:00.000Z',
  }),
  chat('demo-fix', 'Правки по замечаниям', {
    parentId: PARENT_ID,
    stage: 'fix',
    branch: 'split/rename',
    updatedAt: '2026-09-07T10:30:00.000Z',
  }),
];

const fence = (kind, json) => ['```agentdeck:' + kind, JSON.stringify(json), '```'].join('\n');

const PROPOSAL = {
  shared: 'Общий контекст: панель на React, правки в apps/web.',
  groups: [
    {
      title: 'Форма входа',
      branch: 'feature/login',
      tasks: ['починить валидацию', 'убрать двойную отправку'],
      kind: 'implementation',
    },
    {
      title: 'Шапка',
      branch: 'feature/header',
      tasks: ['выровнять отступы', 'вернуть фокус после закрытия меню'],
      kind: 'design',
    },
    {
      title: 'Переименования',
      branch: 'split/rename',
      tasks: ['переименовать поля в десяти файлах'],
      kind: 'mechanical',
    },
  ],
};

const FINDINGS = [
  'ChatSplit.ts:88 — ошибка одной группы гасит остальные',
  'нет теста на пустой дифф',
];

const message = (id, text, timestamp) => ({
  id,
  role: 'assistant',
  blocks: [{ type: 'text', text }],
  timestamp,
});

const MESSAGES = {
  [SOLO_ID]: {
    messages: [
      message(
        'm-solo',
        `Задачи независимы, их удобнее вести врозь.\n\n${fence('split', PROPOSAL)}`,
        '2026-09-07T10:50:00.000Z',
      ),
    ],
    total: 1,
    hasMore: false,
  },
  [PARENT_ID]: {
    messages: [
      message(
        'm-split',
        `Задачи независимы, их удобнее вести врозь.\n\n${fence('split', PROPOSAL)}`,
        '2026-09-07T10:05:00.000Z',
      ),
    ],
    total: 1,
    hasMore: false,
  },
  [REVIEW_ID]: {
    messages: [
      message(
        'm-review',
        `Прочитал дифф ветки против задания.\n\n${fence('review', { findings: FINDINGS })}`,
        '2026-09-07T10:20:00.000Z',
      ),
    ],
    total: 1,
    hasMore: false,
  },
};

const EMPTY_MESSAGES = { messages: [], total: 0, hasMore: false };

const loweredRun = (chatId, model, checks, ok = true, kind, tokens = 12_000) => ({
  chatId,
  projectPath: `C:/demo/${chatId}`,
  model,
  effort: 'high',
  startedAt: 1_757_236_800_000,
  finishedAt: 1_757_237_040_000,
  ok,
  checks,
  ...(kind ? { kind } : {}),
  tokens,
});

// Класс есть у групп разделения (его подобрала панель) и нет у ручного веера —
// в кадре должны быть оба случая, иначе строка «без класса» на снимке не видна.
const JOURNAL = {
  runs: [
    loweredRun(
      'panel',
      'claude-sonnet-5',
      ['pnpm type-check', 'pnpm lint'],
      true,
      'mechanical',
      410_000,
    ),
    loweredRun('widget', 'claude-haiku-4-5', [], true, 'tests', 46_000),
    loweredRun('server', 'claude-haiku-4-5', [], false, undefined, 7_000),
  ],
  summary: {
    total: 3,
    withChecks: 1,
    withoutChecks: 1,
    failed: 1,
    tokens: 463_000,
    byKind: [
      { kind: 'mechanical', total: 1, withChecks: 1, withoutChecks: 0, failed: 0, tokens: 410_000 },
      { kind: 'tests', total: 1, withChecks: 0, withoutChecks: 1, failed: 0, tokens: 46_000 },
      { kind: '', total: 1, withChecks: 0, withoutChecks: 0, failed: 1, tokens: 7_000 },
    ],
  },
};

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1400, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
});
await bypassOnboarding(page, CEILING);

const taken = [];
const shot = async (name, target, clip) => {
  const file = join(OUT, `${name}.png`);
  await (target ?? page).screenshot({ path: file, ...(clip ? { clip } : {}) });
  taken.push(name);
  console.log(`снят ${name}`);
};

await page.route('**/api/chats/projects*', (route) => route.fulfill({ json: PROJECTS }));
await page.route('**/api/chats', (route) => route.fulfill({ json: CHATS }));
await page.route('**/api/chats/*/messages*', (route) => {
  const id = new URL(route.request().url()).pathname.split('/').at(-2);
  return route.fulfill({ json: MESSAGES[id] ?? EMPTY_MESSAGES });
});
await page.route('**/api/chat/active', (route) => route.fulfill({ json: [] }));
await page.route('**/api/chat/*/progress*', (route) =>
  route.fulfill({ json: { steps: [], isComplete: false } }),
);
await page.route('**/api/chat/*/artifacts*', (route) => route.fulfill({ json: [] }));
await page.route('**/api/chat/lowered-runs*', (route) => route.fulfill({ json: JOURNAL }));
await page.route('**/api/project-git*', (route) =>
  route.fulfill({
    json: { isRepo: false, detached: false, unborn: false, branches: [], changes: [] },
  }),
);
await page.route('**/api/chat/send', (route) =>
  route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
);

const openChat = async () => {
  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(1500);
};

// --- 01. Экран чата: домашняя вкладка ------------------------------------
await openChat();
await shot('01-chat-home');

// --- 02. Список проектов и кнопка веера ----------------------------------
await page.getByRole('tab', { name: 'Проекты' }).first().click();
await page.waitForTimeout(700);
await shot('02-projects-tab');

// --- 03-05. Окно параллельного запуска -----------------------------------
await page.getByRole('button', { name: 'Запустить в нескольких' }).first().click();
await page.waitForTimeout(700);
const dialog = page.getByRole('dialog', { name: 'Запуск в нескольких проектах' });
await shot('03-fanout-open', dialog);

await dialog.getByRole('textbox', { name: 'Что сделать' }).fill('прогони линт и типы, покажи итог');
const items = dialog.locator('div[class*="list"] button');
for (let i = 0; i < PROJECTS.length; i += 1) await items.nth(i).click();
await page.waitForTimeout(400);
await shot('04-fanout-cost', dialog);

await dialog.getByRole('combobox', { name: 'Модель всех прогонов веера' }).selectOption('sonnet');
await page.waitForTimeout(400);
await shot('05-fanout-lowered', dialog);
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

// --- 06. Меню «Настройки чата»: автоподтверждение и правила прав ---------
await page.getByRole('tab', { name: 'Проекты' }).first().click();
await page.waitForTimeout(600);
await page
  .getByRole('button', { name: new RegExp(DEMO.name) })
  .first()
  .click();
await page.waitForTimeout(1200);
await shot('06-project-tab');

const menuButton = page.locator('button[aria-haspopup="dialog"]').first();
if (await menuButton.count()) {
  await menuButton.click();
  await page.waitForTimeout(700);
  await shot('07-chat-menu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

// --- 08. Дерево чатов со звеньями конвейера ------------------------------
const sidebar = page.locator('aside').first();
await shot('08-chat-tree', (await sidebar.count()) ? sidebar : undefined);

// --- 09. Карточка разделения задач: живые кнопки -------------------------
await page
  .getByRole('button', { name: /Пул правок на утро/ })
  .first()
  .click();
await page.waitForTimeout(1500);
await shot('09-split-card');

// --- 10. Та же карточка после разделения + сводка звеньев ----------------
await page
  .getByRole('button', { name: /Разбор пула правок/ })
  .first()
  .click();
await page.waitForTimeout(1500);
await shot('10-split-done');

// --- 11. Карточка ревью ---------------------------------------------------
await page
  .getByRole('button', { name: /Ревью работы «Переименования»/ })
  .first()
  .click();
await page.waitForTimeout(1500);
// Снимается сама карточка, а не окно целиком: разговор ревью человеку интересен
// одним — составом замечаний, а во всю полосу этот текст нечитаем. Заодно кадр
// перестаёт быть высотой в треть листа и не гонит перед собой пустой хвост.
const reviewCard = page.locator('[class*="card" i]').filter({ hasText: 'Ревью работы' }).first();
await shot('11-review-card', (await reviewCard.count()) ? reviewCard : undefined);

// --- 12. Понижённые прогоны на аналитике ---------------------------------
await page.goto(`${BASE}/analytics`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1800);

/**
 * Блок снимается по своим границам: остальная аналитика в этот момент ещё
 * догружается, и целый экран показал бы вокруг него серые заглушки.
 */
const loweredHeading = page.getByText('Понижённые прогоны веера').first();
await loweredHeading.scrollIntoViewIfNeeded();
await page.waitForTimeout(600);
// Границы берутся у самой карточки, а не числом: с разрезом по классам блок
// вырос, и постоянная высота обрезала бы нижние строки посередине. Классы здесь
// хешированные (CSS-модули), поэтому карточка узнаётся по своему `padding-*` —
// единственному имени, которое переживает пересборку стилей.
const box = await loweredHeading.evaluate((node) => {
  const card = node.closest('[class*="padding-"]') ?? node.parentElement;
  const rect = card.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
});
await shot('12-lowered-runs', undefined, {
  x: box.x,
  y: box.y,
  width: box.width,
  height: box.height,
});

// --- 13. Группы -----------------------------------------------------------
await page.goto(`${BASE}/groups`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1500);
await shot('13-groups');

const create = page.getByRole('button', { name: /Создать группу/ }).first();
if ((await create.count()) && (await create.isEnabled())) {
  await create.click();
  await page.waitForTimeout(900);
  await shot('14-group-form');
  await page.keyboard.press('Escape');
}

await browser.close();
console.log(`\nКадров снято: ${taken.length} → ${OUT}`);
