import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPLIT_DEFAULTS_BUILTIN } from '@agentdeck/contracts/split-groups';
import { ServerContext } from './context.ts';
import { normalizeProjectPath } from './lib/app-store/projects.ts';

/**
 * Перенос настроек на другую машину через git: снимок рядом со `state.json`,
 * при старте панель применяет снимок, которого сама не писала. Проверяется
 * настоящий старт (`ServerContext`), а не функция слияния: до правки
 * конструктор хранилища успевал переписать принесённый снимок своим, и перенос
 * не срабатывал ни разу.
 */
describe('settings snapshot at startup', () => {
  let root: string;
  let appData: string;
  const previousEnv = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-snapshot-'));
    appData = join(root, 'agentdeck');
    process.env.CLAUDE_CONFIG_DIR = root;
  });

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousEnv;
    rmSync(root, { recursive: true, force: true });
  });

  const snapshotFile = (): string => join(appData, 'settings-snapshot.json');
  const readSnapshot = (): { version: number; state: Record<string, unknown> } =>
    JSON.parse(readFileSync(snapshotFile(), 'utf8')) as {
      version: number;
      state: Record<string, unknown>;
    };

  /** Снимок «с другой машины»: файл, которого эта панель не писала. */
  function pull(state: Record<string, unknown>): void {
    mkdirSync(appData, { recursive: true });
    writeFileSync(snapshotFile(), `${JSON.stringify({ version: 1, state }, null, 2)}\n`);
  }

  it('первый старт пишет снимок, правка настроек его обновляет', () => {
    const ctx = new ServerContext();
    expect(readSnapshot().version).toBe(1);
    ctx.store.updateSettings({ backupKeep: 9 });
    expect((readSnapshot().state.settings as Record<string, unknown>).backupKeep).toBe(9);
  });

  it('свежая машина применяет снимок, записанный другой, а здешнее остаётся своим', () => {
    const other = join(root, 'other-machine');
    mkdirSync(other, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = other;
    const source = new ServerContext();
    const projectPath = join(homedir(), 'work', 'app');
    source.store.addProject({ id: 'p', name: 'app', path: projectPath });
    source.store.updateSettings({
      backupKeep: 4,
      remoteAccess: { enabled: true, publicUrl: 'https://there.ts.net', notify: true },
    });
    const text = readFileSync(join(other, 'agentdeck', 'settings-snapshot.json'), 'utf8');
    expect(text).toContain('<HOME>');
    expect(text).not.toContain('there.ts.net');

    process.env.CLAUDE_CONFIG_DIR = root;
    mkdirSync(appData, { recursive: true });
    writeFileSync(snapshotFile(), text);
    const ctx = new ServerContext();
    expect(ctx.store.getSettings().backupKeep).toBe(4);
    expect(ctx.store.getSettings().remoteAccess.enabled).toBe(false);
    expect(ctx.store.getProjects()).toEqual([{ id: 'p', name: 'app', path: projectPath }]);
  });

  it('свой снимок на следующем старте не применяется повторно', () => {
    pull({ settings: { backupKeep: 4 } });
    const first = new ServerContext();
    first.store.updateSettings({ backupKeep: 6 });
    const second = new ServerContext();
    expect(second.store.getSettings().backupKeep).toBe(6);
  });

  it('снимок, обновлённый git между стартами, применяется при перезапуске', () => {
    const first = new ServerContext();
    first.store.updateSettings({ backupKeep: 6 });
    pull({ settings: { backupKeep: 2 } });
    const second = new ServerContext();
    expect(second.store.getSettings().backupKeep).toBe(2);
  });

  it('испорченный снимок не применяется, панель пишет свой', () => {
    const first = new ServerContext();
    first.store.updateSettings({ backupKeep: 6 });
    mkdirSync(appData, { recursive: true });
    writeFileSync(snapshotFile(), '<<<<<<< HEAD\n{"version":1}\n=======\n');
    const second = new ServerContext();
    expect(second.store.getSettings().backupKeep).toBe(6);
    expect((readSnapshot().state.settings as Record<string, unknown>).backupKeep).toBe(6);
  });

  it('снимок, не прошедший схему, не применяется', () => {
    const first = new ServerContext();
    first.store.updateSettings({ backupKeep: 6 });
    pull({ groups: 'not-an-array', settings: { backupKeep: 1 } });
    const second = new ServerContext();
    expect(second.store.getSettings().backupKeep).toBe(6);
  });

  /**
   * Рычаги решений (решение владельца 24.10): снимок приходит из git, а записать
   * его мог кто угодно с доступом к репозиторию — и агент другой машины тоже.
   * Авторежим, правила автоподтверждения, автопродолжение, сроки D-n, проверка
   * промптов, разрешения и развилки групп, пересылка на телефон и автоприём
   * тестов остаются здешними; нейтральное (число копий, «До MR», потолок групп)
   * приходит как раньше.
   */
  describe('рычаги решений', () => {
    const leverProject = (): string => join(homedir(), 'work', 'levers');
    const LOCAL_LEVERS = {
      chatAutoMode: false,
      autoApproveRules: {},
      handoffAutoDefault: false,
      deferAfterMinutes: 30,
      deferredTtlDays: 3,
      promptGate: { enabled: true, action: 'block' as const },
    };
    const pulledLevers = (key: string): Record<string, unknown> => ({
      settings: {
        backupKeep: 3,
        chatAutoMode: true,
        autoApproveRules: { packagePublish: true, externalDestroy: true },
        handoffAutoDefault: true,
        deferAfterMinutes: 0,
        deferredTtlDays: 90,
        promptGate: { enabled: false, action: 'warn' },
      },
      outsideRelay: true,
      testsAutoAccept: { [key]: true },
      splitDefaults: {
        parallelLight: 3,
        permissions: { packagePublish: 'auto', gitHistory: 'auto' },
      },
      splitSettings: {
        [key]: { deliver: false, permissions: { gitWrite: 'auto', networkExec: 'auto' } },
      },
    });
    const leversOf = (settings: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.keys(LOCAL_LEVERS).map((key) => [key, settings[key]]));

    it('принесённый снимок не переключает рычаги решений, нейтральное применяется', () => {
      const projectPath = leverProject();
      const first = new ServerContext();
      first.store.updateSettings(LOCAL_LEVERS);
      first.store.setOutsideRelay(false);
      first.store.setSplitDefaults({ groupQuestions: 'human' });
      first.store.setSplitSettings(projectPath, {
        deliver: true,
        permissions: { gitWrite: 'human' },
      });
      pull(pulledLevers(normalizeProjectPath(projectPath)));

      const second = new ServerContext();
      const settings = second.store.getSettings();
      expect(settings.backupKeep).toBe(3);
      expect(leversOf(settings as unknown as Record<string, unknown>)).toEqual(LOCAL_LEVERS);
      expect(second.store.getOutsideRelay()).toBe(false);
      expect(second.store.isTestsAutoAccept(projectPath)).toBe(false);
      const defaults = second.store.getSplitDefaults();
      expect(defaults.parallelLight).toBe(3);
      expect(defaults.groupQuestions).toBe('human');
      expect(defaults.permissions.packagePublish).toBe('human');
      expect(second.store.getSplitSettings(projectPath)).toEqual({
        deliver: false,
        permissions: { gitWrite: 'human' },
      });
    });

    it('на свежей машине снимок без ревизии не делает здешние разрешения групп строже или мягче', () => {
      const projectPath = leverProject();
      pull(pulledLevers(normalizeProjectPath(projectPath)));
      const ctx = new ServerContext();
      const defaults = ctx.store.getSplitDefaults();
      expect(defaults.parallelLight).toBe(3);
      expect(defaults.permissions).toEqual(SPLIT_DEFAULTS_BUILTIN.permissions);
      expect(ctx.store.getSplitSettings(projectPath)).toEqual({ deliver: false });
    });

    it('снимок для git не несёт рычагов решений', () => {
      const projectPath = leverProject();
      const ctx = new ServerContext();
      ctx.store.updateSettings({
        ...LOCAL_LEVERS,
        autoApproveRules: { gitWrite: true },
        backupKeep: 5,
      });
      ctx.store.setOutsideRelay(false);
      ctx.store.setTestsAutoAccept(projectPath, true);
      ctx.store.setSplitDefaults({
        groupQuestions: 'human',
        parallelLight: 3,
        permissions: { packagePublish: 'auto' },
      });
      ctx.store.setSplitSettings(projectPath, {
        deliver: false,
        permissions: { gitWrite: 'human' },
      });

      const { state } = readSnapshot();
      const settings = state.settings as Record<string, unknown>;
      expect(settings.backupKeep).toBe(5);
      for (const key of Object.keys(LOCAL_LEVERS)) expect(settings).not.toHaveProperty(key);
      expect(state).not.toHaveProperty('outsideRelay');
      expect(state).not.toHaveProperty('testsAutoAccept');
      expect(state.splitDefaults).toEqual({ parallelLight: 3 });
      expect(Object.values(state.splitSettings as Record<string, unknown>)).toEqual([
        { deliver: false },
      ]);
    });
  });
});
