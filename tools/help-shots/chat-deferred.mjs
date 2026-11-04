/**
 * Сценарий `deferred`: вызовы, которые решает только человек, — список D-n.
 *
 * Один кадр прежнего пути (до ядра новых записей не бывает): плашка «Ждёт
 * решения (N)» над разделом, раскрытая до списка. Раздела D-n в сводке родителя
 * больше нет — кадр 02 снят; карточки прав, ставшей D-n, тоже (кадр 03 снят
 * вместе с её кодом, этап 10).
 *
 * Ответы сервера подменены, экраны — настоящие: та же разметка
 * (`[data-deferred-banner]`). Живой проверки
 * пути больше нет: панель вызовы в D-n не откладывает (этап 10), её скрипт
 * снят в архив вместе с кейсами chat-187/188.
 */
import { PROJECT, chat, sse, settings, projectShell, openProject } from './chat-stubs.mjs';
import { shotLanguage } from './kit.mjs';

const EN = shotLanguage() === 'en';

const PARENT = 'help-deferred-parent';
const A_WORK = 'help-deferred-a-work';
// Ключ как у настоящей сессии — островок группы называет начало ключа чата.
const B_WORK = '7c1e4b2a-93d0-4f6e-8a15-2b9d0e6f4c31';

const A = {
  title: EN ? 'Orders export' : 'Выгрузка заказов',
  branch: 'feature/orders-export',
};
const B = {
  title: EN ? 'List filters' : 'Фильтры списка',
  branch: 'feature/orders-filters',
};
const PARENT_TITLE = EN ? 'Task breakdown' : 'Разбор задач';

/**
 * Даты разговоров — от часов съёмки: сводка групп над разделом считает «с начала …»
 * до настоящего времени браузера, и с неподвижной датой край кадра читался
 * «с начала 10384ч».
 */
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

const link = (id, group, stage) =>
  chat(id, `${group.title} · ${stage}`, {
    createdAt: ago(40),
    updatedAt: ago(2),
    parentId: PARENT,
    branch: group.branch,
    groupTitle: group.title,
    stage,
    projectPath: `${PROJECT.path}-worktrees/${group.branch.replace(/\//g, '-')}`,
  });

const CHATS = [
  chat(PARENT, PARENT_TITLE, { createdAt: ago(45), updatedAt: ago(42) }),
  link(A_WORK, A, 'work'),
  link(B_WORK, B, 'work'),
];

const PARENT_MESSAGES = {
  messages: [
    {
      id: 'p1',
      role: 'user',
      blocks: [
        {
          type: 'text',
          text: EN
            ? 'Two jobs on the orders page: CSV export and list filters.'
            : 'Два дела по странице заказов: выгрузка в CSV и фильтры списка.',
        },
      ],
      timestamp: '2026-10-23T08:00:00.000Z',
    },
    {
      id: 'p2',
      role: 'assistant',
      blocks: [{ type: 'text', text: EN ? 'Split into two groups.' : 'Разделил на две группы.' }],
      timestamp: '2026-10-23T08:02:00.000Z',
    },
  ],
  total: 2,
  hasMore: false,
};

/** Запись D-n так, как её отдаёт `GET /api/chat/deferred`. */
const ask = (id, extra) => ({
  id,
  state: 'waiting',
  kind: 'permission',
  toolName: 'Bash',
  reason: 'group permission rows',
  reasonCode: 'group-rows',
  askedAt: '2026-10-23T08:40:00.000Z',
  expiresAt: '2026-10-30T08:40:00.000Z',
  ...extra,
});

const DEFERRED = {
  generatedAt: '2026-10-23T09:00:00.000Z',
  items: [
    ask('D-3', {
      scope: { kind: 'group', parentChatId: PARENT, groupIndex: 0 },
      summary: 'git branch -D feature/orders-export-old',
      retries: 1,
      chatId: A_WORK,
      source: { project: PROJECT.name, group: 1, groupTitle: A.title, stage: 'work' },
    }),
    ask('D-4', {
      scope: { kind: 'group', parentChatId: PARENT, groupIndex: 1 },
      summary: 'npm publish --access public',
      askedAt: '2026-10-23T08:52:00.000Z',
      expiresAt: '2026-10-30T08:52:00.000Z',
      chatId: B_WORK,
      source: { project: PROJECT.name, group: 2, groupTitle: B.title, stage: 'work' },
    }),
    ask('D-5', {
      scope: { kind: 'chat', chatKeys: ['help-deferred-solo'] },
      summary: 'docker compose down -v',
      reason: 'not covered by auto-approve rules',
      reasonCode: 'not-auto-approved',
      askedAt: '2026-10-23T08:55:00.000Z',
      expiresAt: '2026-10-30T08:55:00.000Z',
      chatId: 'help-deferred-solo',
      source: {
        project: PROJECT.name,
        chatTitle: EN ? 'Returns report' : 'Отчёт по возвратам',
      },
    }),
  ],
};

export async function shootDeferred(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // Знакомство с маскотом уже было: приветствие ложилось поверх раздела хаба.
  await page.addInitScript(() =>
    window.localStorage.setItem(
      'agentdeck.mascot',
      JSON.stringify({ enabled: false, chatty: false, greeted: true }),
    ),
  );
  try {
    await settings(page);
    await projectShell(page);
    await page.route('**/api/chats', (route) => route.fulfill({ json: CHATS }));
    await page.route('**/api/chats/*/messages*', (route) =>
      route.fulfill({ json: { messages: [], total: 0, hasMore: false } }),
    );
    await page.route(`**/api/chats/${PARENT}/messages*`, (route) =>
      route.fulfill({ json: PARENT_MESSAGES }),
    );
    await page.route('**/api/chat/active', (route) =>
      route.fulfill({
        json: [
          { chatId: A_WORK, seq: 0 },
          { chatId: B_WORK, seq: 0 },
        ],
      }),
    );
    await page.route('**/api/chat/deferred', (route) => route.fulfill({ json: DEFERRED }));
    await page.route('**/api/chat/*/tree', (route) =>
      route.fulfill({
        json: {
          root: PARENT,
          running: 2,
          split: {
            parentChatId: PARENT,
            order: [0, 1],
            triage: { at: '2026-10-23T08:02:40.000Z', received: true, repairs: [], conflicts: [] },
            groups: [
              {
                index: 0,
                title: A.title,
                branch: A.branch,
                after: [],
                status: 'started',
                chatId: A_WORK,
              },
              {
                index: 1,
                title: B.title,
                branch: B.branch,
                after: [],
                status: 'started',
                chatId: B_WORK,
              },
            ],
          },
          nodes: [A_WORK, B_WORK].map((id) => ({
            chatId: id,
            aliases: [],
            parentChatId: PARENT,
            title: (CHATS.find((item) => item.id === id) ?? { title: id }).title,
            running: true,
          })),
        },
      }),
    );
    await page.route('**/api/chat/send', (route) => route.fulfill(sse('')));

    await openProject(page, web);

    // ── 01. Плашка над разделом, раскрытая до списка ─────────────────────────
    const banner = page.locator('[data-deferred-banner]');
    await banner.waitFor({ timeout: 20_000 });
    await banner.getByRole('button', { expanded: false }).first().click();
    await banner.locator('[data-deferred-id="D-5"]').waitFor({ timeout: 10_000 });
    await page.mouse.move(5, 5);
    await page.waitForTimeout(600);
    await scenario.shot(page, '01-banner', { clip: '[data-deferred-banner]', padding: 12 });

    console.log(`  проект ${PROJECT.name}: 1 кадр`);
  } finally {
    await page.close();
  }
}
