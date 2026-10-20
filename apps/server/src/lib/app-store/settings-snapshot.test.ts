import { describe, it, expect } from 'vitest';
import { DEFAULT_STATE } from './app-store.constants.ts';
import type { AppState } from './app-store.types.ts';
import { applyPortable, portableOf, PORTABLE_KEYS } from './settings-snapshot.ts';

/**
 * Снимок настроек для git: что уезжает на другую машину, а что остаётся здесь.
 * Опасность в обе стороны: уехавшая ссылка на чат или адрес Tailscale ведёт
 * в чужую машину, а молча оставшаяся группа — «на ноутбуке не те настройки».
 */
const WIN = { home: 'C:\\Users\\alice', platform: 'win32' as const };
const LINUX = { home: '/home/bob', platform: 'linux' as const };

function stateWith(patch: Partial<AppState>): AppState {
  return { ...structuredClone(DEFAULT_STATE), ...patch };
}

describe('settings snapshot', () => {
  it('берёт только переносимые поля, без настроек машины и секретов', () => {
    const state = stateWith({
      chatLinks: { k: { sessionId: 's' } } as unknown as AppState['chatLinks'],
      settings: {
        ...DEFAULT_STATE.settings,
        backupKeep: 7,
        claudeDirOverride: 'D:\\cfg',
        remoteAccess: { enabled: true, publicUrl: 'https://box.ts.net', notify: true },
      },
      envByGroup: { g: ['A=1'] },
    });
    const portable = portableOf(state, WIN);
    expect(portable.chatLinks).toBeUndefined();
    const settings = portable.settings as Record<string, unknown>;
    expect(settings.backupKeep).toBe(7);
    expect(settings).not.toHaveProperty('claudeDirOverride');
    expect(settings).not.toHaveProperty('remoteAccess');
    expect(portable.envByGroup).toEqual({ g: ['A=1'] });
    expect(PORTABLE_KEYS).not.toContain('pushDevices');
    expect(PORTABLE_KEYS).not.toContain('secretBackupVerifier');
  });

  it('строковое значение под секретным ключом в снимок не попадает', () => {
    const state = stateWith({
      runnerPrefs: { p: { apiToken: 'sk-live', apiKey: '', note: 'keep' } },
    } as unknown as Partial<AppState>);
    const prefs = (portableOf(state, WIN).runnerPrefs as Record<string, Record<string, unknown>>)
      .p as Record<string, unknown>;
    expect(prefs).not.toHaveProperty('apiToken');
    expect(prefs.apiKey).toBe('');
    expect(prefs.note).toBe('keep');
  });

  it('путь под домом Windows уезжает меткой и возвращается домом Linux', () => {
    const state = stateWith({
      projects: [
        { id: 'a', name: 'a', path: 'C:\\Users\\alice\\work\\app' },
        { id: 'b', name: 'b', path: 'c:/users/alice/work/lib' },
        { id: 'c', name: 'c', path: 'D:\\other' },
        { id: 'd', name: 'd', path: 'C:\\Users\\alice2\\x' },
      ],
    });
    const portable = portableOf(state, WIN);
    expect((portable.projects as { path: string }[]).map((p) => p.path)).toEqual([
      '<HOME>\\work\\app',
      '<home>/work/lib',
      'D:\\other',
      'C:\\Users\\alice2\\x',
    ]);
    const onLinux = applyPortable(DEFAULT_STATE, portable as Partial<AppState>, LINUX);
    expect(onLinux.projects.map((p) => p.path)).toEqual([
      '/home/bob/work/app',
      '/home/bob/work/lib',
      'D:\\other',
      'C:\\Users\\alice2\\x',
    ]);
  });

  // Ключи по проекту на Windows сложены в нижний регистр: на Linux/macOS они не находили проект.
  it('настройки проекта с Windows находят свой проект на Linux и macOS', () => {
    const state = stateWith({
      projects: [{ id: 'a', name: 'a', path: 'C:\\Users\\alice\\MyProj' }],
      runnerPrefs: { 'c:/users/alice/myproj': { x: 1 } },
    } as unknown as Partial<AppState>);
    const portable = portableOf(state, WIN) as Partial<AppState>;
    for (const target of [LINUX, { home: '/Users/bob', platform: 'darwin' as const }]) {
      const there = applyPortable(DEFAULT_STATE, portable, target);
      const path = there.projects[0]?.path as string;
      expect(path).toBe(`${target.home}/MyProj`);
      expect(Object.keys(there.runnerPrefs)).toEqual([path]);
    }
  });

  it('путь Linux возвращается домом Windows с обратными чертами', () => {
    const state = stateWith({ projects: [{ id: 'a', name: 'a', path: '/home/bob/src/app' }] });
    const back = applyPortable(DEFAULT_STATE, portableOf(state, LINUX) as Partial<AppState>, WIN);
    expect(back.projects[0]?.path).toBe('C:\\Users\\alice/src/app');
  });

  it('применение не трогает здешнее и дополняет выключенные правила', () => {
    const local = stateWith({
      chatLinks: { k: { sessionId: 's' } } as unknown as AppState['chatLinks'],
      settings: {
        ...DEFAULT_STATE.settings,
        remoteAccess: { enabled: true, publicUrl: 'https://here', notify: false },
      },
      disabledRules: [{ title: 'Own', body: 'mine', after: null, before: null, index: 0 }],
    });
    const brought = {
      settings: { backupKeep: 3, remoteAccess: { enabled: false, publicUrl: 'https://there' } },
      disabledRules: [
        { title: 'own ', body: 'theirs', after: null, before: null, index: 0 },
        { title: 'New', body: 'b', after: null, before: null, index: 1 },
      ],
    } as unknown as Partial<AppState>;
    const next = applyPortable(local, brought, WIN);
    expect(next.chatLinks).toEqual(local.chatLinks);
    expect(next.settings.backupKeep).toBe(3);
    expect(next.settings.remoteAccess.publicUrl).toBe('https://here');
    expect(next.disabledRules?.map((rule) => `${rule.title}:${rule.body}`)).toEqual([
      'Own:mine',
      'New:b',
    ]);
  });
});
