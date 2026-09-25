import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatSummary } from '@agentdeck/contracts';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import type { ActiveRunView } from '@shared/lib/agent-runs';
import { i18n } from '@shared/config/i18n';
import { ChildStages } from '@features/ChatMessages';
import { collectChildStages, treeForChat } from './childStages';

/**
 * Хаб родителя целиком: настоящая сводка (`collectChildStages` со склейкой
 * конвейера) рисуется настоящей карточкой `ChildStages`. Подменены только часы.
 *
 * Живой прогон 24.09.2026 (L13, L23, L37, L20): разбор молчал минутами без
 * времени; строка остановленного разбора писала «в работе 21м», и человек
 * читал это как «работает»; сводки «сколько готово, сколько ждёт меня» не было;
 * чаты групп, отброшенных перезапуском, становились строками групп.
 */

function chat(over: Partial<ChatSummary> & { id: string }): ChatSummary {
  return {
    title: over.id,
    project: 'probe',
    projectPath: 'C:/work/probe',
    isSandbox: false,
    messageCount: 1,
    createdAt: '2026-09-24T10:00:00.000Z',
    updatedAt: '2026-09-24T10:00:00.000Z',
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

function render(chats: ChatSummary[], runs: ActiveRunView[], split?: SplitPlanView): string {
  const groups = collectChildStages(chats, 'parent', runs, split);
  // Дерево — как его отдаёт сервер хабу: вид конвейера едет в нём (`split`).
  const tree = split ? { root: 'parent', running: 0, nodes: [], split } : undefined;
  // Кнопки строк (уборка копии, пауза группы) ведут запрос сами — как в панели,
  // под клиентом запросов.
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChildStages groups={groups} onOpen={() => {}} {...(tree ? { tree } : {})} />
    </QueryClientProvider>,
  );
}

/** Текст без разметки — подписи проверяются так, как их читает человек. */
const textOf = (html: string): string => html.replace(/<[^>]+>/g, '|');

/** Кусок разметки от атрибута до конца его элемента-обёртки (грубо, но достаточно). */
function section(html: string, attr: string): string {
  const at = html.indexOf(attr);
  return at < 0 ? '' : html.slice(at, html.indexOf('</div>', at));
}

const triageChat = chat({
  id: 'triage',
  stage: 'triage',
  groupTitle: 'Разбор разделения',
  branch: 'agent/split',
  createdAt: '2026-09-24T10:00:00.000Z',
  updatedAt: '2026-09-24T10:21:57.000Z',
});

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('хаб разделения — разбор', () => {
  it('L23: время остановленного звена подписано как длительность, а не как «в работе»', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-24T12:00:00.000Z') });
    const html = render([triageChat], [], {
      parentChatId: 'parent',
      triageChatId: 'triage',
      triage: { at: '2026-09-24T10:22:00.000Z', received: false, repairs: [], conflicts: [] },
      order: [],
      groups: [],
    });

    expect(textOf(html)).toContain('время работы 21м 57с');
    expect(textOf(html)).not.toContain('в работе 21м');
  });

  it('L13: идущий разбор показывает, сколько он уже идёт, — по часам, а не по последней записи', () => {
    const split: SplitPlanView = {
      parentChatId: 'parent',
      triageChatId: 'triage',
      order: [],
      groups: [],
    };
    vi.useFakeTimers({ now: Date.parse('2026-09-24T10:04:12.000Z') });
    const chip = section(
      render([triageChat], [running('triage')], split),
      'data-hub-triage="running"',
    );
    expect(textOf(chip)).toContain('идёт разбор · 4м 12с');

    vi.setSystemTime(Date.parse('2026-09-24T10:04:42.000Z'));
    const later = section(
      render([triageChat], [running('triage')], split),
      'data-hub-triage="running"',
    );
    expect(textOf(later)).toContain('идёт разбор · 4м 42с');
  });

  // Итога разбора нет, а прогон стоит (пауза, остановка, перезапуск): «идёт
  // разбор» здесь было неправдой — фишка говорит «разбор не идёт» и без времени.
  it('L13: разбор, чей прогон не идёт, не пишет «идёт» вовсе', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-24T12:00:00.000Z') });
    const split: SplitPlanView = {
      parentChatId: 'parent',
      triageChatId: 'triage',
      order: [],
      groups: [],
    };
    const html = render([triageChat], [], split);
    const chip = section(html, 'data-hub-triage="stopped"');

    expect(html).not.toContain('data-hub-triage="running"');
    expect(textOf(chip)).toContain('разбор не идёт');
    expect(textOf(chip)).not.toContain('·');
  });
});

describe('хаб разделения — сводка (L37)', () => {
  const chats = [
    triageChat,
    chat({ id: 'done', branch: 'fix/g0', stage: 'fix', groupTitle: 'Группа 0' }),
    chat({
      id: 'busy',
      branch: 'fix/g1',
      stage: 'work',
      groupTitle: 'Группа 1',
      createdAt: '2026-09-24T10:30:00.000Z',
    }),
    chat({ id: 'stuck', branch: 'fix/g5', stage: 'review', groupTitle: 'Группа 5' }),
  ];
  const split: SplitPlanView = {
    parentChatId: 'parent',
    triageChatId: 'triage',
    triage: { at: '2026-09-24T10:22:00.000Z', received: true, repairs: [], conflicts: [] },
    order: [0, 1, 2, 3, 4, 5],
    groups: [
      group(0, { status: 'done', chatId: 'done' }),
      group(1, { status: 'started', chatId: 'busy' }),
      group(2, { status: 'held', hold: 'Какой браузер?' }),
      group(3, { status: 'pending' }),
      group(4, { status: 'failed', error: 'нет копии' }),
      group(5, { status: 'awaiting', waitingFor: 'delivery', chatId: 'stuck' }),
    ],
  };

  it('счётчики по состояниям, «ждёт вас» и время с начала разделения', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-24T11:05:00.000Z') });
    const html = render(chats, [running('busy')], split);
    const summary = textOf(section(html, 'data-hub-summary'));

    expect(summary).toContain('готово: 1');
    expect(summary).toContain('идёт: 1');
    expect(summary).toContain('ждёт вас: 1');
    expect(summary).toContain('в очереди: 1');
    expect(summary).toContain('упала: 1');
    expect(summary).toContain('стоит: 1');
    // С заведения разбора — первого звена разделения — до «сейчас»: прогон идёт.
    expect(summary).toContain('с начала 1ч 05м');
    // Строка разбора — не группа: шесть групп, а не семь.
    expect(textOf(html)).toContain('Групп разделения: 6');
  });

  it('ждущих человека нет — «ждёт вас» не пишется вовсе', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-24T11:05:00.000Z') });
    const calm = { ...split, groups: split.groups.filter((item) => item.status !== 'held') };
    const markup = section(render(chats, [], calm), 'data-hub-summary');
    const summary = textOf(markup);

    // Ни «ждёт вас: 0», ни «ждут вас: 0» — пустая корзина не пишется вовсе.
    expect(summary).not.toContain('вас');
    expect(markup).not.toContain('data-hub-count="ask"');
    expect(summary).toContain('готово: 1');
  });
});

describe('хаб разделения — отброшенные перезапуском (L20)', () => {
  it('чат с меткой `retired` — внизу под «Неактивно», не строка группы и не в счёте', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-24T11:05:00.000Z') });
    const chats = [
      triageChat,
      // Старый чат отброшенной группы: ветка та же, что у перезапущенной группы в очереди.
      chat({
        id: 'old-g3',
        branch: 'fix/g3',
        stage: 'work',
        retired: true,
        title: 'Старая работа',
      }),
      chat({ id: 'busy', branch: 'fix/g1', stage: 'work', groupTitle: 'Группа 1' }),
    ];
    const split: SplitPlanView = {
      parentChatId: 'parent',
      triageChatId: 'triage',
      triage: { at: '2026-09-24T10:22:00.000Z', received: true, repairs: [], conflicts: [] },
      order: [1, 3],
      groups: [group(1, { status: 'started', chatId: 'busy' }), group(3, { status: 'pending' })],
    };
    const html = render(chats, [running('busy')], split);

    // Группа 3 в очереди, а не «заняла» строку мёртвого чата с той же веткой.
    expect(html).toContain('data-hub-row="queued"');
    expect(textOf(html)).toContain('Группы разделения: 2');
    const inactive = html.slice(html.indexOf('data-hub-inactive'));
    expect(html.indexOf('data-hub-inactive')).toBeGreaterThan(-1);
    expect(textOf(inactive)).toContain('Неактивно: 1');
    expect(textOf(inactive)).toContain('Старая работа');
    // Строк групп с чатом ровно две — разбор и группа 1; отброшенный чат — не из них.
    expect(html.match(/data-hub-row="chat"/g)?.length).toBe(2);
  });

  // F5.2: копия группы прошлого разделения лежала на диске без кнопки уборки —
  // хаб показывает строки только нынешнего плана.
  it('снятый чат с неубранной копией — кнопка уборки у него, у прочих снятых нет', () => {
    const chats = [
      triageChat,
      chat({ id: 'old-copy', retired: true, copyLeft: true, title: 'Старая с копией' }),
      chat({ id: 'old-clean', retired: true, title: 'Старая без копии' }),
    ];
    const html = render(chats, []);

    const inactive = html.slice(html.indexOf('data-hub-inactive'));
    expect(textOf(inactive)).toContain('Неактивно: 2');
    expect(inactive.match(/data-cleanup-group/g)?.length).toBe(1);
    const withCopy = inactive.indexOf('Старая с копией');
    const button = inactive.indexOf('data-cleanup-group');
    expect(button).toBeGreaterThan(withCopy);
    expect(button).toBeLessThan(inactive.indexOf('Старая без копии'));
  });
});

/**
 * Живой прогон 26.09 (F2): дерево сервер отдаёт по корню, и хаб чата группы
 * рисовал план всего разделения — все группы «ждут итога разбора» и кнопку
 * «Отменить план». Путь хаба: дерево → `treeForChat` → сводка → карточка.
 */
describe('хаб разделения — чат группы', () => {
  const split: SplitPlanView = {
    parentChatId: 'parent',
    order: [1, 2],
    groups: [group(1, { status: 'started', chatId: 'g1' }), group(2, {})],
  };
  // Дерево — одно на корень, какой бы чат его ни спросил.
  const served = { root: 'parent', running: 1, nodes: [], split };
  const chats = [
    chat({ id: 'g1', groupIndex: 1, groupTitle: 'Группа 1', stage: 'work' }),
    // У звена группы свой ребёнок (передача) — хаб в нём не пуст.
    chat({ id: 'g1-next', parentId: 'g1', title: 'Передача', stage: 'work' }),
  ];

  function hubOf(chatId: string): string {
    const tree = treeForChat(served, chatId);
    const groups = collectChildStages(chats, chatId, [], tree?.split);
    return renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ChildStages groups={groups} onOpen={() => {}} {...(tree ? { tree } : {})} />
      </QueryClientProvider>,
    );
  }

  it('родитель видит план и кнопку его отмены', () => {
    const html = hubOf('parent');
    expect(html).toContain('data-plan-cancel');
    expect(textOf(html)).toContain('Группа 2');
  });

  it('чат группы не рисует чужой план — только своих детей', () => {
    const html = hubOf('g1');
    expect(html).not.toContain('data-plan-cancel');
    expect(textOf(html)).not.toContain('Группа 2');
    expect(textOf(html)).toContain('Передача');
  });
});

/**
 * Живой прогон 26.09 (O3): отмену плана человеком фишка сводки считала
 * «упала: 1» рядом с верной подписью строки «остановлена: план отменён».
 */
describe('хаб разделения — сводка после отмены плана', () => {
  it('группы, закрытые отменой, считаются «отменена», а не «упала»', () => {
    const cancelled = {
      status: 'failed' as const,
      error: 'план отменён человеком',
      errorCode: 'split-group-plan-cancelled' as const,
    };
    const html = render([], [], {
      parentChatId: 'parent',
      cancelledAt: '2026-09-26T08:00:00.000Z',
      order: [1, 2, 3],
      groups: [
        group(1, { status: 'done' }),
        group(2, cancelled),
        group(3, { status: 'failed', error: 'сбой' }),
      ],
    });
    const summary = textOf(section(html, 'data-hub-summary'));

    expect(summary).toContain('отменена: 1');
    expect(summary).toContain('упала: 1');
  });
});
