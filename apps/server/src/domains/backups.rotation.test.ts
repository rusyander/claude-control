import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreBackup } from './backups.ts';
import { setBackupKeep } from '../lib/safe-io.ts';

/**
 * Откат к САМОЙ СТАРОЙ копии, когда каталог уже заполнен до предела ротации.
 *
 * Ловушка: перед заменой снимается копия текущего состояния, а она заканчивается
 * ротацией — та выкидывала старейшую копию той же базы, то есть ровно ту, к
 * которой откатываются. Файл падал с ENOENT (копия потеряна, откат не состоялся),
 * а папка скилла к тому моменту была уже удалена — терялось и то, и другое.
 */
describe('Резервные копии: откат к старейшей копии не съедает сам себя', () => {
  let dir: string;
  let backupDir: string;
  let skillsDir: string;

  const OLDEST = '2026-07-19T10-00-00-000Z';
  const NEWEST = '2026-07-19T11-00-00-000Z';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-backups-rot-'));
    backupDir = join(dir, 'backups');
    skillsDir = join(dir, 'skills');
    mkdirSync(backupDir, { recursive: true });
    // Предел ротации ровно по числу уже лежащих копий: следующая запись выбьет
    // старейшую. Это и есть боевой случай — каталог давно заполнен.
    setBackupKeep(2);
  });

  afterEach(() => {
    setBackupKeep(10);
    rmSync(dir, { recursive: true, force: true });
  });

  it('файл: старейшая копия возвращается, откат не падает', () => {
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, '{"version":"текущая"}');
    writeFileSync(join(backupDir, `settings.json.${OLDEST}.bak`), '{"version":"старая"}');
    writeFileSync(join(backupDir, `settings.json.${NEWEST}.bak`), '{"version":"средняя"}');

    const result = restoreBackup(backupDir, `settings.json.${OLDEST}.bak`, {
      settings: settingsPath,
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(settingsPath, 'utf8')).toBe('{"version":"старая"}');
    // Откат остался обратимым: состояние «до» сохранено копией.
    expect(readFileSync(result.backupPath!, 'utf8')).toBe('{"version":"текущая"}');
  });

  it('папка скилла: старейшая копия разворачивается, скилл не остаётся стёртым', () => {
    const skillPath = join(skillsDir, 'ревью');
    mkdirSync(skillPath, { recursive: true });
    writeFileSync(join(skillPath, 'SKILL.md'), '# текущий');

    for (const [stamp, text] of [
      [OLDEST, '# старый'],
      [NEWEST, '# средний'],
    ]) {
      const copy = join(backupDir, `skills-ревью.${stamp}.bak`);
      mkdirSync(copy, { recursive: true });
      writeFileSync(join(copy, 'SKILL.md'), text!);
    }

    const result = restoreBackup(backupDir, `skills-ревью.${OLDEST}.bak`, {}, skillsDir);

    expect(result.ok).toBe(true);
    expect(readFileSync(join(skillPath, 'SKILL.md'), 'utf8')).toBe('# старый');
    expect(readFileSync(join(result.backupPath!, 'SKILL.md'), 'utf8')).toBe('# текущий');
    // Временный дубль папки, снятый до ротации, за собой прибран.
    expect(readdirSync(backupDir).some((name) => name.startsWith('.restore-'))).toBe(false);
  });
});
