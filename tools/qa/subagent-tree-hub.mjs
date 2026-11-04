/**
 * Хаб родителя с одной группой для проверок дерева агентов
 * (`check-subagent-tree.mjs`, `check-agent-extensions.mjs`): чат группы засеян
 * настоящим транскриптом (`subagent-tree-fixture.mjs`), подменены только список
 * чатов, дерево разделения и сообщения родителя — их у одноразового стенда нет.
 */
import { TREE_SESSION } from './subagent-tree-fixture.mjs';

export const PROJECT_DIR = 'qa-subagent-tree';
export const GROUP_SESSION = '7e3c1a52-0d4b-4a8e-9b1f-5c2d7a6e9f02';
export const PARENT = 'qa-tree-parent';

export async function stubHub(page, cwd, start) {
  const chat = (id, extra) => ({
    id,
    title: extra.title,
    project: PROJECT_DIR,
    projectPath: cwd,
    isSandbox: false,
    messageCount: 3,
    createdAt: new Date(start).toISOString(),
    updatedAt: new Date(start + 8 * 60_000).toISOString(),
    preview: '',
    ...extra,
  });
  const chats = [
    chat(PARENT, { title: 'Пачка задач отчётов' }),
    chat(GROUP_SESSION, {
      title: 'Отчёты',
      parentId: PARENT,
      stage: 'work',
      groupTitle: 'Отчёты',
      groupIndex: 0,
      branch: 'feature/reports',
    }),
    chat(TREE_SESSION, { title: 'Разбери модуль отчётов' }),
  ];
  await page.route('**/api/chats', (route) => route.fulfill({ json: chats }));
  await page.route('**/api/chat/*/tree', (route) =>
    route.fulfill({
      json: {
        root: PARENT,
        running: 1,
        nodes: [
          {
            chatId: GROUP_SESSION,
            aliases: [],
            parentChatId: PARENT,
            title: 'Отчёты',
            groupIndex: 0,
            running: true,
          },
        ],
      },
    }),
  );
  await page.route(`**/api/chats/${PARENT}/messages*`, (route) =>
    route.fulfill({
      json: {
        messages: [
          {
            id: 'm-1',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Разделил задачи на одну группу.' }],
            timestamp: new Date(start).toISOString(),
          },
        ],
        total: 1,
        hasMore: false,
      },
    }),
  );
}

async function closeGate(page) {
  const gate = page.getByRole('dialog').filter({ hasText: 'нужен доступ' });
  await gate.waitFor({ timeout: 5000 }).catch(() => {});
  if (await gate.count()) await gate.getByRole('button', { name: 'Закрыть' }).last().click();
}

export async function openChat(stand, page, id) {
  await page.goto(`${stand.webUrl}/chat?id=${id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav', { timeout: 90_000 });
  await closeGate(page);
}
