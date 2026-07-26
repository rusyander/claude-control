import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Group } from '@claude-control/contracts';
import { AppStore } from './app-store.ts';

/**
 * Жизненный цикл идентификатора сущности в state.json: переименование и удаление.
 *
 * Отметки («выключено вручную», «погашено группой») и состав групп ключуются
 * идентификатором, а сам идентификатор — это имя (папки, сервера, права). Значит
 * оба события обязаны его отслеживать: иначе состояние копит следы сущностей,
 * которых уже нет, и первая же новая сущность с тем же именем их наследует.
 */
describe('AppStore — переименование и удаление сущности', () => {
  let dir: string;
  let store: AppStore;

  const group = (id: string, members: Group['members']): Group => ({
    id,
    name: id,
    description: '',
    color: 'accent',
    icon: 'folder',
    members,
    env: {},
    isEnabled: true,
    order: 0,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-entity-life-'));
    store = new AppStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('renameEntity', () => {
    it('переносит отметки и состав групп на новое имя', () => {
      store.saveGroup(group('g1', [{ kind: 'mcp', id: 'alpha' }]));
      store.setEnabled('mcp', 'alpha', false);
      store.setGroupDisabled('mcp', 'alpha', 'g1', true);

      store.renameEntity('mcp', 'alpha', 'beta');

      expect(store.getGroupIdsFor('mcp', 'beta')).toEqual(['g1']);
      expect(store.getGroupIdsFor('mcp', 'alpha')).toEqual([]);
      expect(store.isDisabledManually('mcp', 'beta')).toBe(true);
      expect(store.disablingGroups('mcp', 'beta')).toEqual(['g1']);
    });

    it('не задваивает участника, если новое имя уже состоит в той же группе', () => {
      // Дубль: `members: [{mcp,beta},{mcp,beta}]`. Отметки `disabled` от такого
      // же задвоения защищены, а состав групп — нет: участник считался за
      // двоих до следующего сохранения группы.
      store.saveGroup(
        group('g1', [
          { kind: 'mcp', id: 'alpha' },
          { kind: 'mcp', id: 'beta' },
        ]),
      );

      store.renameEntity('mcp', 'alpha', 'beta');

      const members = store.getGroups()[0]?.members ?? [];
      expect(members).toEqual([{ kind: 'mcp', id: 'beta' }]);
    });

    it('дубли не плодятся и в отметке выключения', () => {
      store.setEnabled('mcp', 'alpha', false);
      store.setEnabled('mcp', 'beta', false);

      store.renameEntity('mcp', 'alpha', 'beta');

      expect(store.getState().disabled.mcp).toEqual(['beta']);
    });

    it('участники других видов с тем же именем не трогаются', () => {
      store.saveGroup(
        group('g1', [
          { kind: 'mcp', id: 'alpha' },
          { kind: 'skill', id: 'alpha' },
        ]),
      );

      store.renameEntity('mcp', 'alpha', 'beta');

      expect(store.getGroups()[0]?.members).toEqual([
        { kind: 'mcp', id: 'beta' },
        { kind: 'skill', id: 'alpha' },
      ]);
    });
  });

  describe('removeEntity', () => {
    it('уносит участие в группах, ручную отметку и гашение группой', () => {
      // Без этого карточка группы показывала участника-призрака, а сущность,
      // заведённая потом под тем же именем, молча получала чужие группы и
      // оказывалась погашенной группой, в которую никогда не входила.
      store.saveGroup(group('g1', [{ kind: 'mcp', id: 'ctx7' }]));
      store.setEnabled('mcp', 'ctx7', false);
      store.setGroupDisabled('mcp', 'ctx7', 'g1', true);

      store.removeEntity('mcp', 'ctx7');

      expect(store.getGroups()[0]?.members).toEqual([]);
      expect(store.getGroupIdsFor('mcp', 'ctx7')).toEqual([]);
      expect(store.isDisabledManually('mcp', 'ctx7')).toBe(false);
      expect(store.disablingGroups('mcp', 'ctx7')).toEqual([]);
      expect(store.isDisabled('mcp', 'ctx7')).toBe(false);
    });

    it('чужих не задевает: другой вид и другое имя остаются', () => {
      store.saveGroup(
        group('g1', [
          { kind: 'mcp', id: 'ctx7' },
          { kind: 'skill', id: 'ctx7' },
          { kind: 'mcp', id: 'linear' },
        ]),
      );
      store.setEnabled('skill', 'ctx7', false);

      store.removeEntity('mcp', 'ctx7');

      expect(store.getGroups()[0]?.members).toEqual([
        { kind: 'skill', id: 'ctx7' },
        { kind: 'mcp', id: 'linear' },
      ]);
      expect(store.isDisabledManually('skill', 'ctx7')).toBe(true);
    });

    it('переживает перезапуск — след стёрт в файле, а не только в памяти', () => {
      store.saveGroup(group('g1', [{ kind: 'rule', id: 'staroe' }]));
      store.setEnabled('rule', 'staroe', false);

      store.removeEntity('rule', 'staroe');

      const reopened = new AppStore(dir);
      expect(reopened.getGroupIdsFor('rule', 'staroe')).toEqual([]);
      expect(reopened.isDisabled('rule', 'staroe')).toBe(false);
    });

    it('удаление сущности без единой отметки состояние не трогает', () => {
      const before = JSON.stringify(store.getState());

      store.removeEntity('permission', 'нет-такого');

      expect(JSON.stringify(store.getState())).toBe(before);
    });
  });
});
