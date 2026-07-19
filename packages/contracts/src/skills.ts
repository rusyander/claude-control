import { object, string, array, boolean, number, type infer as Infer } from 'zod';

/**
 * Скилл Claude Code — папка в `skills/` с файлом SKILL.md.
 * Имя и описание берутся из YAML-frontmatter этого файла.
 */
export const skillSchema = object({
  /** Имя папки — оно же идентификатор скилла. */
  id: string(),
  /** Поле name из frontmatter (обычно совпадает с папкой). */
  name: string(),
  /** Поле description — по нему Claude решает, когда скилл применять. */
  description: string(),
  /** Тело SKILL.md без frontmatter. */
  body: string(),
  /** Дополнительные файлы скилла: references/, config/, templates/. */
  files: array(string()),
  sizeBytes: number(),
  modifiedAt: string(),
  groupIds: array(string()),
  /** Выключенный скилл переносится в `skills-disabled/` и Claude его не видит. */
  isEnabled: boolean(),
});

export type Skill = Infer<typeof skillSchema>;

export const skillDraftSchema = object({
  name: string().min(1),
  description: string().min(1),
  body: string(),
  groupIds: array(string()).default([]),
});

export type SkillDraft = Infer<typeof skillDraftSchema>;
