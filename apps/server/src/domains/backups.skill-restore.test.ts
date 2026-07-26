import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore } from '../lib/app-store.ts';
import { restoreBackup } from './backups.ts';
import { readSkills } from './skills.ts';

/**
 * BUG-38. Откат копии скилла обязан вернуть скилл ТУДА, откуда копия снята, и
 * оставить его в одном экземпляре.
 *
 * Выключение скилла — это его физическое местоположение (skills/ против
 * skills-disabled/), поэтому раньше откат молча включал выключенный скилл, а
 * при живой копии в соседнем каталоге один и тот же id оказывался в обоих:
 * `readSkills` показывал его дважды, а переключатель падал на переносе папки
 * поверх существующей.
 */
describe('backups: откат копии скилла', () => {
  let dir: string;
  let skillsDir: string;
  let disabledDir: string;
  let backupDir: string;
  let store: AppStore;

  const putSkillDir = (base: string, id: string, body: string): void => {
    const skillDir = join(base, id);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${id}\ndescription: x\n---\n\n${body}\n`);
  };

  /** Копия папки скилла в каталоге копий: имя вида `<родитель>-<id>.<метка>.bak`. */
  const putBackup = (name: string, id: string, body: string): string => {
    const full = join(backupDir, `${name}.2026-01-01T00-00-00-000Z.bak`);
    mkdirSync(full, { recursive: true });
    writeFileSync(join(full, 'SKILL.md'), `---\nname: ${id}\ndescription: x\n---\n\n${body}\n`);
    return `${name}.2026-01-01T00-00-00-000Z.bak`;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-backup-skill-'));
    skillsDir = join(dir, 'skills');
    disabledDir = join(dir, 'skills-disabled');
    backupDir = join(dir, 'backups');
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(backupDir, { recursive: true });
    store = new AppStore(join(dir, 'claude-control'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('копия выключенного скилла возвращается выключенной, а не включается (BUG-38)', () => {
    const name = putBackup('skills-disabled-review', 'review', 'старое тело');

    const result = restoreBackup(backupDir, name, {}, skillsDir);

    expect(result.ok).toBe(true);
    expect(existsSync(join(disabledDir, 'review', 'SKILL.md'))).toBe(true);
    // Скилл НЕ должен появиться в активном каталоге: пользователь его выключал.
    expect(existsSync(join(skillsDir, 'review'))).toBe(false);
    expect(readSkills(skillsDir, store).find((skill) => skill.id === 'review')?.isEnabled).toBe(
      false,
    );
  });

  it('откат не оставляет один id сразу в skills/ и skills-disabled/ (BUG-38)', () => {
    // Сценарий из отчёта: скилл удалили (осталась копия), создали заново и
    // выключили — теперь он лежит в skills-disabled/.
    putSkillDir(disabledDir, 'review', 'новое тело');
    const name = putBackup('skills-review', 'review', 'старое тело');

    const result = restoreBackup(backupDir, name, {}, skillsDir);

    expect(result.ok).toBe(true);
    expect(existsSync(join(skillsDir, 'review', 'SKILL.md'))).toBe(true);
    // Соседа не осталось — иначе список показывал бы «review» дважды.
    expect(existsSync(join(disabledDir, 'review'))).toBe(false);
    expect(readSkills(skillsDir, store).filter((skill) => skill.id === 'review')).toHaveLength(1);
  });

  /**
   * Имя копии двусмысленно: `skills-disabled-review` — это и выключенный
   * «review», и включённый скилл, который так и называется, «disabled-review».
   * Разбор по одному префиксу выбирал первое прочтение всегда: копия уезжала в
   * skills-disabled/review, а «соседом» объявлялся ПОСТОРОННИЙ скилл
   * skills/review — и удалялся.
   */
  it('копия скилла с именем «disabled-…» не сносит однофамильца (BUG-38)', () => {
    putSkillDir(skillsDir, 'disabled-review', 'тело скилла disabled-review');
    putSkillDir(skillsDir, 'review', 'посторонний скилл');
    const name = putBackup('skills-disabled-review', 'disabled-review', 'старое тело');

    const result = restoreBackup(backupDir, name, {}, skillsDir);

    expect(result.ok).toBe(true);
    // Копия развернулась в свой скилл…
    expect(existsSync(join(skillsDir, 'disabled-review', 'SKILL.md'))).toBe(true);
    // …а посторонний скилл остался нетронутым.
    expect(existsSync(join(skillsDir, 'review', 'SKILL.md'))).toBe(true);
    // И никакого «выключенного review» из воздуха не появилось.
    expect(existsSync(join(disabledDir, 'review'))).toBe(false);
  });

  it('оба прочтения имени живы — откат отказывает, а не бьёт наугад', () => {
    putSkillDir(disabledDir, 'review', 'выключенный review');
    putSkillDir(skillsDir, 'disabled-review', 'скилл disabled-review');
    const name = putBackup('skills-disabled-review', 'review', 'старое тело');

    const result = restoreBackup(backupDir, name, {}, skillsDir);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Непонятно');
    // Ни один из двух живых скиллов не пострадал.
    expect(existsSync(join(disabledDir, 'review', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'disabled-review', 'SKILL.md'))).toBe(true);
  });

  it('вытесненный сосед сохраняется копией — его текст не теряется (BUG-38)', () => {
    putSkillDir(disabledDir, 'review', 'состояние соседа');
    const name = putBackup('skills-review', 'review', 'старое тело');

    restoreBackup(backupDir, name, {}, skillsDir);

    const madeBackup = readdirSync(backupDir).find((entry) =>
      entry.startsWith('skills-disabled-review.'),
    );
    expect(madeBackup).toBeDefined();
    expect(existsSync(join(backupDir, madeBackup as string, 'SKILL.md'))).toBe(true);
  });
});
