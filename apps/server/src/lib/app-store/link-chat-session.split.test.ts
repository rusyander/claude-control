import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from './store.ts';
import type { SplitPlanRecord } from './app-store.types.ts';

/**
 * Ревью 28.09 (F-111, пробел теста): запись разделения под временным ключом
 * `new-…` переезжает на настоящую сессию, только когда это продолжение того же
 * разговора. Ветка правки (`from` — прежняя сессия) — другой разговор: групп у
 * неё нет, и перенос увёл бы дерево исходного чата к ветке. Сторож `!from` в
 * `linkChatSession` ни один тест не держал — снятый, он оставлял набор зелёным.
 */
describe('linkChatSession и запись разделения (F-111)', () => {
  let dir = '';
  let store: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-link-split-'));
    store = new AppStore(dir);
    store.setSplitPlan({
      parentChatId: 'new-7',
      projectPath: join(dir, 'work'),
      createdAt: '2026-09-28T10:00:00.000Z',
      order: [0],
      request: {},
      proposal: { groups: [] },
      groups: [{ index: 0, status: 'running', chatId: 'g-0' }],
    } as unknown as SplitPlanRecord);
    store.setChatLink('g-0', { parentChatId: 'new-7', createdAt: '2026-09-28T10:00:00Z' });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('продолжение (без from) — запись и связи групп едут на настоящий ключ', () => {
    store.linkChatSession('new-7', 'sess-main');
    expect(Object.keys(store.getSplitPlans())).toEqual(['sess-main']);
    // Прежний ключ ведёт на переехавшую запись.
    expect(store.getSplitPlan('new-7')?.parentChatId).toBe('sess-main');
    expect(store.getChatLink('g-0')?.parentChatId).toBe('sess-main');
  });

  it('ветка правки (from) — запись остаётся у исходного ключа, группы не уходят к ветке', () => {
    store.linkChatSession('new-7', 'sess-branch', 'sess-original');
    expect(Object.keys(store.getSplitPlans())).toEqual(['new-7']);
    expect(store.getSplitPlan('sess-branch')).toBeUndefined();
    expect(store.getSplitPlan('new-7')?.parentChatId).toBe('new-7');
    expect(store.getChatLink('g-0')?.parentChatId).toBe('new-7');
  });
});
