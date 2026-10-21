/**
 * Хаб родителя: индикатор каждой группы (19.10.2026).
 *
 * Человек спрашивал «на каком этапе группа, работает ли она» и открывал каждый
 * чат. Теперь у карточки группы: состояние и сколько оно длится (работает /
 * ждёт очередь / ждёт разрешения / стоит / закончила), полоса «сделано из
 * скольких» с процентом и вызов, которым группа занята, с его временем.
 *
 * Пять групп — по одной на состояние:
 * 1. «Вход» идёт: файл шагов 8 из 14 → полоса 7 из 14 · 50 %, вызов Bash виден.
 * 2. «Отчёты» идёт, но её тяжёлая команда стоит в очереди: «ждёт очередь · впереди 2».
 * 3. «Схема» стоит на запросе прав (кадр `permission` в потоке прогона).
 * 4. «Импорт» не идёт и не доставлена: «стоит», вызов НЕ показан.
 * 5. «Доки» доставлена: «закончила», полоса 14 из 14 · 100 %.
 *
 * Данные подменяются целиком: ни копий, ни прогонов проверка не заводит.
 *
 * Запуск: `node tools/qa/check-hub-group-progress.mjs` при поднятом фронте
 * (`APP_URL`, по умолчанию http://localhost:8888); `SHOTS=<папка>` и
 * `PHASE=before|after` — снимки, `QA_THEME=dark` — тёмная тема.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PROJECT = { name: 'QA индикатор групп', path: 'C:/qa-hub-progress-project' };
const CEILING = { chatModel: 'claude-opus-5', chatEffort: 'high' };
const PARENT = 'qa-progress-parent';
const now = Date.now();
const ago = (ms) => new Date(now - ms).toISOString();
const MIN = 60_000;

const GROUPS = [
  {
    index: 0,
    title: 'Вход',
    branch: 'feature/login',
    status: 'started',
    run: 'running',
    progress: {
      tasks: [],
      agents: [],
      steps: { current: 8, total: 14, title: 'Прогон тестов' },
      activeTool: { name: 'Bash', summary: 'pnpm test', startedAt: ago(3 * MIN) },
    },
  },
  {
    index: 1,
    title: 'Отчёты',
    branch: 'feature/reports',
    status: 'started',
    run: 'running',
    progress: {
      tasks: [],
      agents: [],
      steps: { current: 3, total: 10, title: 'Сборка' },
      activeTool: { name: 'Bash', summary: 'pnpm build', startedAt: ago(1.5 * MIN) },
      heavyQueue: { since: ago(1.5 * MIN), ahead: 2, command: 'pnpm build' },
    },
  },
  {
    index: 2,
    title: 'Схема',
    branch: 'feature/schema',
    status: 'started',
    run: 'permission',
    progress: {
      tasks: [],
      agents: [],
      steps: { current: 12, total: 14, title: 'Доставка' },
      activeTool: { name: 'Bash', summary: 'git push origin main', startedAt: ago(4 * MIN) },
    },
  },
  {
    index: 3,
    title: 'Импорт',
    branch: 'feature/import',
    status: 'awaiting',
    progress: {
      tasks: [
        { text: 'Разбор', status: 'completed' },
        { text: 'Код', status: 'completed' },
        { text: 'Тесты', status: 'completed' },
        { text: 'Ревью', status: 'in_progress' },
        { text: 'MR', status: 'pending' },
        { text: 'Приёмка', status: 'pending' },
      ],
      agents: [],
      activeTool: { name: 'Bash', summary: 'sleep 600', startedAt: ago(30 * MIN) },
    },
  },
  {
    index: 4,
    title: 'Доки',
    branch: 'feature/docs',
    status: 'done',
    mr: 14,
    progress: { tasks: [], agents: [], steps: { current: 14, total: 14, title: 'Готово' } },
  },
];

const chatIdOf = (group) => `qa-progress-${group.index}`;
const copyOf = (group) => `${PROJECT.path}-worktrees/${group.branch.replace(/\//g, '-')}`;
const mrOf = (id) => `https://gitlab.example.com/proj/app/-/merge_requests/${id}`;

const chat = (id, extra) => ({
  id,
  title: extra.title,
  project: PROJECT.name,
  projectPath: extra.projectPath ?? PROJECT.path,
  isSandbox: false,
  messageCount: 1,
  createdAt: ago(42 * MIN),
  updatedAt: ago(2 * MIN),
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
    ...(group.mr ? { mr: mrOf(group.mr) } : {}),
    ...(group.status === 'done' ? { result: { kind: 'pushed', commits: 1 } } : {}),
    // Отметки «с отметкой» стоящей группы: повторы и вызовы MCP (карточка 28, 20.10).
    ...(group.title === 'Импорт'
      ? {
          autoNotices: [
            ...[1, 2, 3].map(() => notice('mcp__tracker__jira_assign_issue')),
            notice('pnpm build'),
          ],
        }
      : {}),
  })),
});
const notice = (summary) => ({ at: ago(5 * MIN), summary });

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
        lastActivity: ago(2 * MIN),
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
await page.route('**/api/chats/*/messages*', (route) =>
  route.fulfill({
    json: {
      messages: [
        {
          id: 'm-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Разделил задачи на пять групп.' }],
          timestamp: ago(40 * MIN),
        },
      ],
      total: 1,
      hasMore: false,
    },
  }),
);
// Прогресс — свой у каждого чата группы; родителю — пустой.
await page.route('**/api/chat/*/progress*', (route) => {
  const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] ?? '');
  const group = GROUPS.find((item) => chatIdOf(item) === id);
  return route.fulfill({ json: group?.progress ?? { tasks: [], agents: [] } });
});
await page.route('**/api/chat/*/artifacts*', (route) => route.fulfill({ json: [] }));
// Идут три группы; одна из них стоит на запросе прав — его несёт поток прогона.
const live = GROUPS.filter((group) => group.run);
await page.route('**/api/chat/active', (route) =>
  route.fulfill({
    json: live.map((group, i) => ({
      chatId: chatIdOf(group),
      sessionId: chatIdOf(group),
      projectPath: copyOf(group),
      seq: 0,
      startedAt: now - (10 + i) * MIN,
      status: 'running',
    })),
  }),
);
await page.route('**/api/chat/*/stream*', (route) => {
  const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] ?? '');
  const group = GROUPS.find((item) => chatIdOf(item) === id);
  const frame =
    group?.run === 'permission'
      ? `data: ${JSON.stringify({
          kind: 'permission',
          seq: 1,
          toolName: 'Bash',
          input: { command: 'git push origin main' },
          toolUseId: 'qa-perm-1',
        })}\n\n`
      : ': ping\n\n';
  return route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: frame,
  });
});

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
await page.waitForTimeout(3000);

const hub = page.locator('[data-child-hub]');
check((await hub.count()) === 1, 'сводка групп у родителя показана');
await shot('01-hub-progress');

const card = (title) => hub.locator('[data-hub-row]').filter({ hasText: title });
const textIn = async (title) =>
  (
    await card(title)
      .innerText()
      .catch(() => '')
  ).replace(/\s+/g, ' ');
const stateOf = (title) =>
  card(title)
    .locator('[data-group-progress]')
    .first()
    .getAttribute('data-group-progress')
    .catch(() => null);
const barOf = (title) =>
  card(title)
    .locator('[role="progressbar"]')
    .first()
    .getAttribute('aria-valuenow', { timeout: 2000 })
    .catch(() => null);

const expectations = [
  [
    'Вход',
    'working',
    '50',
    // С начала хода (10 мин), а не с заведения чата (42 мин) — карточка 29, 20.10.
    [/работает · 10м \d\dс/, /7 из 14 · 50 %/, /Bash: pnpm test · 3м \d\dс/],
  ],
  ['Отчёты', 'queued', '20', [/ждёт очередь · 1м \d\dс · впереди 2/, /2 из 10 · 20 %/]],
  ['Схема', 'permission', '79', [/ждёт разрешения · 4м \d\dс/, /Bash: git push origin main/]],
  ['Импорт', 'stalled', '50', [/стоит · 2м \d\dс/, /3 из 6 · 50 %/]],
  // Закончившей — «2 мин назад», без тикающих секунд (владелец 20.10).
  ['Доки', 'finished', '100', [/закончила · 2 мин назад/, /14 из 14 · 100 %/]],
];
for (const [title, state, bar, texts] of expectations) {
  const seen = await stateOf(title);
  check(seen === state, `«${title}»: состояние ${seen} (ждали ${state})`);
  const value = await barOf(title);
  check(value === bar, `«${title}»: полоса ${value} % (ждали ${bar})`);
  const text = await textIn(title);
  for (const pattern of texts) {
    check(pattern.test(text), `«${title}»: ${pattern} — «${text.slice(0, 160)}»`);
  }
}
const imports = await textIn('Импорт');
check(!imports.includes('sleep 600'), 'у стоящей группы незакрытый вызов не показан');
check(
  imports.includes('Разрешено автоматически: tracker: jira_assign_issue ×3; pnpm build'),
  `«Импорт»: отметки сведены в «×N» под сервером MCP — «${imports.slice(0, 240)}»`,
);

check(errors.length === 0, errors.length === 0 ? 'ошибок консоли нет' : errors.join(' | '));
await browser.close();
process.exit(bad === 0 ? 0 : 1);
