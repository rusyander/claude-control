import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore } from './app-store.ts';

/**
 * Групповое выключение хранится отдельно от ручного, и вот почему.
 *
 * Если складывать всё в один список, теряются два случая: сущность, которую
 * человек выключил сам (включение группы её «воскресит»), и сущность в двух
 * группах (первая же включённая группа её вернёт, хотя вторая ещё гасит).
 * Здесь закреплено обратное поведение.
 */
describe('AppStore — групповое выключение', () => {
  let dir: string;
  let store: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-groups-'));
    store = new AppStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('группа гасит сущность', () => {
    store.setGroupDisabled('rule', 'moe-pravilo', 'группа-1', true);

    expect(store.isDisabled('rule', 'moe-pravilo')).toBe(true);
    expect(store.isDisabledManually('rule', 'moe-pravilo')).toBe(false);
  });

  it('включение группы возвращает сущность', () => {
    store.setGroupDisabled('rule', 'moe-pravilo', 'группа-1', true);
    store.setGroupDisabled('rule', 'moe-pravilo', 'группа-1', false);

    expect(store.isDisabled('rule', 'moe-pravilo')).toBe(false);
  });

  it('сущность в двух группах оживает, только когда её отпустили обе', () => {
    store.setGroupDisabled('skill', 'a11y-audit', 'группа-1', true);
    store.setGroupDisabled('skill', 'a11y-audit', 'группа-2', true);

    store.setGroupDisabled('skill', 'a11y-audit', 'группа-1', false);
    expect(store.isDisabled('skill', 'a11y-audit')).toBe(true);

    store.setGroupDisabled('skill', 'a11y-audit', 'группа-2', false);
    expect(store.isDisabled('skill', 'a11y-audit')).toBe(false);
  });

  it('включение группы не воскрешает то, что выключено вручную', () => {
    store.setEnabled('hook', 'Stop:0:0', false);
    store.setGroupDisabled('hook', 'Stop:0:0', 'группа-1', true);

    store.setGroupDisabled('hook', 'Stop:0:0', 'группа-1', false);

    expect(store.isDisabled('hook', 'Stop:0:0')).toBe(true);
    expect(store.isDisabledManually('hook', 'Stop:0:0')).toBe(true);
  });

  it('ручное включение не пересиливает группу', () => {
    store.setGroupDisabled('mcp', 'figma', 'группа-1', true);
    store.setEnabled('mcp', 'figma', true);

    expect(store.isDisabled('mcp', 'figma')).toBe(true);
  });

  it('называет группы, которые сейчас гасят сущность', () => {
    store.setGroupDisabled('rule', 'pravilo', 'группа-1', true);
    store.setGroupDisabled('rule', 'pravilo', 'группа-2', true);

    expect(store.disablingGroups('rule', 'pravilo').sort()).toEqual(['группа-1', 'группа-2']);
  });

  it('повторное выключение той же группой не задваивает отметку', () => {
    store.setGroupDisabled('rule', 'pravilo', 'группа-1', true);
    store.setGroupDisabled('rule', 'pravilo', 'группа-1', true);

    expect(store.disablingGroups('rule', 'pravilo')).toEqual(['группа-1']);
  });

  it('состояние переживает перезапуск: пишется в state.json', () => {
    store.setGroupDisabled('rule', 'pravilo', 'группа-1', true);

    const reopened = new AppStore(dir);
    expect(reopened.isDisabled('rule', 'pravilo')).toBe(true);
    expect(reopened.disablingGroups('rule', 'pravilo')).toEqual(['группа-1']);
  });

  it('отпущенная сущность не оставляет мусора в состоянии', () => {
    store.setGroupDisabled('rule', 'pravilo', 'группа-1', true);
    store.setGroupDisabled('rule', 'pravilo', 'группа-1', false);

    expect(store.getState().disabledByGroup.rule).toEqual({});
  });

  it('старый state.json без нового поля читается без падения', () => {
    // Панель обновляется поверх уже существующего состояния — в файле
    // пользователя поля disabledByGroup ещё нет.
    const legacyDir = mkdtempSync(join(tmpdir(), 'cc-legacy-'));
    const legacy = new AppStore(legacyDir);

    expect(legacy.isDisabled('rule', 'что-угодно')).toBe(false);
    expect(() => legacy.setGroupDisabled('rule', 'x', 'g', true)).not.toThrow();

    rmSync(legacyDir, { recursive: true, force: true });
  });
});
