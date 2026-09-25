import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatSummary } from '@agentdeck/contracts';
import type { ChatTreeNode, SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import type { ActiveRunView } from '@shared/lib/agent-runs';
import { i18n } from '@shared/config/i18n';
import { ChildStages } from '@features/ChatMessages';
import { collectChildStages } from './childStages';

/**
 * Хаб разделения: ручная приёмка группы (TK-accepted), список «Предложить
 * тикет» (95b) и фишка разбора, которая говорит «идёт» только про идущий
 * прогон. Сводка настоящая (`collectChildStages` со склейкой конвейера),
 * карточка настоящая (`ChildStages`); подменены только часы.
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

const running = (id: string): ActiveRunView => ({ id, status: 'running' }) as ActiveRunView;

type Group = SplitPlanView['groups'][number];
const group = (index: number, over: Partial<Group>): Group => ({
  index,
  title: `Группа ${index}`,
  branch: `fix/g${index}`,
  after: [],
  status: 'pending',
  ...over,
});

const TRIAGE = { at: '2026-09-25T10:05:00.000Z', received: true, repairs: [], conflicts: [] };

function render(
  chats: ChatSummary[],
  runs: ActiveRunView[],
  split: SplitPlanView,
  nodes: ChatTreeNode[] = [],
): string {
  const groups = collectChildStages(chats, 'parent', runs, split);
  const tree = { root: 'parent', running: 0, nodes, split };
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChildStages groups={groups} onOpen={() => {}} tree={tree} />
    </QueryClientProvider>,
  );
}

const textOf = (html: string): string => html.replace(/<[^>]+>/g, '|');

/** Строка хаба группы по её ветке: от ближайшего `data-hub-row` до следующего. */
function rowOf(html: string, branch: string): string {
  const at = html.indexOf(branch);
  if (at < 0) return '';
  const start = html.lastIndexOf('data-hub-row', at);
  const next = html.indexOf('data-hub-row', at);
  return html.slice(start, next < 0 ? undefined : next);
}

function section(html: string, attr: string): string {
  const at = html.indexOf(attr);
  return at < 0 ? '' : html.slice(at, html.indexOf('</div>', at));
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('хаб разделения — «Принять» (TK-accepted)', () => {
  const chats = [
    chat({ id: 'c0', branch: 'fix/g0', stage: 'fix', groupTitle: 'Группа 0' }),
    chat({ id: 'c1', branch: 'fix/g1', stage: 'fix', groupTitle: 'Группа 1' }),
    chat({ id: 'c2', branch: 'fix/g2', stage: 'work', groupTitle: 'Группа 2' }),
  ];
  const split = (over: Partial<Group>[] = []): SplitPlanView => ({
    parentChatId: 'parent',
    triage: TRIAGE,
    order: [0, 1, 2],
    groups: [
      group(0, { status: 'done', chatId: 'c0', ...over[0] }),
      group(1, { status: 'done', chatId: 'c1', ...over[1] }),
      group(2, { status: 'started', chatId: 'c2', ...over[2] }),
    ],
  });

  it('доставленная группа несёт «Принять»; идущая — нет', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-25T11:00:00.000Z') });
    const html = render(chats, [running('c2')], split());

    expect(textOf(rowOf(html, 'fix/g0'))).toContain('Принять');
    expect(rowOf(html, 'fix/g0')).toContain('data-accept-group="open"');
    expect(rowOf(html, 'fix/g2')).not.toContain('data-accept-group');
    // Отметки никто не ставил — панель её из «готово» не выводит.
    expect(html).not.toContain('data-hub-accepted');
    expect(textOf(section(html, 'data-hub-summary'))).not.toContain('принято');
  });

  it('«готово», но звено снова идёт — принимать нечего, кнопки нет', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-25T11:00:00.000Z') });
    const html = render(chats, [running('c0')], split());

    expect(rowOf(html, 'fix/g0')).not.toContain('data-accept-group');
    // Недоставленная группа, чьё звено стоит, — тоже без кнопки: «готово» нет.
    expect(rowOf(html, 'fix/g2')).not.toBe('');
    expect(rowOf(html, 'fix/g2')).not.toContain('data-accept-group');
  });

  it('принятая группа: отметка «принято», «Снять отметку» и своя корзина сводки', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-25T11:00:00.000Z') });
    const html = render(chats, [], split([{ acceptedAt: '2026-09-25T10:50:00.000Z' }]));
    const row = rowOf(html, 'fix/g0');

    expect(row).toContain('data-hub-accepted');
    expect(textOf(row)).toContain('принято');
    expect(textOf(row)).toContain('Снять отметку');
    expect(row).toContain('data-accept-group="accepted"');
    // Соседняя доставленная группа — непринятая: у неё «Принять».
    expect(textOf(rowOf(html, 'fix/g1'))).toContain('Принять');
    const summary = textOf(section(html, 'data-hub-summary'));
    expect(summary).toContain('принято: 1');
    expect(summary).toContain('готово: 1');
  });
});

describe('хаб разделения — «Предложить тикет» (95b)', () => {
  const chats = [
    chat({ id: 'c0', branch: 'fix/g0', stage: 'fix', groupTitle: 'Группа 0' }),
    chat({ id: 'c1', branch: 'fix/g1', stage: 'fix', groupTitle: 'Группа 1' }),
  ];
  const ticket = (title: string, where: string, why: string) => ({
    title,
    where,
    why,
    at: '2026-09-25T10:30:00.000Z',
  });

  it('находки групп одним списком, общая — одна строка с обеими группами', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-25T11:00:00.000Z') });
    const html = render(chats, [], {
      parentChatId: 'parent',
      triage: TRIAGE,
      order: [0, 1],
      groups: [
        group(0, {
          status: 'done',
          chatId: 'c0',
          tickets: [ticket('Падает экспорт', 'export.ts:42', 'пустой файл')],
        }),
        group(1, {
          status: 'started',
          chatId: 'c1',
          tickets: [
            ticket('падает  экспорт', 'export.ts:42', 'пустой файл'),
            ticket('Лишний запрос профиля', 'profile.ts:7', 'два GET'),
          ],
        }),
      ],
    });
    const list = html.slice(html.indexOf('data-split-tickets'));

    expect(html).toContain('data-split-tickets="2"');
    expect(textOf(list)).toContain('Предложить тикет: 2');
    expect(textOf(list)).toContain('нашла: Группа 0, Группа 1');
    expect(textOf(list)).toContain('Лишний запрос профиля');
    // Только копирование: ни одной кнопки, которая писала бы в трекер.
    expect(list.match(/data-copy-ticket/g)?.length).toBe(2);
    expect(textOf(list)).not.toMatch(/Завести|Создать/);
  });

  /** L277: трекер привязан — «Завести в PROJ»; заведённый — ключ вместо кнопки. */
  it('привязан трекер — «Завести», заведённый тикет показывает ключ и кнопки не имеет', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-25T11:00:00.000Z') });
    const html = render(chats, [], {
      parentChatId: 'parent',
      triage: TRIAGE,
      ticketTracker: 'PROJ',
      order: [0, 1],
      groups: [
        group(0, {
          status: 'done',
          chatId: 'c0',
          tickets: [
            {
              ...ticket('Падает экспорт', 'export.ts:42', 'пустой файл'),
              filed: { key: 'PROJ-7', at: '2026-09-25T10:40:00.000Z' },
            },
          ],
        }),
        group(1, {
          status: 'done',
          chatId: 'c1',
          tickets: [ticket('Лишний запрос профиля', 'profile.ts:7', 'два GET')],
        }),
      ],
    });
    const list = html.slice(html.indexOf('data-split-tickets'));

    expect(list.match(/data-file-ticket/g)?.length).toBe(1);
    expect(textOf(list)).toContain('Завести в PROJ');
    expect(list).toContain('data-ticket-filed="PROJ-7"');
    expect(textOf(list)).toContain('Заведено: PROJ-7');
  });

  it('находок нет — раздела нет', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-25T11:00:00.000Z') });
    const html = render(chats, [], {
      parentChatId: 'parent',
      triage: TRIAGE,
      order: [0],
      groups: [group(0, { status: 'done', chatId: 'c0' })],
    });

    expect(html).not.toContain('data-split-tickets');
    expect(textOf(html)).not.toContain('Предложить тикет');
    expect(html).not.toContain('data-split-human-steps');
  });

  /** Находка 112: зависимость между MR выставляет только человек — пункт в хабе. */
  it('«Сделать человеку»: шаги групп одним списком, общий шаг — одна строка', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-25T11:00:00.000Z') });
    const step = {
      action: 'Выставить зависимость MR !808 от !789',
      where: 'https://git.example/p/-/merge_requests/808',
      why: 'операции нет в инструментах',
      at: '2026-09-25T10:30:00.000Z',
    };
    const html = render(chats, [], {
      parentChatId: 'parent',
      triage: TRIAGE,
      order: [0, 1],
      groups: [
        group(0, { status: 'done', chatId: 'c0', humanSteps: [step] }),
        group(1, { status: 'done', chatId: 'c1', humanSteps: [{ ...step, why: 'нужна мне' }] }),
      ],
    });
    const list = html.slice(html.indexOf('data-split-human-steps'));

    expect(html).toContain('data-split-human-steps="1"');
    expect(textOf(list)).toContain('Сделать человеку: 1');
    expect(textOf(list)).toContain('Выставить зависимость MR !808 от !789');
    expect(textOf(list)).toContain('просит: Группа 0, Группа 1');
    expect(html).not.toContain('data-split-tickets');
  });
});

describe('хаб разделения — фишка разбора без итога', () => {
  const triageChat = chat({
    id: 'triage',
    stage: 'triage',
    groupTitle: 'Разбор разделения',
    branch: 'agent/split',
  });
  const split: SplitPlanView = {
    parentChatId: 'parent',
    triageChatId: 'triage',
    order: [],
    groups: [],
  };
  const node = (over: Partial<ChatTreeNode>): ChatTreeNode => ({
    chatId: 'x',
    aliases: [],
    running: false,
    ...over,
  });

  it('прогон разбора идёт по строке — «идёт разбор»', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-25T10:03:00.000Z') });
    const html = render([triageChat], [running('triage')], split);

    expect(html).toContain('data-hub-triage="running"');
  });

  it('строка разбора стоит, но узел дерева с его ключом идёт — тоже «идёт»', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-25T10:03:00.000Z') });
    const html = render([triageChat], [], split, [
      node({ chatId: 'sess-triage', aliases: ['triage'], running: true }),
    ]);

    expect(html).toContain('data-hub-triage="running"');
  });

  it('ни строка, ни узел не идут — «разбор не идёт»', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-25T10:03:00.000Z') });
    const html = render([triageChat], [], split, [
      node({ chatId: 'triage', running: false }),
      node({ chatId: 'другой', running: true }),
    ]);

    expect(html).toContain('data-hub-triage="stopped"');
    expect(textOf(section(html, 'data-hub-triage'))).toContain('разбор не идёт');
  });
});
