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

  it('ключ группы — номер из связи: ветка разговора разошлась, а строка одна (Д12)', () => {
    // Как у !772: работа ушла на ветку без `-2`, правки — в detached HEAD.
    const chats = [
      chat({
        id: 'work',
        parentId: 'parent',
        groupIndex: 0,
        branch: 'fix-T-1084/mr',
        stage: 'work',
        groupTitle: 'Правки MR',
        createdAt: '2026-09-09T10:00:00.000Z',
      }),
      chat({
        id: 'fix',
        parentId: 'parent',
        groupIndex: 0,
        branch: 'HEAD',
        stage: 'fix',
        groupTitle: 'Правки MR',
        createdAt: '2026-09-09T10:30:00.000Z',
      }),
      chat({ id: 'other', parentId: 'parent', groupIndex: 1, branch: 'fix-T-1084/mr' }),
    ];
    const rows = collectChildStages(chats, 'parent', [], {
      parentChatId: 'parent',
      order: [0, 1],
      groups: [
        { index: 0, title: 'Правки MR', branch: 'fix-T-1084/mr-2', after: [], status: 'started' },
        { index: 1, title: 'Тесты', branch: 'fix-T-1084/tests', after: [], status: 'started' },
      ],
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ chatId: 'fix', title: 'Правки MR', stages: ['work', 'fix'] });
    expect(rows[1]).toMatchObject({ chatId: 'other', title: 'Тесты' });
  });

  it('группа идёт, если идёт любое её звено, а не только последнее (Д12)', () => {
    const chats = [
      chat({ id: 'fix', parentId: 'parent', groupIndex: 0, stage: 'fix', groupTitle: 'Форма' }),
      chat({
        id: 'push',
        parentId: 'parent',
        groupIndex: 0,
        stage: 'fix',
        groupTitle: 'Форма',
        createdAt: '2026-09-09T11:00:00.000Z',
      }),
    ];

    const rows = collectChildStages(chats, 'parent', [run({ id: 'fix' })]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ chatId: 'push', isRunning: true });
  });

  it('группа, чьё звено спросило человека, — «ждёт ответа», а не «стоит» (Д16)', () => {
    const chats = [
      chat({ id: 'work', parentId: 'parent', groupIndex: 0, awaitingReply: true }),
      chat({ id: 'other', parentId: 'parent', groupIndex: 1 }),
    ];

    const [asking, quiet] = collectChildStages(chats, 'parent', []);

    expect(asking?.waitingFor).toBe('question');
    expect(quiet?.waitingFor).toBeUndefined();
  });

  it('чего ждёт группа с чатом — из конвейера: решения по ревью, фона, повтора (Д3)', () => {
    const chats = [chat({ id: 'review', parentId: 'parent', groupIndex: 0, stage: 'review' })];

    const [row] = collectChildStages(chats, 'parent', [], {
      parentChatId: 'parent',
      order: [0],
      groups: [
        {
          index: 0,
          title: 'Ревью MR',
          branch: 'feature/mr',
          after: [],
          status: 'awaiting',
          waitingFor: 'decision',
          chatId: 'review',
        },
      ],
    });

    expect(row).toMatchObject({ chatId: 'review', waitingFor: 'decision' });
  });

  it('что сделано и хвост ответа — из конвейера, пока звено не идёт (Д5, Д16)', () => {
    const chats = [
      chat({ id: 'review', parentId: 'parent', groupIndex: 0, stage: 'review' }),
      chat({ id: 'work', parentId: 'parent', groupIndex: 1, stage: 'work' }),
    ];
    const group = {
      after: [],
      status: 'done' as const,
      result: { kind: 'reviewed' as const },
      tail: 'Замечаний нет.',
    };

    const [reviewed, running] = collectChildStages(chats, 'parent', [run({ id: 'work' })], {
      parentChatId: 'parent',
      order: [0, 1],
      groups: [
        { ...group, index: 0, title: 'Ревью', branch: 'feature/r', chatId: 'review' },
        {
          ...group,
          index: 1,
          title: 'Работа',
          branch: 'feature/w',
          result: { kind: 'changed', commits: 2 },
          chatId: 'work',
        },
      ],
    });

    expect(reviewed).toMatchObject({ result: { kind: 'reviewed' }, tail: 'Замечаний нет.' });
    // Идущее звено пишет новый ответ: прошлый итог и хвост про него уже неправда.
    expect(running?.result).toBeUndefined();
    expect(running?.tail).toBeUndefined();
  });

  it('MR группы виден и у идущего звена: он не прошлый ход, а факт (доставка)', () => {
    const chats = [chat({ id: 'work', parentId: 'parent', groupIndex: 0, stage: 'work' })];
    const mr = 'https://git.example.com/team/app/-/merge_requests/815';

    const [row] = collectChildStages(chats, 'parent', [run({ id: 'work' })], {
      parentChatId: 'parent',
      order: [0],
      groups: [
        { index: 0, title: 'Работа', branch: 'feature/w', after: [], status: 'started', mr },
      ],
    });

    expect(row).toMatchObject({ chatId: 'work', isRunning: true, mr });
  });

  it('после разбора группа без места — «в очереди», до разбора — «ждёт итога разбора»', () => {
    const split = {
      parentChatId: 'parent',
      order: [0, 1],
      groups: [
        { index: 0, title: 'Первая', branch: 'a', after: [], status: 'started' as const },
        { index: 1, title: 'Вторая', branch: 'b', after: [], status: 'pending' as const },
      ],
    };

    const queued = collectChildStages([], 'parent', [], {
      ...split,
      triage: { at: '', received: true, repairs: [], conflicts: [] },
    }).find((row) => row.title === 'Вторая');
    const early = collectChildStages([], 'parent', [], split).find((row) => row.title === 'Вторая');

    expect(queued?.pending).toBe('queued');
    expect(early?.pending).toBe('pending');
  });

  it('сдавшаяся группа с чатом — с причиной и числом повторов панели (Д10)', () => {
    const chats = [chat({ id: 'work', parentId: 'parent', groupIndex: 0, stage: 'work' })];

    const [row] = collectChildStages(chats, 'parent', [], {
      parentChatId: 'parent',
      order: [0],
      groups: [
        {
          index: 0,
          title: 'Работа',
          branch: 'feature/w',
          after: [],
          status: 'failed',
          error: 'fetch failed',
          retries: 3,
          chatId: 'work',
        },
      ],
    });

    expect(row).toMatchObject({ error: 'fetch failed', retries: 3 });
    expect(row?.pending).toBeUndefined();
  });

  it('закрытой группе предлагают убрать копию, открытой — нет; убранная несёт итог (Д19)', () => {
    const chats = [
      chat({ id: 'done', parentId: 'parent', groupIndex: 0, stage: 'work' }),
      chat({ id: 'open', parentId: 'parent', groupIndex: 1, stage: 'work' }),
      chat({ id: 'gone', parentId: 'parent', groupIndex: 2, stage: 'work' }),
    ];
    const group = (index: number, status: 'done' | 'started', chatId: string) => ({
      index,
      title: chatId,
      branch: `feature/${chatId}`,
      after: [],
      status,
      chatId,
      path: `/copies/${chatId}`,
    });

    const rows = collectChildStages(chats, 'parent', [], {
      parentChatId: 'parent',
      order: [0, 1, 2],
      groups: [
        group(0, 'done', 'done'),
        group(1, 'started', 'open'),
        {
          ...group(2, 'done', 'gone'),
          cleaned: { at: '2026-09-23T00:00:00.000Z', branch: 'kept' },
        },
      ],
    });

    expect(rows.find((row) => row.chatId === 'done')?.copy).toEqual({ index: 0 });
    expect(rows.find((row) => row.chatId === 'open')?.copy).toBeUndefined();
    expect(rows.find((row) => row.chatId === 'gone')?.copy).toEqual({ index: 2, cleaned: 'kept' });
  });

  it('оборванная группа несёт номер для «Продолжить», время обрыва и счёт; идущей кнопка не нужна (WP1c)', () => {
    const chats = [
      chat({ id: 'cut', parentId: 'parent', groupIndex: 0, stage: 'work' }),
      chat({ id: 'back', parentId: 'parent', groupIndex: 1, stage: 'work' }),
    ];
    const group = (index: number, chatId: string) => ({
      index,
      title: chatId,
      branch: `feature/${chatId}`,
      after: [],
      status: 'awaiting' as const,
      waitingFor: 'interrupted' as const,
      interruptedAt: '2026-09-24T21:00:00.000Z',
      interruptResumes: 2,
      chatId,
      path: `/copies/${chatId}`,
    });

    const rows = collectChildStages(chats, 'parent', [run({ id: 'back' })], {
      parentChatId: 'parent',
      order: [0, 1],
      groups: [group(0, 'cut'), group(1, 'back')],
    });

    const cut = rows.find((row) => row.chatId === 'cut');
    expect(cut?.waitingFor).toBe('interrupted');
    expect(cut?.interrupted).toEqual({ index: 0, at: '2026-09-24T21:00:00.000Z', resumes: 2 });
    // Уже продолжена — прогон идёт: запись конвейера ещё не догнала, кнопки нет.
    expect(rows.find((row) => row.chatId === 'back')?.interrupted).toBeUndefined();
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
