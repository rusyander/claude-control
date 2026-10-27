import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from './app-store.ts';
import { recordChatFork } from './chat-forks.ts';
import type { AppState } from './app-store.types.ts';

/**
 * Запись «ветка → исходный разговор» (Telegram 26.10, R2): по ней список
 * подписывает ветку правки реплики. Стор настоящий, каталог данных — временный.
 */
describe('ветки правки реплики в сторе', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chat-forks-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('та же сессия веткой себя не становится, повтор не пишется', () => {
    const state = {} as AppState;
    expect(recordChatFork(state, 'same', 'same')).toBe(false);
    expect(state.chatForks).toBeUndefined();

    expect(recordChatFork(state, 'fork', 'origin')).toBe(true);
    expect(recordChatFork(state, 'fork', 'origin')).toBe(false);
    expect(state.chatForks).toEqual({ fork: 'origin' });
  });

  it('потолок записей: старейшие уходят первыми', () => {
    const state = {} as AppState;
    for (let index = 0; index < 501; index += 1) recordChatFork(state, `f${index}`, 'origin');

    const forks = state.chatForks ?? {};
    expect(Object.keys(forks)).toHaveLength(500);
    expect(forks.f0).toBeUndefined();
    expect(forks.f500).toBe('origin');
  });

  it('стор: связь сессии с from пишет ветку, без from — нет', () => {
    const store = new AppStore(join(root, 'data'));
    store.linkChatSession('new-1', 'plain-session');
    store.linkChatSession('new-2', 'fork-session', 'origin-session');

    expect(store.getChatForks()).toEqual({ 'fork-session': 'origin-session' });
  });

  it('снимок с другой машины ветки здешней машины не стирает и чужие не приносит', () => {
    const store = new AppStore(join(root, 'data'));
    store.linkChatSession('new-1', 'here-fork', 'here-origin');

    store.importForeignState({ chatForks: { 'there-fork': 'there-origin' } });

    expect(store.getChatForks()).toEqual({ 'here-fork': 'here-origin' });
  });
});
