import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
});
