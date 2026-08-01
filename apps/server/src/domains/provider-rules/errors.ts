import type { MdcFormatError } from '../../lib/cursor-mdc.ts';

/** Путь правила выходит за пределы каталога правил — операция запрещена. */
export class UnsafeRulePathError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`Путь правила «${path}» отклонён: ${detail}`);
    this.name = 'UnsafeRulePathError';
    this.path = path;
  }
}

/** Правило существует, но панель его не переписывает (frontmatter не разобран). */
export class RuleNotEditableError extends Error {
  readonly path: string;
  readonly problem: MdcFormatError['problem'];

  constructor(path: string, problem: MdcFormatError['problem'], message: string) {
    super(message);
    this.name = 'RuleNotEditableError';
    this.path = path;
    this.problem = problem;
  }
}

/** Правило с таким путём не найдено в каталоге. */
export class RuleNotFoundError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Правило «${path}» не найдено в каталоге правил.`);
    this.name = 'RuleNotFoundError';
    this.path = path;
  }
}

/**
 * Разложить отказ домена в код ответа и тело — одинаково для глобального и
 * проектного маршрутов (дублировать раскладку в двух местах нельзя: разъедется).
 * Возвращает `undefined` для ошибок, которые маршрут обязан пробросить дальше.
 *
 * Небезопасный путь — всегда 400 `unsafe_path`, НИКОГДА 404: сообщать, есть ли
 * файл за пределами каталога правил, панель не должна.
 */
export function describeRuleError(
  error: unknown,
): { status: number; body: Record<string, unknown> } | undefined {
  if (error instanceof UnsafeRulePathError) {
    return { status: 400, body: { error: 'unsafe_path', message: error.message } };
  }
  if (error instanceof RuleNotFoundError) {
    return { status: 404, body: { error: 'not_found', message: error.message } };
  }
  if (error instanceof RuleNotEditableError) {
    return {
      status: 422,
      body: { error: 'rule_read_only', problem: error.problem, message: error.message },
    };
  }
  return undefined;
}
