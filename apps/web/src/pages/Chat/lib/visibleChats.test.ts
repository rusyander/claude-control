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
