import { describe, expect, it } from 'vitest';
import type { ChatSummary } from '@agentdeck/contracts';
import type { ActiveRunView } from '@shared/lib/agent-runs';
import { collectChildStages } from './childStages';

/** Чат списка: в сводке важны родитель, ветка, стадия, модель и время. */
function chat(over: Partial<ChatSummary> & { id: string }): ChatSummary {
  return {
    title: over.id,
    project: 'probe',
    projectPath: 'C:/work/probe',
    isSandbox: false,
    messageCount: 1,
    createdAt: '2026-09-07T10:00:00.000Z',
    updatedAt: '2026-09-07T10:00:00.000Z',
    ...over,
  };
}

/** Живой прогон: сводке нужны только ключи и статус. */
function run(over: Partial<ActiveRunView> & { id: string }): ActiveRunView {
  return { status: 'running', ...over } as ActiveRunView;
}

describe('collectChildStages', () => {
  it('время до первой правки — по звену работы, без момента поля нет', () => {
    const chats = [
      chat({
        id: 'work',
        parentId: 'parent',
        branch: 'probe/a',
        stage: 'work',
        createdAt: '2026-09-09T10:00:00.000Z',
        firstEditAt: '2026-09-09T10:01:12.000Z',
      }),
      chat({
        id: 'review',
        parentId: 'parent',
        branch: 'probe/a',
        stage: 'review',
        createdAt: '2026-09-09T10:30:00.000Z',
        firstEditAt: '2026-09-09T10:30:05.000Z',
      }),
      chat({ id: 'other', parentId: 'parent', branch: 'probe/b', stage: 'work' }),
    ];
    const [a, b] = collectChildStages(chats, 'parent', []);
    expect(a?.firstEditAfterMs).toBe(72_000);
    expect(b?.firstEditAfterMs).toBeUndefined();
  });

  it('время в работе — сумма звеньев от заведения до последней записи, паузы между ними не в счёт', () => {
    const chats = [
      chat({
        id: 'work',
        parentId: 'parent',
        branch: 'probe/a',
        stage: 'work',
        createdAt: '2026-09-09T10:00:00.000Z',
        updatedAt: '2026-09-09T10:05:00.000Z',
      }),
      chat({
        id: 'review',
        parentId: 'parent',
        branch: 'probe/a',
        stage: 'review',
        createdAt: '2026-09-09T10:30:00.000Z',
        updatedAt: '2026-09-09T10:31:20.000Z',
      }),
      chat({
        id: 'broken',
        parentId: 'parent',
        branch: 'probe/b',
        stage: 'work',
        createdAt: '',
        updatedAt: '',
      }),
    ];
    const [a, b] = collectChildStages(chats, 'parent', []);
    expect(a?.workMs).toBe(380_000);
    expect(b?.workMs).toBeUndefined();
  });

  it('без родителя и без детей молчит', () => {
    expect(collectChildStages([chat({ id: 'a' })], undefined, [])).toEqual([]);
    expect(collectChildStages([chat({ id: 'a' })], 'parent', [])).toEqual([]);
  });

  it('сводит звенья одной ветки в одну строку и показывает путь группы', () => {
    const chats = [
      chat({
        id: 'work',
        title: 'Проект `probe` — библиотека разбора диапазонов…',
        groupTitle: 'Разбор диапазона',
        parentId: 'parent',
        branch: 'probe/range',
        stage: 'work',
        model: 'sonnet',
        createdAt: '2026-09-07T10:00:00.000Z',
      }),
      chat({
        id: 'review',
        title: 'Это новая сессия…',
        groupTitle: 'Разбор диапазона',
        parentId: 'parent',
        branch: 'probe/range',
        stage: 'review',
        model: 'claude-opus-5',
        createdAt: '2026-09-07T10:05:00.000Z',
      }),
    ];

    const [group, ...rest] = collectChildStages(chats, 'parent', []);
    expect(rest).toEqual([]);
    expect(group).toMatchObject({
      chatId: 'review',
      // Имя группы — из связи: заголовки звеньев это тексты их первых
      // сообщений, и по ним группа не узнаётся.
      title: 'Разбор диапазона',
      branch: 'probe/range',
      stages: ['work', 'review'],
      model: 'claude-opus-5',
      isRunning: false,
    });
  });

  it('чужих детей не берёт, а свои группы не смешивает', () => {
    const chats = [
      chat({ id: 'a', parentId: 'parent', branch: 'one', stage: 'work' }),
      chat({ id: 'b', parentId: 'parent', branch: 'two', stage: 'work' }),
      chat({ id: 'c', parentId: 'другой', branch: 'three', stage: 'work' }),
    ];
    expect(collectChildStages(chats, 'parent', []).map((group) => group.branch)).toEqual([
      'one',
      'two',
    ]);
  });

  // Заголовки звеньев здесь РАЗНЫЕ — так и бывает вживую: это тексты первых
  // сообщений работы и правок. Группу держит вместе только имя из связи.
  it('без ветки группу держит имя из связи: делили не репозиторий', () => {
    const chats = [
      chat({
        id: 'w',
        title: 'Сделай разбор диапазона…',
        groupTitle: 'Группа',
        parentId: 'parent',
        createdAt: '2026-09-07T10:00:00.000Z',
      }),
      chat({
        id: 'f',
        title: 'Ревью нашло замечания…',
        groupTitle: 'Группа',
        parentId: 'parent',
        stage: 'fix',
        createdAt: '2026-09-07T10:01:00.000Z',
      }),
    ];
    expect(collectChildStages(chats, 'parent', [])).toMatchObject([
      { chatId: 'f', stages: ['work', 'fix'] },
    ]);
  });

  it('стадию не знает — читает как работу: так выглядят чаты до конвейера', () => {
    const chats = [chat({ id: 'old', parentId: 'parent', branch: 'b' })];
    expect(collectChildStages(chats, 'parent', [])[0]?.stages).toEqual(['work']);
  });

  it('идущий прогон находит и по временному ключу, и по сессии', () => {
    const chats = [chat({ id: 'session-1', parentId: 'parent', branch: 'b' })];

    expect(collectChildStages(chats, 'parent', [run({ id: 'session-1' })])[0]?.isRunning).toBe(
      true,
    );
    expect(
      collectChildStages(chats, 'parent', [run({ id: 'new-9', sessionId: 'session-1' })])[0]
        ?.isRunning,
    ).toBe(true);
    // Ждущий человека прогон в реестре лежит рядом с работающим — «идёт» это
    // только `running`: вопрос ребёнка показывает соседняя карточка, а не эта.
    expect(
      collectChildStages(chats, 'parent', [run({ id: 'session-1', status: 'waiting' })])[0]
        ?.isRunning,
    ).toBe(false);
  });

  it('код вопроса едет в строку хаба — панель покажет свою фразу на языке интерфейса', () => {
    const rows = collectChildStages([], 'parent', [], {
      parentChatId: 'parent',
      order: [0],
      groups: [
        {
          index: 0,
          title: 'Шапка',
          branch: 'feature/header',
          after: [],
          status: 'held',
          hold: 'Разбор оборвался при перезапуске панели и итога не даст.',
          holdCode: 'split-triage-interrupted-hold',
        },
      ],
    });

    // Код переезжает под именем поля, в котором вопрос лежит в строке: его же
    // ищет общий переводчик серверных текстов.
    expect(rows[0]?.hold).toMatchObject({
      index: 0,
      questionCode: 'split-triage-interrupted-hold',
    });
  });

  it('уровни (Т1): разбор первой строкой, группы без чата — по порядку разбора, с тем, чего ждут', () => {
    const chats = [
      chat({ id: 'triage', parentId: 'parent', stage: 'triage', groupTitle: 'Разбор разделения' }),
      chat({
        id: 'plan-a',
        parentId: 'parent',
        branch: 'feature/login',
        stage: 'plan',
        groupTitle: 'Форма входа',
        createdAt: '2026-09-09T10:03:00.000Z',
      }),
    ];
    const rows = collectChildStages(chats, 'parent', [], {
      parentChatId: 'parent',
      triageChatId: 'triage',
      order: [1, 0, 2],
      groups: [
        {
          index: 0,
          title: 'Форма входа',
          branch: 'feature/login',
          after: [],
          status: 'started',
          chatId: 'plan-a',
        },
        {
          index: 1,
          title: 'Шапка',
          branch: 'feature/header',
          after: [],
          status: 'held',
          hold: 'Цвет?',
        },
        {
          index: 2,
          title: 'Тесты',
          branch: 'feature/tests',
          after: [1, 0],
          status: 'waiting',
          holdAnswer: 'Chrome',
          base: 'feature/login',
        },
      ],
    });

    expect(rows.map((row) => row.title)).toEqual([
      'Разбор разделения',
      'Шапка',
      'Форма входа',
      'Тесты',
    ]);
    expect(rows[0]).toMatchObject({ chatId: 'triage', stages: ['triage'] });
    // Номер группы — из конвейера, а не порядок строки: отпускание и ответ
    // адресуются им, а «Шапка» стоит второй строкой, будучи группой №1.
    expect(rows[1]).toMatchObject({
      chatId: '',
      pending: 'held',
      groupIndex: 1,
      hold: { index: 1, question: 'Цвет?' },
    });
    expect(rows[2]).toMatchObject({ chatId: 'plan-a', stages: ['plan'], branch: 'feature/login' });
    expect(rows[3]).toMatchObject({
      chatId: '',
      pending: 'waiting',
      groupIndex: 2,
      waitsFor: ['Шапка', 'Форма входа'],
      holdAnswered: true,
      base: 'feature/login',
    });
  });

  it('незнакомая стадия читается как работа, а первая правка считается по звену работы, не плана', () => {
    const chats = [
      chat({
        id: 'plan',
        parentId: 'parent',
        branch: 'feature/a',
        stage: 'plan',
        createdAt: '2026-09-09T10:00:00.000Z',
        firstEditAt: '2026-09-09T10:00:30.000Z',
      }),
      chat({
        id: 'work',
        parentId: 'parent',
        branch: 'feature/a',
        stage: 'something',
        createdAt: '2026-09-09T10:10:00.000Z',
        firstEditAt: '2026-09-09T10:10:20.000Z',
      }),
    ];
    const [row] = collectChildStages(chats, 'parent', []);
    expect(row?.stages).toEqual(['plan', 'work']);
    expect(row?.firstEditAfterMs).toBe(20_000);
  });
});
