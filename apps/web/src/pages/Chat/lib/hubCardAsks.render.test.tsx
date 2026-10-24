import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatSummary } from '@agentdeck/contracts';
import type { ChatTreeAsk, ChatTreeNode, ChatTreeView } from '@agentdeck/contracts/chat-handoff';
import type { ActiveRunView } from '@shared/lib/agent-runs';
import { i18n } from '@shared/config/i18n';
import { ChildBlocks } from '@features/ChatMessages';
import { collectChildQuestions } from './childQuestions';
import { collectChildPermissions } from './childPermissions';
import { collectChildStages } from './childStages';
import { withTreeAsks } from './withTreeAsks';

/**
 * Запрос прав и вопрос группы — в карточке ЭТОЙ группы (замечание владельца
 * 23.10). Путь настоящий: строки хаба собирает `collectChildStages`, живые
 * запросы — `collectChildQuestions` / `collectChildPermissions` по прогонам,
 * записанные сервером — дерево (`withTreeAsks`), рисует настоящий `ChildBlocks`.
 *
 * Было: запрос прав любой группы висел плашкой над хабом («Просит «…»»), а
 * живой вопрос группы, чей прогон ещё под временным `new-…`, — там же: ключ
 * прогона с ключом карточки (последнее звено в списке) не совпадал.
 */

function chat(over: Partial<ChatSummary> & { id: string }): ChatSummary {
  return {
    title: over.id,
    project: 'probe',
    projectPath: 'C:/work/probe',
    isSandbox: false,
    messageCount: 1,
    createdAt: '2026-10-23T10:00:00.000Z',
    updatedAt: '2026-10-23T10:00:00.000Z',
    parentId: 'parent',
    ...over,
  };
}

const QUESTION = JSON.stringify({
  questions: [
    {
      question: 'Какую таблицу оставить?',
      header: 'Таблица',
      multiSelect: false,
      options: [
        { label: 'Старую', description: 'без миграции' },
        { label: 'Новую', description: 'с миграцией' },
      ],
    },
  ],
});

/** Две группы: «Вход» (работа → ревью) и «Отчёты» (работа); у родителя ещё ручной внук. */
const chats: ChatSummary[] = [
  chat({ id: 'parent', parentId: undefined, title: 'Пачка задач' }),
  chat({
    id: 'login-work',
    title: 'Поправь валидацию формы входа',
    groupTitle: 'Вход',
    groupIndex: 0,
    stage: 'work',
  }),
  chat({
    id: 'login-review',
    title: 'Вход',
    groupTitle: 'Вход',
    groupIndex: 0,
    stage: 'review',
    createdAt: '2026-10-23T11:00:00.000Z',
  }),
  chat({ id: 'reports', title: 'Отчёты', groupTitle: 'Отчёты', groupIndex: 1, stage: 'work' }),
  chat({ id: 'nested', title: 'Вложенный чат входа', parentId: 'login-work' }),
];

const node = (over: Partial<ChatTreeNode> & { chatId: string }): ChatTreeNode => ({
  aliases: [],
  parentChatId: 'parent',
  running: false,
  ...over,
});

const permissionAsk = (runId: string, toolUseId: string, command: string): ChatTreeAsk => ({
  kind: 'permission',
  runId,
  toolUseId,
  toolName: 'Bash',
  input: { command },
  askedAt: '2026-10-23T11:05:00.000Z',
});

function render(runs: ActiveRunView[], view?: ChatTreeView): string {
  const stages = collectChildStages(chats, 'parent', runs);
  const { questions, permissions } = withTreeAsks(
    {
      questions: collectChildQuestions(chats, 'parent', runs),
      permissions: collectChildPermissions(chats, 'parent', runs),
    },
    view,
    'parent',
    chats,
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChildBlocks
        stages={stages}
        onOpenChild={() => {}}
        questions={questions}
        onAnswer={() => {}}
        permissions={permissions}
        onPermissionDecide={() => {}}
      />
    </QueryClientProvider>,
  );
}

/** Разметка карточки группы, в которой стоит текст; нет такой карточки — пусто. */
function cardWith(html: string, text: string): string {
  const at = html.indexOf(text);
  const start = html.lastIndexOf('data-hub-row', at);
  if (at < 0 || start < 0) return '';
  const next = html.indexOf('data-hub-row', at);
  return html.slice(start, next < 0 ? undefined : next);
}

/** Полоса над хабом — всё до карточки хаба. */
const stripOf = (html: string): string => html.slice(0, html.indexOf('data-child-hub'));

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('хаб: запрос прав и вопрос группы — в её карточке', () => {
  it('живой запрос прав группы под временным ключом прогона — в карточке, над хабом его нет', () => {
    const html = render([
      {
        id: 'new-77',
        sessionId: 'login-review',
        status: 'waiting',
        permissions: [
          { toolName: 'Bash', input: { command: 'git fetch origin' }, toolUseId: 'p1' },
        ],
      },
    ]);
    const card = cardWith(html, 'git fetch origin');
    expect(card).toContain('data-group-permission="1"');
    expect(card).toContain('Вход');
    expect(card).toContain('Агент ждёт разрешения · ревью · чат login-re');
    expect(card).not.toContain('Отчёты');
    expect(stripOf(html)).not.toContain('git fetch origin');
    expect(html).not.toContain('Просит «');
  });

  it('живой вопрос группы под временным ключом прогона — в карточке своей группы', () => {
    const html = render([
      {
        id: 'new-78',
        sessionId: 'reports',
        status: 'running',
        tools: [{ name: 'AskUserQuestion', id: 'q1', input: QUESTION }],
      },
    ]);
    const card = cardWith(html, 'Какую таблицу оставить?');
    expect(card).toContain('data-group-ask="1"');
    expect(card).toContain('Отчёты');
    expect(html).not.toContain('data-child-asks');
  });

  it('запрос раннего звена группы (не последнего) — тоже в карточке группы', () => {
    const view: ChatTreeView = {
      root: 'parent',
      running: 0,
      nodes: [
        node({ chatId: 'parent', parentChatId: undefined }),
        node({
          chatId: 'login-work',
          aliases: ['new-11'],
          title: 'Вход',
          asks: [permissionAsk('new-11', 'p2', 'npm run lint')],
        }),
      ],
    };
    const html = render([], view);
    const card = cardWith(html, 'npm run lint');
    expect(card).toContain('data-group-permission="1"');
    expect(card).toContain('Вход');
    expect(stripOf(html)).not.toContain('npm run lint');
  });

  it('запрос вложенного чата без своей карточки — полосой над хабом, с подписью', () => {
    const view: ChatTreeView = {
      root: 'parent',
      running: 0,
      nodes: [
        node({ chatId: 'parent', parentChatId: undefined }),
        node({ chatId: 'login-work', title: 'Вход' }),
        node({
          chatId: 'nested',
          parentChatId: 'login-work',
          asks: [permissionAsk('new-12', 'p3', 'npm publish')],
        }),
      ],
    };
    const html = render([], view);
    const strip = stripOf(html);
    expect(strip).toContain('data-child-asks');
    expect(strip).toContain('npm publish');
    expect(strip).toContain('Просит «Вложенный чат входа»');
    expect(html).not.toContain('data-group-permission');
  });
});
