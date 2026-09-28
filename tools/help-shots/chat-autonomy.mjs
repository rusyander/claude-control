/**
 * Сценарий `autonomy`: группа и автономность ЧАТА и то, что человек видит,
 * когда автономия отвечает за него.
 *
 * Три кадра одного дерева: меню ребёнка разделения (группа и галочка «из
 * родителя»), строка «Автовыбор: …» на месте вопроса и карточка критичного
 * в главном чате. Отдельный сценарий, потому что вход свой: человек, который
 * не включает автономию, сюда не заходит, а у `split` своих кадров достаточно.
 *
 * Ответы сервера подменены, экраны — настоящие: кадр доказывает ту разметку,
 * которую проверяет `tools/qa/check-chat-group-settings.mjs`.
 */
import {
  PROJECT,
  chat,
  settings,
  projectShell,
  openProject,
  openChat,
  closeOverlay,
} from './chat-stubs.mjs';

const ROOT = 'help-autonomy-root';
const KID = 'help-autonomy-kid';

const QUESTION = {
  questions: [
    {
      question: 'Как переносить заказы в новую таблицу?',
      header: 'Перенос',
      multiSelect: false,
      options: [
        { label: 'Одним скриптом', description: 'Быстро, но таблица закрыта на время переноса.' },
        { label: 'Партиями (Recommended)', description: 'Без простоя.' },
      ],
    },
  ],
};

const MESSAGES = {
  [ROOT]: [
    { id: 'r1', role: 'user', blocks: [{ type: 'text', text: 'Разбей работу по заказам' }] },
    { id: 'r2', role: 'assistant', blocks: [{ type: 'text', text: 'Разделил на группы.' }] },
  ],
  [KID]: [
    { id: 'k1', role: 'user', blocks: [{ type: 'text', text: 'Перенеси заказы в новую таблицу' }] },
    {
      id: 'k2',
      role: 'assistant',
      blocks: [
        {
          type: 'tool',
          name: 'AskUserQuestion',
          input: JSON.stringify(QUESTION),
          autoPicks: [
            { question: 'Как переносить заказы в новую таблицу?', label: 'Партиями (Recommended)' },
          ],
        },
        {
          type: 'text',
          text: [
            'Переношу партиями по 5 000 строк.',
            '```agentdeck:escalate',
            '{"severity":"critical","text":"Старая таблица orders_v1 удаляется миграцией — выгрузки из неё перестанут работать"}',
            '```',
          ].join('\n'),
        },
      ],
    },
  ],
};

const GROUPS = [
  {
    id: 'g1',
    name: 'Миграции БД',
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [],
    env: {},
    projectPaths: [],
    isEnabled: true,
    order: 0,
  },
];

const SETTINGS = {
  [ROOT]: {
    groupChoice: 'global:g1',
    groupChoiceInherited: false,
    autonomous: true,
    autonomousInherited: false,
  },
  [KID]: {
    groupChoice: 'global:g1',
    groupChoiceInherited: true,
    autonomous: true,
    autonomousInherited: true,
    parentChatId: ROOT,
  },
};

const ESCALATIONS = {
  chats: {
    [ROOT]: [
      {
        id: `${KID}:e1`,
        childChatId: KID,
        childTitle: 'Перенос заказов',
        text: 'Старая таблица orders_v1 удаляется миграцией — выгрузки из неё перестанут работать',
        source: 'block',
        at: '2026-09-10T11:50:00.000Z',
        read: false,
      },
    ],
  },
};

const idOf = (url) => decodeURIComponent(new URL(url).pathname.split('/')[3] ?? '');

export async function shootAutonomy(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await settings(page);
    await projectShell(page);
    await page.route('**/api/chats', (route) =>
      route.fulfill({
        json: [chat(ROOT, 'Работа по заказам'), chat(KID, 'Перенос заказов', { parentId: ROOT })],
      }),
    );
    await page.route('**/api/chats/*/messages*', (route) => {
      const messages = (MESSAGES[idOf(route.request().url())] ?? []).map((m, index) => ({
        timestamp: `2026-09-10T11:0${index}:00.000Z`,
        ...m,
      }));
      return route.fulfill({ json: { messages, total: messages.length, hasMore: false } });
    });
    await page.route('**/api/chat/active', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/groups', (route) => route.fulfill({ json: GROUPS }));
    await page.route('**/api/chat/escalations', (route) => route.fulfill({ json: ESCALATIONS }));
    await page.route('**/api/chat/*/group-settings*', (route) =>
      route.fulfill({ json: SETTINGS[idOf(route.request().url())] ?? SETTINGS[ROOT] }),
    );

    await openProject(page, web);

    await openChat(page, 'Работа по заказам');
    await page.waitForSelector('[data-escalation-notice]');
    await scenario.shot(page, '01-escalation', { clip: '[data-escalation-notice]', padding: 24 });

    await openChat(page, 'Перенос заказов');
    await page.waitForSelector('[data-auto-pick]');
    await scenario.shot(page, '02-auto-pick', { clip: '[data-auto-pick]', padding: 120 });

    await page
      .getByRole('button', { name: /^(Настройки чата|Chat settings)$/ })
      .first()
      .click();
    await page.waitForTimeout(1200);
    await scenario.shot(page, '03-menu', { clip: '[role="dialog"]', padding: 8 });
    await closeOverlay(page);
    console.log(`  проект ${PROJECT.name}: 3 кадра`);
  } finally {
    await page.close();
  }
}
