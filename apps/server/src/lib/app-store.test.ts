import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@claude-control/contracts';
import { AppStore } from './app-store.ts';

/**
 * Тесты хранилища состояния приложения (группы, сценарии, отметки «выключено»).
 *
 * Главный тест здесь — регрессия: раньше load() при пустом state.json оставлял
 * вложенные массивы общей ссылкой с модульным DEFAULT_STATE, и правки одного
 * стора протекали в другие экземпляры. Экземпляров несколько (песочницы, смена
 * целевого каталога), поэтому изоляция — обязательное свойство. Тест-кейсы см.
 * .agent/TEST-CASES.md → «Хранилище состояния (AppStore)».
 */
describe('AppStore', () => {
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    dirA = mkdtempSync(join(tmpdir(), 'cc-store-a-'));
    dirB = mkdtempSync(join(tmpdir(), 'cc-store-b-'));
  });

  afterEach(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  function makeGroup(id: string): Group {
    return {
      id,
      name: id,
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [],
      env: {},
      isEnabled: true,
      order: 0,
    };
  }

  describe('изоляция экземпляров (регрессия протечки общего дефолта)', () => {
    it('отметка «выключено» в одном сторе не видна в другом', () => {
      const a = new AppStore(join(dirA, 'claude-control'));
      a.setEnabled('hook', 'Stop:0:0', false);

      // Свежий стор из другого каталога — состояние чистое.
      const b = new AppStore(join(dirB, 'claude-control'));
      expect(b.isDisabled('hook', 'Stop:0:0')).toBe(false);
    });

    it('группа, добавленная в один стор, не протекает в другой', () => {
      const a = new AppStore(join(dirA, 'claude-control'));
      a.saveGroup(makeGroup('qa-group'));

      const b = new AppStore(join(dirB, 'claude-control'));
      expect(b.getGroups()).toEqual([]);
    });

    it('дефолт не мутируется — третий стор тоже чист', () => {
      const a = new AppStore(join(dirA, 'claude-control'));
      a.setEnabled('rule', 'some-rule', false);
      a.saveGroup(makeGroup('leak'));

      // Новый временный каталог: если DEFAULT_STATE был испорчен мутацией,
      // этот стор унаследует чужое.
      const dirC = mkdtempSync(join(tmpdir(), 'cc-store-c-'));
      try {
        const c = new AppStore(join(dirC, 'claude-control'));
        expect(c.isDisabled('rule', 'some-rule')).toBe(false);
        expect(c.getGroups()).toEqual([]);
      } finally {
        rmSync(dirC, { recursive: true, force: true });
      }
    });
  });

  describe('сохранение и перезагрузка', () => {
    it('состояние переживает пересоздание стора из того же каталога', () => {
      const a = new AppStore(join(dirA, 'claude-control'));
      a.setEnabled('hook', 'Stop:0:0', false);
      a.saveGroup(makeGroup('kept'));

      // Тот же каталог → state.json прочитан заново.
      const again = new AppStore(join(dirA, 'claude-control'));
      expect(again.isDisabled('hook', 'Stop:0:0')).toBe(true);
      expect(again.getGroups().map((g) => g.id)).toEqual(['kept']);
    });

    it('setEnabled туда-обратно снимает отметку', () => {
      const a = new AppStore(join(dirA, 'claude-control'));
      a.setEnabled('mcp', 'srv', false);
      expect(a.isDisabled('mcp', 'srv')).toBe(true);
      a.setEnabled('mcp', 'srv', true);
      expect(a.isDisabled('mcp', 'srv')).toBe(false);
    });

    it('updateSettings мержит патч, не теряя прочие поля', () => {
      const a = new AppStore(join(dirA, 'claude-control'));
      a.updateSettings({ theme: 'dark' });
      const s = a.getSettings();
      expect(s.theme).toBe('dark');
      // Дефолтные поля на месте.
      expect(s.language).toBe('ru');
      expect(s.backupBeforeWrite).toBe(true);
    });
  });

  describe('группы', () => {
    it('getGroups сортирует по order', () => {
      const a = new AppStore(join(dirA, 'claude-control'));
      a.saveGroup({ ...makeGroup('b'), order: 2 });
      a.saveGroup({ ...makeGroup('a'), order: 1 });
      expect(a.getGroups().map((g) => g.id)).toEqual(['a', 'b']);
    });

    it('saveGroup по существующему id заменяет, а не плодит', () => {
      const a = new AppStore(join(dirA, 'claude-control'));
      a.saveGroup(makeGroup('g'));
      a.saveGroup({ ...makeGroup('g'), name: 'обновлённое' });
      const groups = a.getGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0]?.name).toBe('обновлённое');
    });

    it('deleteGroup убирает нужную группу', () => {
      const a = new AppStore(join(dirA, 'claude-control'));
      a.saveGroup(makeGroup('one'));
      a.saveGroup(makeGroup('two'));
      a.deleteGroup('one');
      expect(a.getGroups().map((g) => g.id)).toEqual(['two']);
    });
  });

  describe('автозапуск dev-сервера', () => {
    const project = join('C:', 'work', 'demo');

    it('тумблер и порт переживают перезапуск панели', () => {
      const dir = join(dirA, 'claude-control');
      const a = new AppStore(dir);
      a.setRunnerAutostart(project, true);
      a.rememberRunnerPort(project, 4321);

      const restarted = new AppStore(dir);
      expect(restarted.getRunnerPrefs(project)).toMatchObject({ autostart: true, port: 4321 });
    });

    it('выключенный автозапуск не забывает порт', () => {
      const a = new AppStore(join(dirA, 'claude-control'));
      a.setRunnerAutostart(project, true);
      a.rememberRunnerPort(project, 4321);
      a.setRunnerAutostart(project, false);

      const prefs = a.getRunnerPrefs(project);
      expect(prefs?.port).toBe(4321);
      expect(prefs?.autostart).toBeFalsy();
    });

    it('выключение без запомненного порта стирает запись целиком', () => {
      const a = new AppStore(join(dirA, 'claude-control'));
      a.setRunnerAutostart(project, true);
      a.setRunnerAutostart(project, false);
      expect(a.getRunnerPrefs(project)).toBeUndefined();
    });

    it('listAutostartProjects возвращает только отмеченные', () => {
      const a = new AppStore(join(dirA, 'claude-control'));
      const other = join('C:', 'work', 'other');
      a.setRunnerAutostart(project, true);
      a.rememberRunnerPort(other, 5555);
      expect(a.listAutostartProjects().map((p) => p.path)).toEqual([project]);
    });

    it('вид слэшей и хвостовой слэш не плодят вторую запись', () => {
      const a = new AppStore(join(dirA, 'claude-control'));
      a.setRunnerAutostart('C:/work/demo', true);
      a.rememberRunnerPort('C:\\work\\demo', 7000);
      expect(a.listAutostartProjects()).toHaveLength(1);
      expect(a.getRunnerPrefs('C:/work/demo/')).toMatchObject({ autostart: true, port: 7000 });
    });
  });

  describe('настройки целей запуска (монорепа)', () => {
    const project = join('C:', 'work', 'mono');
    const web = join(project, 'apps', 'web');
    const api = join(project, 'apps', 'api');
    const meta = (dir: string) => ({ projectPath: project, dir });

    it('у каждой цели своя команда и свой закреплённый порт', () => {
      const a = new AppStore(join(dirA, 'claude-control'));
      a.setRunnerCommand(web, 'pnpm dev:web', meta('apps/web'));
      a.setRunnerPort(web, 5173, meta('apps/web'));
      a.setRunnerPort(api, 3000, meta('apps/api'));

      expect(a.getRunnerCommand(web)).toBe('pnpm dev:web');
      expect(a.getRunnerCommand(api)).toBeUndefined();
      expect(a.getRunnerPrefs(web)?.pinnedPort).toBe(5173);
      expect(a.getRunnerPrefs(api)?.pinnedPort).toBe(3000);
    });

    it('цель помнит, к какому проекту и какой подпапке относится', () => {
      const a = new AppStore(join(dirA, 'claude-control'));
      a.setRunnerAutostart(web, true, meta('apps/web'));
      expect(a.listAutostartProjects()).toMatchObject([
        { path: web, projectPath: project, dir: 'apps/web' },
      ]);
    });

    it('снятие автозапуска у одной цели не трогает соседнюю', () => {
      const a = new AppStore(join(dirA, 'claude-control'));
      a.setRunnerAutostart(web, true, meta('apps/web'));
      a.setRunnerAutostart(api, true, meta('apps/api'));
      a.setRunnerAutostart(web, false, meta('apps/web'));
      expect(a.listAutostartProjects().map((prefs) => prefs.path)).toEqual([api]);
    });

    it('закрытая вкладка снимает автозапуск со ВСЕХ целей проекта', () => {
      const a = new AppStore(join(dirA, 'claude-control'));
      const foreign = join('C:', 'work', 'other');
      a.setRunnerAutostart(project, true);
      a.setRunnerAutostart(web, true, meta('apps/web'));
      a.setRunnerAutostart(api, true, meta('apps/api'));
      a.setRunnerAutostart(foreign, true);

      a.clearRunnerAutostart(project);

      expect(a.listAutostartProjects().map((prefs) => prefs.path)).toEqual([foreign]);
      // Настройки при этом целы: вкладку откроют снова — команда на месте.
      expect(a.getRunnerPrefs(api)).toBeUndefined();
    });

    it('снятие закрепления порта не стирает команду', () => {
      const a = new AppStore(join(dirA, 'claude-control'));
      a.setRunnerCommand(web, 'pnpm dev', meta('apps/web'));
      a.setRunnerPort(web, 5173, meta('apps/web'));
      a.setRunnerPort(web, undefined, meta('apps/web'));

      expect(a.getRunnerPrefs(web)?.pinnedPort).toBeUndefined();
      expect(a.getRunnerCommand(web)).toBe('pnpm dev');
    });

    it('негодный порт закреплением не считается', () => {
      const a = new AppStore(join(dirA, 'claude-control'));
      a.setRunnerPort(web, 0, meta('apps/web'));
      a.setRunnerPort(api, 99_999, meta('apps/api'));
      expect(a.getRunnerPrefs(web)).toBeUndefined();
      expect(a.getRunnerPrefs(api)).toBeUndefined();
    });

    it('оверрайд из старой карты runnerCommands не теряется при обновлении панели', () => {
      const dir = join(dirA, 'claude-control');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'state.json'),
        JSON.stringify({ runnerCommands: { 'c:/work/mono': 'pnpm start' } }),
      );

      const a = new AppStore(dir);
      expect(a.getRunnerCommand('C:/work/mono')).toBe('pnpm start');

      // Переписали — значение переезжает в runnerPrefs, старая запись уходит.
      a.setRunnerCommand('C:/work/mono', 'pnpm dev');
      expect(new AppStore(dir).getRunnerCommand('C:/work/mono')).toBe('pnpm dev');
    });
  });
});
