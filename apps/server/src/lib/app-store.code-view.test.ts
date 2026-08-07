import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from './app-store.ts';

/**
 * Память окна кода: что было открыто у таба проекта.
 *
 * Проверяется ровно то, ради чего эта память заведена на сервере, а не в
 * браузере: снимок переживает перезапуск панели, ключ не зависит от того, как
 * записан путь (регистр и слэши на Windows пляшут), а закрытие таба стирает
 * запись насовсем.
 */
describe('AppStore: снимок окна кода', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-code-view-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const appData = (): string => join(dir, 'claude-control');

  const view = {
    file: 'src/app.ts',
    openDirs: ['src', 'src/lib'],
    showDiff: true,
    onlyChanged: false,
  };

  it('пусто, пока таб не открывали', () => {
    expect(new AppStore(appData()).getCodeView('C:/work/project')).toBeUndefined();
  });

  it('снимок переживает перезапуск панели', () => {
    new AppStore(appData()).setCodeView('C:/work/project', view);

    expect(new AppStore(appData()).getCodeView('C:/work/project')).toEqual(view);
  });

  it('путь читается в любом написании — ключ один', () => {
    const store = new AppStore(appData());
    store.setCodeView('C:/work/Project', view);

    expect(store.getCodeView('c:\\work\\project\\')?.file).toBe('src/app.ts');
  });

  it('закрытие таба стирает запись', () => {
    const store = new AppStore(appData());
    store.setCodeView('C:/work/project', view);
    store.forgetCodeView('C:/work/project');

    expect(store.getCodeView('C:/work/project')).toBeUndefined();
    expect(new AppStore(appData()).getCodeView('C:/work/project')).toBeUndefined();
  });

  it('у каждого проекта своя запись', () => {
    const store = new AppStore(appData());
    store.setCodeView('C:/work/one', view);
    store.setCodeView('C:/work/two', { ...view, file: 'README.md' });

    expect(store.getCodeView('C:/work/one')?.file).toBe('src/app.ts');
    expect(store.getCodeView('C:/work/two')?.file).toBe('README.md');
  });

  it('список раскрытых папок урезается: дерево репозитория не хранилище', () => {
    const store = new AppStore(appData());
    const many = Array.from({ length: 500 }, (_, index) => `dir-${index}`);
    store.setCodeView('C:/work/project', { ...view, openDirs: many });

    expect(store.getCodeView('C:/work/project')?.openDirs).toHaveLength(200);
  });

  it('пустое имя файла означает «не открыт», а не пустой путь', () => {
    const store = new AppStore(appData());
    store.setCodeView('C:/work/project', { ...view, file: '' });

    expect(store.getCodeView('C:/work/project')?.file).toBeUndefined();
  });
});

/**
 * Ширина списка файлов — ОДНА на панель.
 *
 * Проверяется то, что делает её общей и что защищает от мусора: ключа проекта
 * у неё нет, значение обрезается по границам (клиент шлёт результат
 * перетаскивания мышью), а испорченный state.json не должен ронять окно.
 */
describe('AppStore: раскладка окна кода', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-code-layout-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const appData = (): string => join(dir, 'claude-control');

  it('без записи отдаётся умолчание', () => {
    expect(new AppStore(appData()).getCodeLayout()).toEqual({ treeWidth: 300 });
  });

  it('ширина переживает перезапуск панели', () => {
    new AppStore(appData()).setCodeLayout({ treeWidth: 420 });
    expect(new AppStore(appData()).getCodeLayout()).toEqual({ treeWidth: 420 });
  });

  it('ширина одна на все проекты — ключа проекта у неё нет', () => {
    const store = new AppStore(appData());
    store.setCodeView('C:/work/one', {
      file: 'a.ts',
      openDirs: [],
      showDiff: true,
      onlyChanged: false,
    });
    store.setCodeLayout({ treeWidth: 500 });

    store.forgetCodeView('C:/work/one');
    expect(store.getCodeLayout()).toEqual({ treeWidth: 500 });
  });

  it('перебор обрезается по границам, а не отвергается', () => {
    const store = new AppStore(appData());
    store.setCodeLayout({ treeWidth: 5000 });
    expect(store.getCodeLayout()).toEqual({ treeWidth: 720 });

    store.setCodeLayout({ treeWidth: 10 });
    expect(store.getCodeLayout()).toEqual({ treeWidth: 200 });
  });

  it('дробное значение округляется: ширина в пикселях целая', () => {
    const store = new AppStore(appData());
    store.setCodeLayout({ treeWidth: 333.7 });
    expect(store.getCodeLayout()).toEqual({ treeWidth: 334 });
  });

  it('мусор в state.json читается как умолчание, а не роняет окно', () => {
    const store = new AppStore(appData());
    store.setCodeLayout({ treeWidth: Number.NaN });
    expect(store.getCodeLayout()).toEqual({ treeWidth: 300 });
  });
});
