import type { SkillFormatError } from '../../lib/opencode-skill.ts';

/** Путь скилла выходит за пределы каталога скиллов — операция запрещена. */
export class UnsafeSkillPathError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`Путь скилла «${path}» отклонён: ${detail}`);
    this.name = 'UnsafeSkillPathError';
    this.path = path;
  }
}

/** Скилла с таким путём в каталоге нет. */
export class SkillNotFoundError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Скилл «${path}» не найден в каталоге скиллов.`);
    this.name = 'SkillNotFoundError';
    this.path = path;
  }
}

/** Скилл существует, но панель его не переписывает (шапка не разобрана). */
export class SkillNotEditableError extends Error {
  readonly path: string;
  readonly problem: SkillFormatError['problem'];

  constructor(path: string, problem: SkillFormatError['problem'], message: string) {
    super(message);
    this.name = 'SkillNotEditableError';
    this.path = path;
    this.problem = problem;
  }
}

/** Черновик скилла нарушает задокументированные правила — записи не будет. */
export class InvalidSkillDraftError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'InvalidSkillDraftError';
    this.reason = reason;
  }
}

/**
 * Разложить отказ домена в код ответа и тело — одинаково для глобального и
 * проектного маршрутов. `undefined` для ошибок, которые маршрут пробрасывает.
 *
 * Небезопасный путь — всегда 400 `unsafe_path`, НИКОГДА 404.
 */
export function describeSkillError(
  error: unknown,
): { status: number; body: Record<string, unknown> } | undefined {
  if (error instanceof UnsafeSkillPathError) {
    return { status: 400, body: { error: 'unsafe_path', message: error.message } };
  }
  if (error instanceof InvalidSkillDraftError) {
    return {
      status: 400,
      body: { error: 'invalid_draft', reason: error.reason, message: error.message },
    };
  }
  if (error instanceof SkillNotFoundError) {
    return { status: 404, body: { error: 'not_found', message: error.message } };
  }
  if (error instanceof SkillNotEditableError) {
    return {
      status: 422,
      body: { error: 'skill_read_only', problem: error.problem, message: error.message },
    };
  }
  return undefined;
}
