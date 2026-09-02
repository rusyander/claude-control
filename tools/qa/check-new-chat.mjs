/**
 * «Новый чат» внутри проекта обязан открыть ЧИСТЫЙ черновик.
 *
 * Поломка, из-за которой прогон появился (2 сентября): кнопка срабатывала —
 * заголовок менялся, выделение в списке снималось, адрес сбрасывался, — но лента
 * прежнего разговора оставалась на экране. Человек видел старую переписку и
 * считал, что новый чат не завёлся.
 *
 * Причина жила в `useChatMessages`: `placeholderData: keepPreviousData` держит
 * прошлое окно, пока растёт `limit` («загрузить ещё»), и продолжал держать его,
 * когда разговор сменялся на черновик и `chatId` пустел. Стоит вернуть
 * безусловный `keepPreviousData` — прогон снова покраснеет.
 *
 * Данные подменяются целиком: ни настоящих чатов, ни запущенных агентов прогон
 * не трогает и не зависит ни от какой истории.
 *
 * Запуск: `node tools/qa/check-new-chat.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const PROJECT = { name: 'QA черновик', path: 'C:/qa-draft-project' };
const CHAT = 'qa-draft-chat';
const MARKER = 'Строка прежнего разговора';

// Домашняя вкладка показывает ТОЛЬКО разговоры песочницы (`visibleChats`),
// поэтому для неё нужен свой чат — иначе проверять там было бы нечего.
const SANDBOX = 'qa-draft-sandbox';

const CHATS = [
  {
    id: SANDBOX,
    title: 'Разговор песочницы',
    project: 'Песочница',
    projectPath: PROJECT.path,
    isSandbox: true,
    messageCount: 1,
    createdAt: '2026-09-02T09:00:00.000Z',
    updatedAt: '2026-09-02T09:05:00.000Z',
    preview: 'песочница',
  },
  {
    id: CHAT,
    title: 'Прежний разговор',
    project: PROJECT.name,
    projectPath: PROJECT.path,
    isSandbox: false,
    messageCount: 2,
    createdAt: '2026-09-02T10:00:00.000Z',
    updatedAt: '2026-09-02T10:05:00.000Z',
    preview: MARKER,
  },
];

const MESSAGES = {
  messages: [
    {
      id: 'm-1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Ответ прежнего разговора' }],
      timestamp: '2026-09-02T10:01:00.000Z',
    },
  ],
  total: 1,
  hasMore: false,
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await bypassOnboarding(page);

const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text().slice(0, 200));
});

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
        chats: CHATS,
      },
    ],
  }),
);
await page.route('**/api/chats', (route) => route.fulfill({ json: CHATS }));
await page.route(`**/api/chats/${CHAT}/messages*`, (route) => route.fulfill({ json: MESSAGES }));
await page.route(`**/api/chats/${SANDBOX}/messages*`, (route) =>
  route.fulfill({
    json: {
      messages: [
        {
          id: 's-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Ответ разговора песочницы' }],
          timestamp: '2026-09-02T09:01:00.000Z',
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

await page.goto(process.env.APP_URL ?? 'http://localhost:8888/chat');
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

// Открываем прежний разговор — именно из него человек жмёт «Новый чат».
await page
  .getByRole('button', { name: /Прежний разговор/ })
  .first()
  .click();
await page.waitForTimeout(1500);

const thread = page.getByText('Ответ прежнего разговора');
check(await thread.isVisible().catch(() => false), 'прежний разговор открыт и виден');

await page.getByRole('button', { name: 'Новый чат', exact: true }).click();
await page.waitForTimeout(1500);

check(!(await thread.isVisible().catch(() => false)), 'лента прежнего разговора ушла с экрана');
check(
  await page
    .getByText('Новый разговор в каталоге проекта')
    .isVisible()
    .catch(() => false),
  'показана заставка чистого черновика проекта',
);

// Домашняя вкладка идёт тем же местом кода (разговор сбрасывается в пустой id),
// поэтому проверяем и её — иначе починка «проверена» только с одной стороны.
await page.getByRole('tab', { name: 'Чаты' }).first().click();
await page.waitForTimeout(1000);
// Боковая колонка помнит выбранный сегмент, а выше мы уходили в «Проекты».
await page
  .getByRole('tablist', { name: 'Чаты или проекты' })
  .getByRole('tab', { name: 'Чат', exact: true })
  .click();
await page.waitForTimeout(800);
await page
  .getByRole('button', { name: /Разговор песочницы/ })
  .first()
  .click();
await page.waitForTimeout(1500);
const sandboxThread = page.getByText('Ответ разговора песочницы');
check(await sandboxThread.isVisible().catch(() => false), 'на домашней вкладке разговор открыт');

await page.getByRole('button', { name: 'Новый чат', exact: true }).click();
await page.waitForTimeout(1500);
check(
  !(await sandboxThread.isVisible().catch(() => false)),
  'на домашней вкладке лента прежнего разговора тоже ушла',
);

check(errors.length === 0, errors.length === 0 ? 'ошибок консоли нет' : errors.join(' | '));

await browser.close();
console.log(bad === 0 ? 'Новый чат в проекте открывается чистым' : `Проблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
