import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSummary } from '@agentdeck/contracts';
import { CORE_PERMIT_TOOL } from '@agentdeck/contracts/chat-handoff';
import type { ChatTreeNode, ChatTreeView } from '@agentdeck/contracts/chat-handoff';
import type { CommandDraft } from '@entities/CoreTask';

/**
 * Вопрос права задачи ядра у РЕБЁНКА в хабе родителя (этап 10, G5). Сервер пишет запрос прав
 * дерева вместе с полями ядра; хаб собирает их тем же `collectTreeAsks`, и решение по такой
 * карточке уходит командами ядра из окна (грант, затем ответ), а не маршрутом прогона ребёнка —
 * тот ответил бы отказом `core_permit_browser_only`. Подменена только отправка ядру (граница сети).
 */

const sent: CommandDraft[] = [];
vi.mock('@entities/CoreTask', async (importOriginal) => {
  const real = await importOriginal<typeof import('@entities/CoreTask')>();
  return {
    ...real,
    sendCoreCommand: async (draft: CommandDraft) => {
      sent.push(draft);
      return { cmdId: 'c', status: 'applied', seq: sent.length };
    },
  };
});
vi.mock('@shared/lib/toast', () => ({ toast: { error: vi.fn() } }));

const { collectTreeAsks } = await import('./treeAsks');
const { coreCardOf, decideCorePermit } = await import('./corePermit');

const CORE = {
  taskId: 't-child',
  askId: 'ask-child',
  point: 5,
  options: ['grant', 'refuse'],
  project: 'repo-abc',
  globs: ['guarded/a1.txt'],
};

function chat(id: string): ChatSummary {
  return {
    id,
    title: id,
    project: 'probe',
    projectPath: 'C:/work/probe',
    isSandbox: false,
    messageCount: 1,
    createdAt: '2026-11-02T10:00:00.000Z',
    updatedAt: '2026-11-02T10:00:00.000Z',
    parentId: 'parent',
  };
}

const node = (over: Partial<ChatTreeNode> & { chatId: string }): ChatTreeNode => ({
  aliases: [],
  parentChatId: 'parent',
  running: true,
  ...over,
});

const tree: ChatTreeView = {
  root: 'parent',
  running: 1,
  nodes: [
    node({ chatId: 'parent', parentChatId: undefined }),
    node({
      chatId: 'child-1',
      asks: [
        {
          kind: 'permission',
          runId: 'child-1',
          toolUseId: 'ask-child',
          toolName: CORE_PERMIT_TOOL,
          input: { question: 'The step needs a grant to edit guarded/a1.txt (Write)' },
          askedAt: '2026-11-02T10:01:00.000Z',
          core: CORE,
        },
        {
          kind: 'permission',
          runId: 'child-1',
          toolUseId: 'tu-bash',
          toolName: 'Bash',
          input: { command: 'ls' },
          askedAt: '2026-11-02T10:01:01.000Z',
        },
      ],
    }),
  ],
};

beforeEach(() => {
  sent.length = 0;
});

describe('вопрос права ядра у ребёнка в хабе — командой ядра из окна', () => {
  it('поля ядра доезжают из дерева сервера до карточки ребёнка', () => {
    const { permissions } = collectTreeAsks(tree, 'parent', [chat('child-1')]);
    const all = permissions.flatMap((c) => c.permissions);
    expect(coreCardOf(all, 'ask-child')).toEqual(CORE);
    // Карточка CLI ребёнка ядра не несёт — её решает маршрут прогона, как прежде.
    expect(coreCardOf(all, 'tu-bash')).toBeUndefined();
  });

  it('«Разрешить» на карточке ребёнка — грант, затем ответ grant ядру', async () => {
    const { permissions } = collectTreeAsks(tree, 'parent', [chat('child-1')]);
    const card = coreCardOf(
      permissions.flatMap((c) => c.permissions),
      'ask-child',
    );
    expect(card).toBeDefined();
    expect(await decideCorePermit(card!, 'allow')).toBe(true);
    expect(sent.map((d) => d.kind)).toEqual(['grant', 'answer']);
    expect(sent[1]).toMatchObject({
      taskId: 't-child',
      fields: { askId: 'ask-child', answer: 'grant' },
    });
  });
});
