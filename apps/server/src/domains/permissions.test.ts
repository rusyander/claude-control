import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PermissionDraft } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import {
  readPermissions,
  savePermission,
  deletePermission,
  movePermission,
  setPermissionsEnabled,
  createGuardedPatternsReader,
} from './permissions.ts';

/**
 * Полный state.json со свежими массивами — изолирует AppStore от процесс-глобального
 * DEFAULT_STATE (см. отчёт о баге shared-array в app-store.ts): без него saveGroup
 * одного теста протекал бы в остальные через общий по ссылке массив groups.
 */
function seedState(dir: string): void {
  const appDataDir = join(dir, 'claude-control');
  mkdirSync(appDataDir, { recursive: true });
  writeFileSync(
    join(appDataDir, 'state.json'),
    JSON.stringify({
      groups: [],
      automations: [],
      disabled: { rule: [], hook: [], skill: [], mcp: [], permission: [] },
    }),
  );
}

/**
 * Тесты правил доступа из settings.json. Важное здесь — паттерны Bash/Write/Read
 * содержат двоеточия и скобки (`Bash(git push:*)`), а id правила строится как
 * `decision:pattern`. Значит разбор id по двоеточию не должен ломать паттерн при
 * перемещении и удалении правила. Отдельно проверяем разбор MCP-паттернов
 * `mcp__<сервер>__<инструмент>` на сервер и инструмент.
 *
 * Всё пишется только во временный каталог из mkdtempSync — настоящий ~/.claude
 * не затрагивается. Каждый тест убирает свой каталог за собой.
 */
describe('permissions', () => {
  let dir: string;
  let settingsPath: string;
  let store: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-perms-'));
    settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, '{}');
    seedState(dir);
    store = new AppStore(join(dir, 'claude-control'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeSettings = (settings: unknown) =>
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  const draft = (
    over: Partial<PermissionDraft> & Pick<PermissionDraft, 'pattern' | 'decision'>,
  ): PermissionDraft => ({
    groupIds: [],
    ...over,
  });

  describe('readPermissions — чтение allow/ask/deny', () => {
    it('читает все три списка и строит id вида decision:pattern', () => {
      writeSettings({
        permissions: {
          allow: ['Read(~/**)'],
          ask: ['Write(/etc/*)'],
          deny: ['Bash(rm -rf:*)'],
        },
      });

      const rules = readPermissions(settingsPath, store);

      expect(rules).toHaveLength(3);
      const allow = rules.find((r) => r.decision === 'allow');
      expect(allow?.pattern).toBe('Read(~/**)');
      expect(allow?.id).toBe('allow:Read(~/**)');

      expect(rules.find((r) => r.decision === 'ask')?.pattern).toBe('Write(/etc/*)');
      expect(rules.find((r) => r.decision === 'deny')?.pattern).toBe('Bash(rm -rf:*)');
    });

    it('пустой settings.json даёт пустой список', () => {
      expect(readPermissions(settingsPath, store)).toEqual([]);
    });

    it('обычные инструменты Bash/Write/Read не считаются MCP', () => {
      writeSettings({ permissions: { allow: ['Bash(git push:*)', 'Write(src/**)'] } });

      const rules = readPermissions(settingsPath, store);

      // Для не-MCP паттернов поля сервера/инструмента остаются пустыми,
      // а сам паттерн сохраняется дословно (со скобками и двоеточиями).
      const bash = rules.find((r) => r.pattern === 'Bash(git push:*)');
      expect(bash?.mcpServer).toBeUndefined();
      expect(bash?.mcpTool).toBeUndefined();
    });

    it('MCP-паттерн разбирается на сервер и инструмент', () => {
      writeSettings({ permissions: { allow: ['mcp__gitlab-gorgona__get_project'] } });

      const [rule] = readPermissions(settingsPath, store);

      expect(rule?.mcpServer).toBe('gitlab-gorgona');
      expect(rule?.mcpTool).toBe('get_project');
    });

    it('имя MCP-сервера с одиночным подчёркиванием разбирается верно', () => {
      // Разделитель сервер↔инструмент — двойное подчёркивание, одиночные
      // подчёркивания внутри имени сервера не должны его рвать.
      writeSettings({ permissions: { deny: ['mcp__my_server__do_thing'] } });

      const [rule] = readPermissions(settingsPath, store);

      expect(rule?.mcpServer).toBe('my_server');
      expect(rule?.mcpTool).toBe('do_thing');
    });

    it('groupIds подтягиваются из хранилища приложения', () => {
      writeSettings({ permissions: { allow: ['Read(~/**)'] } });
      const id = 'allow:Read(~/**)';
      store.saveGroup({
        id: 'g1',
        name: 'Группа',
        order: 0,
        color: undefined,
        members: [{ kind: 'permission', id }],
      } as never);

      const [rule] = readPermissions(settingsPath, store);
      expect(rule?.groupIds).toEqual(['g1']);
    });
  });

  describe('savePermission — добавление и перемещение', () => {
    it('добавляет новое правило в нужный список', () => {
      savePermission(settingsPath, null, draft({ pattern: 'Bash(ls:*)', decision: 'allow' }));

      const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(saved.permissions.allow).toContain('Bash(ls:*)');
    });

    it('не создаёт дубликат при повторном добавлении того же паттерна', () => {
      savePermission(settingsPath, null, draft({ pattern: 'Read(a)', decision: 'allow' }));
      savePermission(settingsPath, null, draft({ pattern: 'Read(a)', decision: 'allow' }));

      const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(saved.permissions.allow).toEqual(['Read(a)']);
    });

    it('сортирует список правил по алфавиту', () => {
      savePermission(settingsPath, null, draft({ pattern: 'Read(c)', decision: 'allow' }));
      savePermission(settingsPath, null, draft({ pattern: 'Read(a)', decision: 'allow' }));
      savePermission(settingsPath, null, draft({ pattern: 'Read(b)', decision: 'allow' }));

      const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(saved.permissions.allow).toEqual(['Read(a)', 'Read(b)', 'Read(c)']);
    });

    it('повторное сохранение существующего правила не переупорядочивает список', () => {
      // Список в файле уже в непривычном порядке (правили руками). Повторное
      // сохранение того же правила ничего не добавляет — значит и трогать чужой
      // порядок незачем: сортируем только при реальном добавлении.
      writeSettings({ permissions: { allow: ['Read(c)', 'Read(a)', 'Read(b)'] } });

      savePermission(settingsPath, null, draft({ pattern: 'Read(a)', decision: 'allow' }));

      const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(saved.permissions.allow).toEqual(['Read(c)', 'Read(a)', 'Read(b)']);
    });

    it('перемещает правило между списками, убирая его из старого', () => {
      writeSettings({ permissions: { allow: ['Bash(ls:*)'] } });

      // id старого правила = decision:pattern.
      savePermission(
        settingsPath,
        'allow:Bash(ls:*)',
        draft({ pattern: 'Bash(ls:*)', decision: 'deny' }),
      );

      const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(saved.permissions.allow).toEqual([]);
      expect(saved.permissions.deny).toEqual(['Bash(ls:*)']);
    });

    it('перемещает правило, чей паттерн содержит двоеточия (id рвётся только по первому)', () => {
      writeSettings({ permissions: { allow: ['Bash(git push:*)'] } });

      // id = 'allow:Bash(git push:*)' — двоеточие есть и внутри паттерна.
      savePermission(
        settingsPath,
        'allow:Bash(git push:*)',
        draft({ pattern: 'Bash(git push:*)', decision: 'ask' }),
      );

      const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(saved.permissions.allow).toEqual([]);
      expect(saved.permissions.ask).toEqual(['Bash(git push:*)']);
    });

    it('создаёт резервную копию, когда указан backupDir', () => {
      const backupDir = join(dir, 'backups');
      const backup = savePermission(
        settingsPath,
        null,
        draft({ pattern: 'Read(a)', decision: 'allow' }),
        backupDir,
      );

      expect(backup).toBeTypeOf('string');
      expect(existsSync(backup as string)).toBe(true);
    });
  });

  describe('deletePermission — удаление', () => {
    it('удаляет правило из своего списка, не трогая другие', () => {
      writeSettings({
        permissions: { allow: ['Read(a)', 'Read(b)'], deny: ['Bash(rm:*)'] },
      });

      deletePermission(settingsPath, 'allow:Read(a)');

      const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(saved.permissions.allow).toEqual(['Read(b)']);
      expect(saved.permissions.deny).toEqual(['Bash(rm:*)']);
    });

    it('корректно удаляет паттерн с двоеточиями внутри', () => {
      writeSettings({ permissions: { deny: ['Bash(git push:*)', 'Read(a)'] } });

      deletePermission(settingsPath, 'deny:Bash(git push:*)');

      const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
      // Должен уйти только паттерн с двоеточием, второй остаётся.
      expect(saved.permissions.deny).toEqual(['Read(a)']);
    });

    it('удаление отсутствующего правила оставляет список без изменений', () => {
      writeSettings({ permissions: { allow: ['Read(a)'] } });

      deletePermission(settingsPath, 'allow:Read(nope)');

      const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(saved.permissions.allow).toEqual(['Read(a)']);
    });
  });

  describe('movePermission — перенос между settings.json и settings.local.json', () => {
    let localPath: string;

    beforeEach(() => {
      localPath = join(dir, 'settings.local.json');
      writeFileSync(localPath, '{}');
    });

    const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

    it('переносит право в локальный файл и обратно, очищая источник', () => {
      writeSettings({ permissions: { allow: ['Bash(ls:*)'] } });

      // settings.json -> settings.local.json (id без префикса)
      movePermission(settingsPath, localPath, 'allow:Bash(ls:*)');
      expect(read(settingsPath).permissions.allow).toEqual([]);
      expect(read(localPath).permissions.allow).toEqual(['Bash(ls:*)']);

      // обратно: у локального права id с префиксом local:
      movePermission(settingsPath, localPath, 'local:allow:Bash(ls:*)');
      expect(read(localPath).permissions.allow).toEqual([]);
      expect(read(settingsPath).permissions.allow).toEqual(['Bash(ls:*)']);
    });

    it('сохраняет решение и паттерн с двоеточиями при переносе', () => {
      writeSettings({ permissions: { deny: ['Bash(git push:*)'] } });

      movePermission(settingsPath, localPath, 'deny:Bash(git push:*)');

      expect(read(settingsPath).permissions.deny).toEqual([]);
      expect(read(localPath).permissions.deny).toEqual(['Bash(git push:*)']);
    });

    it('создаёт резервную копию, когда указан backupDir', () => {
      writeSettings({ permissions: { allow: ['Read(a)'] } });

      const backup = movePermission(settingsPath, localPath, 'allow:Read(a)', join(dir, 'backups'));

      expect(backup).toBeTypeOf('string');
      expect(existsSync(backup as string)).toBe(true);
    });
  });

  describe('setPermissionsEnabled — пачкой в один файл', () => {
    const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

    it('снимает и возвращает несколько прав за одну запись', () => {
      writeSettings({ permissions: { deny: ['Bash(rm:*)', 'Bash(sudo:*)'], allow: ['Read(a)'] } });

      setPermissionsEnabled(settingsPath, [
        { id: 'deny:Bash(rm:*)', isEnabled: false },
        { id: 'deny:Bash(sudo:*)', isEnabled: false },
      ]);
      expect(read(settingsPath).permissions.deny).toEqual([]);
      // Чужие списки не задеты.
      expect(read(settingsPath).permissions.allow).toEqual(['Read(a)']);

      setPermissionsEnabled(settingsPath, [
        { id: 'deny:Bash(sudo:*)', isEnabled: true },
        { id: 'deny:Bash(rm:*)', isEnabled: true },
      ]);
      // Список держится отсортированным, как и при поштучном сохранении.
      expect(read(settingsPath).permissions.deny).toEqual(['Bash(rm:*)', 'Bash(sudo:*)']);
    });

    it('шаблон с двоеточиями не рвётся по разделителю id', () => {
      writeSettings({ permissions: { ask: ['Bash(git push:*)'] } });

      setPermissionsEnabled(settingsPath, [{ id: 'ask:Bash(git push:*)', isEnabled: false }]);

      expect(read(settingsPath).permissions.ask).toEqual([]);
    });

    it('без изменений файл не переписывается', () => {
      writeSettings({ permissions: { deny: ['Bash(rm:*)'] } });

      const backup = setPermissionsEnabled(
        settingsPath,
        [{ id: 'deny:Bash(rm:*)', isEnabled: true }],
        join(dir, 'backups'),
      );

      expect(backup).toBeUndefined();
      expect(existsSync(join(dir, 'backups'))).toBe(false);
    });
  });

  describe('createGuardedPatternsReader — кэш до правки файла', () => {
    it('отдаёт только ask и deny', () => {
      writeSettings({ permissions: { allow: ['Read(a)'], ask: ['Write(b)'], deny: ['Bash(c)'] } });

      const guarded = createGuardedPatternsReader(() => ({ settings: settingsPath, store }));

      expect(guarded()).toEqual(['Write(b)', 'Bash(c)']);
    });

    it('повторный вызов не перечитывает файл', () => {
      writeSettings({ permissions: { deny: ['Bash(c)'] } });

      const guarded = createGuardedPatternsReader(() => ({ settings: settingsPath, store }));
      const first = guarded();

      // Файл на месте, содержимое то же — читатель обязан вернуть ТОТ ЖЕ массив.
      expect(guarded()).toBe(first);
    });

    it('правка файла мимо панели действует сразу', () => {
      writeSettings({ permissions: { deny: ['Bash(c)'] } });

      const guarded = createGuardedPatternsReader(() => ({ settings: settingsPath, store }));
      expect(guarded()).toEqual(['Bash(c)']);

      writeSettings({ permissions: { deny: ['Bash(c)', 'Bash(rm:*)'] } });

      expect(guarded()).toEqual(['Bash(c)', 'Bash(rm:*)']);
    });

    it('смена каталога конфигурации сбрасывает кэш', () => {
      writeSettings({ permissions: { deny: ['Bash(c)'] } });
      const other = join(dir, 'other-settings.json');
      writeFileSync(other, JSON.stringify({ permissions: { ask: ['Write(x)'] } }));

      let current = settingsPath;
      const guarded = createGuardedPatternsReader(() => ({ settings: current, store }));
      expect(guarded()).toEqual(['Bash(c)']);

      current = other;
      expect(guarded()).toEqual(['Write(x)']);
    });
  });
});
