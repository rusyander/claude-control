import { describe, it, expect } from 'vitest';
import type { ChatTreeView, SplitGroupStatusView } from '@agentdeck/contracts/chat-handoff';
import { splitLocked } from './splitLocked';

/**
 * Находка 12 живого прогона 24.09.2026: при разборе ответ маршрута пуст
 * (`chats: []`), кнопка «Разделить» оживала — второе нажатие заводило второй
 * разбор поверх плана. Кнопку держит запись конвейера из дерева.
 */
function tree(parent: string, statuses: SplitGroupStatusView[]): ChatTreeView {
  return {
    root: 'корень',
    split: {
      parentChatId: parent,
      order: statuses.map((_, index) => index),
      groups: statuses.map((status, index) => ({
        index,
        title: `г${index}`,
        branch: `g${index}`,
        after: [],
        status,
      })),
    },
  } as unknown as ChatTreeView;
}

describe('splitLocked — кнопка «Разделить» заперта, пока разделение идёт', () => {
  it('запрос идёт — заперта, что бы ни было в дереве', () => {
    expect(splitLocked(true, undefined, 'чат')).toBe(true);
  });

  it('разбор идёт (группы ждут итога) — заперта, хотя чатов в ответе не было', () => {
    expect(splitLocked(false, tree('чат', ['pending', 'pending']), 'чат')).toBe(true);
  });

  it('одна группа ещё работает — заперта', () => {
    expect(splitLocked(false, tree('чат', ['done', 'started']), 'чат')).toBe(true);
  });

  it('все группы закрыты (готово/сбой) — открыта для нового разделения', () => {
    expect(splitLocked(false, tree('чат', ['done', 'failed']), 'чат')).toBe(false);
  });

  it('разделение чужого разговора дерева кнопку не держит', () => {
    expect(splitLocked(false, tree('корень', ['started']), 'чат')).toBe(false);
  });

  it('без дерева и без разделения — открыта', () => {
    expect(splitLocked(false, undefined, 'чат')).toBe(false);
    expect(splitLocked(false, { root: 'чат' } as ChatTreeView, 'чат')).toBe(false);
    expect(splitLocked(false, tree('чат', ['started']), undefined)).toBe(false);
  });
});
