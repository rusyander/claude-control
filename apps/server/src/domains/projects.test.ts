import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, sep, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkProjectDir,
  isInsideProject,
  makeProject,
  projectName,
  resolveProjectPaths,
} from './projects.ts';

describe('resolveProjectPaths', () => {
  // База с учётом буквы диска на Windows — resolve добавляет её сам.
  const base = resolve(join(sep, 'work', 'demo'));

  it('строит стандартные проектные пути от каталога', () => {
    const paths = resolveProjectPaths(base);
    expect(paths.root).toBe(base);
    expect(paths.claudeMd).toBe(join(base, 'CLAUDE.md'));
    expect(paths.settings).toBe(join(base, '.claude', 'settings.json'));
    expect(paths.settingsLocal).toBe(join(base, '.claude', 'settings.local.json'));
    expect(paths.mcpConfig).toBe(join(base, '.mcp.json'));
  });

  it('нормализует путь через resolve (корень — абсолютный, без ..)', () => {
    const paths = resolveProjectPaths(join(base, '..', 'demo'));
    expect(paths.root).toBe(base);
  });
});

describe('isInsideProject: безопасность пути', () => {
  const root = resolve(join(sep, 'work', 'demo'));

  it('свои конфиги — внутри проекта', () => {
    const paths = resolveProjectPaths(root);
    expect(isInsideProject(root, paths.claudeMd)).toBe(true);
    expect(isInsideProject(root, paths.settings)).toBe(true);
    expect(isInsideProject(root, paths.mcpConfig)).toBe(true);
  });

  it('выход за пределы каталога отвергается', () => {
    expect(isInsideProject(root, join(sep, 'work', 'other', 'secret'))).toBe(false);
    expect(isInsideProject(root, join(root, '..', 'evil.json'))).toBe(false);
  });
});

describe('checkProjectDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-proj-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('существующий каталог пригоден', () => {
    expect(checkProjectDir(dir)).toBeNull();
  });

  it('несуществующий путь отвергается', () => {
    expect(checkProjectDir(join(dir, 'nope'))).toMatch(/не существует/);
  });

  it('файл вместо каталога отвергается', () => {
    const file = join(dir, 'file.txt');
    writeFileSync(file, 'x', 'utf8');
    expect(checkProjectDir(file)).toMatch(/не каталог/);
  });

  it('относительный путь отвергается', () => {
    expect(checkProjectDir('relative/path')).toMatch(/абсолютным/);
  });

  it('пустой путь отвергается', () => {
    expect(checkProjectDir('   ')).toMatch(/не задан/);
  });
});

describe('makeProject / projectName', () => {
  it('имя берётся из последнего сегмента, если не задано', () => {
    const project = makeProject({ path: join(sep, 'work', 'my-app') });
    expect(project.name).toBe('my-app');
    expect(project.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('заданное имя имеет приоритет', () => {
    const project = makeProject({ path: join(sep, 'work', 'my-app'), name: 'Витрина' });
    expect(project.name).toBe('Витрина');
  });

  it('projectName для каталога с завершающим слэшем', () => {
    expect(projectName(join(sep, 'work', 'demo') + sep)).toBe('demo');
  });

  it('каталог .claude создаётся при записи, а не заранее', () => {
    // Резолв путей не трогает диск: .claude может отсутствовать до первой записи.
    const dir = mkdtempSync(join(tmpdir(), 'cc-proj-'));
    try {
      const paths = resolveProjectPaths(dir);
      expect(paths.settings).toContain(join('.claude', 'settings.json'));
      // Каталога .claude ещё нет — его создаст writeTextFile при первой записи.
      mkdirSync(dir, { recursive: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
