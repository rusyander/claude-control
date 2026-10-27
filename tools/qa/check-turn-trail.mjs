/**
 * След хода под ответом в ленте чата (25.10.2026).
 *
 * 1. Под последним ответом хода — одна свёрнутая строка: «1 скилл · 2 агента ·
 *    2 скрипта · хуки 27, из них 2 добавили контекст · 1,4 с». Слова человека
 *    посреди хода (`midTurn`) и уведомление о фоновой задаче ход не делят:
 *    строка одна, под последним ответом.
 * 2. Ход без скиллов, агентов, скриптов и хуков строки не получает; простые
 *    команды (git, ls) скриптами не считаются.
 * 3. Развёрнутая строка — разделы «Скиллы», «Агенты», «Скрипты», «Хуки»;
 *    хуки по имени CLI со счётом ×N и временем, сбой — «✗ код 2»; «добавили
 *    контекст» раскрывает начало добавленного текста.
 * 4. Клавиатура: строка достижима фокусом и раскрывается Enter, закрывается
 *    повторным Enter.
 *
 * Данные подменяются целиком, ВСЕ запросы `/api` — тоже: живой сервер прогон не
 * трогает. Серверная половина (хуки из транскрипта на шагах хода) доказана
 * `apps/server/src/domains/chat/hook-trace/hook-trace.test.ts`.
 *
 * Запуск: `APP_URL=http://127.0.0.1:<порт> node tools/qa/check-turn-trail.mjs`
 * (фронт этой копии, API за ним не нужен); `SHOTS=<папка>` — снимки.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const PROJECT = { name: 'QA след хода', path: 'C:/qa-trail-project' };
const CHAT = 'qa-turn-trail';

const at = (second) => `2026-10-25T10:00:${String(second).padStart(2, '0')}.000Z`;
const tool = (name, input) => ({ type: 'tool', name, input: JSON.stringify(input) });
const hook = (hookName, fields = {}) => ({ event: hookName.split(':')[0], hookName, ...fields });

const MESSAGES = [
  { id: 'u1', role: 'user', blocks: [{ type: 'text', text: 'Проверь ветку' }], timestamp: at(0) },
  {
    id: 'a1',
    role: 'assistant',
    timestamp: at(2),
    blocks: [tool('Skill', { skill: 'deep-review' })],
    hooks: [
      hook('UserPromptSubmit', { context: 'Самопроверка: паттерн проекта\nвторая строка' }),
      hook('UserPromptSubmit', { name: 'review-trigger', context: 'Триггер ревью' }),
    ],
  },
  {
    id: 'a2',
    role: 'assistant',
    timestamp: at(4),
    blocks: [
      tool('Agent', {
        subagent_type: 'Explore',
        description: 'Telegram code map',
        model: 'sonnet',
      }),
      tool('Bash', {
        command: 'node scripts/check_docs_gate.mjs',
        description: 'Гейт документации',
      }),
    ],
    hooks: Array.from({ length: 24 }, () =>
      hook('PostToolUse:Bash', { name: 'inject-project-rules', durationMs: 45 }),
    ),
  },
  {
    id: 'q1',
    role: 'user',
    midTurn: true,
    blocks: [{ type: 'text', text: 'И тесты прогони' }],
    timestamp: at(5),
  },
  {
    id: 'a3',
    role: 'assistant',
    timestamp: at(7),
    blocks: [
      tool('Agent', { subagent_type: 'general-purpose' }),
      tool('Bash', { command: 'pnpm test' }),
    ],
  },
  {
    id: 'n1',
    role: 'user',
    blocks: [
      {
        type: 'text',
        text: '<task-notification><status>completed</status><summary>Background command "pnpm test" completed (exit code 0)</summary></task-notification>',
      },
    ],
    timestamp: at(8),
  },
  {
    id: 'a4',
    role: 'assistant',
    timestamp: at(9),
    blocks: [{ type: 'text', text: 'Ветка проверена, замечаний два.' }],
    hooks: [hook('Stop', { name: 'tests-hook', durationMs: 300, exitCode: 2 })],
  },
  { id: 'u2', role: 'user', blocks: [{ type: 'text', text: 'Что в git?' }], timestamp: at(20) },
  {
    id: 'a5',
    role: 'assistant',
    timestamp: at(22),
    blocks: [tool('Bash', { command: 'git status' }), { type: 'text', text: 'Чисто.' }],
  },
];

const SETTINGS = { onboardingDone: true, chatModel: 'claude-opus-5', language: 'ru' };
const CHATS = [
  {
    id: CHAT,
    title: 'Проверка ветки',
    project: PROJECT.name,
    projectPath: PROJECT.path,
    isSandbox: false,
    messageCount: MESSAGES.length,
    createdAt: at(0),
    updatedAt: at(22),
    preview: '',
  },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 1400 } });
page.setDefaultTimeout(5000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  const text = message.text();
  // Запросы мимо подмен отвечают 404 нарочно — живого сервера за ними нет.
  if (/404 \(Not Found\)|Failed to load resource/.test(text)) return;
  errors.push(text.slice(0, 200));
});

// Подмена всего API первым маршрутом: Playwright отдаёт запрос ПОСЛЕДНЕМУ
// подходящему обработчику, так что точные подмены ниже её перекрывают.
await page.route(
  (url) => url.pathname.startsWith('/api/'),
  (route) => route.fulfill({ status: 404, json: { error: 'qa stub' } }),
);
await page.route('**/api/settings', (route) => route.fulfill({ json: SETTINGS }));
await page.route('**/api/location', (route) =>
  route.fulfill({ json: { path: 'C:/qa-home/.claude', isValid: true, source: 'default' } }),
);
await page.route('**/api/project-git*', (route) =>
  route.fulfill({
    json: { isRepo: false, detached: false, unborn: false, branches: [], changes: [] },
  }),
);
await page.route('**/api/chats/projects*', (route) =>
  route.fulfill({
    json: [
      { path: PROJECT.path, name: PROJECT.name, exists: true, lastActivity: at(22), chats: [] },
    ],
  }),
);
await page.route('**/api/chats', (route) => route.fulfill({ json: CHATS }));
await page.route('**/api/chats/*/messages*', (route) =>
  route.fulfill({ json: { messages: MESSAGES, total: MESSAGES.length, hasMore: false } }),
);
await page.route('**/api/chat/*/progress*', (route) =>
  route.fulfill({ json: { steps: [], isComplete: false } }),
);
await page.route('**/api/chat/*/artifacts*', (route) => route.fulfill({ json: [] }));
await page.route('**/api/chat/active', (route) => route.fulfill({ json: [] }));

let bad = 0;
const check = (ok, text, detail = '') => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}${detail ? ` — ${detail}` : ''}`);
  if (!ok) bad += 1;
};
const shot = async (name, locator) => {
  if (!SHOTS) return;
  await (locator ?? page)
    .screenshot({ path: join(SHOTS, `${name}.png`) })
    .catch(() => page.screenshot({ path: join(SHOTS, `${name}.png`) }));
};
const isOpen = (locator) => locator.evaluate((node) => node.open);

try {
  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(1200);
  await page.getByRole('tab', { name: 'Проекты' }).click({ timeout: 15_000 });
  await page.waitForTimeout(800);
  await page
    .getByRole('button', { name: new RegExp(PROJECT.name) })
    .first()
    .click();
  await page.waitForTimeout(1200);
  await page
    .getByRole('button', { name: /Проверка ветки/ })
    .first()
    .click();
  await page.locator('[data-feed-message="a4"]').waitFor({ timeout: 20_000 });

  // 1–2. Одна строка на ход, под последним ответом.
  const trails = page.locator('[data-turn-trail]');
  check((await trails.count()) === 1, 'одна строка следа на ленту', `${await trails.count()}`);
  const trail = page.locator('[data-feed-message="a4"] [data-turn-trail]');
  check((await trail.count()) === 1, 'строка стоит под последним ответом хода');
  check(
    (await page.locator('[data-feed-message="a5"] [data-turn-trail]').count()) === 0,
    'ход с одним git status строки не получил',
  );
  const summary = trail.locator('summary').first();
  const line = ((await summary.textContent()) ?? '').trim();
  check(
    line === '1 скилл · 2 агента · 2 скрипта · хуки 27, из них 2 добавили контекст · 1,4 с',
    'текст свёрнутой строки',
    `«${line}»`,
  );
  check(!(await isOpen(trail)), 'строка свёрнута по умолчанию');
  await shot('01-collapsed', page.locator('[data-feed-message="a4"]'));

  // 4. Клавиатура: фокус и Enter.
  await summary.focus();
  check(
    await summary.evaluate((node) => node === document.activeElement),
    'строка принимает фокус',
  );
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check(await isOpen(trail), 'Enter раскрывает строку');

  // 3. Разделы и строки.
  const text = (await trail.innerText()).replace(/\s+/g, ' ');
  for (const part of [
    'Скиллы',
    'deep-review',
    'Агенты',
    'Explore · «Telegram code map» · sonnet',
    'general-purpose',
    'Скрипты',
    'node scripts/check_docs_gate.mjs',
    'Гейт документации',
    'pnpm test',
    'Хуки',
    'inject-project-rules ×24',
    '1,1 с',
  ]) {
    check(text.includes(part), `в развёрнутой строке есть «${part}»`);
  }
  check(!text.includes('git status'), 'простая команда в скрипты не попала');
  const stop = trail.locator('[data-trail-hook="Stop"] [data-trail-failure]');
  check(
    ((await stop.textContent().catch(() => '')) ?? '').includes('✗ код 2'),
    'сбой хука Stop отмечен «✗ код 2»',
  );
  const context = trail.locator('[data-trail-hook="UserPromptSubmit"] details');
  check(!(await isOpen(context)), 'добавленный контекст свёрнут');
  await context.locator('summary').click();
  check(
    (await isOpen(context)) &&
      ((await context.innerText()) ?? '').includes('Самопроверка: паттерн проекта'),
    '«добавили контекст» раскрывает начало текста',
  );
  await shot('02-expanded', page.locator('[data-feed-message="a4"]'));

  await summary.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check(!(await isOpen(trail)), 'повторный Enter сворачивает строку');

  check(errors.length === 0, 'страница без ошибок', errors.join(' | '));
} finally {
  await browser.close();
}
console.log(bad === 0 ? '\nВсё сходится.' : `\nПЛОХО: ${bad}.`);
process.exit(bad === 0 ? 0 : 1);
