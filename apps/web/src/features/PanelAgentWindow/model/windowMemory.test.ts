import { describe, expect, it } from 'vitest';
import type { PanelAgentConversation } from '@agentdeck/contracts/panel-agent';
import { restoredConversation } from './restoredConversation';
import { WINDOW_MEMORY_KEY } from './windowMemory.constants';
import { readWindowMemory } from './readWindowMemory';
import { writeWindowMemory } from './writeWindowMemory';
import { closeSkippedTurn } from './closeSkippedTurn';

const memoryStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    map,
  };
};

const conversation = (last: 'user' | 'assistant'): PanelAgentConversation => ({
  id: 'conv-1',
  createdAt: '2026-09-26T00:00:00.000Z',
  updatedAt: '2026-09-26T00:00:00.000Z',
  context: { route: '/' },
  messages: [
    { role: 'user', content: 'сколько правил', at: '2026-09-26T00:00:00.000Z' },
    { role: 'assistant', content: 'Три.', at: '2026-09-26T00:00:01.000Z' },
    ...(last === 'user'
      ? [{ role: 'user' as const, content: 'включи контур dev', at: '2026-09-26T00:00:02.000Z' }]
      : []),
  ],
});

describe('окно агента через F5', () => {
  it('разговор вкладки переживает перезагрузку: записали — прочли тот же id и признак хода', () => {
    const storage = memoryStorage();
    writeWindowMemory(storage, { conversationId: 'conv-1', turnOpen: true });
    expect(readWindowMemory(storage)).toEqual({ conversationId: 'conv-1', turnOpen: true });
    writeWindowMemory(storage, { conversationId: 'conv-1', turnOpen: false });
    expect(readWindowMemory(storage)).toEqual({ conversationId: 'conv-1', turnOpen: false });
  });

  it('«Новый разговор» стирает память: после F5 окно пустое', () => {
    const storage = memoryStorage();
    writeWindowMemory(storage, { conversationId: 'conv-1', turnOpen: false });
    writeWindowMemory(storage, undefined);
    expect(storage.map.has(WINDOW_MEMORY_KEY)).toBe(false);
    expect(readWindowMemory(storage)).toBeUndefined();
  });

  it('битая запись и недоступное хранилище не роняют окно', () => {
    const storage = memoryStorage();
    storage.setItem(WINDOW_MEMORY_KEY, '{не json');
    expect(readWindowMemory(storage)).toBeUndefined();
    storage.setItem(WINDOW_MEMORY_KEY, JSON.stringify({ conversationId: '' }));
    expect(readWindowMemory(storage)).toBeUndefined();
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => undefined,
    };
    expect(readWindowMemory(throwing)).toBeUndefined();
    expect(() =>
      writeWindowMemory(throwing, { conversationId: 'x', turnOpen: false }),
    ).not.toThrow();
    expect(readWindowMemory(undefined)).toBeUndefined();
  });

  it('ход оборван перезагрузкой: разговор на месте, заметка объясняет, просьба не уйдёт повторно', () => {
    const state = restoredConversation(conversation('user'), true, 'ход оборвала перезагрузка');
    expect(state.conversationId).toBe('conv-1');
    expect(state.running).toBe(false);
    expect(state.feed.map((item) => item.kind)).toEqual(['user', 'assistant', 'user', 'error']);
    expect(state.feed.at(-1)?.text).toBe('ход оборвала перезагрузка');
    // Оборванная просьба видна, но в историю следующего хода не идёт.
    expect(state.messages.map((message) => message.content)).toEqual(['сколько правил', 'Три.']);
  });

  it('ход закончился до перезагрузки — разговор без заметки', () => {
    const state = restoredConversation(conversation('assistant'), false, 'не должно быть');
    expect(state.feed.some((item) => item.kind === 'error')).toBe(false);
    expect(state.messages).toHaveLength(2);
  });
});

describe('closeSkippedTurn — восстановление пропущено (F-288)', () => {
  it('заметка легла раньше ответа: «ход открыт» снимается, разговор помнится', () => {
    const storage = memoryStorage();
    writeWindowMemory(storage, { conversationId: 'conv-1', turnOpen: true });
    closeSkippedTurn(storage, { conversationId: 'conv-1', turnOpen: true });
    expect(readWindowMemory(storage)).toEqual({ conversationId: 'conv-1', turnOpen: false });
  });

  it('память уже другая (новый разговор) — не трогается', () => {
    const storage = memoryStorage();
    writeWindowMemory(storage, { conversationId: 'conv-2', turnOpen: true });
    closeSkippedTurn(storage, { conversationId: 'conv-1', turnOpen: true });
    expect(readWindowMemory(storage)).toEqual({ conversationId: 'conv-2', turnOpen: true });
  });
});
