import { describe, it, expect } from 'vitest';
import { buildProgress } from './ChatProgress.ts';
import type { TranscriptRecord } from './ChatHistory.ts';

/**
 * Прогресс собирается из следа агента в транскрипте: последний `TodoWrite` — это
 * его план, вызовы `Task` — розданная субагентам работа. Панель тут ничего не
 * решает сама, поэтому проверяем ровно чтение: план перезаписывается целиком,
 * а ветка дерева закрывается результатом своего вызова.
 */

function assistant(blocks: unknown[]): TranscriptRecord {
  return {
    type: 'assistant',
    timestamp: '2026-08-01T10:00:00Z',
    message: { content: blocks },
  } as TranscriptRecord;
}

function user(blocks: unknown[]): TranscriptRecord {
  return {
    type: 'user',
    timestamp: '2026-08-01T10:01:00Z',
    message: { content: blocks },
  } as TranscriptRecord;
}

const todoWrite = (todos: { content: string; status: string }[]) => ({
  type: 'tool_use',
  name: 'TodoWrite',
  id: `todo-${todos.length}`,
  input: { todos },
});

describe('buildProgress', () => {
  it('пустой транскрипт — пустой план, а не выдуманный', () => {
    expect(buildProgress([])).toEqual({ tasks: [], agents: [], updatedAt: undefined });
  });

  it('план берётся из ПОСЛЕДНЕГО TodoWrite: агент переписывает его целиком', () => {
    const progress = buildProgress([
      assistant([todoWrite([{ content: 'разобрать код', status: 'in_progress' }])]),
      assistant([
        todoWrite([
          { content: 'разобрать код', status: 'completed' },
          { content: 'починить', status: 'in_progress' },
        ]),
      ]),
    ]);

    expect(progress.tasks).toEqual([
      { text: 'разобрать код', status: 'completed' },
      { text: 'починить', status: 'in_progress' },
    ]);
  });

  it('неизвестный статус чекпоинта считается «не начато», а не роняет разбор', () => {
    const progress = buildProgress([
      assistant([todoWrite([{ content: 'что-то', status: 'странное' }])]),
    ]);
    expect(progress.tasks).toEqual([{ text: 'что-то', status: 'pending' }]);
  });

  it('субагент из Task виден работающим, пока не пришёл его результат', () => {
    const started = buildProgress([
      assistant([
        {
          type: 'tool_use',
          name: 'Task',
          id: 'call-1',
          input: { subagent_type: 'Explore', description: 'найти вызовы' },
        },
      ]),
    ]);
    expect(started.agents).toEqual([
      { id: 'call-1', kind: 'Explore', description: 'найти вызовы', status: 'running' },
    ]);

    const finished = buildProgress([
      assistant([
        {
          type: 'tool_use',
          name: 'Task',
          id: 'call-1',
          input: { subagent_type: 'Explore', description: 'найти вызовы' },
        },
      ]),
      user([{ type: 'tool_result', tool_use_id: 'call-1', content: 'нашёл три места' }]),
    ]);
    expect(finished.agents[0]).toMatchObject({ status: 'done', result: 'нашёл три места' });
  });

  it('упавший субагент помечается упавшим — иначе дерево врало бы про успех', () => {
    const progress = buildProgress([
      assistant([
        { type: 'tool_use', name: 'Task', id: 'call-2', input: { description: 'сборка' } },
      ]),
      user([
        { type: 'tool_result', tool_use_id: 'call-2', is_error: true, content: 'не собралось' },
      ]),
    ]);

    expect(progress.agents[0]).toMatchObject({ status: 'failed', kind: 'agent' });
  });

  it('результат приходит и списком блоков, а не только строкой', () => {
    const progress = buildProgress([
      assistant([
        { type: 'tool_use', name: 'Task', id: 'call-3', input: { description: 'обзор' } },
      ]),
      user([
        {
          type: 'tool_result',
          tool_use_id: 'call-3',
          content: [{ type: 'text', text: 'первая строка' }],
        },
      ]),
    ]);

    expect(progress.agents[0]?.result).toBe('первая строка');
  });

  /**
   * Фоновый субагент отвечает распиской о запуске сразу — работа при этом ещё
   * идёт. Считать такую ветку готовой значило бы врать, а сама расписка
   * (со служебным идентификатором внутри) человеку не предназначена.
   */
  it('расписка фонового запуска не закрывает ветку и в панель не попадает', () => {
    const progress = buildProgress([
      assistant([
        {
          type: 'tool_use',
          name: 'Task',
          id: 'call-4',
          input: { subagent_type: 'general-purpose', description: 'аудит' },
        },
      ]),
      user([
        {
          type: 'tool_result',
          tool_use_id: 'call-4',
          content: 'Async agent launched successfully.\nagentId: ae6240827e9cad501',
        },
      ]),
    ]);

    expect(progress.agents[0]).toMatchObject({ status: 'running' });
    expect(progress.agents[0]?.result).toBeUndefined();
  });

  it('служебный идентификатор не просачивается в показанный результат', () => {
    const progress = buildProgress([
      assistant([
        { type: 'tool_use', name: 'Task', id: 'call-5', input: { description: 'обзор' } },
      ]),
      user([
        {
          type: 'tool_result',
          tool_use_id: 'call-5',
          content: 'нашёл три места\nagentId: ae6240827e9cad501',
        },
      ]),
    ]);

    expect(progress.agents[0]?.result).toBe('нашёл три места');
  });

  /** Результат чужого вызова (не субагента) ветку не заводит и не портит. */
  it('результат постороннего инструмента ничего не добавляет в дерево', () => {
    const progress = buildProgress([
      user([{ type: 'tool_result', tool_use_id: 'read-1', content: 'файл' }]),
    ]);
    expect(progress.agents).toEqual([]);
  });
});
