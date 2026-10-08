import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteSkill } from './skills.ts';

/**
 * Удаление скилла — единственная по-настоящему разрушительная операция
 * панели: стирается целая папка, и отменить это нечем. Всё остальное в
 * приложении пишется через резервную копию, а здесь копии не было.
 * Тесты закрепляют, что она делается ДО удаления.
 */
describe('Удаление скилла — резервная копия', () => {
  let dir: string;
  let skillsDir: string;
  let backupDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-skill-del-'));
    skillsDir = join(dir, 'skills');
    backupDir = join(dir, 'backups');

    mkdirSync(join(skillsDir, 'мой-скилл', 'references'), { recursive: true });
    writeFileSync(join(skillsDir, 'мой-скилл', 'SKILL.md'), '---\nname: мой-скилл\n---\nтело');
    writeFileSync(join(skillsDir, 'мой-скилл', 'references', 'guide.md'), 'вложенный файл');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('папка удаляется', () => {
    deleteSkill(skillsDir, 'мой-скилл', backupDir);
    expect(existsSync(join(skillsDir, 'мой-скилл'))).toBe(false);
  });

  it('копия папки остаётся в бэкапах вместе с вложенными файлами', () => {
    const backupPath = deleteSkill(skillsDir, 'мой-скилл', backupDir);

    expect(backupPath).toBeDefined();
    expect(existsSync(join(backupPath!, 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(backupPath!, 'references', 'guide.md'), 'utf8')).toBe(
      'вложенный файл',
    );
  });

  it('без каталога бэкапов работает как раньше — просто удаляет', () => {
    expect(deleteSkill(skillsDir, 'мой-скилл')).toBeUndefined();
    expect(existsSync(join(skillsDir, 'мой-скилл'))).toBe(false);
  });

  it('удаление несуществующего скилла копию не создаёт', () => {
    expect(deleteSkill(skillsDir, 'нет-такого', backupDir)).toBeUndefined();
    expect(existsSync(backupDir)).toBe(false);
  });

  it('скилл, лежащий в обеих папках, копируется дважды под разными именами', () => {
    // Такое бывает, когда папку положили руками и в skills, и в skills-disabled.
    mkdirSync(join(dir, 'skills-disabled', 'мой-скилл'), { recursive: true });
    writeFileSync(join(dir, 'skills-disabled', 'мой-скилл', 'SKILL.md'), 'выключенная копия');

    deleteSkill(skillsDir, 'мой-скилл', backupDir);

    const backups = readdirSync(backupDir);
    expect(backups).toHaveLength(2);
    expect(backups.some((name) => name.startsWith('skills-мой-скилл'))).toBe(true);
    expect(backups.some((name) => name.startsWith('skills-disabled-мой-скилл'))).toBe(true);
  });
});
