import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatSummary } from '@agentdeck/contracts';
import type { ChatTreeAsk, ChatTreeNode, ChatTreeView } from '@agentdeck/contracts/chat-handoff';
import { agentRuns, type ActiveRunView } from '@shared/lib/agent-runs';
import { i18n } from '@shared/config/i18n';
import { ChildBlocks } from '@features/ChatMessages/ui/ChildBlocks';
import { collectChildQuestions } from './childQuestions';
import { collectChildPermissions } from './childPermissions';
import { collectTreeAsks, withTreeAsks } from './treeAsks';
import { answerChild } from './answerChild';

/**
 * Вопросы и права ОТЦЕПЛЕННЫХ групп в хабе родителя (WP9c; журнал 30, 36, 62,
 * 76b, 97 g7). Путь настоящий: живые вопросы собирает тот же код, что и хаб
 * (`collectChildQuestions` / `collectChildPermissions` по стору прогонов),
 * записанные сервером едут деревом, и оба рисует настоящий `ChildBlocks`.
 *
 * Отцепленная группа — та, чей прогон запустил конвейер, продолжение или
 * перезапуск панели: потока в этой вкладке у неё нет, поэтому живых вопросов у
 * неё НЕТ, и всё, что человек увидит, приходит из дерева.
 */

function chat(over: Partial<ChatSummary> & { id: string }): ChatSummary {
  return {
    title: over.id,
    project: 'probe',
    projectPath: 'C:/work/probe',
    isSandbox: false,
    messageCount: 1,
    createdAt: '2026-09-25T10:00:00.000Z',
    updatedAt: '2026-09-25T10:00:00.000Z',
    parentId: 'parent',
    ...over,
  };
}

function node(over: Partial<ChatTreeNode> & { chatId: string }): ChatTreeNode {
  return { aliases: [], parentChatId: 'parent', running: false, ...over };
}

const tree = (nodes: ChatTreeNode[]): ChatTreeView => ({
  root: 'parent',
  running: 0,
  nodes: [node({ chatId: 'parent', parentChatId: undefined }), ...nodes],
});

const QUESTION = {
  questions: [
    {
      question: 'Какой вариант чинить?',
      header: 'Выбор',
      options: [
        { label: 'Первый', description: 'быстро' },
        { label: 'Второй', description: 'надёжно' },
      ],
      multiSelect: false,
    },
  ],
};

const asks = {
  question: (runId: string, toolUseId: string): ChatTreeAsk => ({
    kind: 'question',
    runId,
    toolUseId,
    input: QUESTION,
    askedAt: '2026-09-25T10:05:00.000Z',
  }),
  permission: (runId: string, toolUseId: string): ChatTreeAsk => ({
    kind: 'permission',
    runId,
    toolUseId,
    toolName: 'Bash',
    input: { command: 'rm -rf build' },
    askedAt: '2026-09-25T10:06:00.000Z',
  }),
  text: (runId: string, text: string): ChatTreeAsk => ({
    kind: 'text',
    runId,
    text,
    askedAt: '2026-09-25T10:07:00.000Z',
  }),
};

/** Хаб так, как его собирает `useChildHub`: живые вопросы плюс записанные сервером. */
function hub(chats: ChatSummary[], runs: ActiveRunView[], view: ChatTreeView | undefined) {
  const live = {
    questions: collectChildQuestions(chats, 'parent', runs),
    permissions: collectChildPermissions(chats, 'parent', runs),
  };
  return withTreeAsks(live, view, 'parent', chats);
}

function render(chats: ChatSummary[], runs: ActiveRunView[], view: ChatTreeView | undefined) {
  const { questions, permissions } = hub(chats, runs, view);
  return renderToStaticMarkup(
    <ChildBlocks
      questions={questions}
      onAnswer={() => {}}
      permissions={permissions}
      onPermissionDecide={() => {}}
    />,
  );
}

const textOf = (html: string): string => html.replace(/<[^>]+>/g, '|');
const count = (html: string, needle: string): number => html.split(needle).length - 1;

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('хаб — вопросы отцепленных групп из записи сервера', () => {
  const chats = [chat({ id: 'g8', title: 'Группа 8' }), chat({ id: 'g9', title: 'Группа 9' })];

  it('журнал 30: вопрос AskUserQuestion группы без потока виден в родителе с подписью', () => {
    const html = render(
      chats,
      [],
      tree([node({ chatId: 'g8', asks: [asks.question('r8', 'tu-1')] })]),
    );

    expect(textOf(html)).toContain('Спрашивает «Группа 8»');
    expect(textOf(html)).toContain('Какой вариант чинить?');
    expect(textOf(html)).toContain('Первый');
  });

  it('журнал 97 g7: вопрос ТЕКСТОМ показан карточкой с полем ответа', () => {
    const html = render(
      chats,
      [],
      tree([node({ chatId: 'g9', asks: [asks.text('r9', 'Чинить или закрыть как не баг?')] })]),
    );

    expect(html).toContain('data-child-text-question');
    expect(textOf(html)).toContain('Чинить или закрыть как не баг?');
    expect(html).toContain('<textarea');
    expect(textOf(html)).toContain('Спрашивает «Группа 9»');
  });

  it('журнал 62: запрос прав отцепленной группы виден, и решение уходит ключом ПРОГОНА', () => {
    const view = tree([
      node({ chatId: 'g8', running: true, asks: [asks.permission('r8', 'tu-p')] }),
    ]);
    const { permissions } = hub(chats, [], view);

    expect(permissions).toEqual([expect.objectContaining({ chatId: 'r8', title: 'Группа 8' })]);
    expect(permissions[0]?.permissions.map((p) => p.toolUseId)).toEqual(['tu-p']);
    expect(textOf(render(chats, [], view))).toContain('Группа 8');
  });

  it('вопрос, который вкладка уже видит потоком, второй раз не рисуется', () => {
    const run = {
      id: 'g8',
      status: 'running',
      tools: [
        { id: 'tu-1', name: 'AskUserQuestion', input: JSON.stringify(QUESTION), status: 'done' },
      ],
    } as unknown as ActiveRunView;
    const view = tree([node({ chatId: 'g8', running: true, asks: [asks.question('g8', 'tu-1')] })]);

    expect(count(render(chats, [run], view), 'Какой вариант чинить?')).toBe(1);
  });

  it('берутся только потомки открытого разговора, отброшенный чат не спрашивает', () => {
    const view = tree([
      node({ chatId: 'g8', asks: [asks.question('r8', 'tu-1')] }),
      node({ chatId: 'x', parentChatId: 'other', asks: [asks.question('rx', 'tu-x')] }),
      node({ chatId: 'old', asks: [asks.question('ro', 'tu-o')] }),
    ]);
    const all = [
      ...chats,
      chat({ id: 'old', retired: true } as Partial<ChatSummary> & { id: string }),
    ];
    const { questions } = collectTreeAsks(view, 'parent', all);

    expect(questions.map((q) => q.toolUseId)).toEqual(['tu-1']);
  });
});

describe('ответ ребёнку по ключу чата из записи сервера', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('занятый ребёнок, известный вкладке под черновым ключом, получает ответ в очередь', () => {
    const enqueue = vi.spyOn(agentRuns, 'enqueue').mockReturnValue('q1');
    const start = vi.spyOn(agentRuns, 'start').mockResolvedValue({ ok: true });
    const run = { id: 'new-1', sessionId: 'g8', status: 'running' } as ActiveRunView;

    answerChild('g8', 'Первый', {
      chats: [chat({ id: 'g8' })],
      runs: [run],
      options: { allowEdits: true, autoApprove: false, model: 'sonnet', effort: 'medium' },
    });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  // W3-5: прогон ребёнка идёт, но вкладка его не ведёт (отцепленная группа) —
  // отправка просит очередь сервера, иначе ответ человека съедал отказ 409.
  it('ребёнок без прогона во вкладке: отправка просит очередь сервера', () => {
    const start = vi.spyOn(agentRuns, 'start').mockResolvedValue({ ok: true });

    answerChild('g8', 'Первый', {
      chats: [chat({ id: 'g8' })],
      runs: [],
      options: { allowEdits: true, autoApprove: false, model: 'sonnet', effort: 'medium' },
    });

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'g8', sessionId: 'g8', queueIfBusy: true }),
    );
  });

  // Тост — по ответу сервера: 202 (очередь сервера) — «в очереди», отказ — не
  // «отправлен», а причина отказа.
  it.each([
    ['ход запущен', { ok: true }, 'sent'],
    ['сервер поставил в очередь', { ok: true, queued: true }, 'queued'],
    ['сервер отказал', { ok: false, message: 'занят' }, 'refused'],
  ] as const)('%s → тост по исходу', async (_name, outcome, expected) => {
    vi.spyOn(agentRuns, 'start').mockResolvedValue(outcome);
    const seen: string[] = [];

    answerChild('g8', 'Первый', {
      chats: [chat({ id: 'g8', title: 'Группа 8' })],
      runs: [],
      options: { allowEdits: true, autoApprove: false, model: 'sonnet', effort: 'medium' },
      notify: (title, queued) => seen.push(`${queued ? 'queued' : 'sent'}:${title}`),
      onRefused: (title, message) => seen.push(`refused:${title}:${message}`),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.startsWith(`${expected}:Группа 8`)).toBe(true);
  });
});
