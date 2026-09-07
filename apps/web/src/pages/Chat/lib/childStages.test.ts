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
});
