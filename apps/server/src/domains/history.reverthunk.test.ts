import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { buildDiff, revertHunk } from './history.ts';
import type { TrackedFile } from './tracked-files.ts';

/**
 * Выборочный откат ОДНОГО ханка из копии в текущий файл.
 *
 * Главная гарантия: откат выбранного блока возвращает ровно его к состоянию
 * копии, а прочие блоки текущего файла не задевает. Плюс безопасность — имя
 * копии из запроса не должно уводить запись наружу, а индексы ханков сервера
 * совпадают с тем, что видно в диффе (buildDiff проставляет hunk строкам).
 */

/** Отслеживаемый файл Claude: имя копии = basename, откат разрешён. */
function claudeTarget(path: string): TrackedFile {
  const file = basename(path);
  return { backupBase: file, path, file, canRevert: true };
}

describe('Выборочный откат ханка', () => {
  let dir: string;
  let backupDir: string;
  let settingsPath: string;
  let knownPaths: TrackedFile[];
  // Копия и текущий файл различаются в двух местах, разделённых контекстом, —
  // это два независимых ханка (0: b→B, 1: d→D).
  const SNAPSHOT = 'a\nb\nc\nd\ne\n';
  const CURRENT = 'a\nB\nc\nD\ne\n';
  const NAME = 'settings.json.2026-07-19T10-00-00-000Z.bak';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-reverthunk-'));
    backupDir = join(dir, 'backups');
    settingsPath = join(dir, 'settings.json');
    mkdirSync(backupDir, { recursive: true });

    writeFileSync(settingsPath, CURRENT);
    writeFileSync(join(backupDir, NAME), SNAPSHOT);
    knownPaths = [claudeTarget(settingsPath)];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('неизвестная копия — отказ с признаком notFound (маршрут отвечает 404, а не 400)', () => {
    for (const name of ['settings.json.2026-01-01T00-00-00-000Z.bak', 'nope', '../x.bak']) {
      const result = revertHunk(backupDir, name, 0, knownPaths, backupDir);
      expect(result.ok).toBe(false);
      expect(result.notFound).toBe(true);
    }
    expect(readFileSync(settingsPath, 'utf8')).toBe(CURRENT);
  });

  it('дифф самой свежей копии нумерует ханки — два блока правок', () => {
    const diff = buildDiff(backupDir, NAME, knownPaths)!;
    expect(diff.label).toBe('current');
    const hunks = new Set(
      diff.lines.filter((line) => line.kind !== 'ctx').map((line) => line.hunk),
    );
    expect(hunks).toEqual(new Set([0, 1]));
  });

  it('откат ханка 0 возвращает только первый блок, второй не трогает', () => {
    const result = revertHunk(backupDir, NAME, 0, knownPaths, backupDir);
    expect(result.ok).toBe(true);
    // b восстановлено из копии, D осталось текущим.
    expect(readFileSync(settingsPath, 'utf8')).toBe('a\nb\nc\nD\ne\n');
  });

  it('откат ханка 1 возвращает только второй блок, первый не трогает', () => {
    const result = revertHunk(backupDir, NAME, 1, knownPaths, backupDir);
    expect(result.ok).toBe(true);
    expect(readFileSync(settingsPath, 'utf8')).toBe('a\nB\nc\nd\ne\n');
  });

  it('откат обоих ханков по очереди приводит файл к состоянию копии', () => {
    revertHunk(backupDir, NAME, 0, knownPaths, backupDir);
    // После первого отката индексы ханков пересчитываются: остаётся один блок (0).
    revertHunk(backupDir, NAME, 0, knownPaths, backupDir);
    expect(readFileSync(settingsPath, 'utf8')).toBe(SNAPSHOT);
  });

  it('сам откат обратим: состояние до сохраняется копией', () => {
    const result = revertHunk(backupDir, NAME, 0, knownPaths, backupDir);
    expect(result.backupPath).toBeDefined();
    expect(readFileSync(result.backupPath!, 'utf8')).toBe(CURRENT);
  });

  it('несуществующий индекс ханка — отказ, файл не тронут', () => {
    const result = revertHunk(backupDir, NAME, 5, knownPaths, backupDir);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/не найдено/i);
    expect(readFileSync(settingsPath, 'utf8')).toBe(CURRENT);
  });

  it('обход пути в имени копии отклоняется, ничего не пишется', () => {
    const result = revertHunk(backupDir, '../../evil', 0, knownPaths, backupDir);
    expect(result.ok).toBe(false);
    expect(readFileSync(settingsPath, 'utf8')).toBe(CURRENT);
  });
});
