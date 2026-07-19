import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { listRoots, listDirectory } from './FileBrowser.ts';

/**
 * Тесты обзора ФС для выбора папки проекта. Показываем только каталоги, скрытые
 * прячем, есть переход вверх. Тест-кейсы см. .agent/TEST-CASES.md → «Обзор ФС».
 */
describe('listRoots', () => {
  it('всегда содержит домашнюю папку и хотя бы один корень', () => {
    const roots = listRoots();
    expect(roots.length).toBeGreaterThanOrEqual(2);
    expect(roots[0]?.name).toBe('~');
  });
});

describe('listDirectory', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-fs-'));
    mkdirSync(join(dir, 'alpha'));
    mkdirSync(join(dir, 'beta'));
    mkdirSync(join(dir, '.hidden'));
    writeFileSync(join(dir, 'file.txt'), 'x');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('возвращает только каталоги, по алфавиту, без файлов и скрытых', () => {
    const listing = listDirectory(dir);
    expect(listing.entries.map((e) => e.name)).toEqual(['alpha', 'beta']);
  });

  it('даёт путь к родителю для перехода вверх', () => {
    const listing = listDirectory(dir);
    expect(listing.parent).toBe(dirname(dir));
    expect(listing.path).toBe(dir);
  });

  it('пути записей абсолютные — их можно открыть как проект', () => {
    const listing = listDirectory(dir);
    expect(listing.entries[0]?.path).toBe(join(dir, 'alpha'));
  });
});
