import { describe, it, expect } from 'vitest';
import type { EscalationNotice } from '@agentdeck/contracts/chat-group-settings';
import type { AppState } from './app-store.types.ts';
import {
  addChatEscalation,
  aliasChatSession,
  canonicalChatKey,
  getChatGroupSettings,
  markChatEscalationsRead,
  setChatGroupSettings,
} from './chat-group-settings.ts';

/**
 * Ревью 28.09 (F-200): ключи искались на простых объектах — id чата
 * `constructor`/`toString` находил члены `Object.prototype`, и маршрут отвечал 500.
 */
describe('chat-group-settings: ключ из прототипа — обычный ключ', () => {
  const notice = { childChatId: 'c', text: 't' } as EscalationNotice;

  it('constructor / toString / __proto__ не роняют чтение и запись', () => {
    const state = { chatEscalations: {}, chatGroupSettings: {} } as unknown as AppState;
    expect(markChatEscalationsRead(state, 'constructor', 'now')).toBe(false);
    expect(getChatGroupSettings(state, 'constructor')).toBeUndefined();
    expect(addChatEscalation(state, 'toString', notice)).toBe(true);
    expect(addChatEscalation(state, 'toString', notice)).toBe(false);
    expect(markChatEscalationsRead(state, 'toString', 'now')).toBe(true);
    expect(aliasChatSession(state, 'hasOwnProperty', 'real-session')).toBe(true);
    expect(getChatGroupSettings(state, '__proto__')).toBeUndefined();
  });
});

/**
 * Ревью 28.09 (F-111): синонимы ключа были одноуровневыми, а прежняя версия
 * писала цепочки `new-1 → s1 → s2` — такие уже лежат в `state.json`.
 */
describe('chat-group-settings: синонимы ключа разговора', () => {
  it('цепочка из старого state.json разрешается до записи', () => {
    const state = {
      chatKeyAliases: { 'new-1': 's1', s1: 's2' },
      chatGroupSettings: { s2: { autonomous: false } },
    } as unknown as AppState;
    expect(canonicalChatKey(state, 'new-1')).toBe('s2');
    expect(getChatGroupSettings(state, 'new-1')).toEqual({ autonomous: false });
  });

  it('петля в синонимах не вешает чтение', () => {
    const state = { chatKeyAliases: { a: 'b', b: 'a' } } as unknown as AppState;
    expect(['a', 'b']).toContain(canonicalChatKey(state, 'a'));
  });

  it('первая сессия ключа: запись переезжает, синонимы на ключ смотрят дальше', () => {
    const state = { chatKeyAliases: { 'old-tab': 'new-1' } } as unknown as AppState;
    setChatGroupSettings(state, 'new-1', { autonomous: false });
    expect(aliasChatSession(state, 'new-1', 's1')).toBe(true);
    expect(state.chatKeyAliases).toEqual({ 'old-tab': 's1', 'new-1': 's1' });
    expect(getChatGroupSettings(state, 'old-tab')).toEqual({ autonomous: false });
  });

  it('ветвление: копия ветке, исходный разговор и его синонимы — при своём', () => {
    const state = {} as AppState;
    setChatGroupSettings(state, 'new-1', { autonomous: false });
    aliasChatSession(state, 'new-1', 's1');
    // Прогон под `new-1` продолжал s1, CLI назвал ветку s2.
    expect(aliasChatSession(state, 'new-1', 's2', 's1')).toBe(true);
    expect(getChatGroupSettings(state, 's2')).toEqual({ autonomous: false });
    setChatGroupSettings(state, 's2', { autonomous: true });
    expect(getChatGroupSettings(state, 's1')).toEqual({ autonomous: false });
    expect(getChatGroupSettings(state, 'new-1')).toEqual({ autonomous: false });
    // Своё у ветки повторным событием не перетирается.
    expect(aliasChatSession(state, 'new-1', 's2', 's1')).toBe(false);
    expect(getChatGroupSettings(state, 's2')).toEqual({ autonomous: true });
  });

  it('ключ уже синоним другой сессии, прежнюю реестр не помнит, — тоже ветвление', () => {
    const state = {} as AppState;
    setChatGroupSettings(state, 'new-1', { groupChoice: 'global:g1' });
    aliasChatSession(state, 'new-1', 's1');
    aliasChatSession(state, 'new-1', 's2');
    expect(getChatGroupSettings(state, 's2')).toEqual({ groupChoice: 'global:g1' });
    expect(getChatGroupSettings(state, 's1')).toEqual({ groupChoice: 'global:g1' });
    expect(canonicalChatKey(state, 'new-1')).toBe('s1');
  });
});
