import { join } from 'node:path';

/** Каталог выключенных скиллов рядом с skills/. Знает и откат копий (backups.ts). */
export const SKILLS_DISABLED_DIR = 'skills-disabled';

/** Соседний каталог выключенных скиллов для заданного `skills/`. */
export function disabledSkillsDir(skillsDir: string): string {
  return join(skillsDir, '..', SKILLS_DISABLED_DIR);
}
