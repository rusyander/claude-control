import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppState } from './app-store.ts';
import { AppStore } from './app-store.ts';

/**
 * Модель envByGroup: какие ключи settings.json → env применила каждая группа.
 * По этой отметке при выключении снимаются только свои ключи, а общий с другой
 * группой ключ держится, пока его держит хоть одна. Плюс перенос состояния
 * (export/import) — снимок state.json для переезда на другую машину.
 */
describe('AppStore — envByGroup', () => {
  let dir: string;
  let store: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-envgroup-'));
    store = new AppStore(join(dir, 'claude-control'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('пустой набор ключей не создаёт запись в состоянии', () => {
    store.setGroupEnvKeys('g1', []);
    expect(store.getGroupEnvKeys('g1')).toEqual([]);
    expect(store.getState().envByGroup.g1).toBeUndefined();
  });

  it('запоминает и отдаёт ключи, применённые группой', () => {
    store.setGroupEnvKeys('g1', ['A', 'B']);
    expect(store.getGroupEnvKeys('g1')).toEqual(['A', 'B']);
  });

  it('очистка ключей удаляет запись целиком, не оставляя мусора', () => {
    store.setGroupEnvKeys('g1', ['A']);
    store.setGroupEnvKeys('g1', []);
    expect(store.getState().envByGroup).toEqual({});
  });

  it('ключ считается «занятым группой», пока его держит хотя бы одна', () => {
    store.setGroupEnvKeys('g1', ['SHARED']);
    store.setGroupEnvKeys('g2', ['SHARED']);

    // g1 отпускает — ключ ещё держит g2.
    store.setGroupEnvKeys('g1', []);
    expect(store.isEnvKeyOwnedByGroup('SHARED')).toBe(true);

    // g2 отпускает — теперь ничей.
    store.setGroupEnvKeys('g2', []);
    expect(store.isEnvKeyOwnedByGroup('SHARED')).toBe(false);
  });

  it('exceptId исключает саму группу из проверки владения (ключ держит только она)', () => {
    store.setGroupEnvKeys('g1', ['ONLY']);
    // «Держит ли кто-то, кроме g1?» — нет.
    expect(store.isEnvKeyOwnedByGroup('ONLY', 'g1')).toBe(false);
    // Без исключения — да, держит g1.
    expect(store.isEnvKeyOwnedByGroup('ONLY')).toBe(true);
  });

  it('exceptId: ключ, общий с другой группой, всё равно занят', () => {
    store.setGroupEnvKeys('g1', ['SHARED']);
    store.setGroupEnvKeys('g2', ['SHARED']);
    expect(store.isEnvKeyOwnedByGroup('SHARED', 'g1')).toBe(true);
  });

  it('набор ключей хранится копией, а не ссылкой на входной массив', () => {
    const keys = ['A', 'B'];
    store.setGroupEnvKeys('g1', keys);
    keys.push('C'); // мутируем исходный массив после записи
    expect(store.getGroupEnvKeys('g1')).toEqual(['A', 'B']);
  });

  it('состояние envByGroup переживает перезапуск', () => {
    store.setGroupEnvKeys('g1', ['A', 'B']);
    const reopened = new AppStore(join(dir, 'claude-control'));
    expect(reopened.getGroupEnvKeys('g1')).toEqual(['A', 'B']);
  });

  it('старый state.json без поля envByGroup читается без падения', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'cc-envgroup-legacy-'));
    try {
      const legacy = new AppStore(legacyDir);
      expect(legacy.getGroupEnvKeys('нет-такой')).toEqual([]);
      expect(legacy.isEnvKeyOwnedByGroup('НЕТ')).toBe(false);
      expect(() => legacy.setGroupEnvKeys('g', ['X'])).not.toThrow();
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});

/**
 * Перенос состояния панели между машинами: export отдаёт снимок, import его
 * принимает и сливает с дефолтами (чужой файл может быть неполным или из старой
 * версии). Ключевое свойство — изоляция: снимок не должен разделять ссылки с
 * живым состоянием или с модульным DEFAULT_STATE (известная грабля).
 */
describe('AppStore — экспорт/импорт состояния', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-export-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exportState отдаёт независимый снимок: правки стора его не меняют', () => {
    const store = new AppStore(join(dir, 'claude-control'));
    store.setEnabled('rule', 'r1', false);

    const snapshot = store.exportState();
    store.setEnabled('hook', 'h1', false);

    // Снимок сделан до второй правки и не должен был измениться задним числом.
    expect(snapshot.disabled.hook).toEqual([]);
    expect(snapshot.disabled.rule).toEqual(['r1']);
  });

  it('importState заменяет состояние и переживает перезапуск (пишется в state.json)', () => {
    const store = new AppStore(join(dir, 'claude-control'));
    store.importState({
      disabled: { rule: ['x'], hook: [], skill: [], mcp: [], permission: [] },
      envByGroup: { g1: ['A'] },
    } satisfies Partial<AppState>);

    const reopened = new AppStore(join(dir, 'claude-control'));
    expect(reopened.isDisabledManually('rule', 'x')).toBe(true);
    expect(reopened.getGroupEnvKeys('g1')).toEqual(['A']);
  });

  it('import неполного снимка добирает недостающее из дефолтов, а не падает', () => {
    const store = new AppStore(join(dir, 'claude-control'));
    // В снимке только disabled.rule — остальные виды и settings должны прийти из base.
    store.importState({ disabled: { rule: ['only'] } } as Partial<AppState>);

    expect(store.isDisabledManually('rule', 'only')).toBe(true);
    // Виды, которых не было в снимке, существуют и пусты.
    expect(store.isDisabledManually('mcp', 'что-угодно')).toBe(false);
    // Настройки заполнены дефолтами.
    expect(store.getSettings().language).toBe('ru');
    expect(store.getSettings().backupKeep).toBe(10);
  });

  it('import частичных settings мержит их с дефолтами, не теряя прочих полей', () => {
    const store = new AppStore(join(dir, 'claude-control'));
    store.importState({ settings: { theme: 'dark' } } as Partial<AppState>);

    expect(store.getSettings().theme).toBe('dark');
    expect(store.getSettings().chatEffort).toBe('xhigh');
  });

  it('import пустого/невалидного значения даёт чистое состояние по дефолтам', () => {
    const store = new AppStore(join(dir, 'claude-control'));
    store.saveGroup({
      id: 'g',
      name: 'g',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [],
      env: {},
      isEnabled: true,
      order: 0,
    });

    store.importState(null);
    expect(store.getGroups()).toEqual([]);
    expect(store.getSettings().backupKeep).toBe(10);
  });

  it('export → import между разными сторами не разделяет ссылок (правка одного не течёт в другой)', () => {
    const a = new AppStore(join(dir, 'a'));
    a.setGroupEnvKeys('g1', ['A']);

    const b = new AppStore(join(dir, 'b'));
    b.importState(a.exportState());

    // Меняем b — a не должен пошевелиться.
    b.setGroupEnvKeys('g1', ['A', 'B']);
    expect(a.getGroupEnvKeys('g1')).toEqual(['A']);
  });

  it('импорт не портит модульный DEFAULT_STATE: свежий сторонний стор остаётся чистым', () => {
    const a = new AppStore(join(dir, 'a'));
    a.importState({
      disabled: { rule: ['leak'], hook: [], skill: [], mcp: [], permission: [] },
    } satisfies Partial<AppState>);

    const fresh = new AppStore(join(dir, 'fresh'));
    expect(fresh.isDisabledManually('rule', 'leak')).toBe(false);
    expect(fresh.getState().disabled.rule).toEqual([]);
  });
});
