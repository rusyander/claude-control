import { describe, expect, it } from 'vitest';
import { coreTaskOf, rememberCoreTask } from './useCoreAutoGrant';

const task = { taskId: 'task-1', project: 'repo-abc' };

describe('useCoreAutoGrant — задача ядра чата между ходами', () => {
  it('идущий прогон — его задача', () => {
    expect(coreTaskOf('new-1', { coreTask: task, sessionId: undefined })).toEqual(task);
  });

  it('прогон убран после хода, чат сменил ключ на номер разговора — задача та же', () => {
    rememberCoreTask('new-2', { coreTask: task, sessionId: 'conv-2' });
    // Стор убрал прогон (ответ в истории), страница теперь под номером разговора.
    expect(coreTaskOf('conv-2', { coreTask: undefined, sessionId: undefined })).toEqual(task);
    expect(coreTaskOf('new-2', { coreTask: undefined, sessionId: undefined })).toEqual(task);
  });

  it('чужой чат задачу не наследует — грант ** чужой задаче не уходит', () => {
    rememberCoreTask('new-3', { coreTask: task, sessionId: 'conv-3' });
    expect(coreTaskOf('conv-other', { coreTask: undefined, sessionId: undefined })).toBeUndefined();
  });

  it('новый ход назвал другую задачу — она и действует', () => {
    const next = { taskId: 'task-2', project: 'repo-abc' };
    rememberCoreTask('conv-4', { coreTask: task, sessionId: 'conv-4' });
    rememberCoreTask('conv-4', { coreTask: next, sessionId: 'conv-4' });
    expect(coreTaskOf('conv-4', { coreTask: undefined, sessionId: undefined })).toEqual(next);
  });
});
