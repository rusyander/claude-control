import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type StoredChatGroupSettings } from '@agentdeck/contracts/chat-group-settings';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import { chatGroupSettingsView, storeTreeReader, type ChatTreeReader } from './chat-autonomy.ts';

/**
 * Группа и автономность чата по дереву разделения. Проверяется то, ради чего
 * настройка ЧАТА, а не проекта: ребёнок без своего берёт родительское, правка у
 * ребёнка не трогает родителя, петля в связях не вешает сервер.
 */
function tree(
  own: Record<string, StoredChatGroupSettings>,
  parents: Record<string, string>,
): ChatTreeReader {
  return { own: (key) => own[key], parentOf: (key) => parents[key] };
}

describe('действующие значения по дереву', () => {
  it('корень без своего — умолчания: авто и автономия включена', () => {
    const view = chatGroupSettingsView(tree({}, {}), ['root']);
    expect(view).toEqual({
      groupChoice: 'auto',
      groupChoiceInherited: false,
      autonomous: true,
      autonomousInherited: false,
    });
  });

  it('ребёнок без своего берёт значения родителя и знает, от кого', () => {
    const reader = tree({ root: { groupChoice: 'global:g1', autonomous: false } }, { kid: 'root' });
    expect(chatGroupSettingsView(reader, ['kid'])).toEqual({
      groupChoice: 'global:g1',
      groupChoiceInherited: true,
      autonomous: false,
      autonomousInherited: true,
      parentChatId: 'root',
    });
  });

  it('внук наследует через ребёнка — до корня', () => {
    const reader = tree({ root: { autonomous: false } }, { kid: 'root', grandkid: 'kid' });
    const view = chatGroupSettingsView(reader, ['grandkid']);
    expect(view.autonomous).toBe(false);
    expect(view.parentChatId).toBe('kid');
  });

  it('своё у ребёнка сильнее родительского и не меняет родителя', () => {
    const reader = tree(
      { root: { groupChoice: 'global:g1', autonomous: true }, kid: { autonomous: false } },
      { kid: 'root' },
    );
    const kid = chatGroupSettingsView(reader, ['kid']);
    expect(kid.autonomous).toBe(false);
    expect(kid.autonomousInherited).toBe(false);
    expect(kid.groupChoice).toBe('global:g1');
    expect(kid.groupChoiceInherited).toBe(true);
    expect(chatGroupSettingsView(reader, ['root']).autonomous).toBe(true);
  });

  it('ключи разговора: своё находится по любому из двух написаний', () => {
    const reader = tree({ 'sess-1': { autonomous: false } }, { 'new-1': 'root' });
    const view = chatGroupSettingsView(reader, ['new-1', 'sess-1']);
    expect(view.autonomous).toBe(false);
    expect(view.parentChatId).toBe('root');
  });

  it('петля в связях не вешает разбор', () => {
    const reader = tree({ a: { autonomous: false } }, { a: 'b', b: 'a' });
    expect(chatGroupSettingsView(reader, ['a']).autonomous).toBe(false);
    expect(chatGroupSettingsView(reader, ['b']).autonomous).toBe(false);
  });
});

describe('дерево по хранилищу панели', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-chat-group-'));
    mkdirSync(join(dir, 'agentdeck'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('связь и своё под обоими ключами (записи прежнего меню чата в state.json)', () => {
    writeFileSync(
      join(dir, 'agentdeck', 'state.json'),
      JSON.stringify({
        chatGroupSettings: { root: { autonomous: false }, 'new-1': { groupChoice: 'global:g1' } },
      }),
      'utf8',
    );
    const store = new AppStore(join(dir, 'agentdeck'));
    store.setChatLink('new-1', { parentChatId: 'root', createdAt: '2026-09-26T00:00:00Z' });
    store.linkChatSession('new-1', 'sess-1');
    const reader = storeTreeReader(store);
    const view = chatGroupSettingsView(reader, ['sess-1']);
    expect(view.groupChoice).toBe('global:g1');
    expect(view.groupChoiceInherited).toBe(false);
    expect(view.autonomous).toBe(false);
    expect(view.parentChatId).toBe('root');
    // Временный ключ вкладки находит ту же запись.
    expect(chatGroupSettingsView(reader, ['new-1']).groupChoice).toBe('global:g1');
  });
});
