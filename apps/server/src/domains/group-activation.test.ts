import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudePaths, Group } from '@agentdeck/contracts';
import { AppStore } from '../lib/app-store.ts';
import {
  activateGroupsForCwd,
  activateGroupsQuietly,
  groupsActivatedNotice,
  groupsForCwd,
  matchesProject,
} from './group-activation.ts';

/**
 * Привязка группы к проекту. Проверяется ровно то, из-за чего эта привязка и
 * задумана: набор включается сам при работе в каталоге проекта — и НИКОГДА не
 * выключается сам, потому что файлы конфигурации общие для всех идущих прогонов.
 */
describe('Привязка группы к проекту', () => {
  const makeGroup = (patch: Partial<Group>): Group => ({
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

  describe('сопоставление путей', () => {
    it('сам каталог проекта и вложенный в него', () => {
      expect(matchesProject('c:/work/company', 'c:/work/company')).toBe(true);
      expect(matchesProject('c:/work/company', 'c:/work/company/apps/web')).toBe(true);
    });

    it('копия ветки лежит РЯДОМ с репозиторием и всё равно считается проектом', () => {
      // `<репозиторий>-worktrees/<ветка>` — соседний каталог, обычной проверкой
      // «путь внутри проекта» он не ловится, а для человека это тот же проект.
      expect(matchesProject('c:/work/company', 'c:/work/company-worktrees/fix-PRJ-1')).toBe(true);
    });

    it('чужой каталог с тем же началом имени не считается проектом', () => {
      expect(matchesProject('c:/work/company', 'c:/work/company-old')).toBe(false);
      expect(matchesProject('c:/work/company', 'c:/work/other')).toBe(false);
    });

    it('пустая привязка не совпадает ни с чем', () => {
      expect(matchesProject('', 'c:/work/company')).toBe(false);
    });

    it('слэши и регистр не мешают (Windows)', () => {
      const same = matchesProject('c:\\work\\company\\', 'c:/work/Company/apps');
      expect(same).toBe(process.platform === 'win32');
    });
  });

  it('к каталогу подбираются только привязанные к нему группы', () => {
    const groups = [
      makeGroup({ id: 'a', projectPaths: ['c:/work/company'] }),
      makeGroup({ id: 'b', projectPaths: ['c:/work/other'] }),
      makeGroup({ id: 'c', projectPaths: [] }),
    ];

    expect(groupsForCwd(groups, 'c:/work/company/apps').map((group) => group.id)).toEqual(['a']);
  });

  describe('включение при запуске прогона', () => {
    let dir: string;
    let store: AppStore;
    let paths: ClaudePaths;

    const deps = () => ({ paths, store });

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cc-group-activate-'));
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

    it('привязанная выключенная группа включается', () => {
      store.saveGroup(makeGroup({ projectPaths: [dir], isEnabled: false }));

      const { activated } = activateGroupsForCwd(deps(), dir);

      expect(activated).toEqual(['Набор']);
      expect(store.getGroups().at(0)?.isEnabled).toBe(true);
    });

    it('выход из проекта группу НЕ выключает', () => {
      store.saveGroup(makeGroup({ projectPaths: [dir], isEnabled: true }));

      // Прогон в постороннем каталоге: ни одна группа не привязана к нему, и
      // включённая обязана остаться включённой — под неё может идти чужой агент.
      const { activated } = activateGroupsForCwd(deps(), join(tmpdir(), 'cc-elsewhere'));

      expect(activated).toEqual([]);
      expect(store.getGroups().at(0)?.isEnabled).toBe(true);
    });

    it('уже включённая группа не переключается повторно', () => {
      store.saveGroup(makeGroup({ projectPaths: [dir], isEnabled: true }));

      expect(activateGroupsForCwd(deps(), dir).activated).toEqual([]);
    });

    it('непривязанная группа не трогается', () => {
      store.saveGroup(makeGroup({ projectPaths: [], isEnabled: false }));

      expect(activateGroupsForCwd(deps(), dir).activated).toEqual([]);
      expect(store.getGroups().at(0)?.isEnabled).toBe(false);
    });

    it('тихий вызов тоже называет включённые наборы: сказать о них надо и там', () => {
      store.saveGroup(makeGroup({ projectPaths: [dir], isEnabled: false }));

      // Разделение и продолжение в чистой сессии зовут именно его — и раньше
      // молчали о включении, потому что имён им не доставалось вовсе.
      expect(activateGroupsQuietly(deps(), dir)).toEqual(['Набор']);
    });
  });

  describe('заметка в ленту прогона', () => {
    it('называет набор и повод — иначе включение выглядит самовольством агента', () => {
      expect(groupsActivatedNotice(['Ревью фронта'])).toEqual({
        kind: 'notice',
        code: 'groupsActivated',
        text: 'Набор «Ревью фронта» включён сам — он привязан к этому проекту.',
      });
    });

    it('несколько наборов — одна строка', () => {
      expect(groupsActivatedNotice(['A', 'B'])).toMatchObject({
        text: 'Наборы «A», «B» включены сами — они привязаны к этому проекту.',
      });
    });

    it('ничего не включилось — и говорить не о чем', () => {
      expect(groupsActivatedNotice([])).toBeUndefined();
    });
  });
});
