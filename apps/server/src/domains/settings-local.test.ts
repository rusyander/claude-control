import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHooks, writeHooks } from './hooks.ts';
import { readPermissions } from './permissions.ts';
import { readEnvVars, saveEnvVar, deleteEnvVar } from './env.ts';
import { AppStore } from '../lib/app-store.ts';

/**
 * settings.local.json Claude Code читает наравне с основным файлом, поэтому
 * панель обязана его показывать — иначе она врёт о том, что действует. Но не
 * писать в него: файл личный.
 *
 * Главный риск здесь — перезапись. `writeHooks` собирает settings.json из
 * плоского списка целиком, а список теперь содержит записи обоих файлов;
 * стоит забыть фильтр — и локальный хук продублируется в основной конфиг.
 * Ровно это и закреплено тестами.
 */
describe('Локальные настройки (settings.local.json)', () => {
  let dir: string;
  let settingsPath: string;
  let localPath: string;
  let secretsPath: string;
  let store: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-local-'));
    settingsPath = join(dir, 'settings.json');
    localPath = join(dir, 'settings.local.json');
    secretsPath = join(dir, '.mcp-secrets.env');
    mkdirSync(join(dir, 'claude-control'), { recursive: true });
    store = new AppStore(join(dir, 'claude-control'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeJson = (path: string, value: unknown): void =>
    writeFileSync(path, JSON.stringify(value, null, 2));

  describe('хуки', () => {
    beforeEach(() => {
      writeJson(settingsPath, {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo основной' }] }] },
      });
      writeJson(localPath, {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo локальный' }] }] },
      });
    });

    it('читает хуки обоих файлов и помечает источник', () => {
      const hooks = readHooks(settingsPath, store, localPath);

      expect(hooks).toHaveLength(2);
      expect(hooks.find((hook) => hook.command === 'echo основной')?.source).toBe('settings');
      expect(hooks.find((hook) => hook.command === 'echo локальный')?.source).toBe(
        'settings-local',
      );
    });

    it('без пути к локальному файлу возвращает только основные', () => {
      expect(readHooks(settingsPath, store)).toHaveLength(1);
    });

    it('идентификаторы не сталкиваются: позиция в двух файлах одинаковая', () => {
      const hooks = readHooks(settingsPath, store, localPath);

      // Идентификатор считается от содержимого, поэтому у разных команд он и
      // так разный; префикс держит их порознь, даже если команда совпадёт.
      expect(new Set(hooks.map((hook) => hook.id)).size).toBe(2);
      expect(hooks.find((hook) => hook.source === 'settings-local')?.id).toMatch(/^local:/);
      expect(hooks.find((hook) => hook.source === 'settings')?.id).not.toMatch(/^local:/);

      // Позиция в обоих файлах одна и та же — прежние id совпали бы.
      expect(hooks.map((hook) => hook.legacyId)).toEqual(['Stop:0:0', 'local:Stop:0:0']);
    });

    it('одинаковая команда в двух файлах остаётся двумя записями', () => {
      writeJson(settingsPath, {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo одно и то же' }] }] },
      });
      writeJson(localPath, {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo одно и то же' }] }] },
      });

      const hooks = readHooks(settingsPath, store, localPath);

      expect(hooks).toHaveLength(2);
      expect(new Set(hooks.map((hook) => hook.id)).size).toBe(2);
    });

    it('ГЛАВНОЕ: перезапись не тащит локальный хук в основной файл', () => {
      const hooks = readHooks(settingsPath, store, localPath);
      writeHooks(settingsPath, hooks);

      const afterWrite = readHooks(settingsPath, store);
      expect(afterWrite).toHaveLength(1);
      expect(afterWrite[0]?.command).toBe('echo основной');
    });

    it('локальный файл после перезаписи основного не тронут', () => {
      writeHooks(settingsPath, readHooks(settingsPath, store, localPath));

      const local = readHooks(localPath, store);
      expect(local).toHaveLength(1);
      expect(local[0]?.command).toBe('echo локальный');
    });

    it('локальный хук показан включённым: выключать его панели нечем', () => {
      const hooks = readHooks(settingsPath, store, localPath);
      const local = hooks.find((hook) => hook.source === 'settings-local');

      // Отметка «выключено» на локальный id ничего не меняет: файл не наш.
      store.setEnabled('hook', local!.id, false);

      const again = readHooks(settingsPath, store, localPath);
      expect(again.find((hook) => hook.source === 'settings-local')?.isEnabled).toBe(true);
    });
  });

  describe('права', () => {
    beforeEach(() => {
      writeJson(settingsPath, { permissions: { allow: ['Bash(ls:*)'] } });
      writeJson(localPath, { permissions: { deny: ['Bash(rm:*)'], allow: ['Bash(ls:*)'] } });
    });

    it('читает права обоих файлов с пометкой источника', () => {
      const rules = readPermissions(settingsPath, store, localPath);

      expect(rules).toHaveLength(3);
      expect(rules.filter((rule) => rule.source === 'settings-local')).toHaveLength(2);
    });

    it('одинаковый паттерн в двух файлах даёт разные идентификаторы', () => {
      const rules = readPermissions(settingsPath, store, localPath);
      const samePattern = rules.filter((rule) => rule.pattern === 'Bash(ls:*)');

      expect(samePattern).toHaveLength(2);
      expect(new Set(samePattern.map((rule) => rule.id)).size).toBe(2);
    });
  });

  describe('переменные окружения', () => {
    beforeEach(() => {
      writeJson(settingsPath, { env: { COMMON: 'да' } });
      writeJson(localPath, { env: { PERSONAL: 'моё' } });
    });

    it('показывает переменные обоих файлов', () => {
      const vars = readEnvVars(settingsPath, secretsPath, localPath);

      expect(vars.find((item) => item.key === 'COMMON')?.source).toBe('settings');
      expect(vars.find((item) => item.key === 'PERSONAL')?.source).toBe('settings-local');
    });

    it('правка локальной переменной уходит в локальный файл', () => {
      saveEnvVar(
        settingsPath,
        secretsPath,
        { key: 'PERSONAL', value: 'обновлённое', source: 'settings-local', isSecret: false },
        undefined,
        localPath,
      );

      const vars = readEnvVars(settingsPath, secretsPath, localPath);
      expect(vars.find((item) => item.key === 'PERSONAL')?.value).toBe('обновлённое');
    });

    it('ГЛАВНОЕ: правка локальной переменной не попадает в основной файл', () => {
      saveEnvVar(
        settingsPath,
        secretsPath,
        { key: 'PERSONAL', value: 'обновлённое', source: 'settings-local', isSecret: false },
        undefined,
        localPath,
      );

      const main = readEnvVars(settingsPath, secretsPath);
      expect(main.find((item) => item.key === 'PERSONAL')).toBeUndefined();
      expect(main.find((item) => item.key === 'COMMON')).toBeDefined();
    });

    it('удаление локальной переменной убирает её из локального файла', () => {
      deleteEnvVar(settingsPath, secretsPath, 'PERSONAL', 'settings-local', undefined, localPath);

      const vars = readEnvVars(settingsPath, secretsPath, localPath);
      expect(vars.find((item) => item.key === 'PERSONAL')).toBeUndefined();
      expect(vars.find((item) => item.key === 'COMMON')).toBeDefined();
    });

    it('без пути к локальному файлу запись отклоняется, а не уходит в общий', () => {
      expect(() =>
        saveEnvVar(settingsPath, secretsPath, {
          key: 'PERSONAL',
          value: 'чужое',
          source: 'settings-local',
          isSecret: false,
        }),
      ).toThrow(/settings\.local\.json/);
    });
  });
});
