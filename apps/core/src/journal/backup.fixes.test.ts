import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as files from '../platform/safe-io/files.ts';
import { backupDay, runDailyBackup } from './backup.ts';
import { tempDir } from './__fixtures__/journal-harness.ts';

/**
 * Ревью core-s2 F-102: `.partial` дня, чья копия так и не собралась, жил вечно (ротация видит
 * только полные дни); проход «ничего не бросает», но бросок чтения каталога выходил наружу;
 * день копии — местный, как его видит человек, а не UTC.
 */
const DAY_MS = 86_400_000;

function dirsOf(root: string) {
  const dirs = {
    backupsDir: join(root, 'backups'),
    tasksDir: join(root, 'tasks'),
    profilesDir: join(root, 'profiles'),
  };
  mkdirSync(dirs.backupsDir, { recursive: true });
  mkdirSync(dirs.tasksDir, { recursive: true });
  return dirs;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('core-s2 daily backup fixes', () => {
  it('F-102 a .partial of a past day is removed by a later pass; today’s .partial is kept for the retry', () => {
    const root = tempDir('bk-');
    const dirs = dirsOf(root);
    // День 1: профили — файл, не каталог: названный сбой, день остаётся `.partial`.
    writeFileSync(dirs.profilesDir, 'not a dir');
    const day1 = new Date(2026, 0, 1, 12).getTime();
    const first = runDailyBackup({ ...dirs, activeTaskIds: [], at: day1 });
    expect(first.failures.length).toBeGreaterThan(0);
    expect(readdirSync(dirs.backupsDir)).toEqual([`${backupDay(day1)}.partial`]);
    const profilesDir = join(root, 'profiles2');
    mkdirSync(profilesDir);
    const next = runDailyBackup({ ...dirs, profilesDir, activeTaskIds: [], at: day1 + DAY_MS });
    expect(next.failures).toEqual([]);
    expect(next.pruned).toContain(`${backupDay(day1)}.partial`);
    expect(readdirSync(dirs.backupsDir)).toEqual([backupDay(day1 + DAY_MS)]);
  });

  it('F-102 the pass never throws: a listing that throws is a named failure', () => {
    const dirs = dirsOf(tempDir('bk-'));
    vi.spyOn(files, 'listDir').mockImplementation(() => {
      throw new Error('EACCES: listing refused');
    });
    let out: ReturnType<typeof runDailyBackup> | undefined;
    expect(() => {
      out = runDailyBackup({ ...dirs, activeTaskIds: [], at: new Date(2026, 0, 2, 12).getTime() });
    }).not.toThrow();
    expect(out?.failures.some((f) => f.includes('EACCES: listing refused'))).toBe(true);
  });

  it('F-102 the backup day is the local calendar day', () => {
    expect(backupDay(new Date(2026, 0, 1, 0, 30).getTime())).toBe('2026-01-01');
    expect(backupDay(new Date(2026, 11, 31, 23, 30).getTime())).toBe('2026-12-31');
  });
});
