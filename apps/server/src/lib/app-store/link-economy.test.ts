import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GROUP_ECONOMY_DEFAULTS } from '@agentdeck/contracts/group-economy';
import { AppStore } from './store.ts';
import { carriedLink } from './chat-links.ts';

/**
 * Рычаги экономии закреплены за разговором (директива §4: никаких смен начала
 * запроса посреди тёплой сессии). Строка привычек — в системном промпте,
 * отвязка от редактора меняет набор инструментов: включи их между ходами — и
 * продолжение переписало бы весь кэш. Новые настройки — новым разговорам.
 */
describe('linkEconomy — рычаги, с которыми разговор стартовал', () => {
  let dir = '';
  let store: AppStore;
  const started = { ...GROUP_ECONOMY_DEFAULTS, workHabits: false };
  const changed = { ...GROUP_ECONOMY_DEFAULTS, workHabits: true, detachIde: false };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-link-economy-'));
    store = new AppStore(dir);
    store.setChatLink('new-1', { parentChatId: 'p', createdAt: '2026-10-21T10:00:00.000Z' });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('первый старт закрепляет текущие; продолжение под настоящим ключом берёт их же', () => {
    expect(store.linkEconomy(['new-1'], started)).toEqual(started);
    store.linkChatSession('new-1', 'sess-1');
    expect(store.linkEconomy(['sess-1'], changed)).toEqual(started);
    // И после перезапуска панели: закрепление в состоянии, а не в памяти.
    expect(new AppStore(dir).linkEconomy(['sess-1'], changed)).toEqual(started);
  });

  it('закрепление пишется под всеми ключами разговора — дерево не раздваивается', () => {
    store.linkChatSession('new-1', 'sess-1');
    store.linkEconomy(['new-1'], started);
    expect(store.getChatLink('sess-1')?.economy).toEqual(started);
    expect(store.getChatLink('new-1')).toEqual(store.getChatLink('sess-1'));
  });

  it('новый разговор группы (связь перенесена) и разговор без связи — текущие', () => {
    store.linkEconomy(['new-1'], started);
    store.setChatLink('new-2', carriedLink(store.getChatLink('new-1')!));
    expect(store.linkEconomy(['new-2'], changed)).toEqual(changed);
    expect(store.linkEconomy(['чужой'], changed)).toEqual(changed);
  });
});
