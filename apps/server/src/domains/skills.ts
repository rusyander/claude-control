/**
 * Скилл — папка с файлом SKILL.md, у которого в начале YAML-frontmatter
 * с полями name и description. Именно description Claude использует, чтобы
 * решить, когда применять скилл, поэтому в интерфейсе оно на видном месте.
 *
 * Выключение реализовано переносом папки в `skills-disabled/`: Claude
 * сканирует только `skills/`, так что перенос — самый честный способ
 * скрыть скилл, не удаляя его.
 *
 * Модули: `skills/read.ts` — чтение списка, `skills/write.ts` — сохранение
 * SKILL.md, `skills/lifecycle.ts` — включение, переименование и удаление папки,
 * `skills/frontmatter.ts` — разбор шапки, `skills/paths.ts` — где что лежит.
 */

export { deleteSkill, renameSkill, setSkillEnabled } from './skills/lifecycle.ts';
export { SKILLS_DISABLED_DIR } from './skills/paths.ts';
export { readSkills } from './skills/read.ts';
export { saveSkill, SkillExistsError } from './skills/write.ts';
