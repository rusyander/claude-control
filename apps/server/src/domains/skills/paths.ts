import { join } from 'node:path';
import { safeSegment } from '../resources/registry.ts';

/**
 * Id скилла — имя его папки, и до этой проверки он шёл в `join()` как есть:
 * `..` уводил запись в корень `~/.claude` (`PUT /api/skills/..` создавал там
 * SKILL.md), `../hooks` — в соседний каталог, а DELETE с тем же id снёс бы его
 * целиком, пусть и с резервной копией. Пустой id указывал на сам `skills/`.
 * Один сегмент без слэшей, точек-шагов и управляющих символов — то же правило,
 * что у файлов ресурсов (`safeSegment`), поэтому и определение одно.
 * `statusCode`/`code` читает Fastify: маршрут отвечает 400, а не 500.
 */
export class InvalidSkillIdError extends Error {
  readonly statusCode = 400;
  readonly code = 'invalid_id';

  constructor(id: string) {
    super(`Недопустимый идентификатор скилла: «${id}»`);
    this.name = 'InvalidSkillIdError';
  }
}

/** Отвергает id, который не является одним именем папки внутри skills/. */
export function assertSkillId(id: string): string {
  if (safeSegment(id) === undefined) throw new InvalidSkillIdError(id);
  return id;
}

/** Каталог выключенных скиллов рядом с skills/. Знает и откат копий (backups.ts). */
export const SKILLS_DISABLED_DIR = 'skills-disabled';

/** Соседний каталог выключенных скиллов для заданного `skills/`. */
export function disabledSkillsDir(skillsDir: string): string {
  return join(skillsDir, '..', SKILLS_DISABLED_DIR);
}
