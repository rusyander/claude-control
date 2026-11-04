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

  it('время работы звена — его activeMs с сервера, а не заведение → последняя запись', () => {
    // Группа на паузе двое суток (19.10): по датам 52 ч, по транскрипту 3,5 ч.
    const chats = [
      chat({
        id: 'work',
        parentId: 'parent',
        branch: 'probe/a',
        stage: 'work',
        createdAt: '2026-10-16T15:00:00.000Z',
        updatedAt: '2026-10-18T19:30:00.000Z',
        activeMs: 12_600_000,
      }),
      chat({
        id: 'review',
        parentId: 'parent',
        branch: 'probe/a',
        stage: 'review',
        createdAt: '2026-10-18T19:40:00.000Z',
        updatedAt: '2026-10-18T19:45:00.000Z',
      }),
    ];
    const [a] = collectChildStages(chats, 'parent', []);
    expect(a?.workMs).toBe(12_600_000 + 300_000);
  });

  it('доля окон лимита группы — сумма звеньев; ни у кого нет — поля нет', () => {
    const chats = [
      chat({
        id: 'work',
        parentId: 'parent',
        branch: 'probe/a',
        stage: 'work',
        limitShare: { fiveHour: 0.03, sevenDay: 0.004 },
      }),
      chat({ id: 'review', parentId: 'parent', branch: 'probe/a', stage: 'review' }),
      chat({
        id: 'fix',
        parentId: 'parent',
        branch: 'probe/a',
        stage: 'fix',
        limitShare: { fiveHour: 0.01 },
      }),
      chat({ id: 'other', parentId: 'parent', branch: 'probe/b', stage: 'work' }),
    ];
    const [a, b] = collectChildStages(chats, 'parent', []);
    expect(a?.limitShare?.fiveHour).toBeCloseTo(0.04);
    expect(a?.limitShare?.sevenDay).toBeCloseTo(0.004);
    expect(b && 'limitShare' in b).toBe(false);
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
    const rows = collectChildStages(chats, 'parent', []);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ chatId: 'fix', title: 'Правки MR', stages: ['work', 'fix'] });
    expect(rows[1]).toMatchObject({ chatId: 'other' });
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

  /** Живой прогон 20.10: продолженная через сутки группа «работала 21ч 09м» при часе работы. */
  it('старт хода группы — у свежего из её идущих прогонов, а не заведение цепочки', () => {
    const chats = [
      chat({ id: 'work', parentId: 'parent', groupIndex: 0, groupTitle: 'Форма' }),
      chat({ id: 'other', parentId: 'parent', groupIndex: 1, groupTitle: 'Список' }),
    ];
    const resumed = Date.parse('2026-09-08T18:59:00.000Z');

    const rows = collectChildStages(chats, 'parent', [
      run({ id: 'new-1', sessionId: 'work', startedAt: resumed - 60_000, status: 'quiet' }),
      run({ id: 'work', startedAt: resumed }),
      run({ id: 'other' }),
    ]);

    expect(rows.find((row) => row.chatId === 'work')).toMatchObject({
      startedAt: '2026-09-07T10:00:00.000Z',
      runStartedAt: '2026-09-08T18:59:00.000Z',
    });
    // Старта прогон не назвал — поля нет, хаб покажет «работает» без времени.
    expect(rows.find((row) => row.chatId === 'other')).not.toHaveProperty('runStartedAt');
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
