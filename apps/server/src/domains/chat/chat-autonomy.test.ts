import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudePaths, Group } from '@agentdeck/contracts';
import {
  AUTONOMOUS_ENV,
  type StoredChatGroupSettings,
} from '@agentdeck/contracts/chat-group-settings';
import { AppStore } from '../../lib/app-store.ts';
import {
  activateChosenGroup,
  chatGroupSettingsView,
  rootChatOf,
  storeTreeReader,
  withAutonomy,
  type ChatTreeReader,
} from './chat-autonomy.ts';

/**
 * Группа и автономность чата по дереву разделения. Проверяется то, ради чего
 * настройка ЧАТА, а не проекта: ребёнок без своего берёт родительское, правка у
 * ребёнка не трогает родителя, петля в связях не вешает сервер, метка автономии
 * снимается безусловно, а явная группа только включается.
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
    expect(rootChatOf(reader, ['a'])).toBe('b');
  });

  it('главный чат — вершина дерева; у корня — он сам', () => {
    const reader = tree({}, { kid: 'root', grandkid: 'kid' });
    expect(rootChatOf(reader, ['grandkid'])).toBe('root');
    expect(rootChatOf(reader, ['root'])).toBe('root');
    expect(rootChatOf(reader, ['new-9', 'sess-9'])).toBe('sess-9');
  });
});

describe('метка автономии в окружении', () => {
  it('включена — ставится', () => {
    expect(withAutonomy({ A: '1' }, true)).toEqual({ A: '1', [AUTONOMOUS_ENV]: '1' });
  });

  it('выключена — снимается, даже пришедшая с прошлой жизни прогона', () => {
    expect(withAutonomy({ A: '1', [AUTONOMOUS_ENV]: '1' }, false)).toEqual({ A: '1' });
    expect(withAutonomy(undefined, false)).toEqual({});
  });
});

describe('явно выбранная группа к старту', () => {
  let dir: string;
  let store: AppStore;
  let paths: ClaudePaths;

  const group = (patch: Partial<Group>): Group => ({
    id: 'g1',
    name: 'Набор',
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [],
    env: {},
    projectPaths: [],
    isEnabled: false,
    order: 0,
    ...patch,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-chat-group-'));
    mkdirSync(join(dir, 'agentdeck'), { recursive: true });
    writeFileSync(join(dir, 'settings.json'), '{}', 'utf8');
    store = new AppStore(join(dir, 'agentdeck'));
    paths = {
      root: dir,
      settings: join(dir, 'settings.json'),
      settingsLocal: join(dir, 'settings.local.json'),
      claudeMd: join(dir, 'CLAUDE.md'),
      secretsEnv: join(dir, '.mcp-secrets.env'),
      skills: join(dir, 'skills'),
      hooks: join(dir, 'hooks'),
      mcpConfig: join(dir, '.claude.json'),
      appData: join(dir, 'agentdeck'),
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('выключенная глобальная группа включается', () => {
    store.saveGroup(group({}));
    expect(activateChosenGroup({ paths, store }, 'global:g1')).toBe('Набор');
    expect(store.getGroups()[0]?.isEnabled).toBe(true);
  });

  it('уже включённая, «авто» и проектная — не трогаются', () => {
    store.saveGroup(group({ isEnabled: true }));
    expect(activateChosenGroup({ paths, store }, 'global:g1')).toBeUndefined();
    expect(activateChosenGroup({ paths, store }, 'auto')).toBeUndefined();
    expect(activateChosenGroup({ paths, store }, 'project:g1')).toBeUndefined();
    expect(activateChosenGroup({ paths, store }, 'global:missing')).toBeUndefined();
  });

  it('проектная группа не включается, даже если лежит в хранилище под своим ключом', () => {
    // Проектная группа — файлы самого проекта: включать её глобально значило бы
    // раздать её правила всем чатам всех проектов.
    store.saveGroup(
      group({ id: 'p1', scope: { kind: 'project', path: 'C:/work/p', provider: 'claude' } }),
    );
    expect(activateChosenGroup({ paths, store }, 'project:p1')).toBeUndefined();
    expect(store.getGroups().find((item) => item.id === 'p1')?.isEnabled).toBe(false);
  });

  it('дерево по хранилищу: связь и своё под обоими ключами', () => {
    store.setChatLink('new-1', { parentChatId: 'root', createdAt: '2026-09-26T00:00:00Z' });
    store.setChatGroupSettings('root', { autonomous: false });
    store.setChatGroupSettings('new-1', { groupChoice: 'global:g1' });
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
