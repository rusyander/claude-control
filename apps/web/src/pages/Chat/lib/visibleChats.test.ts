import { describe, it, expect } from 'vitest';
import type { ChatSummary } from '@claude-control/contracts';
import { visibleChats } from './visibleChats';

/**
 * Отбор разговоров в боковой список. Проверяется то, из-за чего он способен
 * соврать о состоянии: показать чат дважды и показать чужой.
 */

const chat = (patch: Partial<ChatSummary> & { id: string }): ChatSummary => ({
  title: patch.id,
  project: 'demo',
  projectPath: 'C:/work/demo',
  isSandbox: false,
  messageCount: 1,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
  ...patch,
});

const PROJECT = 'c:/work/demo';

describe('видимые чаты проекта', () => {
  it('без открытого проекта показывает только песочницу', () => {
    const rows = visibleChats([
      chat({ id: 'песочница', isSandbox: true }),
      chat({ id: 'проектный' }),
    ]);

    expect(rows.map((row) => row.id)).toEqual(['песочница']);
  });

  /**
   * Параллельный запуск живёт в списке проектов ДОМАШНЕЙ вкладки и вкладок под
   * запущенных больше не открывает. Их разговоры — настоящих проектов, то есть
   * не песочница: без достройки детей они не показались бы нигде.
   */
  it('запущенные из домашнего чата видны ветвями на домашней вкладке', () => {
    const rows = visibleChats([
      chat({ id: 'домашний', isSandbox: true }),
      chat({ id: 'запущенный-в-проекте', parentId: 'домашний' }),
      chat({ id: 'чужой-проектный' }),
    ]);

    expect(rows.map((row) => row.id)).toEqual(['домашний', 'запущенный-в-проекте']);
  });

  it('разделение в проекте без git не удваивает строки', () => {
    // Копий репозитория нет, поэтому дочерние чаты лежат в ТОМ ЖЕ каталоге и
    // уже отобраны как свои. Без проверки они приезжали вторым списком.
    const rows = visibleChats(
      [
        chat({ id: 'родитель' }),
        chat({ id: 'дитя-A', parentId: 'родитель' }),
        chat({ id: 'дитя-B', parentId: 'родитель' }),
      ],
      PROJECT,
    );

    expect(rows.map((row) => row.id)).toEqual(['родитель', 'дитя-A', 'дитя-B']);
  });

  it('чат из копии репозитория виден под своим родителем', () => {
    const rows = visibleChats(
      [
        chat({ id: 'родитель' }),
        chat({
          id: 'дитя',
          parentId: 'родитель',
          projectPath: 'C:/work/demo-worktrees/task-a',
        }),
      ],
      PROJECT,
    );

    expect(rows.map((row) => row.id)).toEqual(['родитель', 'дитя']);
  });

  /**
   * Проект у Claude Code — рабочий каталог запуска. Разговор, начатый на этаж
   * глубже, заводит собственную запись, и вкладка корня показывала «0 из 0» при
   * открытом в ней же разговоре.
   */
  it('разговор из подкаталога проекта виден во вкладке его корня', () => {
    const rows = visibleChats(
      [chat({ id: 'в-корне' }), chat({ id: 'в-подкаталоге', projectPath: 'D:/work/demo/widget' })],
      PROJECT,
    );

    expect(rows.map((row) => row.id)).toEqual(['в-корне']);

    const nested = visibleChats(
      [chat({ id: 'в-корне' }), chat({ id: 'в-подкаталоге', projectPath: 'C:/work/demo/widget' })],
      PROJECT,
    );

    expect(nested.map((row) => row.id)).toEqual(['в-корне', 'в-подкаталоге']);
  });

  it('сосед с тем же началом пути остаётся в своей вкладке', () => {
    // `demo` и `demo-admin` — разные проекты: сравнение идёт по границе сегмента.
    const rows = visibleChats(
      [chat({ id: 'свой' }), chat({ id: 'соседний', projectPath: 'C:/work/demo-admin' })],
      PROJECT,
    );

    expect(rows.map((row) => row.id)).toEqual(['свой']);
  });

  /**
   * Разделение внутри ребёнка рождает внука. Один ярус достройки его не
   * доставал: свой каталог не подходит (чат живёт в копии репозитория), а
   * родитель ему — не корень списка, а сам достроенный ребёнок. Разговор
   * существовал, шёл, тратил лимит — и не показывался нигде.
   */
  it('внук разделения виден в списке проекта', () => {
    const rows = visibleChats(
      [
        chat({ id: 'родитель' }),
        chat({ id: 'дитя', parentId: 'родитель', projectPath: 'C:/work/demo-worktrees/a' }),
        chat({ id: 'внук', parentId: 'дитя', projectPath: 'C:/work/demo-worktrees/a-a' }),
      ],
      PROJECT,
    );

    expect(rows.map((row) => row.id)).toEqual(['родитель', 'дитя', 'внук']);
  });

  it('петля в родителях не зацикливает отбор', () => {
    // Родство берётся из транскриптов, а не из базы с ограничениями: пара
    // чатов, назначивших родителями друг друга, обязана просто не показаться —
    // корня у этой ветви нет, — а не вешать список.
    const rows = visibleChats(
      [
        chat({ id: 'родитель' }),
        chat({ id: 'A', parentId: 'B', projectPath: 'C:/work/demo-worktrees/a' }),
        chat({ id: 'B', parentId: 'A', projectPath: 'C:/work/demo-worktrees/b' }),
      ],
      PROJECT,
    );

    expect(rows.map((row) => row.id)).toEqual(['родитель']);
  });

  it('чужой чат из копии не подтягивается: родителя в этом проекте нет', () => {
    const rows = visibleChats(
      [
        chat({ id: 'родитель' }),
        chat({
          id: 'чужое-дитя',
          parentId: 'другой-родитель',
          projectPath: 'C:/work/другой-worktrees/task-a',
        }),
      ],
      PROJECT,
    );

    expect(rows.map((row) => row.id)).toEqual(['родитель']);
  });
});
