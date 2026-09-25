import { describe, expect, it } from 'vitest';
import type { ChatSummary } from '@agentdeck/contracts';
import { childOfRun, runViewChat } from './runViewChat';

const chat = (id: string, parentId?: string): ChatSummary =>
  ({ id, title: id, ...(parentId ? { parentId } : {}) }) as ChatSummary;

const CHATS = [chat('сессия-группы', 'родитель'), chat('сессия-человека')];

/**
 * Чат группы, открытый посреди её хода (живой прогон 25.09.2026, N4): шапка
 * показывала модель и «До MR» проекта до конца хода, потому что вид прогона
 * становился разговором только по концу хода.
 */
describe('вид прогона → разговор', () => {
  it('группа разделения становится разговором сразу, посреди хода', () => {
    expect(runViewChat(CHATS, 'сессия-группы', true)?.id).toBe('сессия-группы');
  });

  it('черновик человека — только по концу первого хода, как раньше', () => {
    expect(runViewChat(CHATS, 'сессия-человека', true)).toBeUndefined();
    expect(runViewChat(CHATS, 'сессия-человека', false)?.id).toBe('сессия-человека');
  });

  it('разговора в списке ещё нет — вид остаётся прогоном', () => {
    expect(runViewChat(CHATS, 'другая', false)).toBeUndefined();
    expect(runViewChat(CHATS, undefined, false)).toBeUndefined();
  });

  it('ребёнок из пульта находится и по sessionId, когда ключ прогона временный', () => {
    expect(childOfRun(CHATS, { id: 'new-1', sessionId: 'сессия-группы' })?.id).toBe(
      'сессия-группы',
    );
    expect(childOfRun(CHATS, { id: 'сессия-группы' })?.id).toBe('сессия-группы');
    // Разговор человека ребёнком не считается — его ведёт прежняя дорога.
    expect(childOfRun(CHATS, { id: 'new-2', sessionId: 'сессия-человека' })).toBeUndefined();
  });
});
