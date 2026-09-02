import { object, string, array, boolean, number, type infer as Infer } from 'zod';
import { skillSchema } from './skills';
import { hookSchema } from './hooks';

/**
 * Собственный `.claude` проекта — то, что Claude Code загружает из каталога
 * репозитория поверх пользовательского `~/.claude`: скиллы (`.claude/skills`),
 * хуки (`.claude/settings.json` и `.claude/settings.local.json`) и правила
 * (`.claude/rules/**\/*.md`).
 *
 * Панель это ТОЛЬКО ЧИТАЕТ: проектный `.claude` принадлежит гиту проекта, и
 * правится он там, где лежит. Поэтому здесь нет черновиков и результатов записи —
 * одна форма ответа на чтение.
 */

/** Файл правил из `.claude/rules/`. */
export const projectRuleFileSchema = object({
  /** Путь относительно `.claude/rules`, всегда с прямыми слэшами. */
  path: string(),
  /** Первый заголовок файла, иначе имя файла без расширения. */
  title: string(),
  /** Тело без frontmatter. */
  body: string(),
  /**
   * Маски путей из frontmatter (`paths:`) — правило действует только на
   * подходящие файлы. Пусто — правило общее для проекта.
   */
  paths: array(string()),
  sizeBytes: number(),
  modifiedAt: string(),
});

export type ProjectRuleFile = Infer<typeof projectRuleFileSchema>;

export const projectLocalConfigSchema = object({
  /** Абсолютный путь к `<проект>/.claude`. */
  root: string(),
  /** Есть ли каталог `.claude` вообще; без него все списки пусты. */
  exists: boolean(),
  /** `groupIds` здесь всегда пуст: в пользовательские группы проектные скиллы не входят. */
  skills: array(skillSchema),
  /** `isEnabled` всегда true, `groupIds` пуст: выключить проектный хук панели нечем. */
  hooks: array(hookSchema),
  rules: array(projectRuleFileSchema),
});

export type ProjectLocalConfig = Infer<typeof projectLocalConfigSchema>;
