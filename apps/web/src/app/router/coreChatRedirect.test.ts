import { describe, expect, it } from 'vitest';
import { coreChatTarget } from './coreChatRedirect';

/**
 * Старый адрес `/core/chat` → `/chat` (W3-17a): проект переходит, разговор задачи — если книга
 * чата его знает, иначе просто чат. `cli`/`resume` снимает уже `validateSearch` (свой тест).
 */
describe('old /core/chat address lands in /chat', () => {
  it('keeps the project', () => {
    expect(coreChatTarget({ project: 'C:/w/app' }, null)).toEqual({
      to: '/chat',
      search: { project: 'C:/w/app' },
    });
  });

  it('a task the chat book knows opens its conversation; an unknown one opens plain /chat', () => {
    expect(coreChatTarget({ id: 'task-1', project: 'C:/w/app' }, { chatId: 'conv-1' })).toEqual({
      to: '/chat',
      search: { id: 'conv-1', project: 'C:/w/app' },
    });
    expect(coreChatTarget({ id: 'task-0' }, null)).toEqual({ to: '/chat', search: {} });
    expect(coreChatTarget({ id: 'task-0' }, { chatId: null })).toEqual({ to: '/chat', search: {} });
  });

  it('without a project in the address the tab is the one the server names for the conversation (takeover chat in a unit copy)', () => {
    expect(coreChatTarget({ id: 'task-2' }, { chatId: 'conv-2', project: 'C:/w/repo' })).toEqual({
      to: '/chat',
      search: { id: 'conv-2', project: 'C:/w/repo' },
    });
    // Проект адреса сильнее; без разговора вкладку сервера не открываем.
    expect(
      coreChatTarget(
        { id: 'task-2', project: 'C:/w/app' },
        { chatId: 'conv-2', project: 'C:/w/repo' },
      ),
    ).toEqual({ to: '/chat', search: { id: 'conv-2', project: 'C:/w/app' } });
    expect(coreChatTarget({ id: 'task-3' }, { chatId: null, project: 'C:/w/repo' })).toEqual({
      to: '/chat',
      search: {},
    });
  });
});
