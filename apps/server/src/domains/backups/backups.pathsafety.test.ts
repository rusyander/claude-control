import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBackupTarget, restoreBackup, listBackups } from './backups.ts';

/**
 * Безопасность восстановления копий. Имя копии приходит из HTTP-запроса, а по
 * нему решается, КУДА писать на диск. Это классическое место для обхода пути:
 * `../`, разделители каталогов, пустой сегмент, посторонний префикс. Здесь
 * проверяется, что вывод цели безопасен во всех ветках — и для файлов конфига,
 * и для рекурсивно разворачиваемых папок скиллов.
 */
describe('backups: безопасность вывода цели восстановления', () => {
  const skillsDir = join('/srv', '.claude', 'skills');
  const known = {
    settings: join('/srv', '.claude', 'settings.json'),
    claudeMd: join('/srv', '.claude', 'CLAUDE.md'),
    secretsEnv: join('/srv', '.claude', '.mcp-secrets.env'),
  };

  describe('файлы конфигурации: только по известному списку путей', () => {
    it('известный файл резолвится в полный путь из whitelist, а не собирается из имени', () => {
      expect(resolveBackupTarget('settings.json', false, known, skillsDir)).toBe(known.settings);
      expect(resolveBackupTarget('.mcp-secrets.env', false, known, skillsDir)).toBe(
        known.secretsEnv,
      );
    });

    it('посторонний файл — цель неизвестна, восстановление недоступно', () => {
      expect(resolveBackupTarget('чужое.json', false, known, skillsDir)).toBeUndefined();
    });

    it('имя, совпадающее лишь частично, целью не считается (сверка по полному basename)', () => {
      expect(resolveBackupTarget('settings', false, known, skillsDir)).toBeUndefined();
      expect(resolveBackupTarget('settings.json.extra', false, known, skillsDir)).toBeUndefined();
    });
  });

  describe('папки скиллов: id обязан быть одним безопасным сегментом', () => {
    it('skills-<id> разворачивается в активный каталог skills/<id>', () => {
      expect(resolveBackupTarget('skills-мой-скилл', true, {}, skillsDir)).toBe(
        join(skillsDir, 'мой-скилл'),
      );
    });

    /**
     * BUG-38. Раньше обе копии разворачивались в активный skills/ — откат
     * ВКЛЮЧАЛ скилл, который пользователь выключил. Префикс имени копии
     * говорит, где скилл лежал в момент снимка, туда он и возвращается.
     */
    it('skills-disabled-<id> возвращается в skills-disabled/<id>, а не включается (BUG-38)', () => {
      expect(resolveBackupTarget('skills-disabled-мой', true, {}, skillsDir)).toBe(
        join(skillsDir, '..', 'skills-disabled', 'мой'),
      );
      // Префикс снимается целиком — id не должен остаться с «disabled-».
      expect(resolveBackupTarget('skills-disabled-мой', true, {}, skillsDir)).toContain('мой');
      expect(resolveBackupTarget('skills-disabled-мой', true, {}, skillsDir)).not.toContain(
        'disabled-мой',
      );
    });

    it('обход пути через .. в id отклоняется', () => {
      expect(resolveBackupTarget('skills-..', true, {}, skillsDir)).toBeUndefined();
      expect(resolveBackupTarget('skills-../evil', true, {}, skillsDir)).toBeUndefined();
      expect(resolveBackupTarget('skills-disabled-../../etc', true, {}, skillsDir)).toBeUndefined();
    });

    it('разделители каталогов (/ и \\) в id отклоняются', () => {
      expect(resolveBackupTarget('skills-a/b', true, {}, skillsDir)).toBeUndefined();
      expect(resolveBackupTarget('skills-a\\b', true, {}, skillsDir)).toBeUndefined();
      expect(resolveBackupTarget('skills-disabled-a/b', true, {}, skillsDir)).toBeUndefined();
    });

    it('пустой id (голый префикс) отклоняется', () => {
      expect(resolveBackupTarget('skills-', true, {}, skillsDir)).toBeUndefined();
      expect(resolveBackupTarget('skills-disabled-', true, {}, skillsDir)).toBeUndefined();
    });

    it('папка без известного префикса skills- восстановлению не подлежит', () => {
      expect(resolveBackupTarget('чужая-папка', true, {}, skillsDir)).toBeUndefined();
    });

    it('без skillsDir папку вернуть некуда', () => {
      expect(resolveBackupTarget('skills-мой', true, {}, undefined)).toBeUndefined();
    });
  });
});

/**
 * Восстановление на настоящей файловой системе: happy-path папки скилла,
 * обратимость (снимок текущего состояния перед заменой), нелатинские имена и
 * тройная защита имени в restoreBackup (regex + существование + наличие в
 * перечне реальных копий) от обхода пути через параметр name.
 */
describe('backups: восстановление на диске', () => {
  let dir: string;
  let backupDir: string;
  let skillsDir: string;
  let known: Record<string, string>;

  const stamp = '2026-07-19T10-00-00-000Z';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-restore-'));
    backupDir = join(dir, 'backups');
    skillsDir = join(dir, 'skills');
    mkdirSync(backupDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
    known = { settings: join(dir, 'settings.json') };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Кладёт папку-копию скилла с нелатинским именем и парой файлов. */
  const seedSkillBackup = (id: string): string => {
    const name = `skills-${id}.${stamp}.bak`;
    const root = join(backupDir, name);
    mkdirSync(join(root, 'вложенная'), { recursive: true });
    writeFileSync(join(root, 'SKILL.md'), 'тело скилла');
    writeFileSync(join(root, 'вложенная', 'файл.txt'), 'вложенный');
    return name;
  };

  it('папка скилла разворачивается рекурсивно в skills/<id>', () => {
    const name = seedSkillBackup('мой-скилл');

    const result = restoreBackup(backupDir, name, known, skillsDir);

    expect(result.ok).toBe(true);
    expect(result.restoredTo).toBe(join(skillsDir, 'мой-скилл'));
    expect(readFileSync(join(skillsDir, 'мой-скилл', 'SKILL.md'), 'utf8')).toBe('тело скилла');
    // Вложенные файлы тоже на месте — копирование именно рекурсивное.
    expect(readFileSync(join(skillsDir, 'мой-скилл', 'вложенная', 'файл.txt'), 'utf8')).toBe(
      'вложенный',
    );
  });

  it('восстановление поверх существующего скилла обратимо: старое уходит в копию', () => {
    const name = seedSkillBackup('мой-скилл');
    // Уже есть активная версия с ДРУГИМ содержимым и лишним файлом.
    mkdirSync(join(skillsDir, 'мой-скилл'), { recursive: true });
    writeFileSync(join(skillsDir, 'мой-скилл', 'SKILL.md'), 'старая версия');
    writeFileSync(join(skillsDir, 'мой-скилл', 'лишний.txt'), 'должен исчезнуть');

    const result = restoreBackup(backupDir, name, known, skillsDir);

    expect(result.ok).toBe(true);
    // Снимок прежнего состояния сделан — откат обратим.
    expect(result.backupPath).toBeDefined();
    expect(readFileSync(join(result.backupPath!, 'SKILL.md'), 'utf8')).toBe('старая версия');
    // Прежняя папка убрана целиком перед разворачиванием — старые файлы не смешались.
    expect(existsSync(join(skillsDir, 'мой-скилл', 'лишний.txt'))).toBe(false);
    expect(readFileSync(join(skillsDir, 'мой-скилл', 'SKILL.md'), 'utf8')).toBe('тело скилла');
  });

  it('обход пути через name отклоняется: такого имени нет среди реальных копий', () => {
    // Готовим настоящий секрет ЗА пределами каталога копий, который «утечка»
    // попыталась бы восстановить.
    writeFileSync(join(dir, 'секрет.json'), 'секрет');

    const result = restoreBackup(
      backupDir,
      `..${'/'}..${'/'}секрет.json.${stamp}.bak`,
      known,
      skillsDir,
    );

    expect(result.ok).toBe(false);
    // Ничего не восстановлено и не перезаписано за пределами каталога.
    expect(result.restoredTo).toBeUndefined();
  });

  it('имя без валидной метки времени отклоняется до любых обращений к диску', () => {
    const result = restoreBackup(backupDir, '../../evil', known, skillsDir);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/не найдена/i);
  });

  it('listBackups помечает папку скилла как восстановимую, когда известен skillsDir', () => {
    const name = seedSkillBackup('мой-скилл');
    const entry = listBackups(backupDir, known, skillsDir).find((item) => item.name === name);

    expect(entry).toBeDefined();
    expect(entry?.canRestore).toBe(true);
  });

  it('та же папка скилла без skillsDir — уже не восстановима', () => {
    const name = seedSkillBackup('мой-скилл');
    const entry = listBackups(backupDir, known).find((item) => item.name === name);

    expect(entry?.canRestore).toBe(false);
  });
});
